// Checks the rules against published perft counts, and against chessops (a dev dependency only, never shipped) on
// random games
import { describe, expect, it } from "vitest";
import { Chess } from "chessops/chess";
import { makeFen as chessopsMakeFen, parseFen as chessopsParseFen } from "chessops/fen";
import { makeSan as chessopsMakeSan } from "chessops/san";
import { kingCastlesTo, makeUci as chessopsMakeUci } from "chessops/util";
import type { Move as ChessopsMove, Role as ChessopsRole } from "chessops/types";
import { Board, makeBoardFen, parseBoardFen } from "./board.js";
import { emptySetup, makeFen, type Move, parseFen, Position } from "./position.js";
import { makeSan, makeUci, parseSan, parseUci } from "./san.js";
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

// chessops' legal moves in the order the package lists them: by square from, then square to (castling as the king's
// move, sorted by the rook's square), promotions queen first
const chessopsMoves = (pos: Chess): string[] => {
  const ctx = pos.ctx();
  const moves: string[] = [];
  for (const [from, dests] of pos.allDests(ctx)) {
    for (const to of dests) {
      const piece = pos.board.get(from);
      if (piece?.role === "pawn" && (to < 8 || to >= 56)) {
        for (const promotion of ["queen", "rook", "bishop", "knight"] as ChessopsRole[]) {
          moves.push(chessopsMakeUci({ from, to, promotion }));
        }
      } else if (piece?.role === "king" && pos.board.get(to)?.color === pos.turn) {
        moves.push(chessopsMakeUci({ from, to: kingCastlesTo(pos.turn, (to % 8 < from % 8) ? "a" : "h") }));
      } else {
        moves.push(chessopsMakeUci({ from, to }));
      }
    }
  }
  return moves;
}

// A seeded random number generator (mulberry32), so failures can be replayed
const random = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// chessops stops counting the halfmove clock at 150
const capHalfmoves = (fen: string): string => {
  const fields = fen.split(" ");
  fields[4] = String(Math.min(Number(fields[4]), 150));
  return fields.join(" ");
}

// Plays random games from the start, favouring the moves that need special handling, and compares every position
const compareGames = (games: number, start: string, seed: number) => {
  const rand = random(seed);
  for (let game = 0; game < games; game++) {
    const ours = Position.fromFen(start);
    const theirs = Chess.fromSetup(chessopsParseFen(start).unwrap()).unwrap();
    for (let ply = 0; ply < 200; ply++) {
      const fen = chessopsMakeFen(theirs.toSetup());
      expect(capHalfmoves(ours.fen()), `game ${game} ply ${ply}`).toBe(fen);
      const expected = chessopsMoves(theirs);
      const moves = ours.legalMoves();
      expect(moves.map(makeUci), fen).toEqual(expected);
      expect(ours.isCheck(), fen).toBe(theirs.isCheck());
      expect(ours.outcome(), fen).toEqual(theirs.outcome());
      for (const move of moves) {
        const san = makeSan(ours, move);
        // chessops writes castling from the king's move to the rook
        const theirMove = parseUci(makeUci(move)) as ChessopsMove;
        const castle = theirs.board.get(move.from)?.role === "king" && Math.abs(move.to - move.from) === 2;
        const theirSan = chessopsMakeSan(theirs, castle
          ? { from: move.from, to: (move.to > move.from) ? move.from + 3 : move.from - 4 } : theirMove);
        expect(san, fen).toBe(theirSan);
        expect(parseSan(ours, san), `${fen} ${san}`).toEqual(move);
      }
      if (moves.length === 0) break;
      // Captures, promotions, castling and checks are twice as likely, so games reach them more often
      const special = moves.filter((move) => ours.board.has(move.to) || move.promotion !== undefined
        || /^O-O|\+|#|^[a-h]x/.test(makeSan(ours, move)));
      const pool = (special.length > 0 && rand() < 0.5) ? special : moves;
      const move = pool[Math.floor(rand() * pool.length)];
      ours.play(move);
      const castle = theirs.board.get(move.from)?.role === "king" && Math.abs(move.to - move.from) === 2;
      theirs.play(castle ? { from: move.from, to: (move.to > move.from) ? move.from + 3 : move.from - 4 }
        : parseUci(makeUci(move)) as ChessopsMove);
    }
  }
}

describe("against chessops", () => {
  it("agrees on every position, move and SAN in random games", () => {
    compareGames(60, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 1);
  }, 60000);

  it.each([...PERFT.slice(1).map(([name, fen]): [string, string] => [name, fen]),
    ["position 6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10"]
  ])("agrees on random games from the %s position", (_, fen) => {
    compareGames(10, fen, 2);
  }, 60000);

  it("agrees on endgames, where promotions and insufficient material come up", () => {
    compareGames(30, "4k3/1P4p1/8/3K4/8/8/5p2/8 w - - 0 1", 3);
    compareGames(30, "8/8/4k3/8/2B5/8/4K3/7n b - - 0 1", 4);
    compareGames(30, "8/8/4k3/8/2N5/8/4K3/6q1 w - - 0 1", 5);
  }, 60000);
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

  it("matches chessops on an empty setup", () => {
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
