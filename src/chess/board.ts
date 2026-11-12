import { type Move, Position } from "../rules/position.js";
import { makeSan, makeUci, parseSan, parseUci } from "../rules/san.js";
import { parseMoveText } from "../rules/pgn.js";

type HistoryEntry = { move: Move; san: string };

const positionFromFen = (fen: string): Position => Position.fromFen(fen);

// A game from its start position, keeping the moves played so they can be numbered and undone
export class GameBoard {
  readonly start: string;
  readonly history: HistoryEntry[] = [];
  #position: Position;

  constructor(start: string) {
    this.start = start;
    this.#position = positionFromFen(start);
  }

  get position(): Position {
    return this.#position;
  }

  get fen(): string {
    return this.#position.fen();
  }

  // The last move in UCI, or "" before any move
  get lastMove(): string {
    return (this.history.length === 0) ? "" : makeUci(this.history[this.history.length - 1].move);
  }

  // Numbered SAN from the start position, e.g. "1... e5 2. Nf3"
  get moves(): string {
    const pos = positionFromFen(this.start);
    let text = "";
    this.history.forEach(({ move, san }, index) => {
      if (pos.turn === "white") {
        text += `${pos.fullmoves}. `;
      } else if (index === 0) {
        text += `${pos.fullmoves}... `;
      }
      text += `${san} `;
      pos.play(move);
    });
    return text.trim();
  }

  // Each play returns the move, or null if it is not legal here
  playSan(san: string): Move | null {
    const move = parseSan(this.#position, san);
    return (move === undefined) ? null : this.#play(move, san);
  }

  playUci(uci: string): Move | null {
    const move = parseUci(uci);
    if (move === undefined || !this.#position.isLegal(move)) {
      return null;
    }
    return this.#play(move, makeSan(this.#position, move));
  }

  undo() {
    if (this.history.pop() === undefined) {
      return;
    }
    this.#position = positionFromFen(this.start);
    for (const { move } of this.history) {
      this.#position.play(move);
    }
  }

  #play(move: Move, san: string): Move {
    this.history.push({ move, san });
    this.#position.play(move);
    return move;
  }
}

// The board for a game's start position and moves (numbered SAN, as a Game keeps them)
export const makeBoard = (game: { moves: string, start: string }): GameBoard => {
  const board = new GameBoard(game.start);
  for (const san of parseMoveText(game.moves)) {
    board.playSan(san);
  }
  return board;
}
