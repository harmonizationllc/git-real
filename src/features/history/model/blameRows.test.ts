import { describe, expect, it } from "vitest";
import { blameHunk, blameOf } from "../../../test/historyFixtures";
import { blameRows } from "./blameRows";

const A = blameHunk(0, 1, 2);
const B = blameHunk(1, 3, 1);

// Contract: one row per line, carrying its hunk, the hunk's position and whether it starts the hunk.
describe("blameRows", () => {
  it("should emit one row per line", () => {
    expect(blameRows(blameOf([blameHunk(0, 1, 3)], ["a", "b", "c"]))).toHaveLength(3);
  });

  it("should number rows by 0-based line index", () => {
    const rows = blameRows(blameOf([blameHunk(0, 1, 3)], ["a", "b", "c"]));
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("should mark only the first row of a hunk as firstOfHunk", () => {
    const rows = blameRows(blameOf([A, B], ["a", "b", "c"]));
    expect(rows.map((r) => r.firstOfHunk)).toEqual([true, false, true]);
  });

  it("should give every row its hunk position", () => {
    const rows = blameRows(blameOf([A, B], ["a", "b", "c"]));
    expect(rows.map((r) => r.hunkIndex)).toEqual([0, 0, 1]);
  });

  it("should give the second hunk's rows hunkIndex 1", () => {
    const rows = blameRows(blameOf([A, B], ["a", "b", "c"]));
    expect(rows[2]).toEqual({ index: 2, hunk: B, hunkIndex: 1, firstOfHunk: true });
  });

  it("should carry the very hunk object on each row", () => {
    const rows = blameRows(blameOf([A, B], ["a", "b", "c"]));
    expect(rows[1].hunk).toBe(A);
  });

  it("should place a hunk's rows from its 1-based start", () => {
    const rows = blameRows(blameOf([blameHunk(0, 2, 2)], ["x", "a", "b"]));
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
  });
});

// Contract: libgit2 counts hunk lines and blob lines independently, so rows never run past the lines.
describe("blameRows edge cases", () => {
  it("should return no rows for no hunks and no lines", () => {
    expect(blameRows(blameOf([], []))).toEqual([]);
  });

  it("should return no rows for an empty file whose one hunk has zero lines", () => {
    expect(blameRows(blameOf([blameHunk(0, 1, 0)], []))).toEqual([]);
  });

  it("should emit nothing for a zero-line hunk between other hunks", () => {
    const zero = blameHunk(5, 2, 0);
    const rows = blameRows(blameOf([A, zero, blameHunk(1, 2, 1)], ["a", "b"]));
    expect(rows.map((r) => r.hunkIndex)).toEqual([0, 2]);
  });

  it("should clamp a hunk whose count runs past the lines", () => {
    const rows = blameRows(blameOf([blameHunk(0, 1, 5)], ["a", "b"]));
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it("should emit no rows for a hunk that starts past the lines", () => {
    const rows = blameRows(blameOf([A, blameHunk(1, 9, 2)], ["a", "b"]));
    expect(rows.map((r) => r.hunkIndex)).toEqual([0, 0]);
  });
});
