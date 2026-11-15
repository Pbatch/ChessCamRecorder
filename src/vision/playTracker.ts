import type { Position } from "../rules/position.js";
import { GameBoard, makeBoard } from "../chess/board.js";
import { getMovesPairs } from "../chess/moves.js";
import { EMPTY, NUM_LABELS, pieceToLabel } from "../constants.js";
import type { TrackedGame } from "../types.js";
import type { BeamMove, MoveTracker } from "./beamTracker.js";
import {
  type BayesianOptions, DEFAULT_BAYESIAN_OPTIONS, frameLogs, MAX_INTERVAL, REFERENCE_INTERVAL
} from "./bayesianTracker.js";

// Reads the user's move off the board in play mode, where it goes to Lichess as soon as it is shown and can't be
// taken back, and the opponent's moves come from Lichess, which the user copies onto the board.
//
// Between the opponent's moves there is only one move to find, the user's, so it keeps a probability for each state
// the board may be in, from the position after the opponent's last move:
//   behind: the board doesn't show the opponent's move yet, as the user has still to copy it over
//   caught up: it does, and the user hasn't moved
//   one for each move the user may play
// Each frame a little of each state's share moves on (behind to caught up, as the user copies the move; caught up to
// a move, as the user plays it) and a little moves back (a move to caught up, as a piece is picked up again; caught
// up to behind, as the board goes back, or seems to with an arm over it). Then each is weighed by how well it explains
// the frame. A move is shown once each frame's evidence for it has stayed above minEvidence for `hold` seconds, and
// then nothing more until the game changes, as the opponent's reply comes from Lichess.
//
// Following the board a move behind is what keeps a board that hasn't caught up from being read as the user's move:
// after 13. Qf3 with the queen still on d3 and an arm over f5, 13... Bd3 explains f5, but behind explains d3 and f3
// too. And as it can come back at any time, a board that seems to catch up and then goes back is read as behind again.
//
// The model's mistakes are not independent from frame to frame: it can read a piece on the square next to it for
// minutes, which would add up to a move that was never played. So each square learns what the model reads it as, for
// each piece on it, from frames of a position the tracker is sure of (caught up, behind, or after the user's move
// while it waits for the opponent's), and a frame is weighed by how likely it is given what the model reads. Until a
// square has been misread for a while, it is weighed as read.
//
// Promotions to each piece are weighed as one move, as the model often can't tell the new pieces apart, and the
// piece with the largest share is shown (the queen, on a tie), as in BayesianTracker.

export interface PlayOptions extends Pick<BayesianOptions, "moveChance" | "temperature" | "floor" | "evidenceWeight"> {
  // Chance that a state moves back, per REFERENCE_INTERVAL: a move to caught up, or caught up to behind
  backChance: number,
  // The evidence for a move each frame must give, per REFERENCE_INTERVAL, against caught up, and for how long, in
  // seconds, to show it. As a move's share can always move back, it levels off at about
  // 1 - backChance * e^-evidence, so this is a share of 1 - backChance * e^-minEvidence held for the hold.
  minEvidence: number,
  hold: number,
  // Seconds over which each square learns what the model reads it as, for each piece on it, from frames whose
  // position the tracker is sure of, so a misread that lasts (a piece read on a square next to it) counts as no
  // evidence for a move. 0 learns nothing.
  misreadTime: number
}

