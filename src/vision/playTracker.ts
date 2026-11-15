import type { Position } from "../rules/position.js";
import { GameBoard, makeBoard } from "../chess/board.js";
import { getMovesPairs } from "../chess/moves.js";
import { EMPTY, NUM_LABELS, pieceToLabel } from "../constants.js";
import type { TrackedGame } from "../types.js";
import type { BeamMove, MoveTracker } from "./beamTracker.js";
import {
  type BayesianOptions, DEFAULT_BAYESIAN_OPTIONS, frameLogs, MAX_INTERVAL, mix, REFERENCE_INTERVAL
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
// the frame. A move is shown once its share has stayed above the threshold for `hold` seconds, and then nothing more
// until the game changes, as the opponent's reply comes from Lichess.
//
// Following the board a move behind is what keeps a board that hasn't caught up from being read as the user's move:
// after 13. Qf3 with the queen still on d3 and an arm over f5, 13... Bd3 explains f5, but behind explains d3 and f3
// too. And as it can come back at any time, a board that seems to catch up and then goes back is read as behind again.
//
// Promotions to each piece are weighed as one move, as the model often can't tell the new pieces apart, and the
// piece with the largest share is shown (the queen, on a tie), as in BayesianTracker.

export interface PlayOptions extends Pick<BayesianOptions, "moveChance" | "temperature" | "floor" | "evidenceWeight"
  | "flipChance"> {
  // Chance that a state moves back, per REFERENCE_INTERVAL: a move to caught up, or caught up to behind
  backChance: number,
  // How sure the tracker must be of a move to show it, and for how long, in seconds
  threshold: number,
  hold: number
}

// Set by replaying the 43 benchmark games of ChessCamResearch's tracking_benchmark in play mode, as each side (ChessCam's
// dev/replay.mjs --play --tracker play --minGap 5), from play mode's beam settings (evidenceWeight 0.4, and the other
// modes' temperature, floor, moveChance and flipChance), preferring a move never sent to one sent wrong, as Lichess
// can't take a move back. Of the 1206 moves scored, it sends 6 wrong, 16 never, with 68 of 84 games perfect and a
// median delay of 1.75s (90th percentile 2.2s), against the beam's 10, 7, 74 and 1.45s (1.95s). The 6 are two misreads
// that last minutes, each sent after several of the opponent's moves; the beam also sent a promotion and two others.
// Holding 0.5s with backChance 0.001 sent 7 wrong, 7 never, in 1.25s.
//
// As a move can always go back, its share levels off at about 1 - backChance * e^-evidence, for a frame's evidence
// for it against caught up, so a move is shown once each frame's evidence has stayed above
// log(backChance / (1 - threshold)) for the hold: 1.1 here. Much above that, frames read less sure don't reach it:
// 0.9999 with backChance 0.001 (2.3) sent only 2 wrong, but left 39 unsent, and with the model's output softened
// (temperature 4, then 5) 396, then 1181; these settings left 22, then 39, sending 5, then 3, wrong.
export const DEFAULT_PLAY_OPTIONS: PlayOptions = {
  moveChance: DEFAULT_BAYESIAN_OPTIONS.moveChance, temperature: DEFAULT_BAYESIAN_OPTIONS.temperature,
  floor: DEFAULT_BAYESIAN_OPTIONS.floor, evidenceWeight: 0.4, flipChance: DEFAULT_BAYESIAN_OPTIONS.flipChance,
  backChance: 0.003, threshold: 0.999, hold: 1
};

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
    if (this.#done || n === 0) {
      return null;
    }
    const { temperature, floor, flipChance, threshold } = this.#options;
    const steps = interval / REFERENCE_INTERVAL;
    const scaled = (chance: number) => 1 - (1 - chance) ** steps;
    const forward = scaled(this.#options.moveChance);
    const back = scaled(this.#options.backChance);
    const evidenceWeight = this.#options.evidenceWeight * steps;

    // A little of each state's share moves on, and a little back. The user may copy the opponent's move and play
    // theirs between two frames, so behind also moves straight to each move, at the chance of both.
    const hasBehind = this.#behind !== null;
    const belief = this.#belief;
    let movesShare = 0;
    for (let i = 0; i < n; i++) movesShare += belief[i];
    const caughtUp = this.#caughtUp;
    const behind = this.#behindShare;
    const toMove = (caughtUp * forward + behind * forward * forward) / n;
    for (let i = 0; i < n; i++) {
      belief[i] = belief[i] * (1 - back) + toMove;
    }
    let nextCaughtUp = caughtUp * (1 - forward - (hasBehind ? back : 0)) + behind * forward + movesShare * back;
    let nextBehind = hasBehind ? behind * (1 - forward - forward * forward) + caughtUp * back : 0;

    // Each state weighed by how well it explains the frame, against caught up, upright or turned round as in
    // BayesianTracker
    const logs = this.#logs;
    frameLogs(update, temperature, floor, logs);
    const root = this.#root;
    let upright = 0;
    let turned = 0;
    for (let square = 0; square < 64; square++) {
      upright += logs[square * NUM_LABELS + root[square]];
      if (flipChance > 0) turned += logs[(63 - square) * NUM_LABELS + root[square]];
    }
    const uprightPrior = Math.log(1 - flipChance);
    const turnedPrior = Math.log(flipChance);
    const unchanged = (flipChance > 0) ? mix(uprightPrior + upright, turnedPrior + turned) : upright;
    const evidence = (state: State): number => {
      let sum = 0;
      let turnedSum = 0;
      for (let k = 0; k < state.squares.length; k++) {
        const square = state.squares[k];
        sum += logs[square * NUM_LABELS + state.labels[k]] - logs[square * NUM_LABELS + root[square]];
        turnedSum += logs[(63 - square) * NUM_LABELS + state.labels[k]]
          - logs[(63 - square) * NUM_LABELS + root[square]];
      }
      if (flipChance > 0) {
        sum = mix(uprightPrior + upright + sum, turnedPrior + turned + turnedSum) - unchanged;
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

    // The move to show, once its group has stayed above the threshold for the hold
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
