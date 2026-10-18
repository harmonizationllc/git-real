import { describe, expect, it } from "vitest";
import { WORD_DIFF_MAX_TOKENS } from "./limits";
import { wordDiff } from "./wordDiff";

// Contract: wordDiff returns merged UTF-16 character ranges that differ on each side.
describe("wordDiff", () => {
  it("should return no ranges for identical lines", () => {
    expect(wordDiff("a b", "a b")).toEqual({ old: [], new: [] });
  });
  it("should mark only the changed word", () => {
    expect(wordDiff("const a = 1;", "const b = 1;")).toEqual({
      old: [{ start: 6, end: 7 }],
      new: [{ start: 6, end: 7 }],
    });
  });
  it("should mark an inserted suffix on the new side only", () => {
    expect(wordDiff("foo()", "foo(bar)")).toEqual({ old: [], new: [{ start: 4, end: 7 }] });
  });
  it("should mark a deleted suffix on the old side only", () => {
    expect(wordDiff("foo(bar)", "foo()")).toEqual({ old: [{ start: 4, end: 7 }], new: [] });
  });
  it("should merge adjacent changed tokens into one range", () => {
    expect(wordDiff("x", "a.b")).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: 3 }],
    });
  });
  it("should mark whitespace for whitespace-only changes", () => {
    expect(wordDiff("a b", "a  b")).toEqual({
      old: [{ start: 1, end: 2 }],
      new: [{ start: 1, end: 3 }],
    });
  });
  it("should treat unicode letters as word characters", () => {
    expect(wordDiff("héllo wörld", "héllo wørld")).toEqual({
      old: [{ start: 6, end: 11 }],
      new: [{ start: 6, end: 11 }],
    });
  });
  it("should mark whole lines when the old side exceeds WORD_DIFF_MAX_TOKENS tokens", () => {
    const long = Array.from({ length: WORD_DIFF_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(" ");
    expect(wordDiff(long, "x")).toEqual({
      old: [{ start: 0, end: long.length }],
      new: [{ start: 0, end: 1 }],
    });
  });
  it("should mark whole lines when only the new side exceeds WORD_DIFF_MAX_TOKENS tokens", () => {
    const long = Array.from({ length: WORD_DIFF_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(" ");
    expect(wordDiff("x", long)).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: long.length }],
    });
  });
  it("should still diff token by token at exactly WORD_DIFF_MAX_TOKENS tokens", () => {
    const a = Array.from({ length: WORD_DIFF_MAX_TOKENS }, (_, i) =>
      i % 2 === 0 ? "w" : " ",
    ).join("");
    expect(wordDiff(a, "x" + a.slice(1))).toEqual({
      old: [{ start: 0, end: 1 }],
      new: [{ start: 0, end: 1 }],
    });
  });
  it("should give an empty old side no range", () => {
    expect(wordDiff("", "abc")).toEqual({ old: [], new: [{ start: 0, end: 3 }] });
  });
  it("should give an empty new side no range", () => {
    expect(wordDiff("abc", "")).toEqual({ old: [{ start: 0, end: 3 }], new: [] });
  });
});

// Contract: with one side empty, an over-limit other side is one whole-line range and the empty side none.
describe("wordDiff over the token limit against an empty side", () => {
  const long = Array.from({ length: WORD_DIFF_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(" ");
  it("should give an empty old side no range and the long new side one whole-line range", () => {
    expect(wordDiff("", long)).toEqual({ old: [], new: [{ start: 0, end: long.length }] });
  });
  it("should give an empty new side no range and the long old side one whole-line range", () => {
    expect(wordDiff(long, "")).toEqual({ old: [{ start: 0, end: long.length }], new: [] });
  });
});

// Contract: offsets are UTF-16 code units, so ranges slice back to the changed text even for astral characters.
describe("wordDiff with surrogate pairs", () => {
  it("should slice an emoji change back to the emoji on both sides", () => {
    const a = "a😀b";
    const b = "a😁b";
    const d = wordDiff(a, b);
    expect(d.old).toEqual([{ start: 1, end: 3 }]);
    expect(d.new).toEqual([{ start: 1, end: 3 }]);
    expect(a.slice(d.old[0].start, d.old[0].end)).toBe("😀");
    expect(b.slice(d.new[0].start, d.new[0].end)).toBe("😁");
  });
  it("should offset later ranges by the two code units of an unchanged emoji", () => {
    const a = "😀 foo";
    const b = "😀 bar";
    const d = wordDiff(a, b);
    expect(d.old).toEqual([{ start: 3, end: 6 }]);
    expect(a.slice(d.old[0].start, d.old[0].end)).toBe("foo");
    expect(b.slice(d.new[0].start, d.new[0].end)).toBe("bar");
  });
  it("should never split a surrogate pair when an emoji is inserted", () => {
    const d = wordDiff("a(b)", "a(😀b)");
    expect(d.old).toEqual([]);
    expect(d.new).toEqual([{ start: 2, end: 4 }]);
  });
});

// Contract: a difference at the very first or very last token is found without touching the rest.
describe("wordDiff at the line boundaries", () => {
  it("should mark only the first word when only the start differs", () => {
    expect(wordDiff("foo bar baz", "qux bar baz")).toEqual({
      old: [{ start: 0, end: 3 }],
      new: [{ start: 0, end: 3 }],
    });
  });
  it("should mark only the last word when only the end differs", () => {
    expect(wordDiff("foo bar baz", "foo bar qux")).toEqual({
      old: [{ start: 8, end: 11 }],
      new: [{ start: 8, end: 11 }],
    });
  });
  it("should mark a single-character difference at the last position", () => {
    expect(wordDiff("a;", "a,")).toEqual({
      old: [{ start: 1, end: 2 }],
      new: [{ start: 1, end: 2 }],
    });
  });
});