// Set by replaying 58 YunkerChess games the model was never trained on, as each side, in play mode (ChessCam's
// dev/replay.mjs --play --minGap 5): the 43 of ChessCamResearch's tracking_benchmark, and 15 in none of the dataset's
// splits. It starts from play mode's beam settings (evidenceWeight 0.4, and the other modes' temperature, floor and
// moveChance), and prefers a move never sent to one sent wrong, as Lichess can't take a move back. Of the 1684 moves
// scored, it sends 8 wrong, 62 not within 5s, with 76 of 114 games perfect and a median delay of 1.9s (90th percentile
// 2.4s). Without learning misreads, it sent 19 wrong, 37 not, at minEvidence 1.1, and 14, 49 at 1.6; learning over 30s
// sent 11, 50 at 1.1 and 7, 74 at 1.6, and over 15s, 6, 90 at 1.6. The beam sent 10 wrong, 7 not, of the 1206 moves
// of the 43 benchmark games, where these settings send 2, 26.
//
// Learning misreads stops one that lasts minutes from being sent after each of the opponent's moves, but it can learn
// the user's own move if it is quick, leaving it unsent. Most of the wrong moves left are a move to the square next to
// the one played (Kd7 for Kf7, Be3 for Bd2), which a higher minEvidence stops instead.
//
// The threshold of 1 - backChance * e^-minEvidence (0.9994 here) is what the share must reach: much above what each
// frame's evidence gives, a move is never sent. Without learning, on the 43 benchmark games, a threshold of 0.9999 with
// backChance 0.001 (minEvidence 2.3) sent 2 wrong but left 39 unsent, and with the model's output softened
// (temperature 4, then 5) 396, then 1181.
//
// A frame read turned round (BayesianTracker's flipChance), a move straight from behind for the user copying the
// opponent's move and playing theirs between two frames, and starting with behind at 0.1 or 0.9 instead of 0.5 made
// no difference on the benchmark games, so are left out.
export const DEFAULT_PLAY_OPTIONS: PlayOptions = {
  moveChance: DEFAULT_BAYESIAN_OPTIONS.moveChance, temperature: DEFAULT_BAYESIAN_OPTIONS.temperature,
  floor: DEFAULT_BAYESIAN_OPTIONS.floor, evidenceWeight: 0.4, backChance: 0.003, minEvidence: 1.6, hold: 1,
  misreadTime: 60
};

// How sure of a position the tracker must be to learn the model's misreads from a frame
const LEARN_SHARE = 0.99;

// A state other than caught up: the squares it changes from the position after the opponent's move, and the label each
// ends with
interface State {
  squares: number[],
  labels: number[]
}

interface Move extends State {
  san: string,
  // Promotions to each piece of the same pawn move share a group
  group: number
}

export class PlayTracker implements MoveTracker {
  readonly #options: PlayOptions;
  // The game this tracker looks on from, as the app's game had it; null until the first frame
  #known: string | null = null;
  #start: string = "";
  #root: number[] = [];
  #behind: State | null = null;
  #moves: Move[] = [];
  #groupCount = 0;
  // The shares of caught up, behind (0 when there is none) and each move
  #caughtUp = 1;
  #behindShare = 0;
  #belief = new Float64Array(0);
  #logs = new Float64Array(64 * NUM_LABELS);
  // Each square's log-probability of the frame given each label on it, with the misreads learnt
  #likely = new Float64Array(64 * NUM_LABELS);
  // For each square and label on it, by square * NUM_LABELS + label, what the model reads it as, learnt from frames
  // whose position the tracker is sure of. Kept over the game, as a misread may last several moves.
  #misreads = new Map<number, Float64Array>();
  // The labels on each square once the user's move is shown
  #doneLabels: number[] = [];
  #lastTime: number | null = null;
  // The group above the threshold, and since when, in ms
  #leader = -1;
  #since = 0;
  // Whether the user's move has been shown, after which nothing more is until the game changes
  #done = false;

  constructor(options: Partial<PlayOptions> = {}) {
    this.#options = { ...DEFAULT_PLAY_OPTIONS, ...options };
  }

