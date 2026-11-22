import { describe, expect, it } from "vitest";
import { AutoCrop, LOST_MS, padBox } from "./autoCrop.js";
import type { BoardFit } from "./board.js";

const W = 1280, H = 720;

// A fit of a square board `size` wide with its top left at (x, y), good by default
const boardAt = (x: number, y: number, size = 200, inliers = 64, sigma = 0.1): BoardFit =>
  ({ corners: [[x, y], [x + size, y], [x + size, y + size], [x, y + size]], inliers, sigma });

describe("AutoCrop", () => {
  it("crops to the board found in the whole frame, and doesn't use that read", () => {
    const crop = new AutoCrop();
    expect(crop.roi).toBeNull();
    expect(crop.update(boardAt(500, 300), W, H, 0)).toBe(false);
    expect(crop.roi).toEqual(padBox({ x: 500, y: 300, width: 200, height: 200 }));
    expect(crop.roi?.width).toBeCloseTo(260);
  });

  it("uses no reads while no board is found, as they could be anything", () => {
    const crop = new AutoCrop();
    expect(crop.update(null, W, H, 0)).toBe(false);
    expect(crop.update(boardAt(500, 300, 200, 20), W, H, 250)).toBe(false);
    expect(crop.update(boardAt(500, 300, 10), W, H, 500)).toBe(false);
    // A blank frame: every square agrees, but the model is unsure of them all
    expect(crop.update(boardAt(500, 300, 200, 64, 3.2), W, H, 750)).toBe(false);
    // A board turned inside out
    const crossed = boardAt(500, 300);
    crossed.corners = [crossed.corners[0], crossed.corners[2], crossed.corners[1], crossed.corners[3]];
    expect(crop.update(crossed, W, H, 1000)).toBe(false);
    expect(crop.roi).toBeNull();
  });

  it("keeps the crop while the board stays put, and through a hand over it, whose reads aren't used", () => {
    const crop = new AutoCrop();
    crop.update(boardAt(500, 300), W, H, 0);
    const roi = crop.roi;
    for (let t = 250; t < 3000; t += 250) {
      // jitter of a few pixels, and a hand over the board for a second
      const hand = t > 1000 && t < 2000;
      const fit = hand ? boardAt(520, 280, 200, 25) : boardAt(500 + (t % 3), 300 - (t % 2));
      expect(crop.update(fit, W, H, t)).toBe(!hand);
    }
    expect(crop.roi).toBe(roi);
  });

  it("moves the crop once the board has drifted, over a few fits", () => {
    const crop = new AutoCrop();
    crop.update(boardAt(500, 300), W, H, 0);
    crop.update(boardAt(530, 300), W, H, 250);
    crop.update(boardAt(530, 300), W, H, 500);
    expect(crop.roi?.x).toBeCloseTo(470);
    crop.update(boardAt(530, 300), W, H, 750);
    expect(crop.roi).toEqual(padBox({ x: 530, y: 300, width: 200, height: 200 }));
  });

  it("moves the crop when the board grows", () => {
    const crop = new AutoCrop();
    crop.update(boardAt(500, 300), W, H, 0);
    for (let t = 250; t <= 750; t += 250) {
      crop.update(boardAt(480, 280, 250), W, H, t);
    }
    expect(crop.roi?.width).toBeCloseTo(325);
  });

  it("looks in the whole frame again once the board has been lost for a while", () => {
    const crop = new AutoCrop();
    crop.update(boardAt(500, 300), W, H, 0);
    crop.update(null, W, H, LOST_MS - 250);
    expect(crop.roi).not.toBeNull();
    crop.update(null, W, H, LOST_MS + 250);
    expect(crop.roi).toBeNull();
    // and reads nothing until it finds it again
    expect(crop.update(null, W, H, LOST_MS + 500)).toBe(false);
  });

  it("proposes a crop from a rough fit of the whole frame, only while looking for the board", () => {
    const crop = new AutoCrop();
    // A small board: every square agrees, but too unsure to set the crop
    const rough = boardAt(500, 300, 200, 64, 1.2);
    expect(crop.propose(rough, W, H)).toEqual(padBox({ x: 500, y: 300, width: 200, height: 200 }));
    expect(crop.update(rough, W, H, 0)).toBe(false);
    expect(crop.roi).toBeNull();
    // The second read, of the crop proposed, sets it
    crop.update(boardAt(502, 301), W, H, 0);
    expect(crop.roi).not.toBeNull();
    expect(crop.propose(rough, W, H)).toBeNull();
  });

  it("proposes nothing for a fit that is surely not a board", () => {
    const crop = new AutoCrop();
    expect(crop.propose(null, W, H)).toBeNull();
    expect(crop.propose(boardAt(500, 300, 200, 20, 1.2), W, H)).toBeNull();
    // A blank frame
    expect(crop.propose(boardAt(500, 300, 200, 64, 3.2), W, H)).toBeNull();
    expect(crop.propose(boardAt(500, 300, 10, 64, 1.2), W, H)).toBeNull();
    const crossed = boardAt(500, 300, 200, 64, 1.2);
    crossed.corners = [crossed.corners[0], crossed.corners[2], crossed.corners[1], crossed.corners[3]];
    expect(crop.propose(crossed, W, H)).toBeNull();
  });
});
