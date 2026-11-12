// Checks the rules against published perft counts, and SAN, FEN and PGN on hand-picked cases
import { describe, expect, it } from "vitest";
import { Board, makeBoardFen, parseBoardFen } from "./board.js";
import { emptySetup, makeFen, type Move, parseFen, Position } from "./position.js";
import { makeSan, parseSan, parseUci } from "./san.js";
import { makeClock, parseMoveText } from "./pgn.js";

// A move from UCI the test knows is well formed
const uci = (text: string): Move => {
  const move = parseUci(text);
  if (move === undefined) throw new Error(`Bad UCI: ${text}`);
  return move;
}

const perft = (pos: Position, depth: number): number => {
  const moves = pos.legalMoves();
  if (depth === 1) return moves.length;
  let total = 0;
  for (const move of moves) {
    const next = pos.clone();
    next.play(move);
    total += perft(next, depth - 1);
  }
  return total;
}

// From the Chess Programming Wiki's perft results, to depths that run in a few seconds
const PERFT: [string, string, number[]][] = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [20, 400, 8902, 197281]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
  ["position 3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["position 4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["position 4 mirrored", "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1", [6, 264, 9467]],
  ["position 5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]]
];

describe("perft", () => {
  it.each(PERFT)("counts the moves from the %s position", (_, fen, counts) => {
    const pos = Position.fromFen(fen);
    counts.forEach((count, i) => {
      expect(perft(pos, i + 1)).toBe(count);
    });
  });
});

describe("FEN", () => {
  it("reads and writes a FEN", () => {
    const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 3 17";
    expect(makeFen(parseFen(fen))).toBe(fen);
    expect(makeBoardFen(parseBoardFen(fen.split(" ")[0]) ?? Board.empty())).toBe(fen.split(" ")[0]);
  });

  it("fills in missing fields", () => {
    expect(makeFen(parseFen("8/8/8/8/8/8/8/K6k"))).toBe("8/8/8/8/8/8/8/K6k w - - 0 1");
  });

  it.each(["", "8/8/8/8/8/8/8 w - - 0 1", "9/8/8/8/8/8/8/8 w - - 0 1", "8/8/8/8/8/8/8/8 x - - 0 1",
    "8/8/8/8/8/8/8/8 w KX - 0 1", "8/8/8/8/8/8/8/8 w - e9 0 1", "8/8/8/8/8/8/8/8 w - - -1 1",
    "8/8/8/8/8/8/8/8 w - - 0 0"])("refuses %j", (fen) => {
    expect(() => parseFen(fen)).toThrow();
  });

  it("drops castling rights whose king or rook has gone, and an en passant square no pawn passed", () => {
    const pos = Position.fromFen("4k3/8/8/8/8/8/8/4K2R w KQkq e3 0 1");
    expect(pos.castling).toBe(1);
    expect(pos.epSquare).toBeUndefined();
  });

  it("writes the en passant square only when a pawn can take there", () => {
    const pos = Position.default();
    pos.play(uci("e2e4"));
    expect(pos.fen()).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    const ready = Position.fromFen("rnbqkbnr/ppp1pppp/8/8/3p4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3");
    ready.play(uci("e2e4"));
    expect(ready.fen()).toBe("rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3");
  });
});

describe("validate", () => {
  it.each([
    ["8/8/8/8/8/8/8/8 w - - 0 1", "empty"],
    ["8/8/8/8/8/8/8/4K3 w - - 0 1", "kings"],
    ["4k3/8/8/8/8/8/8/3KK3 w - - 0 1", "kings"],
    ["4k3/4R3/8/8/8/8/8/4K3 w - - 0 1", "opposite-check"],
    ["P3k3/8/8/8/8/8/8/4K3 w - - 0 1", "pawns-on-backrank"],
    ["4k3/8/8/8/8/8/8/4K2p w - - 0 1", "pawns-on-backrank"],
    ["4k3/4R3/8/8/8/8/8/4K3 b - - 0 1", null]
  ])("says %s is %s", (fen, reason) => {
    expect(Position.validate(parseFen(fen))).toBe(reason);
  });

  it("says an empty setup is empty", () => {
    expect(Position.validate(emptySetup())).toBe("empty");
  });
});

describe("SAN", () => {
  it("disambiguates by file, then rank, then both", () => {
    const pos = Position.fromFen("4k3/8/8/8/8/1N3N2/8/1N2K1N1 w - - 0 1");
    const san = (text: string) => makeSan(pos, uci(text));
    // Knights on b1, b3 and f3 reach d2: b1's rank is its own, f3's file is, and b3 shares both
    expect(san("b1d2")).toBe("N1d2");
    expect(san("f3d2")).toBe("Nfd2");
    expect(san("b3d2")).toBe("Nb3d2");
    expect(san("b3a5")).toBe("Na5");
  });

  it("reads loose SAN", () => {
    const pos = Position.default();
    expect(parseSan(pos, "Nf3!?")).toEqual(parseUci("g1f3"));
    expect(parseSan(pos, "e2")).toBeUndefined();
    expect(parseSan(pos, "Nd2")).toBeUndefined();
    const castle = Position.fromFen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1");
    expect(parseSan(castle, "0-0")).toEqual(parseUci("e1g1"));
    expect(parseSan(castle, "O-O-O+")).toEqual(parseUci("e1c1"));
    expect(parseSan(castle, "Kg1")).toBeUndefined();
  });

  it("refuses an ambiguous move or a missing promotion", () => {
    expect(parseSan(Position.fromFen("4k3/8/8/8/8/8/8/2N1K1N1 w - - 0 1"), "Ne2")).toBeUndefined();
    expect(parseSan(Position.fromFen("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1"), "b8")).toBeUndefined();
  });
});

describe("UCI", () => {
  it.each(["zz", "e2e9", "e7e8k", "e2e4q4"])("refuses %j", (uci) => {
    expect(parseUci(uci)).toBeUndefined();
  });
});

describe("parseMoveText", () => {
  it("reads the SAN from move text", () => {
    expect(parseMoveText("1. e4 e5 2.Nf3 {a comment} (2. Nc3 (2. f4)) Nc6 $1 3... Bb5 *")).toEqual(
      ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(parseMoveText("1... e5 2. Nf3 1-0")).toEqual(["e5", "Nf3"]);
    expect(parseMoveText("")).toEqual([]);
  });
});

describe("makeClock", () => {
  it("writes whole seconds as H:MM:SS", () => {
    expect(makeClock(4.4)).toBe("0:00:04");
    expect(makeClock(3725)).toBe("1:02:05");
    expect(makeClock(-3)).toBe("0:00:00");
  });
});
