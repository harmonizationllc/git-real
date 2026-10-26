import { describe, expect, it } from "vitest";
import {
  REFS_SECTIONS,
  SECTION_MIN,
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
    expect(REFS_SECTIONS).toEqual(["branches", "stashes", "tags", "pullRequests", "issues"]);
  });
});

// Contract: a floor never pads a section beyond its content.
describe("sectionFloor", () => {
  it("should never pad a short section", () => {
    expect([sectionFloor(28), sectionFloor(72), sectionFloor(500)]).toEqual([28, 72, 72]);
  });
});

// Contract: fitSections shares the container by content (spec 3.1).
describe("fitSections", () => {
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

  it("should be unbounded while unmeasured", () => {
    expect(maxSectionHeight(0, sections, 0)).toBe(Infinity);
  });
});
