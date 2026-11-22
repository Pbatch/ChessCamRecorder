import { makeBoard } from "./chess/board.js";
import { START_FEN } from "./constants.js";
import { type RecorderError, toRecorderError } from "./errors.js";
import { keptTimes, makePgn, makeUpdatePayload, newGame, updateTimes } from "./game.js";
import type { CornerName, Game, Roi } from "./types.js";
import { BeamTracker, type MoveTracker } from "./vision/beamTracker.js";
import { PlayTracker } from "./vision/playTracker.js";
import { type Detection, getOrientation, type Model } from "./vision/model.js";
import { AutoCrop } from "./vision/autoCrop.js";
import { boardDirection, goodFit } from "./vision/board.js";
import { videoReady } from "./vision/video.js";

// How often the FPS reported updates, in ms
const FPS_INTERVAL = 1000;
// Detections per second of video, to spare the CPU and battery. Faster playback scales it, e.g. 16 FPS at 4x.
const DEFAULT_MAX_FPS = 4;

export interface RecorderOptions {
  model: Model,
  video: HTMLVideoElement,
  // The board's region of the video, in video pixels. Without one, a model that gives the squares' positions finds the
  // board and crops to it itself (see onRoi); other models read the whole frame, which only works when the board
  // fills it.
  roi?: Roi | null,
  // The start position as FEN, by default the standard one
  start?: string,
  // Whether to time each move, for [%emt] in the PGN
  timed?: boolean,
  // Whether the user plays one side against an online opponent (play mode): only the user's move is read off the
  // board, and only once it is certain, as it goes straight to the online game, which can't take it back (about 1.75 s
  // after it is played). The opponent's moves come from the online game: pass each with setGame and fromOpponent, and
  // the recorder reads the user's next move once the board shows it. By default every move is read, as soon as it's
  // seen, and may be corrected a few seconds later (see onUpdate).
  play?: boolean,
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
  // The region the recorder cropped to itself, when it changes (no region was given): null while it looks for the
  // board in the whole frame
  onRoi?: (roi: Roi | null) => void,
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
  // The board's region, or null to have the recorder find the board itself
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

// Waits between loop ticks, in ms, when no detection is due sooner, about as often as animation frames
const TICK_MS = 16;

// Ticks the loop from a worker's timer: a hidden page gets no animation frames and its own timers are throttled to
// once a second, but a worker's timers are not, so recording carries on while the tab is in the background
const createTicker = (onTick: () => void) => {
  const url = URL.createObjectURL(new Blob(["onmessage = (event) => setTimeout(() => postMessage(0), event.data)"]));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = onTick;
  return {
    after: (ms: number) => worker.postMessage(ms),
    stop: () => worker.terminate()
  };
}

// requestVideoFrameCallback only fires for frames the page shows, so while the tab is hidden or the app is in the
// background it stops, or (desktop Chrome) fires about once a second, though the video still has new frames to read.
// So a frame also counts as new when the video has decoded more frames since the last read, and after this long
// without either, every frame counts as new. Checking document.hidden instead misses some of these cases, e.g. a
// backgrounded Android Chrome with DevTools attached.
const FRAME_STALL_MS = 1000;

// Frames the video has decoded so far, or null where the browser doesn't count them
const decodedFrames = (video: HTMLVideoElement): number | null =>
  (typeof video.getVideoPlaybackQuality === "function") ? video.getVideoPlaybackQuality().totalVideoFrames : null;

const sameGame =(a: Pick<Game, "start" | "moves" | "fromOpponent">, b: Pick<Game, "start" | "moves" | "fromOpponent">) =>
  (a.start === b.start) && (a.moves === b.moves) && (a.fromOpponent === b.fromOpponent);

// Reads moves off a board in a video, a frame at a time, until destroyed. Starts paused: call start().
export const createRecorder = (options: RecorderOptions): Recorder => {
  const { model, timed = true, play = false, maxFps = DEFAULT_MAX_FPS } = options;
  let video: HTMLVideoElement = options.video;
  let roi: Roi | null = options.roi ?? null;
  let game: Game = newGame(options.start ?? START_FEN);

  // Follows several ways the game may have gone, so a move can still be corrected a few seconds on. In play mode, it
  // shows the user's move once it is certain, and the board may be behind the opponent's.
  const makeTracker = (): MoveTracker => play ? new PlayTracker() : new BeamTracker();
  let tracker = makeTracker();
  // The crop the recorder keeps itself, with no region given
  const autoCrop = new AutoCrop();
  let autoRoi: Roi | null = null;
  let playing: boolean = false;
  let direction: number[] | null = null;
  let orientationKey: string = "";
  // Counts the times the board was looked for afresh, so a frame read before then is not used after
  let resets: number = 0;
  // Looks for the board afresh, e.g. in a new video, whose board may be elsewhere and turned another way
  const resetAutoCrop = () => {
    resets += 1;
    autoCrop.reset();
    if (autoRoi !== null) {
      autoRoi = null;
      options.onRoi?.(null);
    }
    // Reported again from the next frame, even if it is the same
    direction = null;
    orientationKey = "";
  }
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
  // When requestVideoFrameCallback last fired, or the video was first watched
  let lastFrameTime: number = 0;
  // How many frames the video had decoded at the last read
  let readFrames: number | null = null;
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
    lastFrameTime = performance.now();
    if (next === null || typeof next.requestVideoFrameCallback !== "function") {
      return;
    }
    const onFrame = () => {
      newFrame = true;
      lastFrameTime = performance.now();
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
    readFrames = decodedFrames(video);
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

    const auto: boolean = (roi === null) && model.locates;
    const resetsBefore: number = resets;
    let detection = await model.detect(video, auto ? autoCrop.roi : roi);
    // The board was looked for afresh while the frame was read (e.g. a new video started), so the frame is of the old
    // one
    if (resets !== resetsBefore) {
      return;
    }
    // While looking for the board, a rough fit of the whole frame proposes a crop to read the frame again in, whose
    // fit decides (see AutoCrop.propose)
    const proposed = auto ? autoCrop.propose(detection.board, video.videoWidth, video.videoHeight) : null;
    if (proposed !== null) {
      detection = await model.detect(video, proposed);
      if (resets !== resetsBefore) {
        return;
      }
    }
    const { update, board } = detection;
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
    // Only reads of the board's crop with a good fit are used (see AutoCrop.update)
    let useRead: boolean = true;
    if (auto && (roi === null)) {
      useRead = autoCrop.update(board, video.videoWidth, video.videoHeight, playClock);
      if (autoCrop.roi !== autoRoi) {
        autoRoi = autoCrop.roi;
        options.onRoi?.(autoRoi);
      }
    }
    // The board's own corners give its direction more surely than where the model looked. With a model that finds the
    // board, a frame without a good fit has no direction: where the model looked is noise when no board is in view.
    let newDirection: number[] | null = detection.direction;
    if (model.locates) {
      newDirection = goodFit(board) ? boardDirection(board.corners) : null;
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
    if (!useRead) {
      options.onDetect?.(detection);
      return;
    }
    const elapsed = timed ? (playClock - recordStart) : undefined;
    const shown = tracker.update(update, playClock, game);
    if (shown !== null) {
      // A corrected move is timed from when it was played, which may be a few seconds back
      const ago = shown.times.map((time) => (time === null) ? null : playClock - time);
      const payload = makeUpdatePayload(shown.board);
      game = { ...payload, start: game.start, times: updateTimes(game, payload.moves, elapsed, ago) };
      options.onUpdate?.(game);
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
      } else if ((newFrame || (decodedFrames(video) ?? 0) > (readFrames ?? Infinity)
        || (now - lastFrameTime) >= FRAME_STALL_MS) && now >= nextRunTime) {
        await detectFrame(now);
      }
    } catch (error) {
      console.error("Piece detection failed", error);
      options.onError?.(toRecorderError(error));
    } finally {
      if (active) {
        ticker.after(Math.max(TICK_MS, nextRunTime - performance.now()));
      }
    }
  }
  const ticker = createTicker(() => {
    void loop();
  });
  ticker.after(0);

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
      // Looks for the board afresh if the region is cleared later
      resetAutoCrop();
    },
    setVideo: (next) => {
      if (next !== video) {
        resetAutoCrop();
      }
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
      ticker.stop();
      watchFrames(null);
    }
  };
}
