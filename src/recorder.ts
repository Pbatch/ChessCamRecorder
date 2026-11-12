import { makeBoard } from "./chess/board.js";
import { START_FEN } from "./constants.js";
import { type RecorderError, toRecorderError } from "./errors.js";
import { keptTimes, makePgn, makeUpdatePayload, newGame, updateTimes } from "./game.js";
import type { CornerName, Game, Roi } from "./types.js";
import { BeamTracker, PLAY_BEAM_OPTIONS, PLAY_TRACKER_OPTIONS } from "./vision/beamTracker.js";
import { type Detection, getOrientation, type Model } from "./vision/model.js";
import { videoReady } from "./vision/video.js";

// How often the FPS reported updates, in ms
const FPS_INTERVAL = 1000;
// Detections per second of video, to spare the CPU and battery. Faster playback scales it, e.g. 16 FPS at 4x.
const DEFAULT_MAX_FPS = 4;

export interface RecorderOptions {
  model: Model,
  video: HTMLVideoElement,
  // The board's region of the video, in video pixels. Without one the whole frame is read, which only works when the
  // board fills it.
  roi?: Roi | null,
  // The start position as FEN, by default the standard one
  start?: string,
  // Whether to time each move, for [%emt] in the PGN
  timed?: boolean,
  // Whether to report only moves that are final, which can't be taken back. By default a move is reported as soon as
  // it's seen, and may be corrected a few seconds later (see onUpdate). Final moves come about 1.5 s after they are played, and
  // suit moves that go straight to an online game.
  finalMovesOnly?: boolean,
  // Detections a second at normal playback speed
  maxFps?: number,
  // The game, whenever the moves change. A later update may take back or replace recent moves, as the tracker corrects
  // a misread, so keep the whole game from each update rather than appending to it.
  onUpdate?: (game: Game) => void,
  // Each frame read, e.g. to clear an error shown after a failed frame
  onDetect?: (detection: Detection) => void,
  // The detection rate about once a second while running, and null once it stops
  onFps?: (fps: number | null) => void,
  // The board's corners, clockwise from the region's top left, when the board turns
  onOrientation?: (corners: CornerName[]) => void,
  // A frame failed; detection carries on with the next
  onError?: (error: RecorderError) => void
}

// The moves to set, e.g. after a takeback, a new game or a move from an online opponent
export interface GameChange {
  moves: string,
  start?: string,
  fromOpponent?: boolean,
  // The times to keep, if timed; by default the times of the moves the game still has
  times?: number[]
}

export interface Recorder {
  readonly game: Game,
  readonly running: boolean,
  // Starts or resumes reading the board. A pause counts as no time at all, for move times or for corrections.
  start: () => void,
  pause: () => void,
  setRoi: (roi: Roi | null) => void,
  setVideo: (video: HTMLVideoElement) => void,
  // Changes the game other than by the board; the tracker starts again from it, with its moves taken as final
  setGame: (change: GameChange) => void,
  // Starts a new game, and the tracker afresh, even if the game had no moves
  reset: (start?: string) => void,
  // The game so far as PGN, with any extra headers (e.g. White, Black, Event)
  pgn: (headers?: Record<string, string>) => string,
  // Stops for good
  destroy: () => void
}

const sameGame = (a: Pick<Game, "start" | "moves" | "fromOpponent">, b: Pick<Game, "start" | "moves" | "fromOpponent">) =>
  (a.start === b.start) && (a.moves === b.moves) && (a.fromOpponent === b.fromOpponent);

