import { describe, expect, it } from "vitest";
import { MORE_PILL_PX, SUBJECT_RESERVE_PX, fitLabels } from "./refLabelFit";

// Contract: fitLabels returns the largest k >= 1 whose pills (plus the +N pill unless k is every candidate) fit the budget.
describe("fitLabels", () => {
  it("should show every candidate when they all fit without the +N pill", () => {
    expect(fitLabels([40, 80, 40], 4, 170, 36)).toBe(3); // 160 + 2*4 = 168 <= 170
  });

  it("should drop to two when the +N pill fits beside them", () => {
    expect(fitLabels([40, 80, 40], 4, 165, 36)).toBe(2); // 40+80+36 + 2*4 = 164
  });

  it("should drop to one when two plus the pill do not fit", () => {
    expect(fitLabels([40, 80, 40], 4, 160, 36)).toBe(1);
  });

  it("should budget the +N pill when refs beyond the candidates exist even if every candidate fits", () => {
    // total 4 > 3 candidates: all three = 160 + pill 36 + 3*4 = 208 > 170; two = 40+80+36 + 2*4 = 164.
    expect(fitLabels([40, 80, 40], 4, 170, 36, 4)).toBe(2);
    expect(fitLabels([40, 80, 40], 4, 170, 36, 3)).toBe(3);
  });

  it("should never return zero", () => {
    expect(fitLabels([400], 4, 10, 36)).toBe(1);
    expect(fitLabels([400, 50], 4, 10, 36)).toBe(1);
  });

  it("should pin the reserve constants", () => {
    expect([SUBJECT_RESERVE_PX, MORE_PILL_PX]).toEqual([64, 36]);
  });
});
