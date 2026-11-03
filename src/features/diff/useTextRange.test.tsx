import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiff } from "../../lib/ipc";
import { fileDiff, hunk, L, threePairDiff } from "../../test/diffFixtures";
import type { CaretHit, CaretResolver } from "./caretResolver";
import { buildRows, type DiffRow } from "./model/rows";
import { useTextRange, type UseTextRange } from "./useTextRange";

// Unified rows of the three-pair fixture: ctx0, del1, del2, del3, add4, add5, add6, ctx7.
// Split rows: ctx0, {1,4}, {2,5}, {3,6}, ctx4 (row 1's new text is "one two THREE").
const diff = threePairDiff();
const rows = buildRows(diff, "unified");
const splitRows = buildRows(diff, "split");

// The scripted resolver answers by clientX only, so a clamped clientY never changes the hit.
const hits = new Map<number, CaretHit>();
const hitAt = (x: number, hit: CaretHit) => hits.set(x, hit);
const resolver = vi.fn<CaretResolver>((x) => hits.get(x) ?? null);

const RECT = { top: 100, bottom: 300, left: 0, right: 500, width: 500, height: 200, x: 0, y: 100 };
const INSIDE_Y = 150;

// The probe publishes the hook's latest result after every render (in an effect, not in render).
let latest: UseTextRange;

// The fourth argument gives the hook the line text it needs to find a double-clicked word.
function Probe({
  rows,
  resolve,
  lines = diff,
}: {
  rows: DiffRow[];
  resolve: CaretResolver | null;
  lines?: FileDiff;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const result = useTextRange(rows, resolve, () => ref.current, lines);
  useLayoutEffect(() => {
    latest = result;
  });
  return (
    <div
      ref={ref}
      data-testid="probe"
      tabIndex={-1}
      onPointerDown={result.onPointerDown}
      onPointerMove={result.onPointerMove}
      onPointerUp={result.onPointerUp}
      onPointerCancel={result.onPointerCancel}
      onLostPointerCapture={result.onLostPointerCapture}
      onDoubleClick={result.onDoubleClick}
    />
  );
}

function setup(
  resolve: CaretResolver | null = resolver,
  probeRows: DiffRow[] = rows,
  lines: FileDiff = diff,
) {
  const view = render(<Probe rows={probeRows} resolve={resolve} lines={lines} />);
  const el = screen.getByTestId("probe");
  el.getBoundingClientRect = () => ({ ...RECT, toJSON: () => RECT }) as DOMRect;
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.scrollBy = vi.fn() as unknown as typeof el.scrollBy;
  return { ...view, el };
}

const down = (el: HTMLElement, x: number, over: { button?: number; clientY?: number } = {}) =>
  fireEvent.pointerDown(el, {
    button: over.button ?? 0,
    buttons: over.button === 2 ? 2 : 1,
    clientX: x,
    clientY: over.clientY ?? INSIDE_Y,
    pointerId: 1,
  });
// A move during a drag holds the primary button (buttons 1); pointerup has released it.
const move = (el: HTMLElement, x: number, clientY = INSIDE_Y, buttons = 1) =>
  fireEvent.pointerMove(el, { button: -1, buttons, clientX: x, clientY, pointerId: 1 });
const up = (el: HTMLElement, x: number, clientY = INSIDE_Y) =>
  fireEvent.pointerUp(el, { button: 0, buttons: 0, clientX: x, clientY, pointerId: 1 });

beforeEach(() => {
  hits.clear();
  resolver.mockClear();
  // x 10: row 1 offset 3; x 30: row 3 offset 2; x 20: row 2 offset 1; x 40: row 2 offset 4.
  hitAt(10, { row: 1, side: "new", offset: 3 });
  hitAt(20, { row: 2, side: "new", offset: 1 });
  hitAt(30, { row: 3, side: "new", offset: 2 });
  hitAt(40, { row: 2, side: "new", offset: 4 });
  hitAt(50, { row: 5, side: "old", offset: 6 });
});

afterEach(() => {
  vi.useRealTimers();
});

// Contract: a drag from the anchor to the focus makes a range on the anchor's side; tint gives
// each row in it the part to shade (null meaning "to that end of the line").
describe("useTextRange dragging", () => {
  it("should set the range from the pointerdown hit to the pointermove hit", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 3 },
      focus: { row: 3, offset: 2 },
    });
  });

  it("should tint the first row from its offset, interior rows whole and the last row to its offset", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    expect(latest.tint(1)).toEqual({ side: "new", from: 3, to: null });
    expect(latest.tint(2)).toEqual({ side: "new", from: null, to: null });
    expect(latest.tint(3)).toEqual({ side: "new", from: null, to: 2 });
  });

  it("should not tint rows outside the range", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    expect(latest.tint(0)).toBeNull();
    expect(latest.tint(4)).toBeNull();
    expect(latest.tint(7)).toBeNull();
  });

  it("should order the tint when the focus is above the anchor", () => {
    const { el } = setup();
    down(el, 30);
    move(el, 10);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 3, offset: 2 },
      focus: { row: 1, offset: 3 },
    });
    expect(latest.tint(1)).toEqual({ side: "new", from: 3, to: null });
    expect(latest.tint(2)).toEqual({ side: "new", from: null, to: null });
    expect(latest.tint(3)).toEqual({ side: "new", from: null, to: 2 });
  });

  it("should tint a one-row range from the lower offset to the higher", () => {
    const { el } = setup();
    down(el, 40);
    move(el, 20);
    expect(latest.tint(2)).toEqual({ side: "new", from: 1, to: 4 });
    expect(latest.tint(1)).toBeNull();
    expect(latest.tint(3)).toBeNull();
  });

  it("should keep the previous focus when the resolver finds nothing under the pointer", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    move(el, 999);
    expect(latest.range?.focus).toEqual({ row: 3, offset: 2 });
  });

  it("should keep the side fixed at pointerdown when a move lands on the other side", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 50);
    expect(latest.range?.side).toBe("new");
    expect(latest.range?.focus.row).toBe(5);
  });

  it("should not start a range on a pointermove without a pointerdown", () => {
    const { el } = setup();
    move(el, 10);
    move(el, 30);
    expect(latest.range).toBeNull();
  });

  it("should not start a drag when the pointerdown hits nothing", () => {
    const { el } = setup();
    down(el, 999);
    move(el, 30);
    expect(latest.range).toBeNull();
  });
});

