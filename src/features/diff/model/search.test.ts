import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L, threePairDiff } from "../../../test/diffFixtures";
import { buildRows } from "./rows";
import type { Side, TextRange } from "./selection";
import {
  buildMarks,
  compileQuery,
  findHits,
  hitAnchor,
  matchLine,
  pickCurrent,
  SEARCH_HIT_CAP,
  seedFromRange,
  type SearchHit,
  type SearchOptions,
} from "./search";

const opts: SearchOptions = { wholeWord: false, matchCase: false };
const word: SearchOptions = { wholeWord: true, matchCase: false };
const pairs = (rs: { start: number; end: number }[]) => rs.map((r) => [r.start, r.end]);

// Unified rows: ctx0 "keep", del1 "old text", add2 "new text". Split rows: (0,0) (1,2).
const diff = fileDiff([
  hunk([
    L("context", "keep", 1, 1),
    L("deletion", "old text", 2, null),
    L("addition", "new text", null, 2),
  ]),
]);
const unified = buildRows(diff, "unified");
const split = buildRows(diff, "split");

describe("compileQuery", () => {
  it("returns null for an empty query", () => {
    expect(compileQuery("", opts)).toBeNull();
  });

  it("escapes regex metacharacters so `a.b` does not match `axb`", () => {
    const re = compileQuery("a.b", opts)!;
    expect(matchLine("axb", re)).toEqual([]);
    expect(pairs(matchLine("a.b", re))).toEqual([[0, 3]]);
  });

  it("is case-insensitive unless matchCase", () => {
    expect(matchLine("FOO", compileQuery("foo", opts)!)).toHaveLength(1);
    expect(matchLine("FOO", compileQuery("foo", { ...opts, matchCase: true })!)).toHaveLength(0);
    expect(matchLine("foo", compileQuery("foo", { ...opts, matchCase: true })!)).toHaveLength(1);
  });

  // A rejected astral-leading candidate must step a whole code point, or the regex re-matches it forever.
  it("whole-word astral query terminates and finds the standalone hit", { timeout: 2000 }, () => {
    expect(pairs(matchLine("a\u{1F600} \u{1F600}", compileQuery("\u{1F600}", word)!))).toEqual([
      [4, 6],
    ]);
  });

  it(
    "whole-word astral letter next to a word char terminates with no hit",
    { timeout: 2000 },
    () => {
      expect(matchLine("x\u{1D49C}", compileQuery("\u{1D49C}", word)!)).toEqual([]);
    },
  );

  it("uses no lookbehind, for older WebKit", () => {
    expect(compileQuery("foo", word)!.source).not.toContain("(?<");
  });

  it.each([
    ["foo", "foo bar", [[0, 3]]],
    ["foo", "foobar", []],
    ["foo", "_foo", []],
    ["foo", "éfoo", []],
    ["foo", "9foo", []],
    ["foo", "(foo)", [[1, 4]]],
    ["foo", "foo", [[0, 3]]],
    ["foo", "\u{1D49C}foo", []],
    ["foo", "\u{1F600}foo", [[2, 5]]],
  ])("whole word %s in %j", (q, text, ranges) => {
    expect(pairs(matchLine(text, compileQuery(q, word)!))).toEqual(ranges);
  });
});

