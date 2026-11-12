import { describe, expect, it } from "vitest";
import { makeBoard } from "./chess/board.js";
import { keptTimes, makePgn, makeUpdatePayload, newGame, updateTimes } from "./game.js";
import { makeGame } from "./test/helpers.js";
import type { Game } from "./types.js";

// The game after `moves`, timed by `times`, as the recorder keeps it
const timedGame = (moves: string, times: number[]): Game => ({ ...makeGame(moves), times });

describe("makeBoard", () => {
  it("replays the stored moves", () => {
    const board = makeBoard(makeGame("1. e4 e5 2. Nf3"));
    expect(makeUpdatePayload(board)).toMatchObject({
      moves: "1. e4 e5 2. Nf3",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      lastMove: "g1f3"
    });
  });

  it("records SAN for UCI moves", () => {
    const board = makeBoard(makeGame("1. e4 e5"));
    board.playUci("g1f3");
    expect(board.history[board.history.length - 1].san).toBe("Nf3");
  });

  it("rejects malformed UCI and illegal SAN", () => {
    const board = makeBoard(makeGame());
    expect(board.playUci("zz")).toBeNull();
    expect(board.playSan("Qxh7")).toBeNull();
    expect(board.playUci("e2e5")).toBeNull();
    expect(board.history).toHaveLength(0);
  });

  it("undoes the last move", () => {
    const board = makeBoard(makeGame("1. e4 e5 2. Nf3"));
    board.undo();
    expect(makeUpdatePayload(board)).toMatchObject({
      moves: "1. e4 e5",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      lastMove: "e7e5"
    });
  });
});

describe("makeUpdatePayload", () => {
  it("numbers a first move by black", () => {
    const board = makeBoard(makeGame("", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"));
    board.playSan("e5");
    board.playSan("Nf3");
    expect(makeUpdatePayload(board).moves).toBe("1... e5 2. Nf3");
  });
});

describe("makePgn", () => {
  const roster = (result: string) => [
    '[Event "?"]',
    '[Site "?"]',
    '[Date "????.??.??"]',
    '[Round "?"]',
    '[White "?"]',
    '[Black "?"]',
    `[Result "${result}"]`
  ].join("\n");

  it("writes the standard tags and move text", () => {
    expect(makePgn(makeGame("1. e4 e5"))).toBe(`${roster("*")}\n\n1. e4 e5 *\n`);
  });

  it("adds SetUp and FEN for a custom start position", () => {
    const start = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(makePgn(makeGame("1... e5 2. Nf3", start))).toBe(
      `${roster("*")}\n[SetUp "1"]\n[FEN "${start}"]\n\n1... e5 2. Nf3 *\n`
    );
  });

  it("records the result of a finished game", () => {
    expect(makePgn(makeGame("1. f3 e5 2. g4 Qh4#"))).toBe(`${roster("0-1")}\n\n1. f3 e5 2. g4 Qh4# 0-1\n`);
  });

  it("overrides and adds headers, escaping quotes", () => {
    const pgn = makePgn(makeGame("1. e4"), { White: 'Bob "the Bishop"', Annotator: "ChessCam" });
    expect(pgn).toContain('[White "Bob \\"the Bishop\\""]');
    expect(pgn).toContain('[Annotator "ChessCam"]\n\n1. e4 *\n');
  });

  it("handles a game with no moves", () => {
    expect(makePgn(makeGame())).toBe(`${roster("*")}\n\n*\n`);
  });

  it("writes the time each move took, in whole seconds", () => {
    const pgn = makePgn({ ...makeGame("1. e4 e5 2. Nf3"), times: [4400, 65600, 3725000] });
    expect(pgn).toBe(`${roster("*")}\n\n1. e4 { [%emt 0:00:04] } e5 { [%emt 0:01:01] } ` +
      "2. Nf3 { [%emt 1:00:59] } *\n");
  });
});


describe("updateTimes", () => {
  it("times only the new moves", () => {
    expect(updateTimes(timedGame("1. e4", [1000]), "1. e4 e5", 3000)).toEqual([1000, 3000]);
  });

  it("retimes a move that is replaced, but not one that is kept", () => {
    expect(updateTimes(timedGame("1. e4", [1000]), "1. e4", 2000)).toEqual([1000]);
    expect(updateTimes(timedGame("1. e4 e6", [1000, 3000]), "1. e4 e5", 4000)).toEqual([1000, 4000]);
  });

  it("times a corrected move from when it was seen, never before the move before it", () => {
    // At 9s the tracker finds e5 was played instead of e6, seen 7s ago, and Nf3 8s ago: both before e4's 3s, so 3s
    const game = timedGame("1. e4 e6", [3000, 3000]);
    expect(updateTimes(game, "1. e4 e5 2. Nf3", 9000, [null, 7000, 8000])).toEqual([3000, 3000, 3000]);
    expect(updateTimes(timedGame("1. e4 e5 2. Nf3", [3000, 3000, 3000]), "1. e4 e5 2. Nf3 Nc6", 12000,
      [null, null, null, 1500])).toEqual([3000, 3000, 3000, 10500]);
  });

  it("leaves the game untimed without an elapsed time", () => {
    expect(updateTimes(timedGame("1. e4", [1000]), "1. e4 e5")).toEqual([]);
  });
});

describe("keptTimes", () => {
  it("keeps the times of the moves still played, from the start", () => {
    const game = timedGame("1. e4 e5 2. Nf3", [1000, 2000, 3000]);
    expect(keptTimes(game, "1. e4 e5")).toEqual([1000, 2000]);
    expect(keptTimes(game, "1. e4 c5 2. Nf3")).toEqual([1000]);
    expect(keptTimes(game, "")).toEqual([]);
  });
});

describe("newGame", () => {
  it("starts from the given position, or the standard one", () => {
    expect(newGame()).toEqual(makeGame());
    const start = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
    expect(newGame(start)).toMatchObject({ start, fen: start, moves: "" });
  });
});