// Contract: pointerup ends the drag; a click without movement leaves no range.
describe("useTextRange ending a drag", () => {
  it("should keep the range after pointerup but ignore later moves", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    move(el, 20);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 3 },
      focus: { row: 3, offset: 2 },
    });
  });

  it("should leave no range after a pointerdown and pointerup without a move", () => {
    const { el } = setup();
    down(el, 10);
    up(el, 10);
    expect(latest.range).toBeNull();
  });

  it("should leave no range when the drag ends back on the anchor", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    move(el, 10);
    up(el, 10);
    expect(latest.range).toBeNull();
  });

  it("should clear an existing range on a primary click elsewhere", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    down(el, 20);
    up(el, 20);
    expect(latest.range).toBeNull();
  });
});

// Contract: a touch pointer pans the list instead of dragging a range; mouse and pen still drag.
describe("useTextRange touch", () => {
  const touch = (el: HTMLElement, kind: "pointerDown" | "pointerMove", x: number) =>
    fireEvent[kind](el, {
      button: kind === "pointerDown" ? 0 : -1,
      buttons: 1,
      clientX: x,
      clientY: INSIDE_Y,
      pointerId: 1,
      pointerType: "touch",
    });

  it("should not start a range from a touch drag", () => {
    const { el } = setup();
    touch(el, "pointerDown", 10);
    touch(el, "pointerMove", 30);
    expect(latest.range).toBeNull();
    expect(el.setPointerCapture).not.toHaveBeenCalled();
  });

  it("should still drag a range with a pen", () => {
    const { el } = setup();
    fireEvent.pointerDown(el, {
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: INSIDE_Y,
      pointerId: 1,
      pointerType: "pen",
    });
    move(el, 30);
    expect(latest.range).not.toBeNull();
  });
});

// Contract: only the primary button drags, so a right-click keeps the range for the context menu.
describe("useTextRange other buttons", () => {
  it("should keep the range on a secondary-button pointerdown", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    down(el, 20, { button: 2 });
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 3 },
      focus: { row: 3, offset: 2 },
    });
  });

  it("should not start a drag on a secondary-button pointerdown", () => {
    const { el } = setup();
    down(el, 10, { button: 2 });
    move(el, 30);
    expect(latest.range).toBeNull();
  });
});