describe("matchLine", () => {
  it("finds every non-overlapping hit left to right: `aa` in `aaaa`", () => {
    expect(pairs(matchLine("aaaa", compileQuery("aa", opts)!))).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("ignores the trailing newline", () => {
    expect(matchLine("x\n", compileQuery("\n", opts)!)).toEqual([]);
    expect(pairs(matchLine("x\n", compileQuery("x", opts)!))).toEqual([[0, 1]]);
  });

  it("returns [] for a line that is only a newline, and for a query longer than the line", () => {
    expect(matchLine("\n", compileQuery("x", opts)!)).toEqual([]);
    expect(matchLine("ab", compileQuery("abc", opts)!)).toEqual([]);
  });
});

describe("findHits", () => {
  it("orders unified hits by row then offset, side old for deletions and new otherwise", () => {
    const { hits, capped } = findHits(diff, unified, "e", opts);
    expect(capped).toBe(false);
    expect(hits).toEqual([
      { row: 0, side: "new", start: 1, end: 2 },
      { row: 0, side: "new", start: 2, end: 3 },
      { row: 1, side: "old", start: 5, end: 6 },
      { row: 2, side: "new", start: 1, end: 2 },
      { row: 2, side: "new", start: 5, end: 6 },
    ]);
  });

  it("orders split hits old side before new side within a row", () => {
    const { hits } = findHits(diff, split, "text", opts);
    expect(hits).toEqual([
      { row: 1, side: "old", start: 4, end: 8 },
      { row: 1, side: "new", start: 4, end: 8 },
    ]);
  });

  it("counts a split context row once, on the new side", () => {
    const { hits } = findHits(diff, split, "keep", opts);
    expect(hits).toEqual([{ row: 0, side: "new", start: 0, end: 4 }]);
  });

  it("searches the query as typed, including leading and trailing spaces", () => {
    expect(findHits(diff, unified, " text", opts).hits).toHaveLength(2);
    expect(findHits(diff, unified, "ld ", opts).hits).toHaveLength(1);
    expect(findHits(diff, unified, "keep ", opts).hits).toHaveLength(0);
  });

  it("returns no hits for an empty query", () => {
    expect(findHits(diff, unified, "", opts)).toEqual({ hits: [], capped: false });
  });

  it("caps at SEARCH_HIT_CAP and reports capped: true", () => {
    const big = fileDiff([
      hunk(Array.from({ length: SEARCH_HIT_CAP + 1 }, (_, i) => L("context", "a", i + 1, i + 1))),
    ]);
    const res = findHits(big, buildRows(big, "unified"), "a", opts);
    expect(res.hits).toHaveLength(SEARCH_HIT_CAP);
    expect(res.capped).toBe(true);
  });
});

describe("pickCurrent", () => {
  const hits = findHits(diff, unified, "e", opts).hits;

  it("returns null for no hits", () => {
    expect(pickCurrent([], unified, null, 0)).toBeNull();
  });

  it("keeps the hit whose anchor still matches after the list is rebuilt", () => {
    const anchor = hitAnchor(hits[3], unified);
    expect(anchor).toEqual({ key: unified[2].key, side: "new", start: 1 });
    expect(pickCurrent(hits, unified, anchor, 0)).toBe(3);
  });

  it("falls back to the first hit at or after firstVisibleRow when the anchor is gone", () => {
    const gone = { key: "nope", side: "new" as const, start: 9 };
    expect(pickCurrent(hits, unified, gone, 1)).toBe(2);
    expect(pickCurrent(hits, unified, null, 2)).toBe(3);
  });

  it("wraps to 0 when every hit is above firstVisibleRow", () => {
    expect(pickCurrent(hits, unified, null, 99)).toBe(0);
  });
});

describe("buildMarks", () => {
  const hits = findHits(diff, unified, "e", opts).hits;

  it("groups hits per row and side as Range objects", () => {
    const marks = buildMarks(hits, unified, null);
    expect(marks.get(0)!.new!.matches).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    expect(marks.get(0)!.old).toBeNull();
    expect(marks.get(1)!.old!.matches).toEqual([{ start: 5, end: 6 }]);
    expect(marks.get(0)!.new!.current).toBeNull();
  });

  it("marks the current hit's Range as current in its cell and nowhere else", () => {
    const marks = buildMarks(hits, unified, 3);
    expect(marks.get(2)!.new!.current).toEqual({ start: 1, end: 2 });
    expect(marks.get(0)!.new!.current).toBeNull();
    expect(marks.get(1)!.old!.current).toBeNull();
  });

  it("gives a split context row the same CellMarks object on old and new", () => {
    const sh: SearchHit[] = findHits(diff, split, "keep", opts).hits;
    const marks = buildMarks(sh, split, 0);
    const m = marks.get(0)!;
    expect(m.old).not.toBeNull();
    expect(m.old).toBe(m.new);
    expect(m.new!.current).toEqual({ start: 0, end: 4 });
  });

  it("leaves rows without hits out of the map", () => {
    const marks = buildMarks(findHits(diff, unified, "keep", opts).hits, unified, null);
    expect([...marks.keys()]).toEqual([0]);
  });
});

describe("seedFromRange", () => {
  const three = threePairDiff();
  const tSplit = buildRows(three, "split");
  const tUnified = buildRows(three, "unified");
  const range = (side: Side, anchor: [number, number], focus: [number, number]): TextRange => ({
    side,
    anchor: { row: anchor[0], offset: anchor[1] },
    focus: { row: focus[0], offset: focus[1] },
  });

  const cases = [
    {
      name: "split partial new side",
      rows: tSplit,
      range: range("new", [1, 8], [1, 13]),
      text: "THREE",
      at: [1, "new", 8],
    },
    {
      name: "backward range",
      rows: tSplit,
      range: range("new", [1, 13], [1, 8]),
      text: "THREE",
      at: [1, "new", 8],
    },
    {
      name: "split context old cell resolves to new",
      rows: tSplit,
      range: range("old", [0, 0], [0, 1]),
      text: "c",
      at: [0, "new", 0],
    },
    {
      name: "unified deletion dragged on old",
      rows: tUnified,
      range: range("old", [1, 4], [1, 7]),
      text: "two",
      at: [1, "old", 4],
    },
    {
      name: "unified deletion dragged on new is covered whole",
      rows: tUnified,
      range: range("new", [1, 4], [1, 7]),
      text: "one two three",
      at: [1, "old", 0],
    },
  ] as const;

  it.each(cases)("seeds: $name", (c) => {
    expect(seedFromRange(three, c.rows, c.range)).toEqual({
      text: c.text,
      anchor: { key: c.rows[c.at[0]].key, side: c.at[1], start: c.at[2] },
    });
  });

  // Not a general law: a self-overlapping selection ("aa" at offset 1 of "aaaa") has no hit at
  // its anchor, since hits never overlap. These cases do not overlap themselves.
  it.each(cases)("the anchor is a hit of the seed text for these cases: $name", (c) => {
    const seed = seedFromRange(three, c.rows, c.range)!;
    const { hits } = findHits(three, c.rows, seed.text, opts);
    const anchors = hits.map((h) => hitAnchor(h, c.rows));
    expect(anchors).toContainEqual(seed.anchor);
  });

  it("seeds nothing from a multi-row range", () => {
    expect(seedFromRange(three, tSplit, range("new", [1, 8], [3, 5]))).toBeNull();
  });

  it("seeds nothing from whitespace only", () => {
    expect(seedFromRange(three, tSplit, range("new", [1, 3], [1, 4]))).toBeNull();
  });

  it("drops a trailing newline from the seed", () => {
    const one = fileDiff([hunk([L("context", "abc\n", 1, 1)])]);
    const seed = seedFromRange(one, buildRows(one, "split"), range("new", [0, 0], [0, 4]));
    expect(seed?.text).toBe("abc");
    expect(seed?.anchor.start).toBe(0);
  });
});
