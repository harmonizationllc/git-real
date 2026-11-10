import { describe, expect, it } from "vitest";
import { rowHeightEstimate } from "./rowHeight";

// Contract: a single-line row is the code's 1.4 line box at the diff font size, never shorter
// than the 18 px gutter.
describe("rowHeightEstimate", () => {
  it.each([
    [10, 18], // 14 px line box, but the 18 px gutter sets the row
    [13, 18], // the default: 18.2 → 18
    [14, 20], // 19.6 → 20
    [16, 22],
    [24, 34],
  ])("should give a %i px font a %i px row", (size, px) => {
    expect(rowHeightEstimate(size)).toBe(px);
  });
});