// Contract: clear() and a new rows identity both drop the range.
describe("useTextRange reset", () => {
  it("should clear the range on clear()", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    act(() => latest.clear());
    expect(latest.range).toBeNull();
    expect(latest.tint(2)).toBeNull();
  });

  it("should clear the range when rows change identity", () => {
    const { el, rerender } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    rerender(<Probe rows={buildRows(threePairDiff(), "unified")} resolve={resolver} />);
    expect(latest.range).toBeNull();
    expect(latest.tint(2)).toBeNull();
  });

  it("should keep the range when re-rendered with the same rows", () => {
    const { el, rerender } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    rerender(<Probe rows={rows} resolve={resolver} />);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 3 },
      focus: { row: 3, offset: 2 },
    });
  });

  it("should do nothing without a resolver", () => {
    const { el } = setup(null);
    down(el, 10);
    move(el, 30);
    up(el, 30);
    expect(latest.range).toBeNull();
  });
});

// Contract: a double-click selects the maximal run of word characters [A-Za-z0-9_] around the
// resolved offset on the hit's row and side; on whitespace or with no hit nothing changes.
describe("useTextRange double-click", () => {
  const dbl = (el: HTMLElement, x: number) =>
    fireEvent.doubleClick(el, { button: 0, clientX: x, clientY: INSIDE_Y });

  it("should select the word around the offset", () => {
    const { el } = setup(resolver, splitRows);
    hitAt(60, { row: 1, side: "new", offset: 9 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 8 },
      focus: { row: 1, offset: 13 },
    });
    expect(latest.tint(1)).toEqual({ side: "new", from: 8, to: 13 });
  });

  it("should select the word on the old side of the same split row", () => {
    const { el } = setup(resolver, splitRows);
    hitAt(60, { row: 1, side: "old", offset: 5 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "old",
      anchor: { row: 1, offset: 4 },
      focus: { row: 1, offset: 7 },
    });
  });

  it("should select the word on a unified row", () => {
    const { el } = setup();
    hitAt(60, { row: 5, side: "new", offset: 6 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 5, offset: 5 },
      focus: { row: 5, offset: 9 },
    });
  });

  it("should keep the word after the click events that precede a real double-click", () => {
    const { el } = setup(resolver, splitRows);
    hitAt(60, { row: 1, side: "new", offset: 9 });
    down(el, 60);
    up(el, 60);
    down(el, 60);
    up(el, 60);
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 8 },
      focus: { row: 1, offset: 13 },
    });
  });

  it("should select the word that ends at the offset", () => {
    const { el } = setup(resolver, splitRows);
    // "one two THREE": offset 13 is the end of the line, the end of "THREE".
    hitAt(60, { row: 1, side: "new", offset: 13 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 8 },
      focus: { row: 1, offset: 13 },
    });
  });

  it("should select the word ending at the offset when a space follows it", () => {
    const { el } = setup(resolver, splitRows);
    // "one two THREE": offset 7 is the space after "two".
    hitAt(60, { row: 1, side: "new", offset: 7 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 1, offset: 4 },
      focus: { row: 1, offset: 7 },
    });
  });

  it("should leave the range null on a double-click strictly inside whitespace", () => {
    const spaced = fileDiff([hunk([L("addition", "one  two", null, 1)])]);
    const { el } = setup(resolver, buildRows(spaced, "unified"), spaced);
    // "one  two": offset 4 sits between the two spaces.
    hitAt(60, { row: 0, side: "new", offset: 4 });
    dbl(el, 60);
    expect(latest.range).toBeNull();
  });

  it("should select a word with non-ASCII letters whole", () => {
    const cafe = fileDiff([hunk([L("context", "café au lait", 1, 1)])]);
    const { el } = setup(resolver, buildRows(cafe, "split"), cafe);
    hitAt(60, { row: 0, side: "new", offset: 2 });
    dbl(el, 60);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: 0, offset: 0 },
      focus: { row: 0, offset: 4 },
    });
  });

  it("should leave the range null when the resolver finds nothing", () => {
    const { el } = setup(resolver, splitRows);
    dbl(el, 999);
    expect(latest.range).toBeNull();
  });
});

