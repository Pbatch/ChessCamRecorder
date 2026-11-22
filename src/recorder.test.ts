import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { START_FEN } from "./constants.js";
import { RecorderError } from "./errors.js";
import { createRecorder, type Recorder, type RecorderOptions } from "./recorder.js";
import { oneHotState } from "./test/helpers.js";
import type { CornerName, Game, Roi } from "./types.js";
import type { Model } from "./vision/model.js";
import type { BoardFit } from "./vision/board.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FRAME_MS = 250;

// A fake page: the recorder's ticks run when the test ticks the clock, and the model sees whatever `board` is
let clock: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let board: string;
let failure: Error | null;
// Runs each time the clock moves on, before the recorder's tick, e.g. to fire a video's frame callbacks
let onClock: (() => void) | null;

const video = {
  videoWidth: 1280, videoHeight: 720, readyState: 4, seeking: false, srcObject: {}, currentSrc: "", playbackRate: 1
} as unknown as HTMLVideoElement;

const model: Model = {
  detect: async () => {
    if (failure !== null) {
      throw failure;
    }
    return { update: oneHotState(board), direction: null, board: null };
  },
  locates: false,
  delete: () => undefined
};

// Runs the recorder's ticks for `seconds`, a frame at a time, letting each frame's detection finish
const run = async (seconds: number) => {
  for (let elapsed = 0; elapsed < 1000 * seconds; elapsed += FRAME_MS) {
    clock += FRAME_MS;
    onClock?.();
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) {
      callback(clock);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Lets reads that were just answered finish
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The board as each scene shows it, for the given seconds
const show = async (...scenes: [string, number][]) => {
  for (const [fen, seconds] of scenes) {
    board = fen;
    await run(seconds);
  }
}

let recorder: Recorder;
const record = (options: Partial<RecorderOptions> = {}): Game[] => {
  const updates: Game[] = [];
  recorder = createRecorder({ model, video, onUpdate: (game) => updates.push(game), ...options });
  return updates;
}

beforeEach(() => {
  clock = 0;
  frames = new Map();
  nextFrameId = 1;
  board = START_FEN;
  failure = null;
  onClock = null;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  // The recorder's ticker: each tick it asks for runs on the test's next frame
  vi.stubGlobal("Worker", class {
    onmessage: (() => void) | null = null;
    private ids = new Set<number>();
    postMessage() {
      const id = nextFrameId++;
      this.ids.add(id);
      frames.set(id, () => this.onmessage?.());
    }
    terminate() {
      this.ids.forEach((id) => {
        frames.delete(id);
      });
    }
  });
});

afterEach(() => {
  recorder.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createRecorder", () => {
  it("starts paused", async () => {
    const updates = record();
    await show([AFTER_E4, 3]);
    expect(updates).toEqual([]);
    expect(recorder.running).toBe(false);
  });

  it("records the moves played, timed from the start", async () => {
    record();
    recorder.start();
    await show([START_FEN, 2], [AFTER_E4, 3], [AFTER_E4_E5, 3]);
    expect(recorder.game).toMatchObject({ moves: "1. e4 e5", fen: AFTER_E4_E5, lastMove: "e7e5" });
    // e4 shows from 2s, and e5 from 5s
    expect(recorder.game.times[0]).toBeGreaterThanOrEqual(2000);
    expect(recorder.game.times[0]).toBeLessThanOrEqual(3000);
    expect(recorder.game.times[1]).toBeGreaterThanOrEqual(5000);
    expect(recorder.game.times[1]).toBeLessThanOrEqual(6500);
    expect(recorder.running).toBe(true);
  });

  it("gives the game as PGN with the players' names and move times", async () => {
    record();
    recorder.start();
    await show([START_FEN, 2], [AFTER_E4, 3], [AFTER_E4_E5, 3]);
    const pgn = recorder.pgn({ White: "Alice", Black: "Bob" });
    expect(pgn).toContain('[White "Alice"]\n[Black "Bob"]');
    expect(pgn).toMatch(/1\. e4 \{ \[%emt 0:00:0\d\] \} e5 \{ \[%emt 0:00:0\d\] \} \*/);
  });

  it("leaves moves untimed when asked", async () => {
    record({ timed: false });
    recorder.start();
    await show([AFTER_E4, 2]);
    expect(recorder.game).toMatchObject({ moves: "1. e4", times: [] });
  });

  it("doesn't count a pause as time, or see moves during it", async () => {
    const updates = record();
    recorder.start();
    await show([AFTER_E4, 2]);
    recorder.pause();
    const before = updates.length;
    await show([AFTER_E4_E5, 10]);
    expect(updates.length).toBe(before);
    expect(recorder.running).toBe(false);
    recorder.start();
    await show([AFTER_E4_E5, 2]);
    expect(recorder.game.moves).toBe("1. e4 e5");
    // From when recording started, less the 10s paused
    expect(recorder.game.times[1]).toBeLessThan(5000);
  });

  it("reports the detection rate, and null once paused", async () => {
    const fps: (number | null)[] = [];
    record({ onFps: (value) => fps.push(value) });
    recorder.start();
    await show([START_FEN, 3]);
    expect(fps.at(-1)).toBeCloseTo(4);
    recorder.pause();
    await run(1);
    expect(fps.at(-1)).toBeNull();
  });

  it("follows a game changed off the board, keeping the times of the moves it still has", async () => {
    record();
    recorder.start();
    await show([START_FEN, 1], [AFTER_E4, 2], [AFTER_E4_E5, 2]);
    const e4Time = recorder.game.times[0];
    // A takeback of e5, then the board shows a different reply
    recorder.setGame({ moves: "1. e4" });
    expect(recorder.game).toMatchObject({ moves: "1. e4", fen: AFTER_E4, times: [e4Time] });
    await show([AFTER_E4, 1], ["rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", 2]);
    expect(recorder.game.moves).toBe("1. e4 e6");
    expect(recorder.game.times[0]).toBe(e4Time);
  });

  it("starts from a game set from outside, such as an opponent's move", async () => {
    record();
    recorder.setGame({ moves: "1. e4", fromOpponent: true });
    expect(recorder.game).toMatchObject({ moves: "1. e4", fromOpponent: true, times: [] });
    recorder.start();
    await show([AFTER_E4, 1], [AFTER_E4_E5, 2]);
    expect(recorder.game).toMatchObject({ moves: "1. e4 e5", fromOpponent: false });
  });

  it("starts a new game on reset", async () => {
    record();
    recorder.start();
    await show([AFTER_E4, 2]);
    recorder.reset();
    expect(recorder.game).toMatchObject({ moves: "", fen: START_FEN, times: [] });
    await show([START_FEN, 2]);
    expect(recorder.game.moves).toBe("");
  });

  it("in play mode, shows only the user's move, once certain", async () => {
    const updates = record({ play: true });
    recorder.start();
    await show([START_FEN, 1], [AFTER_E4, 4]);
    expect(recorder.game.moves).toBe("1. e4");
    // Never a move that was later taken back
    expect(updates.map(({ moves }) => moves)).toEqual(["1. e4"]);
  });

  it("reports a failed frame and carries on", async () => {
    const errors: RecorderError[] = [];
    record({ onError: (error) => errors.push(error) });
    recorder.start();
    failure = new RecorderError("worker-stopped");
    await show([START_FEN, 1]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe("worker-stopped");
    failure = new Error("out of memory");
    await show([START_FEN, 0.25]);
    expect(errors.at(-1)).toMatchObject({ code: "detection-failed", message: "out of memory" });
    failure = null;
    await show([AFTER_E4, 2]);
    expect(recorder.game.moves).toBe("1. e4");
  });

  it("waits for the video to have a frame", async () => {
    const updates = record({ video: { ...video, readyState: 1 } as HTMLVideoElement });
    recorder.start();
    await show([AFTER_E4, 2]);
    expect(updates).toEqual([]);
    recorder.setVideo(video);
    await show([AFTER_E4, 2]);
    expect(recorder.game.moves).toBe("1. e4");
  });

  it("reads the board when the video stops reporting frames, as in a background tab", async () => {
    // requestVideoFrameCallback never fires, as when the page isn't shown
    const hiddenVideo = { ...video, requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => undefined };
    record({ video: hiddenVideo as unknown as HTMLVideoElement });
    recorder.start();
    await show([START_FEN, 2], [AFTER_E4, 3]);
    expect(recorder.game.moves).toBe("1. e4");
  });

  // A video whose frame callbacks fire every `callbackMs` and which decodes a new frame every `decodeMs`
  const pacedVideo = (callbackMs: number, decodeMs: number): HTMLVideoElement => {
    let pending: VideoFrameRequestCallback | null = null;
    let lastCallback = 0;
    onClock = () => {
      if (pending !== null && clock - lastCallback >= callbackMs) {
        lastCallback = clock;
        const callback = pending;
        pending = null;
        callback(clock, {} as VideoFrameCallbackMetadata);
      }
    };
    return {
      ...video,
      requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => {
        pending = callback;
        return 1;
      },
      cancelVideoFrameCallback: () => {
        pending = null;
      },
      getVideoPlaybackQuality: () => ({ totalVideoFrames: Math.floor(clock / decodeMs) })
    } as unknown as HTMLVideoElement;
  }

  it("keeps the full rate when frame callbacks slow to once a second but the video still decodes", async () => {
    // As in a hidden tab with DevTools (or any CDP client) attached: the callbacks come just often enough that the
    // video never counts as stalled
    const fps: (number | null)[] = [];
    record({ video: pacedVideo(1000, 1000 / 30), onFps: (value) => fps.push(value) });
    recorder.start();
    await show([START_FEN, 4]);
    expect(fps.at(-1)).toBeCloseTo(4);
  });

  it("reads a slow camera no faster than it gives frames", async () => {
    const fps: (number | null)[] = [];
    record({ video: pacedVideo(500, 500), onFps: (value) => fps.push(value) });
    recorder.start();
    await show([START_FEN, 4]);
    expect(fps.at(-1)).toBeCloseTo(2);
  });

  it("finds the board itself and reads its crop, with a model that gives positions", async () => {
    // The board is 200px wide at (500, 300) of the video, in the region read or the whole frame
    const regions: (Roi | null)[] = [];
    const locating: Model = {
      detect: async (_video, roi = null) => {
        regions.push(roi);
        const corners = [[500, 300], [700, 300], [700, 500], [500, 500]];
        return { update: oneHotState(board), direction: null, board: { corners, inliers: 64, sigma: 0.1 } };
      },
      locates: true,
      delete: () => undefined
    };
    const rois: (Roi | null)[] = [];
    // The whole-frame read shows a move that isn't there, which mustn't be used
    board = AFTER_E4;
    record({ model: locating, onRoi: (roi) => rois.push(roi) });
    recorder.start();
    await run(0.25);
    // The whole frame, then the crop its fit proposes, read again
    const crop = { x: 470, y: 270, width: 260, height: 260 };
    expect(regions).toEqual([null, crop]);
    expect(rois).toEqual([crop]);
    await show([START_FEN, 2], [AFTER_E4, 3]);
    expect(regions.slice(1).every((roi) => roi?.x === 470)).toBe(true);
    expect(recorder.game.moves).toBe("1. e4");
    // A region given overrides it, and clearing it looks for the board again
    recorder.setRoi({ x: 0, y: 0, width: 640, height: 360 });
    await run(0.25);
    expect(regions.at(-1)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(rois.at(-1)).toBeNull();
    recorder.setRoi(null);
    await run(0.25);
    expect(regions.slice(-2)).toEqual([null, crop]);
  });

  it("reads the frame again in the crop a rough fit of the whole frame proposes, and crops to the board found there", async () => {
    // The board is small in the whole frame, so its fit there is too unsure (sigma 1.2) to set the crop; in the crop it
    // proposes, the fit is sure. The reads of the whole frame and of the proposal show a move that isn't there.
    const regions: (Roi | null)[] = [];
    const corners = [[500, 300], [700, 300], [700, 500], [500, 500]];
    const small: Model = {
      detect: async (_video, roi = null) => {
        regions.push(roi);
        return { update: oneHotState(board), direction: null, board: { corners, inliers: 64, sigma: (roi === null) ? 1.2 : 0.1 } };
      },
      locates: true,
      delete: () => undefined
    };
    const rois: (Roi | null)[] = [];
    board = AFTER_E4;
    record({ model: small, onRoi: (roi) => rois.push(roi) });
    recorder.start();
    await run(0.25);
    const crop = { x: 470, y: 270, width: 260, height: 260 };
    expect(regions).toEqual([null, crop]);
    expect(rois).toEqual([crop]);
    await show([START_FEN, 2], [AFTER_E4, 3]);
    expect(regions.slice(2).every((roi) => roi?.x === 470)).toBe(true);
    expect(recorder.game.moves).toBe("1. e4");
  });

  it("drops a frame read before the board was looked for afresh, as in a new video", async () => {
    // Each read waits until the test lets it finish
    const pending: ((fit?: BoardFit) => void)[] = [];
    const corners = [[500, 300], [700, 300], [700, 500], [500, 500]];
    const slow: Model = {
      detect: () => new Promise((resolve) => {
        pending.push((fit = { corners, inliers: 64, sigma: 0.1 }) => resolve({ update: oneHotState(board), direction: [1, 0], board: fit }));
      }),
      locates: true,
      delete: () => undefined
    };
    const rois: (Roi | null)[] = [];
    const orientations: CornerName[][] = [];
    record({ model: slow, onRoi: (roi) => rois.push(roi), onOrientation: (o) => orientations.push(o) });
    recorder.start();
    await run(0.25);
    expect(pending).toHaveLength(1);
    // A new video starts while the frame is read
    recorder.setRoi(null);
    pending.shift()?.();
    await flush();
    expect(rois).toEqual([]);
    expect(orientations).toEqual([]);
    // A frame without a good fit gives no orientation
    await run(0.25);
    pending.shift()?.({ corners, inliers: 64, sigma: 3 });
    await flush();
    expect(orientations).toEqual([]);
    // The next frame finds the board, read again in the crop its fit proposes, and reports its orientation
    await run(0.25);
    pending.shift()?.();
    await flush();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await flush();
    expect(rois).toHaveLength(1);
    expect(orientations).toEqual([["a8", "h8", "h1", "a1"]]);
    // After another reset, the same orientation is reported again, as the app clears it for a new video
    recorder.setRoi(null);
    await run(0.25);
    pending.shift()?.();
    await flush();
    pending.shift()?.();
    await flush();
    expect(orientations).toEqual([["a8", "h8", "h1", "a1"], ["a8", "h8", "h1", "a1"]]);
  });

  it("stops for good once destroyed", async () => {
    const updates = record();
    recorder.start();
    recorder.destroy();
    await show([AFTER_E4, 2]);
    expect(updates).toEqual([]);
    expect(frames.size).toBe(0);
  });
});
