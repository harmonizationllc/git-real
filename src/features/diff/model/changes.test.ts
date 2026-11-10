import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L } from "../../../test/diffFixtures";
import { changeBlocks } from "./changes";
import { buildRows } from "./rows";

const mixed = fileDiff([
  hunk([
    L("context", "c0", 1, 1),
    L("deletion", "a", 2, null),
    L("addition", "A", null, 2),
    L("context", "c1", 3, 3),
    L("addition", "x", null, 4),
    L("addition", "y", null, 5),
    L("context", "c2", 4, 6),
    L("deletion", "z", 5, null),
  ]),
]);

// Contract: a change block is a maximal run of consecutive rows holding a non-context line.
describe("changeBlocks", () => {
  it("should group consecutive changed unified rows into blocks", () => {
    const blocks = changeBlocks(mixed, buildRows(mixed, "unified"));
    expect(blocks).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 2, kind: "modified" },
      { hunkIndex: 0, firstRow: 4, lastRow: 5, kind: "added" },
      { hunkIndex: 0, firstRow: 7, lastRow: 7, kind: "removed" },
    ]);
  });
  it("should group changed split rows into the same number of blocks", () => {
    const blocks = changeBlocks(mixed, buildRows(mixed, "split"));
    expect(blocks).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 1, kind: "modified" },
      { hunkIndex: 0, firstRow: 3, lastRow: 4, kind: "added" },
      { hunkIndex: 0, firstRow: 6, lastRow: 6, kind: "removed" },
    ]);
  });
  it("should yield no blocks when there are no hunks", () => {
    const empty = fileDiff([]);
    expect(changeBlocks(empty, buildRows(empty, "unified"))).toEqual([]);
    expect(changeBlocks(empty, buildRows(empty, "split"))).toEqual([]);
  });
  it("should count blocks across hunks", () => {
    const two = fileDiff([
      hunk([L("context", "c", 1, 1), L("deletion", "a", 2, null), L("addition", "A", null, 2)]),
      hunk([L("addition", "n", null, 9), L("context", "c", 8, 10)]),
    ]);
    expect(changeBlocks(two, buildRows(two, "unified"))).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 2, kind: "modified" },
      { hunkIndex: 1, firstRow: 3, lastRow: 3, kind: "added" },
    ]);
  });
  it("should not merge changed rows of different hunks into one block", () => {
    const two = fileDiff([
      hunk([L("deletion", "a", 1, null)]),
      hunk([L("addition", "n", null, 9)]),
    ]);
    expect(changeBlocks(two, buildRows(two, "split"))).toEqual([
      { hunkIndex: 0, firstRow: 0, lastRow: 0, kind: "removed" },
      { hunkIndex: 1, firstRow: 1, lastRow: 1, kind: "added" },
    ]);
  });
});

// Hunk 0: context, deletion, addition. Hunk 1: addition, context.
const twoHunks = fileDiff([
  hunk([L("context", "a", 1, 1), L("deletion", "b", 2, null), L("addition", "B", null, 2)]),
  hunk([L("addition", "n", null, 9), L("context", "c", 8, 10)]),
]);

// Contract: a block's kind says whether it adds, removes or modifies lines.
describe("changeBlocks kinds", () => {
  it("should mark a block holding deletions and additions as modified", () => {
    const rows = buildRows(twoHunks, "unified");
    expect(changeBlocks(twoHunks, rows)[0]!.kind).toBe("modified");
  });
  it("should mark a block of only additions as added", () => {
    const rows = buildRows(twoHunks, "unified");
    expect(changeBlocks(twoHunks, rows)[1]!.kind).toBe("added");
  });
  it("should mark a block of only deletions as removed", () => {
    const diff = fileDiff([hunk([L("context", "a", 1, 1), L("deletion", "b", 2, null)])]);
    const rows = buildRows(diff, "unified");
    expect(changeBlocks(diff, rows)).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 1, kind: "removed" },
    ]);
  });
  it("should give split rows the same kinds as unified rows", () => {
    const unified = changeBlocks(twoHunks, buildRows(twoHunks, "unified")).map((b) => b.kind);
    const split = changeBlocks(twoHunks, buildRows(twoHunks, "split")).map((b) => b.kind);
    expect(split).toEqual(unified);
    expect(split).toEqual(["modified", "added"]);
  });
});
