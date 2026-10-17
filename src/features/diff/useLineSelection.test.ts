import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../lib/ipc";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { useLineSelection } from "./useLineSelection";

const d = fileDiff([
  hunk([
    L("context", "c"),
    L("deletion", "a"),
    L("addition", "b"),
    L("addition", "c"),
    L("context", "e"),
  ]),
  hunk([L("addition", "z")]),
]);
const gapped = fileDiff([hunk([L("addition", "a"), L("context", "m"), L("addition", "b")])]);

const setup = (diff: FileDiff | undefined) =>
  renderHook(({ diff: current }) => useLineSelection(current), { initialProps: { diff } });
const sorted = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);

// Contract: nothing is selected initially.
describe("useLineSelection initial state", () => {
  it("should start with an empty selection", () => {
    expect(setup(d).result.current.selected.size).toBe(0);
  });
  it("should start with no hunk", () => {
    expect(setup(d).result.current.hunkIndex).toBeNull();
  });
  it("should work with an undefined diff", () => {
    const { result } = setup(undefined);
    expect(result.current.selected.size).toBe(0);
  });
});

// Contract: a plain click toggles a changed line and ties the selection to its hunk.
describe("useLineSelection plain click", () => {
  it("should select the clicked changed line in its hunk", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    expect(sorted(result.current.selected)).toEqual([1]);
    expect(result.current.hunkIndex).toBe(0);
  });
  it("should deselect on a second click and keep the hunk", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 1, false));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBe(0);
  });
  it("should add further lines of the same hunk", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 3, false));
    expect(sorted(result.current.selected)).toEqual([1, 3]);
  });
  it("should replace the selection when another hunk is clicked", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(1, 0, false));
    expect(sorted(result.current.selected)).toEqual([0]);
    expect(result.current.hunkIndex).toBe(1);
  });
});

// Contract: clicks on context lines or on lines/hunks that do not exist are ignored.
describe("useLineSelection ignored clicks", () => {
  it("should ignore a context line", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 0, false));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBeNull();
  });
  it("should ignore an out-of-range line index", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 99, false));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBeNull();
  });
  it("should ignore a negative line index", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, -1, false));
    expect(result.current.selected.size).toBe(0);
  });
  it("should ignore an out-of-range hunk index", () => {
    const { result } = setup(d);
    act(() => result.current.click(5, 0, false));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBeNull();
  });
  it("should ignore clicks when there is no diff", () => {
    const { result } = setup(undefined);
    act(() => result.current.click(0, 1, false));
    expect(result.current.selected.size).toBe(0);
  });
  it("should keep an existing selection when an invalid click arrives", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 99, false));
    expect(sorted(result.current.selected)).toEqual([1]);
  });
});

// Contract: shift-click adds the changed lines between the anchor and the target, inclusive.
describe("useLineSelection shift click", () => {
  it("should select changed lines from the anchor to the target inclusive", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 3, true));
    expect(sorted(result.current.selected)).toEqual([1, 2, 3]);
  });
  it("should select a range when the target is before the anchor", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 3, false));
    act(() => result.current.click(0, 1, true));
    expect(sorted(result.current.selected)).toEqual([1, 2, 3]);
  });
  it("should skip context lines inside the range", () => {
    const { result } = setup(gapped);
    act(() => result.current.click(0, 0, false));
    act(() => result.current.click(0, 2, true));
    expect(sorted(result.current.selected)).toEqual([0, 2]);
  });
  it("should add to the existing selection instead of replacing it", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 3, false));
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 2, true));
    expect(sorted(result.current.selected)).toEqual([1, 2, 3]);
  });
  it("should act like a plain click when nothing is selected yet", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 2, true));
    expect(sorted(result.current.selected)).toEqual([2]);
  });
  it("should act like a plain click when the anchor is in another hunk", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(1, 0, true));
    expect(sorted(result.current.selected)).toEqual([0]);
    expect(result.current.hunkIndex).toBe(1);
  });
  it("should ignore a shift-click on a context line", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 4, true));
    expect(sorted(result.current.selected)).toEqual([1]);
  });
  it("should ignore a shift-click on an out-of-range line", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.click(0, 99, true));
    expect(sorted(result.current.selected)).toEqual([1]);
  });
});

// Contract: clear resets the selection and the hunk.
describe("useLineSelection clear", () => {
  it("should empty the selection and reset the hunk", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBeNull();
  });
  it("should forget the anchor so the next shift-click is a plain click", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    act(() => result.current.clear());
    act(() => result.current.click(0, 3, true));
    expect(sorted(result.current.selected)).toEqual([3]);
  });
});

// Contract: a new diff identity resets the selection; the same identity keeps it.
describe("useLineSelection diff identity", () => {
  it("should reset when the diff changes identity", () => {
    const { result, rerender } = setup(d);
    act(() => result.current.click(0, 1, false));
    rerender({ diff: structuredClone(d) });
    expect(result.current.selected.size).toBe(0);
    expect(result.current.hunkIndex).toBeNull();
  });
  it("should keep the selection when rerendered with the same diff", () => {
    const { result, rerender } = setup(d);
    act(() => result.current.click(0, 1, false));
    rerender({ diff: d });
    expect(sorted(result.current.selected)).toEqual([1]);
  });
  it("should select against the new diff after a reset", () => {
    const { result, rerender } = setup(d);
    rerender({ diff: gapped });
    act(() => result.current.click(0, 2, false));
    expect(sorted(result.current.selected)).toEqual([2]);
  });
});

// Contract: each change yields a new Set so memoised consumers update.
describe("useLineSelection referential updates", () => {
  it("should expose a new Set instance after each change", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    const first = result.current.selected;
    act(() => result.current.click(0, 2, false));
    expect(result.current.selected).not.toBe(first);
  });
  it("should not mutate a previously exposed Set", () => {
    const { result } = setup(d);
    act(() => result.current.click(0, 1, false));
    const first = result.current.selected;
    act(() => result.current.click(0, 2, false));
    expect(sorted(first)).toEqual([1]);
  });
});
