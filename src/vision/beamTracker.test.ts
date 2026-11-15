import { describe, expect, it } from "vitest";
import { BeamTracker } from "./beamTracker.js";
import { makeUpdatePayload } from "../game.js";
import { replay } from "./replay.js";
import { makeGame, oneHotState, videoProbs } from "../test/helpers.js";
import { START_FEN } from "../constants.js";
import type { Game } from "../types.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
const FPS = 4;

const video = (...scenes: [string, number][]) => videoProbs(FPS, ...scenes);

const sans = (moves: { san: string }[]) => moves.map(({ san }) => san);

// A tracker, the game as the store would keep it, and the clock it runs on, in ms
interface Run { tracker: BeamTracker, game: Game, clock: number }
const start = (game: Game = makeGame()): Run => ({ tracker: new BeamTracker(), game, clock: 0 });

// Runs the tracker on frames of each FEN in turn
const run = (state: Run, ...scenes: [string, number][]): Run => {
  for (const [fen, seconds] of scenes) {
    for (let i = 0; i < seconds * FPS; i++) {
      const move = state.tracker.update(oneHotState(fen), state.clock, state.game);
      if (move !== null) state.game = { ...state.game, ...makeUpdatePayload(move.board) };
      state.clock += 1000 / FPS;
    }
  }
  return state;
}

describe("BeamTracker", () => {
  it("plays a move and its reply", () => {
    expect(sans(replay(video([START_FEN, 3], [AFTER_E4, 3], [AFTER_E4_E5, 3]), FPS))).toEqual(["e4", "e5"]);
  });

  it("goes on from the app's game", () => {
    expect(run(start(makeGame("1. e4")), [AFTER_E4, 2], [AFTER_E4_E5, 3]).game.moves).toBe("1. e4 e5");
  });

  it("starts again when the game is changed elsewhere", () => {
    const state = run(start(), [START_FEN, 2], [AFTER_E4, 2], [AFTER_E4_E5, 3]);
    expect(state.game.moves).toBe("1. e4 e5");
    // The user takes back both moves, and the board shows the start again
    state.game = makeGame();
    expect(run(state, [START_FEN, 3]).game.moves).toBe("");
  });

  it("takes every move in a game changed elsewhere as final", () => {
    // The user entered 1. e4, but the board still shows the start
    expect(run(start(makeGame("1. e4")), [START_FEN, 3]).game.moves).toBe("1. e4");
  });

  it("can still replace a move shown just before a pause", () => {
    const state = run(start(), [START_FEN, 2], [AFTER_E4, 1]);
    expect(state.game.moves).toBe("1. e4");
    // Detection pauses, which stops the clock, and the board shows d4 once it starts again
    expect(run(state, [AFTER_D4, 3]).game.moves).toBe("1. d4");
  });

  it("goes on after a long gap in which the board was reset", () => {
    const state = run(start(), [START_FEN, 2], [AFTER_E4, 2], [AFTER_E4_E5, 3]);
    state.clock += 60000;
    run(state, [START_FEN, 3]);
    expect(state.game.moves).toBe("1. e4 e5");
    expect(run(state, [AFTER_E4_E5, 2], [AFTER_E4_E5_NF3, 3]).game.moves).toBe("1. e4 e5 2. Nf3");
  });
});
