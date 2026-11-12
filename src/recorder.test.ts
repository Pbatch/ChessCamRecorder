import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { START_FEN } from "./constants.js";
import { RecorderError } from "./errors.js";
import { createRecorder, type Recorder, type RecorderOptions } from "./recorder.js";
import { oneHotState } from "./test/helpers.js";
import type { Game } from "./types.js";
import type { Model } from "./vision/model.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FRAME_MS = 250;

// A fake page: animation frames run when the test ticks the clock, and the model sees whatever `board` is
let clock: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let board: string;
let failure: Error | null;

const video = {
  videoWidth: 1280, videoHeight: 720, readyState: 4, seeking: false, srcObject: {}, currentSrc: "", playbackRate: 1
} as unknown as HTMLVideoElement;

const model: Model = {
  detect: async () => {
    if (failure !== null) {
      throw failure;
    }
    return { update: oneHotState(board), direction: null };
  },
  delete: () => undefined
};

// Runs the page's animation frames for `seconds`, a frame at a time, letting each frame's detection finish
const run = async (seconds: number) => {
  for (let elapsed = 0; elapsed < 1000 * seconds; elapsed += FRAME_MS) {
    clock += FRAME_MS;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) {
      callback(clock);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
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

  it("only shows final moves when asked", async () => {
    const updates = record({ finalMovesOnly: true });
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

  it("stops for good once destroyed", async () => {
    const updates = record();
    recorder.start();
    recorder.destroy();
    await show([AFTER_E4, 2]);
    expect(updates).toEqual([]);
    expect(frames.size).toBe(0);
  });
});