// Reads moves off a board in a video, a frame at a time, until destroyed. Starts paused: call start().
export const createRecorder = (options: RecorderOptions): Recorder => {
  const { model, timed = true, finalMovesOnly = false, maxFps = DEFAULT_MAX_FPS } = options;
  let video: HTMLVideoElement = options.video;
  let roi: Roi | null = options.roi ?? null;
  let game: Game = newGame(options.start ?? START_FEN);

  // Follows several ways the game may have gone, so a move can still be corrected a few seconds on. With final moves
  // only, it shows a move once it can't be taken back.
  const makeTracker = () => finalMovesOnly ? new BeamTracker(PLAY_TRACKER_OPTIONS, PLAY_BEAM_OPTIONS)
    : new BeamTracker();
  let tracker = makeTracker();
  let playing: boolean = false;
  let direction: number[] | null = null;
  let orientationKey: string = "";
  let requestId: number | undefined;
  // Detections started since the FPS was last reported, which is about once a second
  let fpsSince: number = 0;
  let fpsFrames: number = 0;
  let active = true;
  // When the next detection may start
  let nextRunTime: number = 0;
  // Whether the video has shown a frame that has not been detected yet. Browsers without
  // requestVideoFrameCallback cannot tell, so every frame counts as new.
  let frameVideo: HTMLVideoElement | null = null;
  let frameCallbackId: number | undefined;
  let newFrame: boolean = true;
  // A clock that stops while detection is paused, in ms. The tracker runs on it, so a pause neither counts as time
  // for its settings nor uses up the time a move can still be corrected in, and moves are timed on it, from where it
  // was when detection last started on a game without moves.
  let playClock: number = 0;
  // Whether detection was running at the last frame, to report when it stops
  let running: boolean = false;
  let lastTick: number | null = null;
  let recordStart: number = 0;

  const watchFrames = (next: HTMLVideoElement | null) => {
    if (next === frameVideo) {
      return;
    }
    if (frameVideo !== null && frameCallbackId !== undefined) {
      frameVideo.cancelVideoFrameCallback(frameCallbackId);
    }
    frameVideo = next;
    frameCallbackId = undefined;
    newFrame = true;
    if (next === null || typeof next.requestVideoFrameCallback !== "function") {
      return;
    }
    const onFrame = () => {
      newFrame = true;
      frameCallbackId = next.requestVideoFrameCallback(onFrame);
    }
    frameCallbackId = next.requestVideoFrameCallback(onFrame);
  }

  const stopped = () => {
    if (running) {
      options.onFps?.(null);
      fpsFrames = 0;
      running = false;
    }
  }

  const detectFrame = async (now: number) => {
    newFrame = (frameCallbackId === undefined);
    const minFrameTime: number = 1000 / (maxFps * (video.playbackRate || 1));
    // Steps by the interval, so the frames a display ticks on do not round the rate down,
    // but catches up by at most half an interval after a slow frame
    nextRunTime = Math.max(nextRunTime + minFrameTime, now + minFrameTime / 2);
    const startTime: number = performance.now();
    // The real rate, from start to start, so it shows the cap and any time between detections
    if (fpsFrames === 0) {
      fpsSince = startTime;
    } else if ((startTime - fpsSince) >= FPS_INTERVAL) {
      options.onFps?.(1000 * fpsFrames / (startTime - fpsSince));
      fpsSince = startTime;
      fpsFrames = 0;
    }
    fpsFrames += 1;

    const detection = await model.detect(video, roi);
    const { update, direction: newDirection } = detection;
    // A NaN would stay in the smoothed state for good, and no move scores above 0 against it
    if (!update.every((square) => square.every(Number.isFinite))) {
      console.warn("Skipped a frame with non-finite probabilities");
      return;
    }
    // Paused or destroyed while the frame was read
    if (!active || !playing) {
      return;
    }
    running = true;
    const elapsed = timed ? (playClock - recordStart) : undefined;
    const shown = tracker.update(update, playClock, game);
    if (shown !== null) {
      // A corrected move is timed from when it was played, which may be a few seconds back
      const ago = shown.times.map((time) => (time === null) ? null : playClock - time);
      const payload = makeUpdatePayload(shown.board);
      game = { ...payload, start: game.start, times: updateTimes(game, payload.moves, elapsed, ago) };
      options.onUpdate?.(game);
    }

    // The first frame starts the smoothed direction, so it does not wait to climb from zero
    if (newDirection?.every(Number.isFinite)) {
      // Smoothed, so a board near 45 degrees does not flicker between orientations
      direction = (direction === null) ? newDirection
        : direction.map((d, i) => 0.5 * d + 0.5 * newDirection[i]);
      const orientation = getOrientation(direction);
      if (orientation.join() !== orientationKey) {
        orientationKey = orientation.join();
        options.onOrientation?.(orientation);
      }
    }
    options.onDetect?.(detection);
  }

  const loop = async () => {
    try {
      watchFrames(video);
      const now: number = performance.now();
      if (!playing) {
        lastTick = null;
        if (game.lastMove === "") {
          recordStart = playClock;
        }
      } else {
        playClock += now - (lastTick ?? now);
        lastTick = now;
      }
      // The tracker keeps its ways the game may have gone over a pause. It starts again only when the game is
      // changed other than by it.
      if (!playing || !videoReady(video)) {
        stopped();
      } else if (newFrame && now >= nextRunTime) {
        await detectFrame(now);
      }
    } catch (error) {
      console.error("Piece detection failed", error);
      options.onError?.(toRecorderError(error));
    } finally {
      if (active) {
        requestId = requestAnimationFrame(() => {
          void loop();
        });
      }
    }
  }
  requestId = requestAnimationFrame(() => {
    void loop();
  });

  return {
    get game() {
      return game;
    },
    get running() {
      return running;
    },
    start: () => {
      playing = true;
    },
    pause: () => {
      playing = false;
    },
    setRoi: (next) => {
      roi = next;
    },
    setVideo: (next) => {
      video = next;
    },
    setGame: (change) => {
      const start: string = change.start ?? game.start;
      const fromOpponent: boolean = change.fromOpponent ?? false;
      if (sameGame(game, { start, moves: change.moves, fromOpponent })) {
        return;
      }
      const board = makeBoard({ moves: change.moves, start });
      // By default, the times of the moves the game still has
      const kept: number[] = (start === game.start) ? keptTimes(game, board.moves) : [];
      game = { ...makeUpdatePayload(board, fromOpponent), start, times: timed ? (change.times ?? kept) : [] };
    },
    reset: (start = game.start) => {
      game = newGame(start);
      tracker = makeTracker();
    },
    pgn: (headers = {}) => makePgn(game, headers),
    destroy: () => {
      active = false;
      playing = false;
      if (requestId !== undefined) {
        cancelAnimationFrame(requestId);
      }
      watchFrames(null);
    }
  };
}
