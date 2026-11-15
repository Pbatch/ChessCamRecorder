import { describe, expect, it } from "vitest";
import { replay, replayPlay } from "./replay.js";
import { BeamTracker } from "./beamTracker.js";
import { PlayTracker } from "./playTracker.js";
import { GameBoard } from "../chess/board.js";
import { videoProbs } from "../test/helpers.js";
import { START_FEN } from "../constants.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FPS = 4;
const video = (...scenes: [string, number][]) => videoProbs(FPS, ...scenes);

describe("replay", () => {
  it("plays nothing while the board stays at the start", () => {
    expect(replay(video([START_FEN, 5]), FPS)).toEqual([]);
  });

  it("plays each move, timed from when it was first shown", () => {
    const moves = replay(video([START_FEN, 3], [AFTER_E4, 3], [AFTER_E4_E5, 3]), FPS);
    expect(moves.map(({ san }) => san)).toEqual(["e4", "e5"]);
    // e4 shows from 3s and e5 from 6s; a move can be shown from its first clear frame. e5 first has to confirm e4, so
    // it takes a frame or so longer.
    expect(moves[0].time).toBeGreaterThanOrEqual(3);
    expect(moves[0].time).toBeLessThanOrEqual(4);
    expect(moves[1].time).toBeGreaterThan(6);
    expect(moves[1].time).toBeLessThanOrEqual(7.5);
  });

  it("starts at the given time, timing moves from the video's start", () => {
    const moves = replay(video([AFTER_E4, 3], [START_FEN, 3], [AFTER_E4, 3]), FPS, 3);
    expect(moves.map(({ san }) => san)).toEqual(["e4"]);
    // From the video's start, not from the given time: e4 shows again from 6s
    expect(moves[0].time).toBeGreaterThanOrEqual(6);
  });

  it("skips frames with non-finite probabilities", () => {
    const probs = video([START_FEN, 3], [AFTER_E4, 3]);
    probs.fill(Number.NaN, 0, 64 * 13);
    expect(replay(probs, FPS).map(({ san }) => san)).toEqual(["e4"]);
  });
});

// A video of the true game: the start until the first move's time, then each position until the next move's, and the
// last until `end` seconds
const gameVideo = (sans: string[], times: number[], end: number) => {
  const board = new GameBoard(START_FEN);
  const scenes: [string, number][] = [[START_FEN, times[0]]];
  sans.forEach((san, k) => {
    board.playSan(san);
    scenes.push([board.fen, (times[k + 1] ?? end) - times[k]]);
  });
  return video(...scenes);
};

describe("replayPlay", () => {
  const truth = ["e4", "e5", "Nf3", "Nc6"];
  const truthTimes = [3, 6, 9, 12];
  const probs = gameVideo(truth, truthTimes, 16);
  const accepted = (sends: { ply: number, san: string, accepted: boolean }[]) =>
    sends.filter((send) => send.accepted).map(({ ply, san }) => [ply, san]);

  it("as White, sends each move, and gets each reply after it and before the board shows it", () => {
    const { sends, received } = replayPlay(probs, FPS, { color: "white", truth, truthTimes });
    expect(sends.map(({ ply, san, accepted }) => [ply, san, accepted])).toEqual([[0, "e4", true], [2, "Nf3", true]]);
    expect(received[0]).toBeNull();
    expect(received[1]).toBeGreaterThanOrEqual(sends[0].time);
    expect(received[1]).toBeLessThan(6);
  });

  it("as Black, gets the first move from Lichess before the board shows it", () => {
    const { sends, received } = replayPlay(probs, FPS, { color: "black", truth, truthTimes });
    expect(received[0]).toBe(1);
    expect(accepted(sends)).toEqual([[1, "e5"], [3, "Nc6"]]);
  });

  it("goes on without a move the board never shows, once it shows the reply", () => {
    // 2. Nf3 and 2... Nc6 appear on the board together at 12s, before Lichess has Nf3
    const moves = [...truth, "Bc4"];
    const together = gameVideo(["e4", "e5", "Nf3", "Nc6", "Bc4"], [3, 6, 12, 12, 15], 19);
    const { sends, received } = replayPlay(together, FPS, { color: "white", truth: moves, truthTimes: [3, 6, 12, 12, 15] });
    expect(accepted(sends)).toContainEqual([0, "e4"]);
    expect(accepted(sends)).toContainEqual([4, "Bc4"]);
    expect(accepted(sends).map(([ply]) => ply)).not.toContain(2);
    expect(received[3]).toBe(12);
  });

  it("catches a move sent while the board is a move behind, which play mode's tracker prevents", () => {
    // 1. d4 Nf6 2. Nf3 d5 3. Bf4 e6 4. e3 c5 5. Nbd2 Nc6 6. e4, with Nc6 sent 10s before the board shows it
    const game = ["d4", "Nf6", "Nf3", "d5", "Bf4", "e6", "e3", "c5", "Nbd2", "Nc6", "e4"];
    const times = [4, 8, 12, 16, 20, 24, 28, 32, 36, 50, 54];
    const slow = gameVideo(game, times, 58);
    // Record mode's beam doesn't follow a board a move behind
    const run = (tracker: BeamTracker | PlayTracker) => replayPlay(slow, FPS, {
      color: "white", truth: game, truthTimes: times, lead: 10, tracker
    });
    // The beam explains the knight still on b8 as 6. Bb8 Nxb8, so 6. e4 can't follow
    const eager = run(new BeamTracker()).sends.filter(({ ply }) => ply >= 10);
    expect(eager.filter(({ accepted, san }) => accepted && san === "e4")).toEqual([]);
    expect(accepted(run(new PlayTracker()).sends).filter(([ply]) => ply === 10)).toEqual([[10, "e4"]]);
  });
});
