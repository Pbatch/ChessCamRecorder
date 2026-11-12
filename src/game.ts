import { defaultGame, defaultHeaders, makeComment, makeOutcome, makePgn as writePgn, parsePgn } from "chessops/pgn";
import { type GameBoard, makeBoard } from "./chess/board.js";
import { START_FEN } from "./constants.js";
import type { Game } from "./types.js";

// Everything a move changes; the start position is kept, and the times worked out
export type GameUpdate = Omit<Game, "start" | "times">;

export const newGame = (start: string = START_FEN): Game => ({
  fen: start, moves: "", start, lastMove: "", fromOpponent: false, times: []
});

export const makeUpdatePayload = (board: GameBoard, fromOpponent: boolean = false): GameUpdate => ({
  moves: board.moves,
  fen: board.fen,
  lastMove: board.lastMove,
  fromOpponent
});

// The times of the moves `moves` shares with the game, from the start
export const keptTimes = (game: Game, moves: string): number[] => {
  const before = makeBoard(game).history;
  const after = makeBoard({ moves, start: game.start }).history;
  let kept = 0;
  while ((kept < Math.min(before.length, game.times.length)) && (before[kept].san === after[kept]?.san)) {
    kept += 1;
  }
  return game.times.slice(0, kept);
}

// Moves kept from before keep their times, so a move shown before it was confirmed is timed from when it was first
// seen. New moves are timed at `elapsed`, less how long ago each was seen (`ago`, ms, by index in the game),
// as a move the tracker corrects may have been played a few seconds before it was shown, and without `elapsed` the
// game is untimed.
export const updateTimes = (game: Game, moves: string, elapsed?: number, ago: (number | null)[] = []): number[] => {
  if (elapsed === undefined) {
    return [];
  }
  const times = keptTimes(game, moves);
  const after = makeBoard({ moves, start: game.start }).history;
  for (let i = times.length; i < after.length; i++) {
    // Never before the move before it
    times.push(Math.max(elapsed - (ago[i] ?? 0), times[i - 1] ?? 0));
  }
  return times;
}

// Full PGN for export, with the seven standard tags plus any extra headers, and with times, the
// time each move took as a [%emt] comment
export const makePgn = (game: Pick<Game, "moves" | "start"> & Partial<Pick<Game, "times">>,
  headers: Record<string, string> = {}): string => {
  const pgnGame = parsePgn(game.moves)[0] ?? defaultGame();
  const times: number[] = game.times ?? [];
  let index = 0;
  for (const node of pgnGame.moves.mainline()) {
    if (index < times.length) {
      // Whole seconds, as detection is only good to about a second
      const emt = Math.round((times[index] - (times[index - 1] ?? 0)) / 1000);
      node.comments = [makeComment({ emt: Math.max(0, emt) })];
    }
    index += 1;
  }
  pgnGame.headers = defaultHeaders();
  pgnGame.headers.set("Result", makeOutcome(makeBoard(game).position.outcome()));
  if (game.start !== START_FEN) {
    pgnGame.headers.set("SetUp", "1");
    pgnGame.headers.set("FEN", game.start);
  }
  for (const [key, value] of Object.entries(headers)) {
    pgnGame.headers.set(key, value);
  }
  return writePgn(pgnGame);
}
