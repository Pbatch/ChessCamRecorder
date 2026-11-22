import type { Roi } from "../types.js";
import { type BoardFit, boundingBox, goodFit, MIN_INLIERS, convex } from "./board.js";

// Finds the board and keeps a crop around it, for a recorder given no region. With no crop yet, the whole frame is
// read and the board fitted to it; once a fit is good, the crop is its box padded on every side. A board small in the
// frame is rarely fitted surely enough from the whole frame, so a rougher fit proposes a crop (propose), the same
// frame is read again in it, and that read's fit decides. Each read of the
// crop fits the board again, and the crop moves when the board comes near its edge, drifts or changes size (the camera
// moved), and is dropped when no board has been fitted for a while (the camera was knocked, or the board taken away).

// Padding of the crop on every side, as a fraction of the board's box (30% in all), as the model was tested with
export const PAD = 0.15;
// The crop moves when a board corner is this close to its edge, as a fraction of its size
export const EDGE_GAP = 0.03;
// or the board's centre has moved this far from where it was when the crop was set, in board widths
export const MAX_SHIFT = 0.1;
// or its width has changed by this factor
export const MAX_SIZE_CHANGE = 1.2;
// Good fits averaged before moving the crop, as one fit is about 0.3 squares out
export const AVERAGE_FITS = 3;
// How long without a good fit before the board counts as lost and the whole frame is read again, in ms. On the
// YunkerChess and ChessFlow test videos, hands broke the fit for at most 0.25 s at a time.
export const LOST_MS = 3000;
// The most sigma (in squares) a fit of the whole frame may have to propose a crop. Fits of small boards in the whole
// frame have 0.6 to 1.5 (LEYxdEWJXCg, where the board was then looked for for 26 s); with a second read in the crop
// proposed, the board was found on every YunkerChess and ChessFlow test video, and 2.4% more frames were read.
export const PROPOSE_SIGMA = 1.5;

export const padBox = (box: Roi, pad: number = PAD): Roi =>
  ({ x: box.x - pad * box.width, y: box.y - pad * box.height, width: (1 + 2 * pad) * box.width,
    height: (1 + 2 * pad) * box.height });

const plausible = (box: Roi, width: number, height: number): boolean =>
  [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width >= 32 && box.height >= 32
  && box.width <= 2 * width && box.height <= 2 * height;

const average = (fits: BoardFit[]): number[][] =>
  fits[0].corners.map((_, i) => [0, 1].map((k) => fits.reduce((s, f) => s + f.corners[i][k], 0) / fits.length));

export class AutoCrop {
  // The crop read, or null while the board is being looked for in the whole frame
  roi: Roi | null = null;
  // The board's box when the crop was set
  private anchor: Roi | null = null;
  private recent: BoardFit[] = [];
  private lastGood: number = 0;

  // Starts looking for the board again
  reset() {
    this.roi = null;
    this.anchor = null;
    this.recent = [];
  }

  // While the board is being looked for, the crop to read the same frame again in, from a fit of the whole frame
  // that may be of a board (a looser test than goodFit); null otherwise. The second read's fit, not this one, goes
  // to update, as a board fitted from the whole frame is too small to place the crop well.
  propose(fit: BoardFit | null, width: number, height: number): Roi | null {
    if (this.roi !== null || fit === null || fit.inliers < MIN_INLIERS || fit.sigma > PROPOSE_SIGMA
      || !convex(fit.corners)) {
      return null;
    }
    const box = boundingBox(fit.corners);
    return plausible(box, width, height) ? padBox(box) : null;
  }

  // Takes the board fitted to a read of `this.roi` (or of the whole frame, while it is null) at time `now` in ms, in a
  // video of `width` x `height`. Returns whether the read's pieces can be used: never for a read of the whole frame,
  // and not for a read of the crop without a good fit, which was right for only 64% of squares on the test videos,
  // against 99% with one. Nothing is read while the board is being looked for.
  update(fit: BoardFit | null, width: number, height: number, now: number): boolean {
    const good = goodFit(fit) && plausible(boundingBox(fit.corners), width, height);
    if (this.roi === null) {
      // No read of the whole frame is used: one that found the board is too small to read well, and one that didn't
      // could be anything. A board that fills the frame is found, and cropped to, like any other.
      if (good) {
        this.setCrop(fit.corners, now);
      }
      return false;
    }
    if (!good) {
      if (now - this.lastGood > LOST_MS) {
        this.reset();
      }
      return false;
    }
    this.lastGood = now;
    this.recent = [...this.recent, fit].slice(-AVERAGE_FITS);
    if (this.recent.length === AVERAGE_FITS && this.drifted(average(this.recent))) {
      this.setCrop(average(this.recent), now);
    }
    return true;
  }

  private setCrop(corners: number[][], now: number) {
    this.anchor = boundingBox(corners);
    this.roi = padBox(this.anchor);
    this.recent = [];
    this.lastGood = now;
  }

  private drifted(corners: number[][]): boolean {
    const roi = this.roi as Roi;
    const anchor = this.anchor as Roi;
    const box = boundingBox(corners);
    const gap = Math.min((box.x - roi.x) / roi.width, (roi.x + roi.width - box.x - box.width) / roi.width,
      (box.y - roi.y) / roi.height, (roi.y + roi.height - box.y - box.height) / roi.height);
    const shift = Math.hypot(box.x + box.width / 2 - anchor.x - anchor.width / 2,
      box.y + box.height / 2 - anchor.y - anchor.height / 2) / anchor.width;
    const size = box.width / anchor.width;
    return gap < EDGE_GAP || shift > MAX_SHIFT || size > MAX_SIZE_CHANGE || size < 1 / MAX_SIZE_CHANGE;
  }
}