// Split rows of this fixture, found by their line indices rather than assumed:
// a context pair "c", the edited pair "alpha"/"ALPHA", a lone deletion "zeta theta" (empty new
// cell) and a context pair "delta epsilon".
const snapDiff = fileDiff([
  hunk([
    L("context", "c", 1, 1),
    L("deletion", "alpha", 2, null),
    L("deletion", "zeta theta", 3, null),
    L("addition", "ALPHA", null, 2),
    L("context", "delta epsilon", 4, 3),
  ]),
]);
const snapRows = buildRows(snapDiff, "split");
const rowOf = (old: number | null, nu: number | null) =>
  snapRows.findIndex((r) => r.kind === "split" && r.old === old && r.new === nu);

// Contract: in split mode a move onto the other side's cell (or an empty cell) snaps the focus to
// that row on the drag side: its line length there when at or below the anchor row, 0 above it.
// The other cell's offset is never applied to the drag side.
describe("useTextRange split snap", () => {
  const pair = rowOf(1, 3);
  const lone = rowOf(2, null);
  const last = rowOf(4, 4);

  it("should find the fixture's rows", () => {
    expect([pair, lone, last].every((i) => i >= 0)).toBe(true);
    expect(pair).toBeLessThan(lone);
    expect(lone).toBeLessThan(last);
  });

  it("should snap a move onto the new cell below the anchor to the old line's end", () => {
    const { el } = setup(resolver, snapRows, snapDiff);
    hitAt(60, { row: pair, side: "old", offset: 2 });
    hitAt(70, { row: last, side: "new", offset: 2 });
    down(el, 60);
    move(el, 70);
    expect(latest.range).toEqual({
      side: "old",
      anchor: { row: pair, offset: 2 },
      focus: { row: last, offset: "delta epsilon".length },
    });
  });

  it("should snap a move onto the new cell above the anchor to the old line's start", () => {
    const { el } = setup(resolver, snapRows, snapDiff);
    hitAt(60, { row: last, side: "old", offset: 4 });
    hitAt(70, { row: pair, side: "new", offset: 3 });
    down(el, 60);
    move(el, 70);
    expect(latest.range).toEqual({
      side: "old",
      anchor: { row: last, offset: 4 },
      focus: { row: pair, offset: 0 },
    });
  });

  it("should snap a move onto the empty new cell of a lone deletion to the old line's end", () => {
    const { el } = setup(resolver, snapRows, snapDiff);
    hitAt(60, { row: pair, side: "old", offset: 2 });
    // The resolver reports an empty cell with its own side and offset 0.
    hitAt(70, { row: lone, side: "new", offset: 0 });
    down(el, 60);
    move(el, 70);
    expect(latest.range).toEqual({
      side: "old",
      anchor: { row: pair, offset: 2 },
      focus: { row: lone, offset: "zeta theta".length },
    });
  });

  it("should snap a new-side move onto a row with no new line to offset 0", () => {
    const { el } = setup(resolver, snapRows, snapDiff);
    hitAt(60, { row: pair, side: "new", offset: 1 });
    // The empty new cell of the lone deletion, on the drag side but with no line there.
    hitAt(70, { row: lone, side: "new", offset: 7 });
    down(el, 60);
    move(el, 70);
    expect(latest.range).toEqual({
      side: "new",
      anchor: { row: pair, offset: 1 },
      focus: { row: lone, offset: 0 },
    });
  });

  it("should keep a same-side hit's own offset", () => {
    const { el } = setup(resolver, snapRows, snapDiff);
    hitAt(60, { row: pair, side: "old", offset: 2 });
    hitAt(70, { row: last, side: "old", offset: 5 });
    down(el, 60);
    move(el, 70);
    expect(latest.range?.focus).toEqual({ row: last, offset: 5 });
  });
});

