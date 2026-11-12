import {
  Board, type Color, code, colorOf, makeBoardFen, makeSquare, opposite, parseBoardFen, parseSquare, type Role, roleOf,
  type Square, squareFile, squareRank
} from "./board.js";

// A move from one square to another, with the piece a pawn promotes to. Castling is the king's move, e.g. e1 to g1.
export interface Move {
  from: Square,
  to: Square,
  promotion?: Role
}

// Everything a FEN says, before it is checked to be a legal position
export interface Setup {
  board: Board,
  turn: Color,
  // Bits: 1 white king's side, 2 white queen's side, 4 black king's side, 8 black queen's side
  castling: number,
  epSquare: Square | undefined,
  halfmoves: number,
  fullmoves: number
}

export const emptySetup = (): Setup => ({
  board: Board.empty(), turn: "white", castling: 0, epSquare: undefined, halfmoves: 0, fullmoves: 1
});

// Why a setup is not a legal position
export type IllegalSetup = "empty" | "kings" | "opposite-check" | "pawns-on-backrank";

export class IllegalSetupError extends Error {
  readonly reason: IllegalSetup;

  constructor(reason: IllegalSetup) {
    super(`Illegal position: ${reason}`);
    this.name = "IllegalSetupError";
    this.reason = reason;
  }
}

export class FenError extends Error {
  constructor(fen: string) {
    super(`Invalid FEN: ${fen}`);
    this.name = "FenError";
  }
}

export interface Outcome {
  // Undefined for a draw
  winner: Color | undefined
}

const WHITE_KING_SIDE = 1;
const WHITE_QUEEN_SIDE = 2;
const BLACK_KING_SIDE = 4;
const BLACK_QUEEN_SIDE = 8;
// The rights lost when a piece moves from or to each corner
const CORNER_RIGHTS: Record<number, number> = {
  0: WHITE_QUEEN_SIDE, 7: WHITE_KING_SIDE, 56: BLACK_QUEEN_SIDE, 63: BLACK_KING_SIDE
};

const PAWN = 0;
const KNIGHT = 1;
const BISHOP = 2;
const ROOK = 3;
const QUEEN = 4;
const KING = 5;
// Promotions in the order moves are listed
const PROMOTIONS: readonly Role[] = ["queen", "rook", "bishop", "knight"];

// The squares a step or a slide reaches from each square, in [file, rank] steps
const targets = (steps: [number, number][], slide: boolean): number[][][] => Array.from({ length: 64 }, (_, from) =>
  steps.map(([df, dr]) => {
    const squares: number[] = [];
    let file = squareFile(from) + df;
    let rank = squareRank(from) + dr;
    while (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
      squares.push(8 * rank + file);
      if (!slide) break;
      file += df;
      rank += dr;
    }
    return squares;
  }));
const KNIGHT_STEPS = targets([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]], false)
  .map((rays) => rays.flat());
const KING_STEPS = targets([[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]], false)
  .map((rays) => rays.flat());
const ROOK_RAYS = targets([[0, 1], [1, 0], [0, -1], [-1, 0]], true);
const BISHOP_RAYS = targets([[1, 1], [1, -1], [-1, -1], [-1, 1]], true);

// Piece codes: 1-6 white pawn to king, 7-12 black
const base = (color: Color): number => (color === "white") ? 1 : 7;

// Whether a piece of `by` attacks the square, on the board as `squares` has it
const isAttacked = (squares: Int8Array, square: Square, by: Color): boolean => {
  const b = base(by);
  const file = squareFile(square);
  // Pawns attack forwards, so a white attacker is below the square and a black one above
  const behind = (by === "white") ? -8 : 8;
  if (file > 0 && squares[square + behind - 1] === b + PAWN && square + behind - 1 >= 0) return true;
  if (file < 7 && squares[square + behind + 1] === b + PAWN && square + behind + 1 < 64) return true;
  for (const from of KNIGHT_STEPS[square]) {
    if (squares[from] === b + KNIGHT) return true;
  }
  for (const from of KING_STEPS[square]) {
    if (squares[from] === b + KING) return true;
  }
  for (const ray of ROOK_RAYS[square]) {
    for (const from of ray) {
      const piece = squares[from];
      if (piece === 0) continue;
      if (piece === b + ROOK || piece === b + QUEEN) return true;
      break;
    }
  }
  for (const ray of BISHOP_RAYS[square]) {
    for (const from of ray) {
      const piece = squares[from];
      if (piece === 0) continue;
      if (piece === b + BISHOP || piece === b + QUEEN) return true;
      break;
    }
  }
  return false;
}

