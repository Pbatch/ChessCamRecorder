import { MODEL_SIZE, LABEL_MAP, NUM_LABELS, zeros } from "../constants.js";
import { RecorderError } from "../errors.js";
import type { CornerName, Roi } from "../types.js";
import type { WorkerCall, WorkerRequest, WorkerResponse } from "./worker.js";

// Square probabilities, and where each square query looked (null for models without that output)
interface PieceModelOutputs {
  probs: Float32Array,
  centroids: Float32Array | null
}

// The loaded model, in a CPU worker. A null video gives blank pixels, for the warm-up.
interface PieceModel {
  run: (video: HTMLVideoElement | null, roi: Roi | null) => Promise<PieceModelOutputs>,
  delete: () => void
}

// Model classes, in output order
const CLASS_SYMBOLS: string[] = [".", "P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"];
const NUM_PROBS: number = 64 * CLASS_SYMBOLS.length;
// Region corners clockwise from the top left when rank 8 is at the top
const CORNERS: CornerName[] = ["a8", "h8", "h1", "a1"];
// chessq-chesscam-mnv4m-320-v1, a MobileNetV4 Conv-M model distilled from v5: about 100 ms a frame on a Pixel 7a's
// CPU, against v5's 400, and 23.9 MB against 62.5. Pinned to a commit so a new upload cannot change the model under a
// deployed app.
export const DEFAULT_MODEL_URL: string = "https://huggingface.co/PBatch23888/chessq-chesscam/resolve/0c3de0dd34a5e1a60d69e942045fb6dc0f82aeb4/chessq-chesscam-mnv4m-320-v1-fp16.tflite";
// The LiteRT.js runtime must match the library exactly, so the dependency is pinned to this version
export const LITERT_VERSION: string = "2.6.0";
export const DEFAULT_WASM_URL: string = `https://cdn.jsdelivr.net/npm/@litertjs/core@${LITERT_VERSION}/wasm/`;

let canvas: OffscreenCanvas | null = null;

const blankPixels = (): Uint8Array<ArrayBuffer> => new Uint8Array(MODEL_SIZE * MODEL_SIZE * 4);

// Output order is up to the converter, so they are told apart by size
const toOutputs = (arrays: Float32Array[]): PieceModelOutputs => {
  const probs = arrays.find((array) => array.length === NUM_PROBS);
  if (probs === undefined) {
    throw new Error("Model has no square probabilities");
  }
  return { probs, centroids: arrays.find((array) => array.length === 64 * 2) ?? null };
}

// The CPU model runs in a worker, as each run blocks its thread for the whole inference. The URL is relative to the
// built file, which bundlers (e.g. Vite, webpack) follow to bundle the worker.
const loadWorker = async (wasmUrl: string, modelUrl: string): Promise<PieceModel> => {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (arrays: Float32Array[]) => void, reject: (error: Error) => void }>();
  let nextId: number = 0;
  // Set once the worker has stopped, so later runs fail rather than wait forever
  let stopped: Error | null = null;
  const stop = (error: Error) => {
    stopped = error;
    worker.terminate();
    pending.forEach(({ reject }) => {
      reject(error);
    });
    pending.clear();
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    pending.delete(response.id);
    if ("error" in response) {
      request?.reject(new Error(response.error));
    } else {
      request?.resolve(response.arrays);
    }
  }
  // e.g. the worker failed to start, or ran out of memory
  worker.onerror = (event: ErrorEvent) => {
    console.error("Piece detection worker failed", event.message);
    stop(new RecorderError("worker-stopped", event.message));
  }

  const send = (call: WorkerCall, transfer: Transferable[] = []): Promise<Float32Array[]> => {
    if (stopped !== null) {
      return Promise.reject(stopped);
    }
    const id: number = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const request: WorkerRequest = { ...call, id };
      worker.postMessage(request, transfer);
    });
  }

  try {
    // The worker's URL is not the page's, so the URLs are made absolute
    await send({ type: "load", wasmUrl: new URL(wasmUrl, document.baseURI).href,
      modelUrl: new URL(modelUrl, document.baseURI).href });
  } catch (error) {
    stop(error as Error);
    throw error;
  }
  return {
    run: async (video, roi) => {
      const pixels = (video === null) ? blankPixels() : getPixels(video, roi);
      return toOutputs(await send({ type: "run", pixels }, [pixels.buffer]));
    },
    delete: () => stop(new RecorderError("unloaded", "The model was unloaded"))
  };
}

// One frame's reading: a 64x13 state in square order (a1..h8), and the direction of rank 8 in video pixels, if the
// model gives it
export interface Detection {
  update: number[][],
  direction: number[] | null
}

export interface ModelOptions {
  // The .tflite model, which must take 320x320 RGBA and give 64x13 square probabilities. Self-host it to load it
  // from the page's own origin, e.g. where huggingface.co is blocked.
  modelUrl?: string,
  // Where LiteRT.js's runtime (the files in @litertjs/core/wasm/) is served, ending in a slash. Self-host it for
  // offline use; it must be version LITERT_VERSION.
  wasmUrl?: string
}

