import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L, threePairDiff } from "../../../test/diffFixtures";
import { buildRows } from "./rows";
import {
  coveredText,
  orderedRange,
  rowLine,
  selectionRequest,
  type MenuTarget,
  type Side,
  type TextRange,
} from "./selection";

const diff = threePairDiff();
const split = buildRows(diff, "split");
const unified = buildRows(diff, "unified");

const range = (side: Side, anchor: [number, number], focus: [number, number]): TextRange => ({
  side,
  anchor: { row: anchor[0], offset: anchor[1] },
  focus: { row: focus[0], offset: focus[1] },
});
const target = (r: TextRange): MenuTarget => ({ kind: "range", range: r });

const discardResult = {
  hunkIndex: 0,
  lines: [1, 2, 4, 5, 6],
  edits: [{ index: 6, text: "seven eight NINE" }],
};
const stageResult = {
  hunkIndex: 0,
  lines: [1, 2, 3, 4, 5],
  edits: [{ index: 3, text: "SEVEN eight nine" }],
};

// Contract: orderedRange sorts anchor and focus into document order.
describe("orderedRange", () => {
  it("should keep a forward range as is", () => {
    const r = range("new", [1, 2], [3, 4]);
    expect(orderedRange(r)).toEqual({ start: r.anchor, end: r.focus });
  });
  it("should swap a backward range", () => {
    const r = range("new", [3, 4], [1, 2]);
    expect(orderedRange(r)).toEqual({ start: r.focus, end: r.anchor });
  });
  it("should order by offset within one row", () => {
    const r = range("new", [2, 9], [2, 1]);
    expect(orderedRange(r)).toEqual({ start: r.focus, end: r.anchor });
  });
});

// Contract: rowLine resolves the line a row shows on a side, or null.
describe("rowLine", () => {
  it("should return the single line of a unified row whatever the side", () => {
    expect(rowLine(diff, unified, 4, "old")).toEqual({ hunkIndex: 0, lineIndex: 4 });
    expect(rowLine(diff, unified, 4, "new")).toEqual({ hunkIndex: 0, lineIndex: 4 });
  });
  it("should return the line on the requested side of a split row", () => {
    expect(rowLine(diff, split, 1, "old")).toEqual({ hunkIndex: 0, lineIndex: 1 });
    expect(rowLine(diff, split, 1, "new")).toEqual({ hunkIndex: 0, lineIndex: 4 });
  });
  it("should return null for a missing side of a split row", () => {
    const d = fileDiff([hunk([L("deletion", "x", 1, null)])]);
    const rows = buildRows(d, "split");
    expect(rowLine(d, rows, 0, "new")).toBeNull();
    expect(rowLine(d, rows, 0, "old")).toEqual({ hunkIndex: 0, lineIndex: 0 });
  });
});

// Contract: coveredText is the text a range covers on its side, rows joined by newlines.
describe("coveredText", () => {
  it("should cover part of the first and last split rows and all between", () => {
    expect(coveredText(diff, split, range("new", [1, 8], [3, 5]))).toBe(
      "THREE\nFOUR FIVE SIX\nSEVEN",
    );
  });
  it("should give the same text for the equivalent unified range", () => {
    expect(coveredText(diff, unified, range("new", [4, 8], [6, 5]))).toBe(
      "THREE\nFOUR FIVE SIX\nSEVEN",
    );
  });
  it("should give the same text for a backward range", () => {
    expect(coveredText(diff, split, range("new", [3, 5], [1, 8]))).toBe(
      "THREE\nFOUR FIVE SIX\nSEVEN",
    );
  });
});