const findKing = (squares: Int8Array, color: Color): Square => squares.indexOf(base(color) + KING);

const sameMove = (a: Move, b: Move) => (a.from === b.from) && (a.to === b.to) && (a.promotion === b.promotion);

// A standard chess position: the board, whose turn it is, castling rights, the en passant square and move counters
export class Position {
  board: Board;
  turn: Color;
  castling: number;
  // The square a pawn passed over on the last move, whether or not it can be taken there
  epSquare: Square | undefined;
  halfmoves: number;
  fullmoves: number;

  private constructor(setup: Setup) {
    this.board = setup.board;
    this.turn = setup.turn;
    this.castling = setup.castling;
    this.epSquare = setup.epSquare;
    this.halfmoves = setup.halfmoves;
    this.fullmoves = setup.fullmoves;
  }

  static default(): Position {
    return Position.fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  }

  // Why the setup is not a legal position, if it isn't
  static validate(setup: Setup): IllegalSetup | null {
    const squares = setup.board.squares;
    if (squares.every((piece) => piece === 0)) return "empty";
    const kings = (color: Color) => squares.filter((piece) => piece === base(color) + KING).length;
    if (kings("white") !== 1 || kings("black") !== 1) return "kings";
    const other = opposite(setup.turn);
    if (isAttacked(squares, findKing(squares, other), setup.turn)) return "opposite-check";
    for (let file = 0; file < 8; file++) {
      for (const square of [file, 56 + file]) {
        if (squares[square] === 1 + PAWN || squares[square] === 7 + PAWN) return "pawns-on-backrank";
      }
    }
    return null;
  }

  // The position, with castling rights and an en passant square the board can't have dropped. Throws an
  // IllegalSetupError if it is not a legal position.
  static fromSetup(setup: Setup): Position {
    const reason = Position.validate(setup);
    if (reason !== null) {
      throw new IllegalSetupError(reason);
    }
    const squares = setup.board.squares;
    let castling = 0;
    for (const [right, king, rook, color] of [[WHITE_KING_SIDE, 4, 7, "white"], [WHITE_QUEEN_SIDE, 4, 0, "white"],
      [BLACK_KING_SIDE, 60, 63, "black"], [BLACK_QUEEN_SIDE, 60, 56, "black"]] as const) {
      if ((setup.castling & right) && squares[king] === base(color) + KING && squares[rook] === base(color) + ROOK) {
        castling |= right;
      }
    }
    let epSquare = setup.epSquare;
    if (epSquare !== undefined) {
      // On the square behind a pawn that has just moved two squares
      const forward = (setup.turn === "white") ? 8 : -8;
      const valid = (squareRank(epSquare) === ((setup.turn === "white") ? 5 : 2)) && (squares[epSquare] === 0)
        && (squares[epSquare - forward] === base(opposite(setup.turn)) + PAWN) && (squares[epSquare + forward] === 0);
      epSquare = valid ? epSquare : undefined;
    }
    return new Position({ ...setup, board: setup.board.clone(), castling, epSquare });
  }

  static fromFen(fen: string): Position {
    return Position.fromSetup(parseFen(fen));
  }

  // The setup, with the en passant square only if a pawn can legally take there
  toSetup(): Setup {
    return {
      board: this.board.clone(), turn: this.turn, castling: this.castling, epSquare: this.legalEpSquare(),
      halfmoves: this.halfmoves, fullmoves: this.fullmoves
    };
  }

  fen(): string {
    return makeFen(this.toSetup());
  }

  clone(): Position {
    return new Position({ ...this, board: this.board.clone() });
  }

  isCheck(): boolean {
    const squares = this.board.squares;
    return isAttacked(squares, findKing(squares, this.turn), opposite(this.turn));
  }

