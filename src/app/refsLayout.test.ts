import { describe, expect, it } from "vitest";
import {
  REFS_SECTIONS,
  SECTION_MIN,
  SECTION_WHOLE_MAX,
  fitSections,
  maxSectionHeight,
  resizeSection,
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
      "local",
      "remote",
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

  it("should never take the rounding pixel from a section shown whole", () => {
    // two sharers at 454.5 both round up; the 92 px section keeps its content height
    expect(fitSections(1001, [auto(1000), auto(1000), auto(92)])).toEqual([455, 454, 92]);
  });

  it("should give a fits-all rounding pixel to the automatic Branches", () => {
    // Branches holds the 389.4 px leftover; no section is shrunk, so Branches takes the pixel
    expect(fitSections(600, [auto(200.4), auto(60.3), auto(150.3)])).toEqual([390, 60, 150]);
  });

  it("should leave the rounding pixel unassigned when no automatic section can take it", () => {
    // fixed Branches, nothing shrunk: 460.4 rounds to 460 in a 460.6 container
    expect(fitSections(460.6, [fixed(400, 250.4), auto(60), auto(150)])).toEqual([250, 60, 150]);
  });

  it("should never push the rounding pixel's recipient below its floor", () => {
    // sharers at 100.6 and 72.2, two whole sections at 100.6: the remainder is -1, and the
    // 72.2 px sharer would drop to 71, so the 100.6 px sharer gives the pixel back instead
    const heights = fitSections(374, [auto(14372), auto(100.6), auto(100.6), auto(172)]);
    expect(heights).toEqual([100, 101, 101, 72]);
    expect(heights[3]).toBeGreaterThanOrEqual(SECTION_MIN);
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

  it("should take stored blank space before any content", () => {
    // prefs 782, over 182; Local's 300 of blank space (500 stored over 200 content) covers it
    expect(fitSections(600, [fixed(200, 500), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      318, 60, 150, 36, 36,
    ]);
  });

  it("should take blank space from every stored section in proportion", () => {
    // blank 200 and 100, over 32 → 21.33 and 10.67
    expect(
      fitSections(600, [fixed(100, 300), auto(60), fixed(100, 200), auto(36), auto(36)]),
    ).toEqual([279, 60, 189, 36, 36]);
  });

  it("should shrink the automatic sections once the blank space is gone", () => {
    // over 132: Local's 100 of blank space first, then Tags' room (78) gives the rest
    expect(fitSections(450, [fixed(200, 300), auto(60), auto(150), auto(36), auto(36)])).toEqual([
      200, 60, 118, 36, 36,
    ]);
  });

  it("should hold a stored height above the content as blank space when it fits", () => {
    expect(fitSections(2000, [auto(100), auto(60), fixed(572, 900), auto(36), auto(36)])).toEqual([
      968, 60, 900, 36, 36,
    ]);
    expect(fitSections(2000, [auto(100), auto(60), fixed(28, 300), auto(36), auto(36)])).toEqual([
      1568, 60, 300, 36, 36,
    ]);
  });

  it("should clamp a fixed height below the floor to the floor", () => {
    expect(fitSections(2000, [auto(100), auto(60), fixed(572, 10), auto(36), auto(36)])[2]).toBe(
      72,
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

// Contract: the absorber index takes the leftover; null leaves it unassigned (GR-58).
describe("fitSections absorber", () => {
  it("should give the leftover to the absorber at index 1", () => {
    expect(fitSections(500, [auto(100), auto(200), auto(60)], 1)).toEqual([100, 340, 60]);
  });

  it("should hold index 0's stored height as a true height when it is not the absorber", () => {
    // 560 fits in 600; the 40 left goes to the absorber at index 1
    expect(fitSections(600, [fixed(100, 300), auto(200), auto(60)], 1)).toEqual([300, 240, 60]);
    // in 500, index 0's 200 of blank space is the first thing taken
    expect(fitSections(500, [fixed(100, 300), auto(200), auto(60)], 1)).toEqual([240, 200, 60]);
  });

  it("should keep the absorber's stored height above its content, only floored", () => {
    expect(fitSections(500, [auto(100), fixed(200, 300), auto(60)], 1)).toEqual([100, 300, 60]);
    expect(fitSections(500, [auto(100), fixed(200, 10), auto(60)], 1)).toEqual([100, 72, 60]);
  });

  it("should give a fits-all rounding pixel to the absorber at index 1", () => {
    expect(fitSections(600, [auto(60.3), auto(200.4), auto(150.3)], 1)).toEqual([60, 390, 150]);
  });

  it("should leave the leftover unassigned with no absorber", () => {
    expect(fitSections(500, [auto(100), auto(200), auto(60)], null)).toEqual([100, 200, 60]);
    expect(fitSections(500, [fixed(100, 300), auto(200), auto(60)], null)).toEqual([100, 200, 60]);
  });

  it("should still shrink sections in proportion when there is no absorber", () => {
    expect(fitSections(400, [auto(400), auto(400)], null)).toEqual([200, 200]);
  });
});

// Contract: a drag stores the dragged height and unpins every other stored section the fit
// would shrink below its stored height, so the dragged height holds (spec §3.1 step 5).
describe("resizeSection", () => {
  // Local content 600 stored 429, Remote content 300 stored 156, in a 600 px column.
  const column = [fixed(600, 429), fixed(300, 156), auto(60), auto(36), auto(36)];

  it("should store the dragged height and unpin a stored section the fit shrinks", () => {
    expect(resizeSection(600, column, 0, 1, 256)).toEqual([null, 256, null, null, null]);
  });

  it("should hold the dragged height once the loser is automatic", () => {
    const next = column.map((s, i) => ({ ...s, fixed: resizeSection(600, column, 0, 1, 256)[i]! }));
    expect(fitSections(600, next, 0)).toEqual([212, 256, 60, 36, 36]);
  });

  it("should unpin a stored section the fit already shrinks when the drag goes the other way", () => {
    expect(resizeSection(600, column, 0, 1, 100)).toEqual([null, 100, null, null, null]);
  });

  it("should keep a stored height that still fits", () => {
    const sections = [auto(600), fixed(300, 156), auto(60), fixed(150, 100), auto(36)];
    expect(resizeSection(600, sections, 0, 1, 200)).toEqual([null, 200, null, 100, null]);
  });

  it("should keep a stored height below the floor", () => {
    const sections = [auto(600), fixed(300, 156), fixed(200, 10), auto(36), auto(36)];
    expect(resizeSection(600, sections, 0, 1, 200)).toEqual([null, 200, 10, null, null]);
  });

  it("should change only the dragged entry while unmeasured", () => {
    expect(resizeSection(0, column, 0, 1, 256)).toEqual([429, 256, null, null, null]);
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