// Contract: pointercancel and lostpointercapture end the drag like pointerup (range kept, edge
// scroll stopped); a move with no button held ends the drag instead of extending it; unmounting
// mid-drag cancels the pending frame.
describe("useTextRange drag interruptions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });

  const dragged = {
    side: "new",
    anchor: { row: 1, offset: 3 },
    focus: { row: 3, offset: 2 },
  };

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "should keep the range and stop the edge scroll on %s",
    (kind) => {
      const { el } = setup();
      down(el, 10);
      move(el, 30, RECT.top - 40);
      fireEvent[kind](el, { pointerId: 1 });
      act(() => vi.advanceTimersToNextFrame());
      act(() => vi.advanceTimersToNextFrame());
      expect(el.scrollBy).not.toHaveBeenCalled();
      expect(latest.range).toEqual(dragged);
    },
  );

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "should ignore moves after %s",
    (kind) => {
      const { el } = setup();
      down(el, 10);
      move(el, 30);
      fireEvent[kind](el, { pointerId: 1 });
      move(el, 20);
      expect(latest.range).toEqual(dragged);
    },
  );

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "should leave no range when %s ends a drag back on its anchor",
    (kind) => {
      const { el } = setup();
      down(el, 10);
      move(el, 30);
      move(el, 10);
      fireEvent[kind](el, { pointerId: 1 });
      expect(latest.range).toBeNull();
    },
  );

  it("should end the drag on a move with no button held", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    move(el, 20, INSIDE_Y, 0);
    expect(latest.range).toEqual(dragged);
    move(el, 40);
    expect(latest.range).toEqual(dragged);
  });

  it("should stop the edge scroll on a move with no button held", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30, RECT.top - 40);
    move(el, 30, RECT.top - 40, 0);
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).not.toHaveBeenCalled();
  });

  it("should not scroll after unmounting mid-drag", () => {
    const { el, unmount } = setup();
    down(el, 10);
    move(el, 30, RECT.top - 40);
    unmount();
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).not.toHaveBeenCalled();
  });
});

// Contract: a move delivered after rows changed identity never builds a range from the old drag.
describe("useTextRange refetch race", () => {
  it("should not make a range from a move handler that outlived its rows", () => {
    const { el, rerender } = setup();
    down(el, 10);
    const staleMove = latest.onPointerMove;
    rerender(<Probe rows={buildRows(diff, "unified")} resolve={resolver} />);
    act(() =>
      staleMove({
        buttons: 1,
        clientX: 30,
        clientY: INSIDE_Y,
        pointerId: 1,
        currentTarget: el,
        target: el,
      } as unknown as PointerEvent),
    );
    expect(latest.range).toBeNull();
  });
});

// Contract: x, like y, is clamped into the container before it reaches the resolver.
describe("useTextRange x clamp", () => {
  it.each([
    ["left of", -50],
    ["right of", RECT.right + 50],
  ])("should clamp a clientX %s the container into it", (_where, clientX) => {
    const { el } = setup();
    down(el, 10);
    resolver.mockClear();
    move(el, clientX);
    const [x] = resolver.mock.calls[0];
    expect(x).toBeGreaterThanOrEqual(RECT.left);
    expect(x).toBeLessThanOrEqual(RECT.right);
  });
});

// Contract: the drag captures the pointer and focuses the container.
describe("useTextRange pointer capture and focus", () => {
  it("should capture the pointer on pointerdown", () => {
    const { el } = setup();
    down(el, 10);
    expect(el.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should release the pointer on pointerup", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    up(el, 30);
    expect(el.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should focus the container on pointerdown", () => {
    const { el } = setup();
    down(el, 10);
    expect(document.activeElement).toBe(el);
  });
});

// Contract: dragging past the container's top or bottom edge scrolls it 16 px per animation frame,
// and the focus is resolved with clientY clamped into the container.
describe("useTextRange edge scroll", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });

  it("should scroll up on the next frame while the pointer is above the container", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30, RECT.top - 40);
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).toHaveBeenCalledWith(0, -16);
  });

  it("should scroll down on the next frame while the pointer is below the container", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30, RECT.bottom + 40);
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).toHaveBeenCalledWith(0, 16);
  });

  it("should keep scrolling every frame while the pointer stays outside", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30, RECT.top - 40);
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).toHaveBeenCalledTimes(2);
  });

  it("should not scroll while the pointer is inside the container", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30);
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).not.toHaveBeenCalled();
  });

  it("should stop scrolling after pointerup", () => {
    const { el } = setup();
    down(el, 10);
    move(el, 30, RECT.top - 40);
    up(el, 30, RECT.top - 40);
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(el.scrollBy).not.toHaveBeenCalled();
  });

  it("should resolve the focus with clientY clamped into the container", () => {
    const { el } = setup();
    down(el, 10);
    resolver.mockClear();
    move(el, 30, RECT.top - 40);
    const [x, y] = resolver.mock.calls[0];
    expect(x).toBe(30);
    expect(y).toBeGreaterThanOrEqual(RECT.top);
    expect(y).toBeLessThanOrEqual(RECT.bottom);
    expect(latest.range?.focus).toEqual({ row: 3, offset: 2 });
  });
});
