import { GameBoard, makeBoard } from "../chess/board.js";
import { toUpdate } from "./model.js";
import { BeamTracker, type MoveTracker } from "./beamTracker.js";
import { PlayTracker } from "./playTracker.js";
import type { Game } from "../types.js";
import type { Color } from "../rules/board.js";
import { START_FEN } from "../constants.js";
import { makeUpdatePayload, newGame } from "../game.js";

// Runs saved model outputs through the move tracking, frame by frame as findPieces does, for the tests and for
// scoring the tracking on recorded games (ChessCam's dev/replay.mjs): replay as record and upload modes run it, and
// replayPlay as play mode does, with the opponent's moves from Lichess.

// The model's output per frame: 64 squares in FEN order, by 13 classes
const FRAME_SIZE: number = 64 * 13;

export interface TimedMove {
  uci: string,
  san: string,
  // When the move was first played, in seconds of video
  time: number
}

// Given each game shown, as it changes, whether to stop replaying there, e.g. once the game's true last move is
// shown, so moves made while the board is cleared afterwards can't replace it
export type Until = (moves: TimedMove[]) => boolean;

// The game shown as `sans`, from what was shown before: moves kept from before keep their times, as in the game store,
// and the others are played at `time`
const retime = (shown: TimedMove[], sans: string[], time: number): TimedMove[] => {
  let kept = 0;
  while (kept < Math.min(shown.length, sans.length) && shown[kept].san === sans[kept]) {
    kept += 1;
  }
  const replayed = new GameBoard(START_FEN);
  return sans.map((san, index) => {
    const played = replayed.playSan(san);
    const uci = replayed.lastMove;
    if (played === null) {
      throw new Error(`Replayed an illegal move, ${san}`);
    }
    return { uci, san, time: (index < kept) ? shown[index].time : time };
  });
}

// Replays a video's model outputs, one frame per 1 / fps seconds, through a tracker as findPieces runs it, from
// `start` seconds (when someone would start detection): the game is kept as the store keeps it, and each game the
// tracker shows replaces it. Returns the game shown at the end, with when each move was first played.
export const replay = (probs: Float32Array, fps: number, start: number = 0,
  tracker: MoveTracker = new BeamTracker(), until?: Until): TimedMove[] => {
  let shown: TimedMove[] = [];
  let game: Game = { moves: "", fen: START_FEN, start: START_FEN, lastMove: "", fromOpponent: false, times: [] };
  for (let i = Math.ceil(start * fps); i < probs.length / FRAME_SIZE; i++) {
    const update = toUpdate(probs.subarray(i * FRAME_SIZE, (i + 1) * FRAME_SIZE));
    if (!update.every((square) => square.every(Number.isFinite))) {
      continue;
    }
    const time = i / fps;
    const move = tracker.update(update, 1000 * time, game);
    if (move !== null) {
      const { board } = move;
      game = { ...game, moves: board.moves, fen: board.fen, lastMove: board.lastMove };
      shown = retime(shown, move.board.history.map(({ san }) => san), time);
      if (until?.(shown)) break;
    }
  }
  return shown;
}

// Seconds before the video shows each of the opponent's moves that Lichess sends it, by default: the time a player
// takes to see the move and copy it onto the board
const DEFAULT_LEAD = 2;
// Seconds replayed after the last true move, by default, for a move of the user's still to be sent
const DEFAULT_TAIL = 5;

export interface PlayReplayOptions {
  // The colour the user plays on the board; the other side's moves come from Lichess
  color: Color,
  // The true game from the standard start, as SAN, and when the video shows each move, in seconds
  truth: string[],
  truthTimes: number[],
  // Seconds before the video shows an opponent's move that Lichess sends it (see DEFAULT_LEAD)
  lead?: number,
  // When to start, in seconds of video, as in replay
  start?: number,
  // A PlayTracker by default
  tracker?: MoveTracker,
  // Seconds replayed after the last true move (see DEFAULT_TAIL)
  tail?: number
}

// A move the app sent Lichess: the ply it is for, as the index of its move in the game, and whether Lichess took it,
// which it does when it is the user's turn there and the app's game agrees with Lichess's up to it
export interface PlaySend {
  ply: number,
  san: string,
  time: number,
  accepted: boolean
}

