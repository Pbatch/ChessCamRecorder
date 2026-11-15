import { describe, expect, it } from "vitest";
import { PlayTracker } from "./playTracker.js";
import { makeUpdatePayload } from "../game.js";
import { GameBoard } from "../chess/board.js";
import { replay } from "./replay.js";
import { makeGame, oneHotState, videoProbs } from "../test/helpers.js";
import { EMPTY, SQUARE_MAP, START_FEN } from "../constants.js";
import type { Game } from "../types.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const FPS = 4;

const video = (...scenes: [string, number][]) => videoProbs(FPS, ...scenes);

// Runs a tracker on frames, each held for some seconds, from a game, keeping the game as the store would; returns it
const run = (tracker: PlayTracker, game: Game, ...scenes: [number[][], number][]): Game => {
  let clock = 0;
  for (const [state, seconds] of scenes) {
    for (let i = 0; i < seconds * FPS; i++) {
      const move = tracker.update(state, clock, game);
      if (move !== null) game = { ...game, ...makeUpdatePayload(move.board) };
      clock += 1000 / FPS;
    }
  }
  return game;
};

describe("PlayTracker", () => {
  it("sends a move a second or so after it is played", () => {
    // replay only times the moves shown, which is all a PlayTracker shows
    const moves = replay(video([START_FEN, 3], [AFTER_E4, 4]), FPS, 0, new PlayTracker());
    expect(moves.map(({ san }) => san)).toEqual(["e4"]);
    expect(moves[0].time).toBeGreaterThan(3.5);
    expect(moves[0].time).toBeLessThanOrEqual(5.5);
  });

  it("never sends a move from a single clear frame of another position", () => {
    for (const stray of [AFTER_E4, AFTER_E4_E5]) {
      const game = run(new PlayTracker(), makeGame(), [oneHotState(START_FEN), 1], [oneHotState(stray), 0.25],
        [oneHotState(START_FEN), 3]);
      expect(game.moves).toBe("");
    }
  });

  it("never sends a move shown for less than a second", () => {
    const game = run(new PlayTracker(), makeGame(), [oneHotState(START_FEN), 3], [oneHotState(AFTER_E4), 0.75],
      [oneHotState(START_FEN), 4]);
    expect(game.moves).toBe("");
  });

  it("sends one move only, as the next comes from Lichess", () => {
    const game = run(new PlayTracker(), makeGame(), [oneHotState(START_FEN), 1], [oneHotState(AFTER_E4), 3],
      [oneHotState(AFTER_E4_E5), 3]);
    expect(game.moves).toBe("1. e4");
  });

  describe("after the opponent's move comes from Lichess", () => {
    // 1. d4 Nf6 2. Nf3 d5 3. Bf4 e6 4. e3 c5 5. Nbd2, then Lichess sends 5... Nc6
    const board = new GameBoard(START_FEN);
    ["d2d4", "g8f6", "g1f3", "d7d5", "c1f4", "e7e6", "e2e3", "c7c5", "b1d2"].forEach((uci) => { board.playUci(uci); });
    const before = oneHotState(board.fen);
    board.playUci("b8c6");
    const after = oneHotState(board.fen);
    const fromLichess: Game = { ...makeGame(), ...makeUpdatePayload(board, true) };
    board.playUci("e3e4");
    const afterE4 = oneHotState(board.fen);

    it("sends nothing while the board still shows the position before it", () => {
      // A board a move behind fits 6. Bb8 Nxb8, wrong only on f4, which the beam without following it sent
      expect(run(new PlayTracker(), fromLichess, [before, 10])).toBe(fromLichess);
    });

    it("sends the user's move once the board shows the opponent's", () => {
      expect(run(new PlayTracker(), fromLichess, [before, 3], [after, 2], [afterE4, 3]).moves).toMatch(/Nc6 6\. e4$/);
    });

    it("sends the user's move when both are played at once", () => {
      expect(run(new PlayTracker(), fromLichess, [before, 3], [afterE4, 4]).moves).toMatch(/Nc6 6\. e4$/);
    });

    it("doesn't wait when the board already shows it", () => {
      expect(run(new PlayTracker(), fromLichess, [after, 2], [afterE4, 3]).moves).toMatch(/Nc6 6\. e4$/);
    });
  });

  describe("when the board shows the opponent's move and then goes back", () => {
    // A Benoni (lichess.org/i6QvfBKP) up to 12... Bf5, then Lichess sends 13. Qf3, played by the user as Black
    const board = new GameBoard(START_FEN);
    ("d2d4 g8f6 c2c4 c7c5 d4d5 g7g6 b1c3 f8g7 e2e4 d7d6 f1d3 e8g8 g1e2 e7e6 e1g1 e6d5 e4d5 b8d7 c1g5 d7e5 f2f4 e5d3 "
      + "d1d3 c8f5").split(" ").forEach((uci) => { board.playUci(uci); });
    const before = board.fen;
    board.playUci("d3f3");
    const after = board.fen;
    const fromLichess: Game = { ...makeGame(), ...makeUpdatePayload(board, true) };
    board.playUci("f5g4");
    const afterBg4 = board.fen;
    // An arm reaching over f5, which the model reads as empty
    const armOverF5 = (fen: string) => {
      const state = oneHotState(fen);
      state[SQUARE_MAP.f5] = state[SQUARE_MAP.f5].map((_, label) => (label === EMPTY) ? 0.999 : 0.001 / 12);
      return state;
    };

    it("sends nothing, however long the board showed 13. Qf3", () => {
      for (const shownFor of [1, 3, 10, 30]) {
        const game = run(new PlayTracker(), fromLichess, [oneHotState(before), 1], [armOverF5(after), shownFor],
          [armOverF5(before), 3], [oneHotState(after), 2]);
        expect(game.moves).toBe(fromLichess.moves);
      }
    });

    it("sends nothing while the board still shows the position before, with an arm over f5", () => {
      expect(run(new PlayTracker(), fromLichess, [armOverF5(before), 8]).moves).toBe(fromLichess.moves);
    });

    it("sends the user's move once played", () => {
      const game = run(new PlayTracker(), fromLichess, [oneHotState(before), 1], [armOverF5(after), 1],
        [armOverF5(before), 3], [oneHotState(after), 2], [oneHotState(afterBg4), 3]);
      expect(game.moves).toBe(`${fromLichess.moves} Bg4`);
    });
  });

  describe("with a misread that lasts", () => {
    // 1. d4 Nf6 2. Nf3 d5 3. Bf4 e6 4. e3 c5, with the user playing White, then 5. Nbd2 Nc6 from Lichess
    const board = new GameBoard(START_FEN);
    ["d2d4", "g8f6", "g1f3", "d7d5", "c1f4", "e7e6", "e2e3", "c7c5"].forEach((uci) => { board.playUci(uci); });
    const start: Game = { ...makeGame(), ...makeUpdatePayload(board) };
    const beforeNbd2 = oneHotState(board.fen);
    board.playUci("b1d2");
    const afterNbd2 = board.fen;
    board.playUci("b8c6");
    const afterNc6 = board.fen;
    const fromLichess: Game = { ...makeGame(), ...makeUpdatePayload(board, true) };
    // The model reads the pawn on e3 as on e4, as if 6. e4 were played
    const misread = (fen: string) => {
      const state = oneHotState(fen);
      const pawn = state[SQUARE_MAP.e3];
      state[SQUARE_MAP.e3] = state[SQUARE_MAP.e4];
      state[SQUARE_MAP.e4] = pawn;
      return state;
    };
    const replies = (misreadTime: number) => {
      const tracker = new PlayTracker({ misreadTime });
      // 5. Nbd2 is sent, then the misread lasts two minutes while the opponent thinks
      const sent = run(tracker, start, [beforeNbd2, 2], [oneHotState(afterNbd2), 3], [misread(afterNbd2), 120]);
      expect(sent.moves).toMatch(/5\. Nbd2$/);
      return run(tracker, fromLichess, [misread(afterNc6), 10]).moves;
    };

    it("sends it as a move without learning misreads", () => {
      expect(replies(0)).toMatch(/Nc6 6\. e4$/);
    });

    it("sends nothing once it has learnt the misread", () => {
      expect(replies(60)).toBe(fromLichess.moves);
    });
  });
});
