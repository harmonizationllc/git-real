import { describe, expect, it } from "vitest";
import type { ChangeBlock } from "./changes";
import { RULER_CELLS, rulerMarks } from "./ruler";

const block = (firstRow: number, lastRow: number, kind: ChangeBlock["kind"]): ChangeBlock => ({
  hunkIndex: 0,
  firstRow,
  lastRow,
  kind,
});

// Contract: blocks sharing or abutting a thousandth of the strip merge into one mark.
describe("rulerMarks", () => {
  it("should give every block its own mark when they sit in different cells", () => {
    const blocks = [block(2, 4, "modified"), block(7, 7, "added"), block(9, 9, "removed")];
    const marks = rulerMarks(blocks, 10);
    expect(marks).toHaveLength(3);
    marks.forEach((m, i) => {
      expect(m.firstBlock).toBe(i);
      expect(m.lastBlock).toBe(i);
      expect(m.firstRow).toBe(blocks[i]!.firstRow);
      expect(m.lastRow).toBe(blocks[i]!.lastRow);
      expect(m.kind).toBe(blocks[i]!.kind);
    });
  });

  it("should merge blocks whose cells overlap or abut", () => {
    const marks = rulerMarks(
      [block(10, 12, "added"), block(14, 14, "added"), block(30000, 30000, "removed")],
      100000,
    );
    expect(marks).toEqual([
      { firstBlock: 0, lastBlock: 1, firstRow: 10, lastRow: 14, kind: "added" },
      { firstBlock: 2, lastBlock: 2, firstRow: 30000, lastRow: 30000, kind: "removed" },
    ]);
  });

  it("should merge a block whose cell abuts the open mark's", () => {
    const marks = rulerMarks([block(0, 0, "added"), block(1, 1, "added")], 1000);
    expect(marks).toEqual([
      { firstBlock: 0, lastBlock: 1, firstRow: 0, lastRow: 1, kind: "added" },
    ]);
  });

  it("should mark merged blocks of different kinds as modified", () => {
    const marks = rulerMarks([block(10, 10, "added"), block(12, 12, "removed")], 100000);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe("modified");
  });

  it("should keep a one-row block at the very end", () => {
    const marks = rulerMarks([block(999, 999, "added")], 1000);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.firstRow).toBe(999);
    expect(marks[0]!.lastRow).toBe(999);
  });

  it("should return no marks without blocks or rows", () => {
    expect(rulerMarks([], 10)).toEqual([]);
    expect(rulerMarks([block(0, 0, "added")], 0)).toEqual([]);
  });

  it("should never produce more marks than cells plus one", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => block(i * 2, i * 2, "added"));
    expect(rulerMarks(blocks, 10000).length).toBeLessThanOrEqual(RULER_CELLS + 1);
  });
});