export interface PlayReplay {
  sends: PlaySend[],
  // When Lichess sent each of the opponent's moves, in seconds of video, or null for the user's moves and moves
  // never sent
  received: (number | null)[]
}

// Replays a recorded game as play mode runs it, for scoring play mode: the user plays `color` on the board and the
// app sends each move it reads to Lichess, while the opponent's moves come from Lichess `lead` seconds before the
// video shows them, so the board is a move behind the game until the user has copied each one over, as in a real
// game. Lichess's game is taken to be the true one: it takes a wrong move the app sends, but then sends the opponent's
// true reply, which puts the app's game back on the true one, so each of the user's moves is scored on its own. An
// opponent's move comes no sooner than the move before it was sent, as the opponent can only reply to a move once
// they have it, and no later than the video shows it. A user's move the app never sends by then is skipped.
//
// The app's side follows findPieces and playSidebar: the tracker's moves go to the game, a move is sent when the
// game's last move is the user's, once for each game, and Lichess's moves change the game unless it already has them.
export const replayPlay = (probs: Float32Array, fps: number, options: PlayReplayOptions): PlayReplay => {
  const { color, truth, truthTimes, lead = DEFAULT_LEAD, start = 0, tail = DEFAULT_TAIL,
    tracker = new PlayTracker() } = options;
  // From the standard start, White plays the even plies
  const isUsers = (ply: number): boolean => ((ply % 2 === 0) ? "white" : "black") === color;
  let game: Game = newGame();
  // How many of the true game's moves Lichess has
  let held = 0;
  // When the app sent each of the user's moves that Lichess took, by ply
  const sentAt = new Map<number, number>();
  const sends: PlaySend[] = [];
  const received: (number | null)[] = truth.map(() => null);
  let lastSent = "";
  const end = (truthTimes.at(-1) ?? 0) + tail;
  for (let i = Math.ceil(start * fps); i < probs.length / FRAME_SIZE; i++) {
    const time = i / fps;
    if (time > end) break;
    while (held < truth.length) {
      if (isUsers(held)) {
        // Not sent by the time the video shows the reply, so the replay goes on without it
        if (held + 1 < truth.length && time >= truthTimes[held + 1]) {
          held += 1;
          continue;
        }
        break;
      }
      const previous = (held === 0) ? Number.NEGATIVE_INFINITY : (sentAt.get(held - 1) ?? Number.POSITIVE_INFINITY);
      const due = Math.min(truthTimes[held], Math.max(truthTimes[held] - lead, previous));
      if (time < due) break;
      game = sync(game, truth.slice(0, held + 1));
      received[held] = time;
      held += 1;
    }

    const update = toUpdate(probs.subarray(i * FRAME_SIZE, (i + 1) * FRAME_SIZE));
    if (!update.every((square) => square.every(Number.isFinite))) {
      continue;
    }
    const shown = tracker.update(update, 1000 * time, game);
    if (shown === null) {
      continue;
    }
    const { board } = shown;
    game = { ...game, ...makeUpdatePayload(board) };
    const ply = board.history.length - 1;
    if (ply < 0 || !isUsers(ply) || game.moves === lastSent) {
      continue;
    }
    lastSent = game.moves;
    const accepted = (ply === held) && board.history.slice(0, ply).every(({ san }, k) => san === truth[k]);
    sends.push({ ply, san: board.history[ply].san, time, accepted });
    if (accepted) {
      sentAt.set(ply, time);
      held += 1;
    }
  }
  return { sends, received };
}

// The game once Lichess sends the true moves `sans`, as gameSync makes it: unchanged if it already has them
const sync = (game: Game, sans: string[]): Game => {
  const local = makeBoard(game).history;
  if (local.length >= sans.length && sans.every((san, k) => local[k].san === san)) {
    return game;
  }
  const board = new GameBoard(START_FEN);
  for (const san of sans) {
    if (board.playSan(san) === null) {
      throw new Error(`The true game has an illegal move, ${san}`);
    }
  }
  return { ...game, ...makeUpdatePayload(board, true) };
}
