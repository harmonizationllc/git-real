import { describe, expect, it } from "vitest";
import {
  REFS_SECTIONS,
  SECTION_MIN,
  SECTION_WHOLE_MAX,
  fitSections,
  maxSectionHeight,
  sectionFloor,
  type SectionInput,
} from "./refsLayout";

const auto = (natural: number): SectionInput => ({ natural, fixed: null });
const fixed = (natural: number, height: number): SectionInput => ({ natural, fixed: height });

// Contract: the constants pin the section order and the minimum height.
describe("refsLayout constants", () => {
  it("should pin SECTION_MIN and the section order", () => {
    expect(SECTION_MIN).toBe(72);
    expect(REFS_SECTIONS).toEqual([
      "branches",
      "stashes",
      "tags",
      "worktrees",
      "pullRequests",
      "issues",
    ]);
  });

  it("should pin SECTION_WHOLE_MAX", () => {
    expect(SECTION_WHOLE_MAX).toBe(144);
  });
});

// Contract: a floor never pads a section beyond its content.
describe("sectionFloor", () => {
  it("should keep a section whole up to SECTION_WHOLE_MAX, then floor it at SECTION_MIN", () => {
    expect([28, 72, 92, 144, 145, 500].map(sectionFloor)).toEqual([28, 72, 92, 144, 72, 72]);
  });
});

// Contract: fitSections shares the container by content (spec 3.1).
describe("fitSections", () => {
  it("should never clip a section that fits under SECTION_WHOLE_MAX", () => {
    // the walk case: 92 px Worktrees held whole; Branches and Tags share the overflow
    expect(fitSections(614, [auto(7608), auto(68), auto(1688), auto(92)])).toEqual([
      327, 68, 127, 92,
    ]);
  });

  it("should return whole pixels that sum to the container", () => {
    // thirds: 333.33 x3 round to 999; the last automatic section takes the 1 px
    const heights = fitSections(1000, [auto(1000), auto(1000), auto(1000)]);
    expect(heights).toEqual([333, 333, 334]);
    expect(heights.every(Number.isInteger)).toBe(true);
  });

  it("should give the rounding remainder to the last automatic section, not a fixed one", () => {
    // 399.5 x2 round up to 800 + 201 = 1001; the last automatic section gives back the 1 px
    expect(fitSections(1000, [auto(1000), auto(1000), fixed(1000, 201)])).toEqual([400, 399, 201]);
  });

  it("should leave a fixed-Branches leftover unassigned after rounding", () => {
    expect(fitSections(600, [fixed(400, 250.4), auto(60), auto(150)])).toEqual([250, 60, 150]);
  });

  it("should clamp a stored height on a small section to its content and show it whole", () => {
    expect(fitSections(1000, [auto(100), fixed(92, 500)])).toEqual([908, 92]);
  });

  it("should give the leftover to an automatic Branches when everything fits", () => {
    expect(fitSections(600, [auto(200), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      318, 60, 150, 36, 36,
    ]);
  });

  it("should leave the leftover unassigned when Branches is fixed", () => {
    expect(fitSections(600, [fixed(400, 250), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      250, 60, 150, 36, 36,
    ]);
  });

  it("should shrink automatic sections in proportion to their room above the floor", () => {
    // rooms 1000, 0, 500, 0, 0; over 750 so the ratio is 1/2
    expect(fitSections(1038, [auto(1072), auto(72), auto(572), auto(36), auto(36)])).toEqual([
      572, 72, 322, 36, 36,
    ]);
  });

  it("should hold a fixed section while the automatic ones shrink", () => {
    expect(fitSections(1038, [auto(1072), auto(72), fixed(572, 400), auto(36), auto(36)])).toEqual([
      494, 72, 400, 36, 36,
    ]);
  });

  it("should keep a stored Branches height above its content", () => {
    expect(fitSections(600, [fixed(200, 300), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      300, 60, 150, 36, 36,
    ]);
  });

  it("should let a stored Branches height squeeze the automatic sections", () => {
    // prefs 782, over 182; only Tags has room (78) so it drops to 72 and Branches gives 104
    expect(fitSections(600, [fixed(200, 500), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      396, 60, 72, 36, 36,
    ]);
  });

  it("should clamp a fixed height above the content to the content", () => {
    expect(fitSections(2000, [auto(100), auto(60), fixed(572, 900), auto(36), auto(36)])[2]).toBe(
      572,
    );
  });

  it("should clamp a fixed height below the floor to the floor", () => {
    expect(fitSections(2000, [auto(100), auto(60), fixed(572, 10), auto(36), auto(36)])[2]).toBe(
      72,
    );
  });

  it("should show a collapsed section at its header even with a stored height", () => {
    expect(fitSections(2000, [auto(100), auto(60), fixed(28, 300), auto(36), auto(36)])[2]).toBe(
      28,
    );
  });

  it("should take from fixed sections once the automatic room is gone", () => {
    expect(fitSections(300, [auto(72), auto(72), fixed(572, 500), auto(36), auto(36)])).toEqual([
      72, 72, 84, 36, 36,
    ]);
  });

  it("should keep every floor when the floors alone overflow the container", () => {
    expect(fitSections(100, [auto(72), auto(72), auto(72), auto(36), auto(36)])).toEqual([
      72, 72, 72, 36, 36,
    ]);
  });

  it("should pass the naturals through while unmeasured", () => {
    expect(fitSections(0, [auto(1072), auto(72), fixed(572, 100), auto(36), auto(36)])).toEqual([
      1072, 72, 572, 36, 36,
    ]);
  });
});

// Contract: the most a section can take leaves every other section its floor.
describe("maxSectionHeight", () => {
  const sections = [auto(1072), auto(72), auto(572), auto(36), auto(36)];

  it("should be the container less the other floors", () => {
    expect(maxSectionHeight(1038, sections, 0)).toBe(822);
    expect(maxSectionHeight(1038, sections, 2)).toBe(822);
  });

  it("should never fall below the section's own floor", () => {
    const tight = [auto(72), auto(72), auto(72), auto(36), auto(36)];
    expect(maxSectionHeight(100, tight, 2)).toBe(72);
  });

  it("should be unbounded while unmeasured", () => {
    expect(maxSectionHeight(0, sections, 0)).toBe(Infinity);
  });
});
