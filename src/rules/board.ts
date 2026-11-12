// The pieces on the board. Squares are numbered 0 (a1) to 63 (h8), a1, b1, ..., h1, a2, ..., h8.

export type Color = "white" | "black";
export type Role = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
export type Square = number;
export type SquareName = `${"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"}${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

export interface Piece {
  readonly role: Role,
  readonly color: Color
}

export const ROLES: readonly Role[] = ["pawn", "knight", "bishop", "rook", "queen", "king"];
export const FILE_NAMES = "abcdefgh";

export const opposite = (color: Color): Color => (color === "white") ? "black" : "white";
export const squareFile = (square: Square): number => square & 7;
export const squareRank = (square: Square): number => square >> 3;
export const makeSquare = (square: Square): SquareName =>
  `${FILE_NAMES[squareFile(square)]}${squareRank(square) + 1}` as SquareName;
export const parseSquare = (name: string): Square | undefined => {
  if (!/^[a-h][1-8]$/.test(name)) {
    return undefined;
  }
  return FILE_NAMES.indexOf(name[0]) + 8 * (Number(name[1]) - 1);
}

// A piece as a number: 0 for an empty square, 1-6 white pawn to king, 7-12 black pawn to king
export const pieceCode = (piece: Piece): number => ROLES.indexOf(piece.role) + ((piece.color === "white") ? 1 : 7);
// One shared object per piece, so reading the board never allocates
export const PIECES: readonly (Piece | undefined)[] = [undefined, ...(["white", "black"] as const).flatMap((color) =>
  ROLES.map((role) => Object.freeze({ role, color })))];
export const roleOf = (code: number): Role => ROLES[(code - 1) % 6];
export const colorOf = (code: number): Color => (code <= 6) ? "white" : "black";
export const code = (role: Role, color: Color): number => ROLES.indexOf(role) + ((color === "white") ? 1 : 7);

export class Board {
  readonly squares: Int8Array;

  constructor(squares: Int8Array = new Int8Array(64)) {
    this.squares = squares;
  }

  static empty(): Board {
    return new Board();
  }

  get(square: Square): Piece | undefined {
    return PIECES[this.squares[square]];
  }

  has(square: Square): boolean {
    return this.squares[square] !== 0;
  }

  set(square: Square, piece: Piece) {
    this.squares[square] = pieceCode(piece);
  }

  take(square: Square): Piece | undefined {
    const piece = this.get(square);
    this.squares[square] = 0;
    return piece;
  }

  clone(): Board {
    return new Board(this.squares.slice());
  }
}

const FEN_LETTERS = "PNBRQKpnbrqk";

// The board part of a FEN, rank 8 first
export const makeBoardFen = (board: Board): string => {
  const ranks: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let text = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board.squares[8 * rank + file];
      if (piece === 0) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        text += empty;
        empty = 0;
      }
      text += FEN_LETTERS[piece - 1];
    }
    ranks.push((empty > 0) ? text + empty : text);
  }
  return ranks.join("/");
}

export const parseBoardFen = (text: string): Board | undefined => {
  const board = Board.empty();
  const ranks = text.split("/");
  if (ranks.length !== 8) {
    return undefined;
  }
  for (let i = 0; i < 8; i++) {
    let file = 0;
    for (const char of ranks[i]) {
      if (char >= "1" && char <= "8") {
        file += Number(char);
      } else {
        const letter = FEN_LETTERS.indexOf(char);
        if (letter === -1 || file > 7) {
          return undefined;
        }
        board.squares[8 * (7 - i) + file] = letter + 1;
        file += 1;
      }
    }
    if (file !== 8) {
      return undefined;
    }
  }
  return board;
}
