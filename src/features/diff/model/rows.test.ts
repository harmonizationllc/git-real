import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L } from "../../../test/diffFixtures";
import { buildRows } from "./rows";

const h0 = hunk(
  [
    L("context", "c", 1, 1),
    L("deletion", "a", 2, null),
    L("addition", "A", null, 2),
    L("addition", "B", null, 3),
  ],
  "@@ -1,2 +1,3 @@",
);
const h1 = hunk([L("addition", "z", null, 9)], "@@ -8,0 +9 @@");
const diff = fileDiff([h0, h1]);

// Contract: unified mode emits a header then one row per line, linking edited pairs via partner.
describe("buildRows unified", () => {
  it("should emit a header then one row per line with partners for changed pairs", () => {
    expect(buildRows(diff, "unified")).toEqual([
      { kind: "header", key: "h0", hunkIndex: 0, header: "@@ -1,2 +1,3 @@" },
      { kind: "unified", key: "u0:0", hunkIndex: 0, lineIndex: 0, partner: null },
      { kind: "unified", key: "u0:1", hunkIndex: 0, lineIndex: 1, partner: 2 },
      { kind: "unified", key: "u0:2", hunkIndex: 0, lineIndex: 2, partner: 1 },
      { kind: "unified", key: "u0:3", hunkIndex: 0, lineIndex: 3, partner: null },
      { kind: "header", key: "h1", hunkIndex: 1, header: "@@ -8,0 +9 @@" },
      { kind: "unified", key: "u1:0", hunkIndex: 1, lineIndex: 0, partner: null },
    ]);
  });
  it("should yield no rows when there are no hunks", () => {
    expect(buildRows(fileDiff([]), "unified")).toEqual([]);
  });
});

// Contract: split mode emits a header then one row per old/new pair.
describe("buildRows split", () => {
  it("should emit a header then one row per pair", () => {
    expect(buildRows(diff, "split")).toEqual([
      { kind: "header", key: "h0", hunkIndex: 0, header: "@@ -1,2 +1,3 @@" },
      { kind: "split", key: "s0:0:0", hunkIndex: 0, old: 0, new: 0 },
      { kind: "split", key: "s0:1:2", hunkIndex: 0, old: 1, new: 2 },
      { kind: "split", key: "s0:-:3", hunkIndex: 0, old: null, new: 3 },
      { kind: "header", key: "h1", hunkIndex: 1, header: "@@ -8,0 +9 @@" },
      { kind: "split", key: "s1:-:0", hunkIndex: 1, old: null, new: 0 },
    ]);
  });
  it("should yield no rows when there are no hunks", () => {
    expect(buildRows(fileDiff([]), "split")).toEqual([]);
  });
  it("should give every row a unique key", () => {
    const keys = buildRows(diff, "split").map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const trailingDeletion = fileDiff([
  hunk([L("context", "c", 1, 1), L("deletion", "x", 2, null), L("deletion", "y", 3, null)]),
]);
const uneven = fileDiff([
  hunk([
    L("deletion", "a", 1, null),
    L("deletion", "b", 2, null),
    L("addition", "A", null, 1),
    L("context", "c", 3, 2),
    L("deletion", "d", 4, null),
    L("addition", "D", null, 3),
    L("addition", "E", null, 4),
  ]),
]);

// Contract: a trailing deletion run yields split rows with no new side, keyed with "-".
describe("buildRows split with a trailing deletion run", () => {
  it("should emit rows with new null and a '-' key segment", () => {
    expect(buildRows(trailingDeletion, "split")).toEqual([
      { kind: "header", key: "h0", hunkIndex: 0, header: "@@ -1,2 +1,2 @@" },
      { kind: "split", key: "s0:0:0", hunkIndex: 0, old: 0, new: 0 },
      { kind: "split", key: "s0:1:-", hunkIndex: 0, old: 1, new: null },
      { kind: "split", key: "s0:2:-", hunkIndex: 0, old: 2, new: null },
    ]);
  });
  it("should keep keys unique across one-sided old and one-sided new rows", () => {
    const keys = buildRows(uneven, "split").map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("s0:1:-");
    expect(keys).toContain("s0:-:6");
  });
});

// Contract: unified partners link only paired lines; surplus lines of an uneven run have none.
describe("buildRows unified with uneven runs", () => {
  const partners = (diff: typeof uneven) =>
    buildRows(diff, "unified").flatMap((r) => (r.kind === "unified" ? [r.partner] : []));
  it("should link paired lines and leave surplus deletions and additions unpartnered", () => {
    // 0 del a <-> 2 add A; 1 del b surplus; 3 context; 4 del d <-> 5 add D; 6 add E surplus
    expect(partners(uneven)).toEqual([2, null, 0, null, 5, 4, null]);
  });
  it("should give a pure deletion run no partners", () => {
    expect(partners(trailingDeletion)).toEqual([null, null, null]);
  });
});