  // `update` is a 64x13 state in square order for one frame, `now` its time in ms, and `game` the game as it is now.
  // Returns the game to show, if it changed.
  update(update: number[][], now: number, game: TrackedGame): BeamMove | null {
    if (this.#known === null || game.start !== this.#start || game.moves !== this.#known) {
      this.#restart(game);
    }
    const interval = (this.#lastTime === null) ? REFERENCE_INTERVAL
      : Math.min(Math.max(now - this.#lastTime, 0), MAX_INTERVAL);
    this.#lastTime = now;
    const n = this.#moves.length;
    const { temperature, floor } = this.#options;
    const logs = this.#logs;
    frameLogs(update, temperature, floor, logs);
    if (this.#done || n === 0) {
      if (this.#done) this.#learn(update, this.#doneLabels, interval);
      return null;
    }
    const steps = interval / REFERENCE_INTERVAL;
    const scaled = (chance: number) => 1 - (1 - chance) ** steps;
    const forward = scaled(this.#options.moveChance);
    const back = scaled(this.#options.backChance);
    const evidenceWeight = this.#options.evidenceWeight * steps;

    // A little of each state's share moves on, and a little back
    const hasBehind = this.#behind !== null;
    const belief = this.#belief;
    let movesShare = 0;
    for (let i = 0; i < n; i++) movesShare += belief[i];
    const caughtUp = this.#caughtUp;
    const behind = this.#behindShare;
    const toMove = caughtUp * forward / n;
    for (let i = 0; i < n; i++) {
      belief[i] = belief[i] * (1 - back) + toMove;
    }
    let nextCaughtUp = caughtUp * (1 - forward - (hasBehind ? back : 0)) + behind * forward + movesShare * back;
    let nextBehind = hasBehind ? behind * (1 - forward) + caughtUp * back : 0;

    // Each state weighed by how well it explains the frame, against caught up
    const likely = this.#likely;
    likely.set(logs);
    for (const [key, read] of this.#misreads) {
      // The frame given this label: as each label the model reads it as, weighed by how often it does
      const row = key - (key % NUM_LABELS);
      let sum = 0;
      for (let label = 0; label < NUM_LABELS; label++) sum += read[label] * Math.exp(logs[row + label]);
      likely[key] = Math.log(sum);
    }
    const root = this.#root;
    const evidence = (state: State): number => {
      let sum = 0;
      for (let k = 0; k < state.squares.length; k++) {
        const square = state.squares[k];
        sum += likely[square * NUM_LABELS + state.labels[k]] - likely[square * NUM_LABELS + root[square]];
      }
      return evidenceWeight * sum;
    };
    const moveEvidence = this.#moves.map(evidence);
    const behindEvidence = hasBehind ? evidence(this.#behind as State) : 0;
    const top = Math.max(0, behindEvidence, ...moveEvidence);
    nextCaughtUp *= Math.exp(-top);
    nextBehind *= Math.exp(behindEvidence - top);
    let total = nextCaughtUp + nextBehind;
    for (let i = 0; i < n; i++) {
      belief[i] *= Math.exp(moveEvidence[i] - top);
      total += belief[i];
    }
    this.#caughtUp = nextCaughtUp / total;
    this.#behindShare = nextBehind / total;
    const groups = new Float64Array(this.#groupCount);
    for (let i = 0; i < n; i++) {
      belief[i] /= total;
      groups[this.#moves[i].group] += belief[i];
    }

    // The board's position, to learn the model's misreads from, when the tracker is sure of it
    if (this.#caughtUp > LEARN_SHARE) {
      this.#learn(update, root, interval);
    } else if (this.#behindShare > LEARN_SHARE && this.#behind !== null) {
      const labels = [...root];
      this.#behind.squares.forEach((square, k) => { labels[square] = (this.#behind as State).labels[k]; });
      this.#learn(update, labels, interval);
    }

    // The move to show, once its group has stayed above the threshold for the hold
    const threshold = 1 - back * Math.exp(-this.#options.minEvidence);
    let best = 0;
    for (let g = 1; g < groups.length; g++) {
      if (groups[g] > groups[best]) best = g;
    }
    if (groups[best] <= threshold) {
      this.#leader = -1;
      return null;
    }
    if (best !== this.#leader) {
      this.#leader = best;
      this.#since = now;
    }
    if (now - this.#since < 1000 * this.#options.hold) {
      return null;
    }
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (this.#moves[i].group === best && (pick === -1 || belief[i] > belief[pick])) pick = i;
    }
    this.#done = true;
    this.#doneLabels = [...root];
    this.#moves[pick].squares.forEach((square, k) => { this.#doneLabels[square] = this.#moves[pick].labels[k]; });
    const board = makeBoard({ moves: this.#known as string, start: this.#start });
    const times: (number | null)[] = board.history.map(() => null);
    board.playSan(this.#moves[pick].san);
    times.push(now);
    this.#known = board.moves;
    return { board, times };
  }

  // Looks on from the app's game, after the opponent's move from Lichess if it was one
  #restart(game: TrackedGame) {
    const board = makeBoard(game);
    this.#known = game.moves;
    this.#start = game.start;
    const position = board.position;
    this.#root = labelsOf(position);
    this.#behind = game.fromOpponent ? this.#behindState(board) : null;
    this.#moves = [];
    const groupOf = new Map<string, number>();
    const seen = new Set<string>();
    for (const { move1 } of getMovesPairs(position)) {
      if (seen.has(move1.uci)) continue;
      seen.add(move1.uci);
      const key = move1.uci.slice(0, 4);
      let group = groupOf.get(key);
      if (group === undefined) {
        group = groupOf.size;
        groupOf.set(key, group);
      }
      this.#moves.push({ san: move1.san, group, squares: [...move1.from, ...move1.to],
        labels: [...move1.from.map(() => EMPTY), ...move1.targets] });
    }
    this.#groupCount = groupOf.size;
    this.#belief = new Float64Array(this.#moves.length);
    // Just after the opponent's move, the board may show it or not, as the user may have copied it before Lichess
    // sent it to the app; the frames soon tell
    this.#caughtUp = (this.#behind === null) ? 1 : 0.5;
    this.#behindShare = (this.#behind === null) ? 0 : 0.5;
    this.#leader = -1;
    this.#done = false;
  }

  // Learns what the model reads each square as, from a frame of a position the tracker is sure of, `labels`, with
  // `update` the model's probabilities, unsoftened, as they show what it reads
  #learn(update: number[][], labels: number[], interval: number) {
    const time = this.#options.misreadTime;
    if (time <= 0) return;
    const rate = 1 - Math.exp(-interval / (1000 * time));
    for (let square = 0; square < 64; square++) {
      const key = square * NUM_LABELS + labels[square];
      let read = this.#misreads.get(key);
      if (read === undefined) {
        // Read as it is, until frames show otherwise
        read = new Float64Array(NUM_LABELS);
        read[labels[square]] = 1;
        this.#misreads.set(key, read);
      }
      let sum = 0;
      for (let label = 0; label < NUM_LABELS; label++) sum += update[square][label];
      for (let label = 0; label < NUM_LABELS; label++) {
        read[label] = (1 - rate) * read[label] + rate * update[square][label] / sum;
      }
    }
  }

  // Behind: each square the board's last move changed, as it was before it. Null if there is no last move.
  #behindState(board: GameBoard): State | null {
    if (board.history.length === 0) {
      return null;
    }
    const before = new GameBoard(board.start);
    board.history.slice(0, -1).forEach(({ san }) => { before.playSan(san); });
    const was = labelsOf(before.position);
    const squares: number[] = [];
    const labels: number[] = [];
    this.#root.forEach((label, square) => {
      if (label !== was[square]) {
        squares.push(square);
        labels.push(was[square]);
      }
    });
    return { squares, labels };
  }
}

const labelsOf = (position: Position): number[] => Array.from({ length: 64 }, (_, square) => {
  const piece = position.board.get(square);
  return (piece === undefined) ? EMPTY : pieceToLabel(piece);
});
