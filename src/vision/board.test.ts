import { describe, expect, it } from "vitest";
import { boardDirection, boundingBox, fitBoard, goodFit, project } from "./board.js";
import type { Roi } from "../types.js";

// A board seen in perspective: farther ranks (rank 8 at the top) narrower, in a 1280x720 video
const H: number[][] = [[60, 18, 400], [0, 30, 250], [0, 0.04, 1]];
const RECT: Roi = { x: 300, y: 150, width: 600, height: 500 };

// The model's positions for this board, read from RECT: (x, y, sigma) in [0, 1] of the rect, in FEN order
const positionsFor = (h: number[][], rect: Roi, sigma = 0.01): Float32Array => {
  const out = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    const [x, y] = project(h, [(i % 8) + 0.5, Math.floor(i / 8) + 0.5]);
    out.set([(x - rect.x) / rect.width, (y - rect.y) / rect.height, sigma], 3 * i);
  }
  return out;
}

const expectCorners = (actual: number[][], h: number[][], tolerance: number) => {
  [[0, 0], [8, 0], [8, 8], [0, 8]].forEach((c, i) => {
    const [x, y] = project(h, c);
    expect(Math.hypot(actual[i][0] - x, actual[i][1] - y)).toBeLessThan(tolerance);
  });
}

describe("fitBoard", () => {
  it("finds the outer corners from the square centres, in video pixels", () => {
    const fit = fitBoard(positionsFor(H, RECT), RECT);
    expect(fit).not.toBeNull();
    expect(fit?.inliers).toBe(64);
    expectCorners(fit?.corners ?? [], H, 0.05);
    // sigma 0.01 of the 600x500 rect is 5.5px, and the board's squares average about 50px
    expect(fit?.sigma).toBeGreaterThan(0.05);
    expect(fit?.sigma).toBeLessThan(0.2);
    expect(goodFit(fit)).toBe(true);
  });

  it("isn't good when the model is unsure of every square, as with no board in view", () => {
    const fit = fitBoard(positionsFor(H, RECT, 0.3), RECT);
    expect(fit?.inliers).toBe(64);
    expect(goodFit(fit)).toBe(false);
  });

  it("ignores a few squares that are far off, as under a hand", () => {
    const positions = positionsFor(H, RECT);
    for (const i of [3, 10, 17, 30, 41, 42, 50, 63]) {
      positions[3 * i] += 0.2;
      positions[3 * i + 1] -= 0.15;
    }
    const fit = fitBoard(positions, RECT);
    expect(fit?.inliers).toBe(56);
    expectCorners(fit?.corners ?? [], H, 1);
  });

  it("agrees with few squares when the positions are not a board", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    }
    const positions = Float32Array.from({ length: 64 * 3 }, (_, k) => (k % 3 === 2) ? 0.005 : random());
    expect(fitBoard(positions, RECT)?.inliers ?? 0).toBeLessThan(20);
  });

  it("gives null for non-finite positions", () => {
    const positions = positionsFor(H, RECT);
    positions[5] = Number.NaN;
    expect(fitBoard(positions, RECT)).toBeNull();
  });
});

describe("boundingBox and boardDirection", () => {
  it("boxes the corners, and points from rank 1 to rank 8", () => {
    const corners = [[100, 50], [300, 60], [320, 260], [90, 240]];
    expect(boundingBox(corners)).toEqual({ x: 90, y: 50, width: 230, height: 210 });
    const [dx, dy] = boardDirection(corners);
    expect(dy).toBeLessThan(-0.99);
    expect(Math.abs(dx)).toBeLessThan(0.1);
    // Turned a quarter clockwise on screen, rank 8 is on the right
    expect(boardDirection([[300, 50], [300, 250], [100, 250], [100, 50]])).toEqual([1, 0]);
  });
});
