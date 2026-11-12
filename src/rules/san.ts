import { FILE_NAMES, makeSquare, parseSquare, type Role, roleOf, squareFile, squareRank } from "./board.js";
import type { Move, Position } from "./position.js";

const LETTERS: Record<Role, string> = { pawn: "", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K" };
const ROLES_BY_LETTER: Record<string, Role> = { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };

// e.g. e2e4, e7e8q, e1g1 for castling
export const makeUci = (move: Move): string =>
  makeSquare(move.from) + makeSquare(move.to) + ((move.promotion === undefined) ? "" : LETTERS[move.promotion].toLowerCase());

export const parseUci = (uci: string): Move | undefined => {
  const match = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/.exec(uci);
  if (match === null) {
    return undefined;
  }
  const move: Move = { from: parseSquare(match[1]) as number, to: parseSquare(match[2]) as number };
  if (match[3] !== undefined) {
    move.promotion = ROLES_BY_LETTER[match[3].toUpperCase()];
  }
  return move;
}

// The move in SAN, e.g. Nbd7, exd5, O-O, e8=Q+, Qh4#. The move must be legal.
export const makeSan = (pos: Position, move: Move): string => {
  const squares = pos.board.squares;
  const piece = squares[move.from];
  const role = roleOf(piece);
  let san: string;
  if (role === "king" && Math.abs(move.to - move.from) === 2) {
    san = (move.to > move.from) ? "O-O" : "O-O-O";
  } else {
    const capture = squares[move.to] !== 0 || (role === "pawn" && squareFile(move.from) !== squareFile(move.to));
    if (role === "pawn") {
      san = capture ? `${FILE_NAMES[squareFile(move.from)]}x` : "";
    } else {
      san = LETTERS[role];
      // Other pieces of the same kind that could go to the same square
      const others = pos.legalMoves().filter(({ from, to }) => to === move.to && from !== move.from && squares[from] === piece);
      if (others.length > 0) {
        const sameRank = others.some(({ from }) => squareRank(from) === squareRank(move.from));
        const sameFile = others.some(({ from }) => squareFile(from) === squareFile(move.from));
        if (sameRank || !sameFile) san += FILE_NAMES[squareFile(move.from)];
        if (sameFile) san += squareRank(move.from) + 1;
      }
      if (capture) san += "x";
    }
    san += makeSquare(move.to);
    if (move.promotion !== undefined) san += `=${LETTERS[move.promotion]}`;
  }
  const after = pos.clone();
  after.play(move);
  if (after.isCheck()) {
    san += (after.legalMoves().length === 0) ? "#" : "+";
  }
  return san;
}

const SAN = /^([NBRQK])?([a-h])?([1-8])?[-x]?([a-h][1-8])(?:=?([NBRQnbrq]))?$/;

// The legal move a SAN names, or undefined if it names none or more than one. Accepts O-O and 0-0, and check and
// annotation marks.
export const parseSan = (pos: Position, san: string): Move | undefined => {
  const text = san.replace(/[+#!?]+$/, "");
  const legal = pos.legalMoves();
  const squares = pos.board.squares;
  const castle = (text === "O-O" || text === "0-0") ? 2 : (text === "O-O-O" || text === "0-0-0") ? -2 : 0;
  if (castle !== 0) {
    return legal.find(({ from, to }) => roleOf(squares[from]) === "king" && to - from === castle);
  }
  const match = SAN.exec(text);
  if (match === null) {
    return undefined;
  }
  const role: Role = (match[1] === undefined) ? "pawn" : ROLES_BY_LETTER[match[1]];
  const file = (match[2] === undefined) ? undefined : FILE_NAMES.indexOf(match[2]);
  const rank = (match[3] === undefined) ? undefined : Number(match[3]) - 1;
  const to = parseSquare(match[4]) as number;
  const promotion = (match[5] === undefined) ? undefined : ROLES_BY_LETTER[match[5].toUpperCase()];
  const candidates = legal.filter((move) => move.to === to && squares[move.from] !== 0
    && roleOf(squares[move.from]) === role && move.promotion === promotion
    // A pawn's move names its file only when it captures
    && ((file === undefined) ? (role !== "pawn" || squareFile(move.from) === squareFile(to))
      : squareFile(move.from) === file)
    && (rank === undefined || squareRank(move.from) === rank)
    // Castling is only written O-O, never as the king's move
    && !(role === "king" && Math.abs(move.to - move.from) === 2));
  return (candidates.length === 1) ? candidates[0] : undefined;
}