  // Every legal move, by the square it is from, then the square it goes to (castling counts as going to the rook's
  // square), with promotions queen first
  legalMoves(): Move[] {
    const squares = this.board.squares;
    const us = this.turn;
    const them = opposite(us);
    const ours = base(us);
    const king = findKing(squares, us);
    const forward = (us === "white") ? 8 : -8;
    const startRank = (us === "white") ? 1 : 6;
    const lastRank = (us === "white") ? 7 : 0;
    const moves: Move[] = [];
    // Destinations from one square, with the square they sort by
    const dests: { to: Square, key: Square }[] = [];

    // Whether the move leaves the king safe, tried on the board and undone
    const safe = (from: Square, to: Square, captured: Square): boolean => {
      const piece = squares[from];
      const taken = squares[captured];
      const target = squares[to];
      squares[captured] = 0;
      squares[to] = piece;
      squares[from] = 0;
      const result = !isAttacked(squares, (from === king) ? to : king, them);
      squares[from] = piece;
      squares[to] = target;
      squares[captured] = taken;
      return result;
    }
    const isOurs = (piece: number) => piece >= ours && piece < ours + 6;
    const isTheirs = (piece: number) => piece !== 0 && !isOurs(piece);
    const add = (from: Square, to: Square, captured: Square = to, key: Square = to) => {
      if (safe(from, to, captured)) {
        dests.push({ to, key });
      }
    }

    for (let from = 0; from < 64; from++) {
      const piece = squares[from];
      if (!isOurs(piece)) continue;
      dests.length = 0;
      const role = piece - ours;
      if (role === PAWN) {
        const one = from + forward;
        if (squares[one] === 0) {
          add(from, one);
          const two = one + forward;
          if (squareRank(from) === startRank && squares[two] === 0) {
            add(from, two);
          }
        }
        for (const side of [-1, 1]) {
          const file = squareFile(from) + side;
          if (file < 0 || file > 7) continue;
          const to = one + side;
          if (isTheirs(squares[to])) {
            add(from, to);
          } else if (to === this.epSquare) {
            add(from, to, to - forward);
          }
        }
      } else if (role === KNIGHT || role === KING) {
        for (const to of (role === KNIGHT) ? KNIGHT_STEPS[from] : KING_STEPS[from]) {
          if (!isOurs(squares[to])) add(from, to);
        }
        if (role === KING) {
          this.#castlingMoves(from, add);
        }
      } else {
        const rays = (role === BISHOP) ? BISHOP_RAYS[from] : (role === ROOK) ? ROOK_RAYS[from]
          : [...ROOK_RAYS[from], ...BISHOP_RAYS[from]];
        for (const ray of rays) {
          for (const to of ray) {
            const target = squares[to];
            if (isOurs(target)) break;
            add(from, to);
            if (target !== 0) break;
          }
        }
      }
      dests.sort((a, b) => a.key - b.key);
      for (const { to } of dests) {
        if (role === PAWN && squareRank(to) === lastRank) {
          for (const promotion of PROMOTIONS) {
            moves.push({ from, to, promotion });
          }
        } else {
          moves.push({ from, to });
        }
      }
    }
    return moves;
  }