// Contract: selectionRequest maps a highlight to whole lines plus partial-line edits.
describe("selectionRequest from a text range", () => {
  it("should select partial pairs for discard (split, new side)", () => {
    expect(selectionRequest(diff, split, target(range("new", [1, 8], [3, 5])), "discard")).toEqual(
      discardResult,
    );
  });
  it("should select partial pairs for stage going forward", () => {
    expect(selectionRequest(diff, split, target(range("new", [1, 8], [3, 5])), "stage")).toEqual(
      stageResult,
    );
  });
  it("should give identical results for the same highlight on the old side", () => {
    const r = range("old", [1, 8], [3, 5]);
    expect(selectionRequest(diff, split, target(r), "discard")).toEqual(discardResult);
    expect(selectionRequest(diff, split, target(r), "stage")).toEqual(stageResult);
  });
  it("should give identical results for the equivalent unified highlight", () => {
    const r = range("new", [4, 8], [6, 5]);
    expect(selectionRequest(diff, unified, target(r), "discard")).toEqual(discardResult);
    expect(selectionRequest(diff, unified, target(r), "stage")).toEqual(stageResult);
  });
  it("should treat a backward drag like a forward one", () => {
    const r = range("new", [3, 5], [1, 8]);
    expect(selectionRequest(diff, split, target(r), "discard")).toEqual(discardResult);
  });
  it("should treat unified deletion rows as whole on the new side (drag up from an addition)", () => {
    const r = range("new", [4, 5], [2, 3]);
    expect(selectionRequest(diff, unified, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [2, 3, 5, 6],
      edits: [],
    });
  });
  it("should treat an addition end row as whole on the old side (drag down to an addition)", () => {
    const r = range("old", [1, 3], [4, 0]);
    expect(selectionRequest(diff, unified, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1, 2, 3, 4, 5, 6],
      edits: [],
    });
  });
  it("should choose nothing from a row whose coverage is empty (focus at offset 0)", () => {
    const r = range("new", [1, 8], [2, 0]);
    expect(selectionRequest(diff, split, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1, 4],
      edits: [],
    });
  });
  it("should return null for a range covering only context rows", () => {
    const r = range("new", [0, 0], [0, 1]);
    expect(selectionRequest(diff, split, target(r), "discard")).toBeNull();
    expect(selectionRequest(diff, unified, target(r), "stage")).toBeNull();
  });
  it("should use the hunk of the start row and ignore rows of other hunks", () => {
    const two = fileDiff([
      hunk([L("deletion", "foo bar", 1, null), L("addition", "foo BAR", null, 1)]),
      hunk([L("deletion", "baz qux", 9, null), L("addition", "baz QUX", null, 9)]),
    ]);
    const rows = buildRows(two, "unified");
    const r = range("new", [1, 0], [3, 3]);
    expect(selectionRequest(two, rows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [0, 1],
      edits: [],
    });
  });
});

// Contract: several partially chosen pairs each yield an edit, ordered by line index.
describe("selectionRequest with several partial pairs", () => {
  const r = range("new", [2, 5], [3, 5]);
  it("should emit one edit per partial pair in line order for discard", () => {
    expect(selectionRequest(diff, split, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [5, 6],
      edits: [
        { index: 5, text: "FOUR five six" },
        { index: 6, text: "seven eight NINE" },
      ],
    });
  });
  it("should emit one edit per partial pair in line order for stage", () => {
    expect(selectionRequest(diff, split, target(r), "stage")).toEqual({
      hunkIndex: 0,
      lines: [2, 3],
      edits: [
        { index: 2, text: "four FIVE SIX" },
        { index: 3, text: "SEVEN eight nine" },
      ],
    });
  });
});

// Contract: a row target selects the lines that row shows, never a partner.
describe("selectionRequest from a row", () => {
  it("should select both lines of a split row", () => {
    expect(selectionRequest(diff, split, { kind: "row", row: 1 }, "discard")).toEqual({
      hunkIndex: 0,
      lines: [1, 4],
      edits: [],
    });
  });
  it("should select only the single line of a unified row", () => {
    expect(selectionRequest(diff, unified, { kind: "row", row: 4 }, "discard")).toEqual({
      hunkIndex: 0,
      lines: [4],
      edits: [],
    });
  });
  it("should return null for a context row", () => {
    expect(selectionRequest(diff, split, { kind: "row", row: 0 }, "stage")).toBeNull();
    expect(selectionRequest(diff, unified, { kind: "row", row: 0 }, "stage")).toBeNull();
  });
});

