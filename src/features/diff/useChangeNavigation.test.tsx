import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import type { DiffViewerHandle } from "./DiffViewer";
import { changeBlocks } from "./model/changes";
import { buildRows } from "./model/rows";
import { useChangeNavigation } from "./useChangeNavigation";

// One hunk, unified rows 0-9: ctx, del, add, add, ctx, del, add, ctx, add, ctx.
// Changed blocks are rows 1-3, 5-6 and 8.
const diff = fileDiff([
  hunk([
    L("context", "c0", 1, 1),
    L("deletion", "d1", 2, null),
    L("addition", "a2", null, 2),
    L("addition", "a3", null, 3),
    L("context", "c4", 3, 4),
    L("deletion", "d5", 4, null),
    L("addition", "a6", null, 5),
    L("context", "c7", 5, 6),
    L("addition", "a8", null, 7),
    L("context", "c9", 6, 8),
  ]),
]);

function setup(firstVisible = 0) {
  const scrollToRow = vi.fn();
  const firstVisibleRow = vi.fn(() => firstVisible);
  const handle: DiffViewerHandle = { scrollToRow, firstVisibleRow };
  const viewer: RefObject<DiffViewerHandle | null> = { current: handle };
  const rows = buildRows(diff, "unified");
  const view = renderHook(({ r }) => useChangeNavigation(diff, r, viewer), {
    initialProps: { r: rows },
  });
  return { ...view, rows, scrollToRow, firstVisibleRow };
}

// Contract: the fixture really has three change blocks, so the expectations below are grounded.
describe("useChangeNavigation fixture", () => {
  it("should group the fixture rows into blocks 1-3, 5-6 and 8", () => {
    expect(changeBlocks(diff, buildRows(diff, "unified"))).toEqual([
      { hunkIndex: 0, firstRow: 1, lastRow: 3, kind: "modified" },
      { hunkIndex: 0, firstRow: 5, lastRow: 6, kind: "modified" },
      { hunkIndex: 0, firstRow: 8, lastRow: 8, kind: "added" },
    ]);
  });
});

// Contract: count is the number of blocks; nothing is current until the user navigates.
describe("useChangeNavigation initial state", () => {
  it("should count three changes with none current", () => {
    const { result } = setup();
    expect(result.current.count).toBe(3);
    expect(result.current.current).toBeNull();
  });
});

// Contract: goTo scrolls three rows above the block's first row, clamped at zero.
describe("useChangeNavigation goTo and next", () => {
  it("should scroll to row 0 and make block 0 current on goTo(0)", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(0));
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(0);
    expect(result.current.current).toBe(0);
  });

  it("should walk forward block by block and stop at the last", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(0));
    scrollToRow.mockClear();
    act(() => result.current.next());
    expect(scrollToRow).toHaveBeenLastCalledWith(2);
    expect(result.current.current).toBe(1);
    act(() => result.current.next());
    expect(scrollToRow).toHaveBeenLastCalledWith(5);
    expect(result.current.current).toBe(2);
    scrollToRow.mockClear();
    act(() => result.current.next());
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(result.current.current).toBe(2);
  });

  it("should step back with prev", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(2));
    scrollToRow.mockClear();
    act(() => result.current.prev());
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(2);
    expect(result.current.current).toBe(1);
  });

  it("should not scroll on prev from the first block", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(0));
    scrollToRow.mockClear();
    act(() => result.current.prev());
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(result.current.current).toBe(0);
  });
});

// Contract: a user scroll forgets the current block; navigation then starts from the viewport.
describe("useChangeNavigation user scroll", () => {
  it("should clear current on onUserScroll", () => {
    const { result } = setup();
    act(() => result.current.goTo(1));
    expect(result.current.current).toBe(1);
    act(() => result.current.onUserScroll());
    expect(result.current.current).toBeNull();
  });

  it("should go to the first block below the first visible row on next", () => {
    const { result, scrollToRow } = setup(4);
    act(() => result.current.next());
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(2);
    expect(result.current.current).toBe(1);
  });

  it("should go to the last block above the first visible row on prev", () => {
    const { result, scrollToRow } = setup(4);
    act(() => result.current.prev());
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(0);
    expect(result.current.current).toBe(0);
  });

  it("should not scroll on prev when nothing is above the first visible row", () => {
    const { result, scrollToRow } = setup(0);
    act(() => result.current.prev());
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(result.current.current).toBeNull();
  });
});

