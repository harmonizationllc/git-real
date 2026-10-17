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