// Contract: a line with no partner is chosen whole by any non-empty highlight, never partially.
describe("selectionRequest with unpaired lines", () => {
  const solo = fileDiff([
    hunk([
      L("context", "c", 1, 1),
      L("deletion", "gone line", 2, null),
      L("context", "m", 3, 2),
      L("addition", "new line", null, 3),
    ]),
  ]);
  const uRows = buildRows(solo, "unified");
  const sRows = buildRows(solo, "split");
  it("should select a whole unpaired deletion for a partial highlight in unified mode", () => {
    const r = range("old", [1, 2], [1, 4]);
    expect(selectionRequest(solo, uRows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [],
    });
  });
  it("should select a whole unpaired addition for a partial highlight in split mode", () => {
    const r = range("new", [3, 1], [3, 3]);
    expect(selectionRequest(solo, sRows, target(r), "stage")).toEqual({
      hunkIndex: 0,
      lines: [3],
      edits: [],
    });
  });
  it("should select nothing when the highlight on an unpaired line is empty", () => {
    const r = range("old", [1, 2], [1, 2]);
    expect(selectionRequest(solo, uRows, target(r), "discard")).toBeNull();
  });
  it("should treat a row with no line on the range side as whole and contribute no text", () => {
    const r = range("new", [1, 0], [1, 0]);
    expect(coveredText(solo, sRows, r)).toBe("");
    expect(selectionRequest(solo, sRows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [],
    });
  });
  it("should ignore context rows inside a range", () => {
    const r = range("new", [0, 0], [3, 3]);
    expect(selectionRequest(solo, sRows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1, 3],
      edits: [],
    });
    expect(coveredText(solo, sRows, r)).toBe("c\nm\nnew");
  });
  it("should clamp an end offset beyond the line length", () => {
    const r = range("new", [3, 0], [3, 99]);
    expect(selectionRequest(solo, sRows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [3],
      edits: [],
    });
  });
  it("should select the single line of an unpaired row target", () => {
    expect(selectionRequest(solo, uRows, { kind: "row", row: 1 }, "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [],
    });
    expect(selectionRequest(solo, sRows, { kind: "row", row: 3 }, "discard")).toEqual({
      hunkIndex: 0,
      lines: [3],
      edits: [],
    });
  });
});

// Contract: a pure insertion unit is chosen only when its position is strictly inside the
// covered interval; touching a boundary does not choose it.
describe("selectionRequest with empty-side edit units", () => {
  // Units: insertion of "bar" (old {4,4}, new {4,7}) and x -> y (old {6,7}, new {9,10}).
  const pair = fileDiff([
    hunk([L("deletion", "foo() x", 1, null), L("addition", "foo(bar) y", null, 1)]),
  ]);
  const rows = buildRows(pair, "unified");
  it("should not choose an insertion the highlight only touches at its end", () => {
    const r = range("old", [0, 0], [0, 4]);
    expect(selectionRequest(pair, rows, target(r), "discard")).toBeNull();
  });
  it("should not choose an insertion the highlight only touches at its start", () => {
    const r = range("old", [0, 4], [0, 7]);
    expect(selectionRequest(pair, rows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [{ index: 1, text: "foo(bar) x" }],
    });
  });
  it("should choose an insertion strictly inside the highlight (discard reverses it)", () => {
    const r = range("old", [0, 0], [0, 5]);
    expect(selectionRequest(pair, rows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [{ index: 1, text: "foo() y" }],
    });
  });
  it("should apply the chosen insertion forward for stage on the deletion side", () => {
    const r = range("old", [0, 0], [0, 5]);
    expect(selectionRequest(pair, rows, target(r), "stage")).toEqual({
      hunkIndex: 0,
      lines: [0],
      edits: [{ index: 0, text: "foo(bar) x" }],
    });
  });
  it("should choose an insertion whose new text the highlight intersects", () => {
    const r = range("new", [1, 5], [1, 6]);
    expect(selectionRequest(pair, rows, target(r), "discard")).toEqual({
      hunkIndex: 0,
      lines: [1],
      edits: [{ index: 1, text: "foo() y" }],
    });
  });
});