// Contract: new rows (a mode switch or reload) reset the position without scrolling.
describe("useChangeNavigation rows change", () => {
  it("should clear current without scrolling when rows get a new identity", () => {
    const { result, rerender, scrollToRow } = setup();
    act(() => result.current.goTo(1));
    scrollToRow.mockClear();
    rerender({ r: buildRows(diff, "unified") });
    expect(result.current.current).toBeNull();
    expect(result.current.count).toBe(3);
    expect(scrollToRow).not.toHaveBeenCalled();
  });
});

// Contract: with no viewer mounted, navigation still tracks the current change and never throws.
describe("useChangeNavigation without a viewer", () => {
  const detached = () => {
    const viewer: RefObject<DiffViewerHandle | null> = { current: null };
    const rows = buildRows(diff, "unified");
    return renderHook(() => useChangeNavigation(diff, rows, viewer));
  };

  it("should treat the first visible row as 0 on next", () => {
    const { result } = detached();
    act(() => result.current.next());
    expect(result.current.current).toBe(0);
  });

  it("should do nothing on prev", () => {
    const { result } = detached();
    act(() => result.current.prev());
    expect(result.current.current).toBeNull();
  });

  it("should still set current on goTo", () => {
    const { result } = detached();
    act(() => result.current.goTo(2));
    expect(result.current.current).toBe(2);
  });
});

// Contract: goTo is a no-op without blocks and clamps an out-of-range index.
describe("useChangeNavigation goTo guard and clamping", () => {
  it("should do nothing on goTo when the diff has no changes", () => {
    const quiet = fileDiff([hunk([L("context", "a", 1, 1), L("context", "b", 2, 2)])]);
    const scrollToRow = vi.fn();
    const viewer: RefObject<DiffViewerHandle | null> = {
      current: { scrollToRow, firstVisibleRow: () => 0 },
    };
    const rows = buildRows(quiet, "unified");
    const { result } = renderHook(() => useChangeNavigation(quiet, rows, viewer));
    expect(result.current.count).toBe(0);
    act(() => result.current.goTo(0));
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(result.current.current).toBeNull();
  });

  it("should clamp a too-large index to the last block", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(99));
    expect(result.current.current).toBe(2);
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("should clamp a negative index to the first block", () => {
    const { result, scrollToRow } = setup();
    act(() => result.current.goTo(-1));
    expect(result.current.current).toBe(0);
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(0);
  });
});

// Contract: a change at row 0 is reachable from the top of the viewport.
describe("useChangeNavigation change at row 0", () => {
  it("should go to block 0 on next when it starts at the first visible row", () => {
    const top = fileDiff([
      hunk([L("addition", "a0", null, 1), L("context", "c1", 1, 2), L("deletion", "d2", 2, null)]),
    ]);
    const scrollToRow = vi.fn();
    const viewer: RefObject<DiffViewerHandle | null> = {
      current: { scrollToRow, firstVisibleRow: () => 0 },
    };
    const rows = buildRows(top, "unified");
    expect(changeBlocks(top, rows)[0].firstRow).toBe(0);
    const { result } = renderHook(() => useChangeNavigation(top, rows, viewer));
    act(() => result.current.next());
    expect(result.current.current).toBe(0);
    expect(scrollToRow).toHaveBeenCalledExactlyOnceWith(0);
  });
});

// Contract: the hook exposes the very blocks it counts, for the change ruler.
describe("useChangeNavigation blocks", () => {
  it("should expose the blocks it counts", () => {
    const { result, rows } = setup();
    expect(result.current.blocks).toEqual(changeBlocks(diff, rows));
    expect(result.current.blocks).toHaveLength(result.current.count);
  });
});

// Contract: a scroll with nothing current changes no state, so the viewer is not re-rendered.
describe("useChangeNavigation scroll with nothing current", () => {
  it("should keep the same state object on a user scroll when nothing is current", () => {
    let renders = 0;
    const rows = buildRows(diff, "unified");
    const viewer: RefObject<DiffViewerHandle | null> = { current: null };
    const { result } = renderHook(() => {
      renders += 1;
      return useChangeNavigation(diff, rows, viewer);
    });
    expect(result.current.current).toBeNull();
    const before = renders;
    act(() => result.current.onUserScroll());
    expect(renders).toBe(before);
  });
});
