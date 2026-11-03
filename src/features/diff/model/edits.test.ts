import { describe, expect, it } from "vitest";
import { applyUnits, lineEdits, pickTokens, tokenRanges } from "./edits";
import { WORD_DIFF_MAX_TOKENS } from "./limits";
import { wordDiff } from "./wordDiff";

// Contract: lineEdits yields one unit per maximal run of unmatched tokens between LCS matches.
describe("lineEdits", () => {
  it("should yield one unit for a replaced word", () => {
    expect(lineEdits("foo bar baz", "foo qux baz")).toEqual([
      { old: { start: 4, end: 7 }, new: { start: 4, end: 7 } },
    ]);
  });
  it("should yield a replacement then an insertion with an empty old range", () => {
    expect(lineEdits("a b c d", "a X c d e")).toEqual([
      { old: { start: 2, end: 3 }, new: { start: 2, end: 3 } },
      { old: { start: 7, end: 7 }, new: { start: 7, end: 9 } },
    ]);
  });
  it('should yield one unit with an empty new range for a pure deletion ("b " removed)', () => {
    expect(lineEdits("a b c", "a c")).toEqual([
      { old: { start: 2, end: 4 }, new: { start: 2, end: 2 } },
    ]);
  });
  it("should yield no units for identical lines", () => {
    expect(lineEdits("same line", "same line")).toEqual([]);
  });
  it("should yield one whole-line unit beyond the token limit", () => {
    const a = "a ".repeat(WORD_DIFF_MAX_TOKENS / 2 + 1);
    const b = "b ".repeat(WORD_DIFF_MAX_TOKENS / 2 + 1);
    expect(lineEdits(a, b)).toEqual([
      { old: { start: 0, end: a.length }, new: { start: 0, end: b.length } },
    ]);
  });
});

// Contract: applyUnits applies chosen units forward (old to new) or reverses them (new to old).
describe("applyUnits", () => {
  const a = "a b c d";
  const b = "a X c d e";
  const units = () => lineEdits(a, b);
  it("should apply only the first unit going forward", () => {
    expect(applyUnits(a, b, units(), new Set([0]), true)).toBe("a X c d");
  });
  it("should apply only the second unit going forward", () => {
    expect(applyUnits(a, b, units(), new Set([1]), true)).toBe("a b c d e");
  });
  it("should apply every unit going forward to reach the new line", () => {
    expect(applyUnits(a, b, units(), new Set([0, 1]), true)).toBe(b);
  });
  it("should apply nothing for an empty choice", () => {
    expect(applyUnits(a, b, units(), new Set(), true)).toBe(a);
    expect(applyUnits(a, b, units(), new Set(), false)).toBe(b);
  });
  it("should reverse only the first unit going backward", () => {
    expect(applyUnits(a, b, units(), new Set([0]), false)).toBe("a b c d e");
  });
  it("should reverse every unit going backward to reach the old line", () => {
    expect(applyUnits(a, b, units(), new Set([0, 1]), false)).toBe("a b c d");
  });
});

// Contract: tokenRanges lists one range per token; pickTokens keeps or drops the chosen tokens.
describe("tokenRanges and pickTokens", () => {
  const text = "foo bar baz";
  it("should list one range per token in order", () => {
    expect(tokenRanges(text)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 8 },
      { start: 8, end: 11 },
    ]);
  });
  it("should list no ranges for an empty line", () => {
    expect(tokenRanges("")).toEqual([]);
  });
  it("should keep only the chosen tokens", () => {
    expect(pickTokens(text, tokenRanges(text), new Set([2]), true)).toBe("bar");
  });
  it("should drop the chosen tokens", () => {
    expect(pickTokens(text, tokenRanges(text), new Set([2]), false)).toBe("foo  baz");
    expect(pickTokens(text, tokenRanges(text), new Set([2, 3]), false)).toBe("foo baz");
  });
});

// Contract: wordDiff is the merged-range projection of lineEdits.
describe("wordDiff as a projection of lineEdits", () => {
  it("should list the non-empty ranges of each side", () => {
    expect(wordDiff("a b c d", "a X c d e")).toEqual({
      old: [{ start: 2, end: 3 }],
      new: [
        { start: 2, end: 3 },
        { start: 7, end: 9 },
      ],
    });
  });
});
