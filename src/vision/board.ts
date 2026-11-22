import type { Roi } from "../types.js";

// Fitting the board to the model's square positions: a homography from board units to video pixels, which gives the
// board's outer corners even where the model can't see them.

// Board units: (0, 0) is a8's outer corner, x runs along the files a->h and y along the ranks 8->1, one per square
export interface BoardFit {
  // The board's outer corners in video pixels: a8, h8, h1, a1
  corners: number[][],
  // Squares whose position agrees with the fitted board, of 64. Few agree when a hand covers the board.
  inliers: number,
  // How sure the model is of where the squares are: their median sigma, in squares of the fitted board. With no board
  // in view (or a blank frame) the model is unsure of every square, so they all agree with whatever board is fitted,
  // and this is what gives it away: about 0.1 for a crop of the board, 0.3 for a whole frame showing one, and over 2
  // for an image with no board.
  sigma: number
}

// Squares that must agree with a fit for it to count, of 64
export const MIN_INLIERS = 40;
// The most sigma (in squares) a fit may have to count. Passes 91% of whole frames with a board and 97% of crops of
// one, and 3% of images without one, as measured on the YunkerChess and ChessFlow test videos.
export const MAX_SIGMA = 0.6;

// A square agrees with the fit when it is within this many of its own sigmas of where the fit puts it
const INLIER_SIGMAS = 3;
// Reweighting rounds of the robust fit
const ITERATIONS = 10;
// Cauchy scale, in sigmas: a square this far off counts half
const CAUCHY_SCALE = 2;
// Whether the four corners make a convex shape, as a board seen by a camera does: each turn along them is the same way
export const convex = (corners: number[][]): boolean => {
  const turns = corners.map((c, i) => {
    const b = corners[(i + 1) % 4], d = corners[(i + 2) % 4];
    return (b[0] - c[0]) * (d[1] - b[1]) - (b[1] - c[1]) * (d[0] - b[0]);
  });
  return turns.every((t) => t > 0) || turns.every((t) => t < 0);
}

// Whether a fit is surely of a board: most squares agree with it, the model is sure where they are, and it is the
// shape of one
export const goodFit = (fit: BoardFit | null): fit is BoardFit =>
  (fit !== null) && fit.inliers >= MIN_INLIERS && fit.sigma <= MAX_SIGMA && convex(fit.corners);

// Board corners, clockwise from a8's, in board units
const OUTER: number[][] = [[0, 0], [8, 0], [8, 8], [0, 8]];

// Square centres in FEN order (a8..h1), in board units
const CENTRES: number[][] = Array.from({ length: 64 }, (_, i) => [(i % 8) + 0.5, Math.floor(i / 8) + 0.5]);

type Matrix = number[][];

const multiply = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)));

const invert3 = (m: Matrix): Matrix => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
  ];
}

export const project = (h: Matrix, [x, y]: number[]): number[] => {
  const w = h[2][0] * x + h[2][1] * y + h[2][2];
  return [(h[0][0] * x + h[0][1] * y + h[0][2]) / w, (h[1][0] * x + h[1][1] * y + h[1][2]) / w];
}

// Hartley normalisation: moves the points' mean to the origin and their mean distance from it to sqrt(2)
const normaliser = (points: number[][]): Matrix => {
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  const mean = points.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / points.length;
  const s = Math.SQRT2 / (mean || 1);
  return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
}

// The unit eigenvector of a symmetric matrix with the smallest eigenvalue, by Jacobi rotations
const smallestEigenvector = (input: Matrix): number[] => {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v: Matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j) ? 1 : 0));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        off += a[p][q] * a[p][q];
      }
    }
    if (off < 1e-30) {
      break;
    }
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) {
          continue;
        }
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) {
    if (a[i][i] < a[best][best]) {
      best = i;
    }
  }
  return v.map((row) => row[best]);
}

// The homography taking the square centres to `points` that best fits them weighted by `weights` (direct linear
// transform, on normalised points)
const weightedHomography = (points: number[][], weights: number[]): Matrix => {
  const ta = normaliser(CENTRES);
  const tb = normaliser(points);
  const ata: Matrix = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const addRow = (row: number[]) => {
    for (let i = 0; i < 9; i++) {
      for (let j = i; j < 9; j++) {
        ata[i][j] += row[i] * row[j];
      }
    }
  }
  for (let k = 0; k < 64; k++) {
    const [X, Y] = project(ta, CENTRES[k]);
    const [u, v] = project(tb, points[k]);
    const w = weights[k];
    addRow([X, Y, 1, 0, 0, 0, -u * X, -u * Y, -u].map((value) => w * value));
    addRow([0, 0, 0, X, Y, 1, -v * X, -v * Y, -v].map((value) => w * value));
  }
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < i; j++) {
      ata[i][j] = ata[j][i];
    }
  }
  const hv = smallestEigenvector(ata);
  const hn: Matrix = [hv.slice(0, 3), hv.slice(3, 6), hv.slice(6, 9)];
  const h = multiply(multiply(invert3(tb), hn), ta);
  const scale = h[2][2];
  return h.map((row) => row.map((value) => value / scale));
}

// Fits the board to the model's square positions, (x, y, sigma) per square in FEN order in [0, 1] input coordinates,
// from a read of `rect` of the video (in video pixels). Null when no board can be fitted.
export const fitBoard = (positions: Float32Array, rect: Roi): BoardFit | null => {
  const points: number[][] = [];
  const sigmas: number[] = [];
  const scale = (rect.width + rect.height) / 2;
  for (let i = 0; i < 64; i++) {
    points.push([rect.x + positions[3 * i] * rect.width, rect.y + positions[3 * i + 1] * rect.height]);
    sigmas.push(Math.max(positions[3 * i + 2] * scale, 1e-6));
  }
  if (!points.every((p) => p.every(Number.isFinite)) || !sigmas.every(Number.isFinite)) {
    return null;
  }
  let weights = sigmas.map((s) => 1 / s);
  let h: Matrix = [];
  let residuals: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    h = weightedHomography(points, weights);
    residuals = CENTRES.map((c, k) => {
      const [x, y] = project(h, c);
      return Math.hypot(x - points[k][0], y - points[k][1]) / sigmas[k];
    });
    weights = residuals.map((r, k) => (1 / sigmas[k]) / (1 + (r / CAUCHY_SCALE) ** 2));
  }
  const corners = OUTER.map((c) => project(h, c));
  if (!corners.every((c) => c.every(Number.isFinite))) {
    return null;
  }
  const side = corners.reduce((sum, c, i) => sum + Math.hypot(corners[(i + 1) % 4][0] - c[0], corners[(i + 1) % 4][1] - c[1]), 0) / 32;
  const sorted = sigmas.slice().sort((a, b) => a - b);
  const sigma = (sorted[31] + sorted[32]) / 2 / side;
  return { corners, inliers: residuals.filter((r) => r < INLIER_SIGMAS).length, sigma };
}

// The rectangle around a board's corners
export const boundingBox = (corners: number[][]): Roi => {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// Direction of rank 8 in video pixels, from the board's corners
export const boardDirection = (corners: number[][]): number[] => {
  const [a8, h8, h1, a1] = corners;
  const up = [(a8[0] + h8[0] - h1[0] - a1[0]) / 2, (a8[1] + h8[1] - h1[1] - a1[1]) / 2];
  const norm = Math.hypot(up[0], up[1]) || 1;
  return [up[0] / norm, up[1] / norm];
}
