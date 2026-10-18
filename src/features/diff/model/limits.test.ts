import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L } from "../../../test/diffFixtures";
import { FULL_DIFF_LINES, HIGHLIGHT_LIMIT, totalLines, WORD_DIFF_MAX_TOKENS } from "./limits";

// Contract: the three tuning constants are fixed values.
describe("limit constants", () => {
  it("should set HIGHLIGHT_LIMIT to 20_000", () => {
    expect(HIGHLIGHT_LIMIT).toBe(20_000);
  });
  it("should set FULL_DIFF_LINES to 1_000_000", () => {
    expect(FULL_DIFF_LINES).toBe(1_000_000);
  });
  it("should set WORD_DIFF_MAX_TOKENS to 400", () => {
    expect(WORD_DIFF_MAX_TOKENS).toBe(400);
  });
});

// Contract: totalLines sums the line count of every hunk.
describe("totalLines", () => {
  it("should sum lines across hunks", () => {
    const d = fileDiff([hunk([L("context", "a"), L("addition", "b")]), hunk([L("deletion", "c")])]);
    expect(totalLines(d)).toBe(3);
  });
  it("should return 0 when there are no hunks", () => {
    expect(totalLines(fileDiff([]))).toBe(0);
  });
  it("should return 0 when hunks have no lines", () => {
    expect(totalLines(fileDiff([hunk([])]))).toBe(0);
  });
});
