// Region of interest, in video pixels
export interface Roi {
  x: number,
  y: number,
  width: number,
  height: number
}

export type CornerName = "a8" | "h8" | "h1" | "a1";

// The squares a move (or a move and its reply) changes, and the label each ends with
export interface SquaresData {
  from: number[],
  to: number[],
  targets: number[]
}
// One move: its UCI (e.g. e2e4, e7e8q, castling as the king's move), which tells moves apart, and its squares
export interface MovesData extends SquaresData {
  uci: string
}
// A first move, which is shown in the game so also has its SAN, and a reply to it with what the two change together.
// Replies have no SAN, as working it out for every reply was most of the time spent making the pairs.
export interface MovesPair {
  move1: MovesData & { san: string },
  move2: MovesData | null,
  moves: SquaresData | null
}

export interface Game {
  // The position after the moves, as FEN
  fen: string,
  // Numbered SAN from the start position, e.g. "1. e4 e5 2. Nf3"
  moves: string,
  // The start position, as FEN
  start: string,
  // The last move in UCI, or "" before any move
  lastMove: string,
  // Whether the last move came from outside the board (e.g. an online opponent), not from the camera
  fromOpponent: boolean,
  // For a timed game, the ms since recording started at each move; otherwise empty
  times: number[]
}

// What the tracker needs to know of the game
export type TrackedGame = Pick<Game, "start" | "moves" | "fromOpponent">;
