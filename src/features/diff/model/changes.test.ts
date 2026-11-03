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
      { hunkIndex: 0, firstRow: 1, lastRow: 2 },
      { hunkIndex: 0, firstRow: 4, lastRow: 5 },
      { hunkIndex: 0, firstRow: 7, lastRow: 7 },
    ]);
  });
  it("should group changed split rows into the same number of blocks", () => {
    const blocks = changeBlocks(mixed, buildRows(mixed, "split"));
    expect(blocks).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 1 },
      { hunkIndex: 0, firstRow: 3, lastRow: 4 },
      { hunkIndex: 0, firstRow: 6, lastRow: 6 },
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
      { hunkIndex: 0, firstRow: 1, lastRow: 2 },
      { hunkIndex: 1, firstRow: 3, lastRow: 3 },
    ]);
  });
  it("should not merge changed rows of different hunks into one block", () => {
    const two = fileDiff([
      hunk([L("deletion", "a", 1, null)]),
      hunk([L("addition", "n", null, 9)]),
    ]);
    expect(changeBlocks(two, buildRows(two, "split"))).toHaveLength(2);
  });
});
