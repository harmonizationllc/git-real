import { act } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useDiffSearchStore } from "../../lib/store/diffSearch";
import type { DiffViewerHandle } from "./DiffViewer";
import { SEARCH_HIT_CAP } from "./model/search";
import { buildRows } from "./model/rows";
import { useDiffSearch } from "./useDiffSearch";

// Unified rows: 0 ctx "foo a", 1 del "foo b", 2 add "Foo c", 3 ctx "d", 4 add "foo foo".
const diff = fileDiff([
  hunk([
    L("context", "foo a", 1, 1),
    L("deletion", "foo b", 2, null),
    L("addition", "Foo c", null, 2),
    L("context", "d", 3, 3),
    L("addition", "foo foo", null, 4),
  ]),
]);

function setStore(query: string) {
  useDiffSearchStore.setState({ query, wholeWord: false, matchCase: false });
}

beforeEach(() => setStore(""));

function harness(opts: { open?: boolean; top?: number; query?: string } = {}) {
  const top = { value: opts.top ?? 0 };
  const revealRow = vi.fn();
  const viewer: RefObject<DiffViewerHandle | null> = {
    current: {
      scrollToRow: vi.fn(),
      firstVisibleRow: () => top.value,
      revealRow,
      focus: vi.fn(),
    },
  };
  setStore(opts.query ?? "");
  const props = { rows: buildRows(diff, "unified"), open: opts.open ?? true };
  const view = renderHookWithProviders(() => useDiffSearch(diff, props.rows, viewer, props.open));
  const rerender = (next: Partial<typeof props>) => {
    Object.assign(props, next);
    view.rerender();
  };
  return { view, top, revealRow, rerender };
}

describe("useDiffSearch", () => {
  it("returns no hits and no marks while closed even with a query", () => {
    const { view, revealRow } = harness({ open: false, query: "foo" });
    expect(view.result.current.hits).toEqual([]);
    expect(view.result.current.marks.size).toBe(0);
    expect(view.result.current.current).toBeNull();
    expect(revealRow).not.toHaveBeenCalled();
  });

  it("picks the first hit at or after firstVisibleRow when opened and reveals it", () => {
    const { view, revealRow, rerender } = harness({ open: false, query: "foo", top: 2 });
    rerender({ open: true });
    // hits: rows 0, 1, 2, 4, 4 -> the first at or after row 2 is index 2
    expect(view.result.current.hits).toHaveLength(5);
    expect(view.result.current.current).toBe(2);
    expect(revealRow).toHaveBeenLastCalledWith(2);
  });

  it("next and prev wrap and reveal each hit", () => {
    const { view, revealRow } = harness({ query: "foo" });
    expect(view.result.current.current).toBe(0);
    act(() => view.result.current.prev());
    expect(view.result.current.current).toBe(4);
    expect(revealRow).toHaveBeenLastCalledWith(4);
    act(() => view.result.current.next());
    expect(view.result.current.current).toBe(0);
    expect(revealRow).toHaveBeenLastCalledWith(0);
    act(() => view.result.current.next());
    expect(view.result.current.current).toBe(1);
    expect(revealRow).toHaveBeenLastCalledWith(1);
  });

  it("keeps the current hit when the query grows and the hit still starts at the anchor", () => {
    const { view } = harness({ query: "fo" });
    for (let i = 0; i < 3; i++) act(() => view.result.current.next());
    expect(view.result.current.current).toBe(3);
    expect(view.result.current.hits[3]).toMatchObject({ row: 4, start: 0 });
    act(() => useDiffSearchStore.getState().setQuery("foo"));
    const { hits, current } = view.result.current;
    expect(hits[current!]).toMatchObject({ row: 4, start: 0 });
  });

  it("falls back to the nearest hit when the rows are rebuilt and the anchor is gone", () => {
    const { view, top, rerender } = harness({ query: "foo" });
    act(() => view.result.current.next());
    expect(view.result.current.current).toBe(1);
    top.value = 3;
    // New rows with different keys: the anchored hit no longer exists.
    const rebuilt = buildRows(diff, "unified").map((r) => ({ ...r, key: `x${r.key}` }));
    rerender({ rows: rebuilt });
    const { hits, current } = view.result.current;
    expect(hits[current!].row).toBe(4);
  });

  it("re-derives the current hit on a toggle change", () => {
    const { view } = harness({ query: "foo" });
    act(() => view.result.current.next());
    expect(view.result.current.hits).toHaveLength(5);
    act(() => useDiffSearchStore.getState().toggleMatchCase());
    expect(view.result.current.hits).toHaveLength(4);
    expect(view.result.current.hits[view.result.current.current!]).toMatchObject({
      row: 1,
      start: 0,
    });
  });

  it("reports capped from findHits", () => {
    const big = fileDiff([hunk([L("addition", "a".repeat(SEARCH_HIT_CAP + 5), null, 1)])]);
    setStore("a");
    const viewer: RefObject<DiffViewerHandle | null> = { current: null };
    const rows = buildRows(big, "unified");
    const view = renderHookWithProviders(() => useDiffSearch(big, rows, viewer, true));
    expect(view.result.current.capped).toBe(true);
    expect(view.result.current.hits).toHaveLength(SEARCH_HIT_CAP);
  });
});
