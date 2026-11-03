import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../lib/ipc";
import { fileDiff, hunk, L, threePairDiff } from "../../../test/diffFixtures";
import { LABELS, NOTHING_REASON, revertBody, revertedRows } from "./menu";
import { buildRows } from "./rows";
import { selectionRequest, type MenuTarget, type Side, type TextRange } from "./selection";

// threePairDiff split rows: 0 ctx, 1 {1,4}, 2 {2,5}, 3 {3,6}, 4 ctx.
const three = threePairDiff();
const threeRows = buildRows(three, "split");

// Split rows: 0 ctx, 1 {1 "a", 3 "A"}, 2 {2 "b", blank new cell}, 3 ctx.
const lonely: FileDiff = fileDiff([
  hunk([
    L("context", "c", 1, 1),
    L("deletion", "a", 2, null),
    L("deletion", "b", 3, null),
    L("addition", "A", null, 2),
    L("context", "d", 4, 3),
  ]),
]);
const lonelyRows = buildRows(lonely, "split");

const range = (
  anchor: [number, number],
  focus: [number, number],
  side: Side = "new",
): TextRange => ({
  side,
  anchor: { row: anchor[0], offset: anchor[1] },
  focus: { row: focus[0], offset: focus[1] },
});
const rangeTarget = (r: TextRange): MenuTarget => ({ kind: "range", range: r });

/** The dialog body for a discard of `target`, with the request the menu would send. */
const bodyFor = (diff: FileDiff, target: MenuTarget) => {
  const rows = buildRows(diff, "split");
  return revertBody(diff, rows, target, selectionRequest(diff, rows, target, "discard")!);
};

// Contract: the menu copy per action and target kind is exact.
describe("LABELS", () => {
  it("should name the row and range items for every action", () => {
    expect(LABELS).toEqual({
      discard: { row: "Revert this line", range: "Revert this section" },
      stage: { row: "Stage this line", range: "Stage selection" },
      unstage: { row: "Unstage this line", range: "Unstage selection" },
    });
  });
});

// Contract: a target with nothing to apply is explained per target kind.
describe("NOTHING_REASON", () => {
  it("should explain an empty row and an empty range", () => {
    expect(NOTHING_REASON).toEqual({
      row: "Not a changed line",
      range: "No changed text in the selection",
    });
  });
});

// Contract: the revert dialog says what it reverts: highlighted text, one line, or n lines.
describe("revertBody", () => {
  it("should use the single-line copy for a row target", () => {
    expect(bodyFor(three, { kind: "row", row: 1 })).toBe(
      "Revert this line in a.ts? This cannot be undone.",
    );
  });

  it("should use the highlighted-text copy for a range with a partial-line edit", () => {
    expect(bodyFor(three, rangeTarget(range([1, 8], [3, 5])))).toBe(
      "Revert the highlighted text in a.ts? This cannot be undone.",
    );
  });

  it("should count the rows of a range of whole rows", () => {
    expect(bodyFor(three, rangeTarget(range([1, 0], [2, 13])))).toBe(
      "Revert 2 lines in a.ts? This cannot be undone.",
    );
  });

  it("should not count a context row inside the range", () => {
    expect(bodyFor(three, rangeTarget(range([0, 0], [2, 13])))).toBe(
      "Revert 2 lines in a.ts? This cannot be undone.",
    );
  });

  it("should use the single-line copy for a range covering one whole changed row", () => {
    expect(bodyFor(three, rangeTarget(range([1, 0], [1, 13])))).toBe(
      "Revert this line in a.ts? This cannot be undone.",
    );
  });

  it("should use the diff's path", () => {
    const other = { ...three, path: "src/b.ts" };
    expect(bodyFor(other, { kind: "row", row: 1 })).toBe(
      "Revert this line in src/b.ts? This cannot be undone.",
    );
  });
});

// Contract: revertedRows counts the rows in the range that show a selected line on either side,
// so a row whose highlighted-side cell is blank still counts when its other line is reverted.
describe("revertedRows", () => {
  it("should count a new-side row with a blank cell whose deletion is reverted", () => {
    const r = range([1, 0], [2, 0]);
    const selection = selectionRequest(lonely, lonelyRows, rangeTarget(r), "discard")!;
    expect(selection).toEqual({ hunkIndex: 0, lines: [1, 2, 3], edits: [] });
    expect(revertedRows(lonely, lonelyRows, r, selection)).toBe(2);
  });

  it("should count a split pair once", () => {
    const r = range([1, 0], [2, 13]);
    const selection = selectionRequest(three, threeRows, rangeTarget(r), "discard")!;
    expect(revertedRows(three, threeRows, r, selection)).toBe(2);
  });

  it("should not count context rows inside the range", () => {
    const r = range([0, 0], [4, 1]);
    const selection = selectionRequest(three, threeRows, rangeTarget(r), "discard")!;
    expect(revertedRows(three, threeRows, r, selection)).toBe(3);
  });

  it("should count the same rows for a backwards range", () => {
    const r = range([2, 13], [1, 0]);
    const selection = selectionRequest(three, threeRows, rangeTarget(r), "discard")!;
    expect(revertedRows(three, threeRows, r, selection)).toBe(2);
  });

  it("should give the blank-cell fixture's dialog body with two lines", () => {
    expect(bodyFor(lonely, rangeTarget(range([1, 0], [2, 0])))).toBe(
      "Revert 2 lines in a.ts? This cannot be undone.",
    );
  });
});