export interface Model {
  // Reads one frame of the video, cropped to the region if given (otherwise the whole frame)
  detect: (video: HTMLVideoElement, roi?: Roi | null) => Promise<Detection>,
  // Frees the model. A later loadModel() loads it again.
  delete: () => void
}

let loaded: { key: string, model: Promise<Model> } | null = null;

const makeModel = (pieceModel: PieceModel): Model => {
  let current: PieceModel | null = pieceModel;
  return {
    detect: async (video, roi = null) => {
      if (current === null) {
        throw new RecorderError("not-ready", "The model is not loaded");
      }
      const { probs, centroids } = await current.run(video, roi);
      const width: number = (roi === null) ? video.videoWidth : roi.width;
      const height: number = (roi === null) ? video.videoHeight : roi.height;
      return {
        update: toUpdate(probs),
        direction: (centroids === null) ? null : toDirection(centroids, width, height)
      };
    },
    delete: () => {
      const model = current;
      current = null;
      loaded = null;
      model?.delete();
    }
  };
}

// Loads the model on the CPU in a worker, warmed up so the first frame is quick. A page has one model: calling again
// gives the same one, until it is deleted.
export const loadModel = (options: ModelOptions = {}): Promise<Model> => {
  const modelUrl: string = options.modelUrl ?? DEFAULT_MODEL_URL;
  const wasmUrl: string = options.wasmUrl ?? DEFAULT_WASM_URL;
  const key: string = JSON.stringify([modelUrl, wasmUrl]);
  if (loaded !== null) {
    return (loaded.key === key) ? loaded.model
      : Promise.reject(new Error("A different model is already loaded; delete it first"));
  }
  const model: Promise<Model> = loadWorker(wasmUrl, modelUrl).then(makeModel);
  loaded = { key, model };
  void model.catch(() => {
    if (loaded?.model === model) {
      loaded = null;
    }
  });
  return model;
}

// RGBA bytes as the model takes them, viewing the canvas data without a copy.
const getPixels = (video: HTMLVideoElement, roi: Roi | null): Uint8Array<ArrayBuffer> => {
  if (canvas === null) {
    canvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    throw new Error("Canvas is not ready");
  }
  // The model was trained on square-resized images, so the aspect ratio is not kept
  ctx.imageSmoothingQuality = "high";
  if (roi === null) {
    ctx.drawImage(video, 0, 0, MODEL_SIZE, MODEL_SIZE);
  } else {
    ctx.drawImage(video, roi.x, roi.y, roi.width, roi.height, 0, 0, MODEL_SIZE, MODEL_SIZE);
  }
  const imageData: ImageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  return new Uint8Array<ArrayBuffer>(imageData.data.buffer);
}

// Direction of rank 8 in video pixels, from the attention centroids in FEN order (a8..h1).
// The centroids are pulled towards the board centre, so only the rank and file directions are used.
export const toDirection = (centroids: Float32Array, width: number, height: number): number[] => {
  const up: number[] = [0, 0];
  const right: number[] = [0, 0];
  for (let i = 0; i < 64; i++) {
    const rank: number = 7 - Math.floor(i / 8) - 3.5;
    const file: number = (i % 8) - 3.5;
    const x: number = centroids[2 * i] * width;
    const y: number = centroids[2 * i + 1] * height;
    up[0] += rank * x;
    up[1] += rank * y;
    right[0] += file * x;
    right[1] += file * y;
  }
  // Camera images are never mirrored, so the a->h direction turned 90 degrees anticlockwise is also rank 8
  const upNorm: number = Math.hypot(up[0], up[1]) || 1;
  const rightNorm: number = Math.hypot(right[0], right[1]) || 1;
  return [up[0] / upNorm + right[1] / rightNorm, up[1] / upNorm - right[0] / rightNorm];
}

// Rank 8 direction -> square names of the region corners, clockwise from the top left
export const getOrientation = (direction: number[]): CornerName[] => {
  // Quarter turns clockwise from rank 8 at the top
  const turns: number = Math.round(Math.atan2(direction[0], -direction[1]) / (Math.PI / 2));
  return CORNERS.map((_, i) => CORNERS[(((i - turns) % 4) + 4) % 4]);
}

// Probabilities in FEN order (a8..h1) -> 64x13 state in square order (a1..h8)
export const toUpdate = (probs: Float32Array): number[][] => {
  const update: number[][] = zeros(64, NUM_LABELS);
  for (let i = 0; i < 64; i++) {
    const rank: number = 7 - Math.floor(i / 8);
    const file: number = i % 8;
    const square: number = 8 * rank + file;
    for (let j = 0; j < CLASS_SYMBOLS.length; j++) {
      update[square][LABEL_MAP[CLASS_SYMBOLS[j]]] = probs[i * CLASS_SYMBOLS.length + j];
    }
  }
  return update;
}