  #castlingMoves(from: Square, add: (from: Square, to: Square, captured?: Square, key?: Square) => void) {
    const squares = this.board.squares;
    const white = this.turn === "white";
    const them = opposite(this.turn);
    const home = white ? 4 : 60;
    if (from !== home || isAttacked(squares, home, them)) return;
    const rook = base(this.turn) + ROOK;
    // The king's side: f and g empty, and the king not passing through check on f
    if ((this.castling & (white ? WHITE_KING_SIDE : BLACK_KING_SIDE)) && squares[home + 3] === rook
      && squares[home + 1] === 0 && squares[home + 2] === 0 && !isAttacked(squares, home + 1, them)) {
      add(from, home + 2, home + 2, home + 3);
    }
    // The queen's side: b, c and d empty, and the king not passing through check on d
    if ((this.castling & (white ? WHITE_QUEEN_SIDE : BLACK_QUEEN_SIDE)) && squares[home - 4] === rook
      && squares[home - 1] === 0 && squares[home - 2] === 0 && squares[home - 3] === 0
      && !isAttacked(squares, home - 1, them)) {
      add(from, home - 2, home - 2, home - 4);
    }
  }

  isLegal(move: Move): boolean {
    return this.legalMoves().some((legal) => sameMove(legal, move));
  }

  // Plays a move, which must be legal
  play(move: Move) {
    const squares = this.board.squares;
    const { from, to } = move;
    const piece = squares[from];
    const role = roleOf(piece);
    const color = colorOf(piece);
    const ep = this.epSquare;
    this.epSquare = undefined;
    this.halfmoves += 1;
    if (squares[to] !== 0) {
      this.halfmoves = 0;
    }
    if (role === "pawn") {
      this.halfmoves = 0;
      if (to === ep) {
        squares[to + ((color === "white") ? -8 : 8)] = 0;
      } else if (Math.abs(to - from) === 16) {
        this.epSquare = (from + to) / 2;
      }
    } else if (role === "king") {
      this.castling &= (color === "white") ? ~(WHITE_KING_SIDE | WHITE_QUEEN_SIDE) : ~(BLACK_KING_SIDE | BLACK_QUEEN_SIDE);
      if (to - from === 2) {
        squares[from + 1] = squares[from + 3];
        squares[from + 3] = 0;
      } else if (from - to === 2) {
        squares[from - 1] = squares[from - 4];
        squares[from - 4] = 0;
      }
    }
    this.castling &= ~((CORNER_RIGHTS[from] ?? 0) | (CORNER_RIGHTS[to] ?? 0));
    squares[to] = (move.promotion === undefined) ? piece : code(move.promotion, color);
    squares[from] = 0;
    if (color === "black") {
      this.fullmoves += 1;
    }
    this.turn = opposite(color);
  }

  isCheckmate(): boolean {
    return this.isCheck() && this.legalMoves().length === 0;
  }

  isStalemate(): boolean {
    return !this.isCheck() && this.legalMoves().length === 0;
  }

  // Neither side has the pieces to mate, even with the other's help
  isInsufficientMaterial(): boolean {
    return this.#insufficient("white") && this.#insufficient("black");
  }

  #insufficient(color: Color): boolean {
    const squares = this.board.squares;
    const b = base(color);
    const own = (role: number) => squares.filter((piece) => piece === b + role).length;
    if (own(PAWN) + own(ROOK) + own(QUEEN) > 0) return false;
    const others = base(opposite(color));
    if (own(KNIGHT) > 0) {
      // A lone knight, against a king and only queens, can't mate
      return own(KNIGHT) + own(BISHOP) === 1
        && squares.every((piece) => piece === 0 || piece < others || piece >= others + 6
          || piece === others + KING || piece === others + QUEEN);
    }
    if (own(BISHOP) > 0) {
      // Bishops all on one colour, with no pawns or knights on the board at all
      let light = false;
      let dark = false;
      squares.forEach((piece, square) => {
        if (piece === 1 + BISHOP || piece === 7 + BISHOP) {
          if ((squareFile(square) + squareRank(square)) % 2 === 0) dark = true; else light = true;
        }
      });
      return !(light && dark) && squares.every((piece) => ![1 + PAWN, 7 + PAWN, 1 + KNIGHT, 7 + KNIGHT].includes(piece));
    }
    return true;
  }

  // The game's result, if it is over by checkmate, stalemate or insufficient material
  outcome(): Outcome | undefined {
    if (this.isCheckmate()) return { winner: opposite(this.turn) };
    if (this.isInsufficientMaterial() || this.isStalemate()) return { winner: undefined };
    return undefined;
  }

  legalEpSquare(): Square | undefined {
    const ep = this.epSquare;
    if (ep === undefined) return undefined;
    const pawn = base(this.turn) + PAWN;
    return this.legalMoves().some(({ from, to }) => to === ep && this.board.squares[from] === pawn) ? ep : undefined;
  }
}

const CASTLING_LETTERS: [number, string][] = [
  [WHITE_KING_SIDE, "K"], [WHITE_QUEEN_SIDE, "Q"], [BLACK_KING_SIDE, "k"], [BLACK_QUEEN_SIDE, "q"]
];

// Reads a FEN. Missing fields after the board take their usual values. Throws a FenError if it can't be read.
export const parseFen = (fen: string): Setup => {
  const fields = fen.trim().split(/\s+/);
  const board = parseBoardFen(fields[0]);
  const turn = fields[1] ?? "w";
  const castling = fields[2] ?? "-";
  const ep = fields[3] ?? "-";
  const halfmoves = Number(fields[4] ?? 0);
  const fullmoves = Number(fields[5] ?? 1);
  const epSquare = (ep === "-") ? undefined : parseSquare(ep);
  if (board === undefined || (turn !== "w" && turn !== "b") || !/^(-|K?Q?k?q?)$/.test(castling) || castling === ""
    || (ep !== "-" && epSquare === undefined) || !Number.isInteger(halfmoves) || halfmoves < 0
    || !Number.isInteger(fullmoves) || fullmoves < 1 || fields.length > 6) {
    throw new FenError(fen);
  }
  return {
    board, turn: (turn === "w") ? "white" : "black", epSquare, halfmoves, fullmoves,
    castling: CASTLING_LETTERS.reduce((rights, [right, letter]) => castling.includes(letter) ? rights | right : rights, 0)
  };
}

export const makeFen = (setup: Setup): string => {
  const castling = CASTLING_LETTERS.filter(([right]) => setup.castling & right).map(([, letter]) => letter).join("");
  return [makeBoardFen(setup.board), (setup.turn === "white") ? "w" : "b", castling || "-",
    (setup.epSquare === undefined) ? "-" : makeSquare(setup.epSquare), setup.halfmoves, setup.fullmoves].join(" ");
}
