import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threePairDiff } from "../../test/diffFixtures";
import type { CaretHit, CaretResolver } from "./caretResolver";
import { buildRows, type DiffRow } from "./model/rows";
import { useTextRange, type UseTextRange } from "./useTextRange";

// Unified rows of the three-pair fixture: ctx0, del1, del2, del3, add4, add5, add6, ctx7.
const rows = buildRows(threePairDiff(), "unified");

// The scripted resolver answers by clientX only, so a clamped clientY never changes the hit.
const hits = new Map<number, CaretHit>();
const hitAt = (x: number, hit: CaretHit) => hits.set(x, hit);
const resolver = vi.fn<CaretResolver>((x) => hits.get(x) ?? null);

const RECT = { top: 100, bottom: 300, left: 0, right: 500, width: 500, height: 200, x: 0, y: 100 };
const INSIDE_Y = 150;

// The probe publishes the hook's latest result after every render (in an effect, not in render).
let latest: UseTextRange;

function Probe({ rows, resolve }: { rows: DiffRow[]; resolve: CaretResolver | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const result = useTextRange(rows, resolve, () => ref.current);
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
    />
  );
}

function setup(resolve: CaretResolver | null = resolver) {
  const view = render(<Probe rows={rows} resolve={resolve} />);
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
    clientX: x,
    clientY: over.clientY ?? INSIDE_Y,
    pointerId: 1,
  });
const move = (el: HTMLElement, x: number, clientY = INSIDE_Y) =>
  fireEvent.pointerMove(el, { button: 0, clientX: x, clientY, pointerId: 1 });
const up = (el: HTMLElement, x: number, clientY = INSIDE_Y) =>
  fireEvent.pointerUp(el, { button: 0, clientX: x, clientY, pointerId: 1 });

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
