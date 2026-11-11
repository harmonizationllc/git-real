import { createEvent, fireEvent, render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { isScrollbarPress, useScrollRangeHold } from "./useScrollRangeHold";

/** A 500 × 300 client box inside a 517 × 317 border box: a 17 px scrollbar right and below. */
const element = (clientWidth = 500, clientHeight = 300) => {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: clientWidth });
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 517, bottom: 317, width: 517, height: 317 }) as DOMRect;
  return el;
};
const press = (el: HTMLElement, clientX: number, clientY = 50, button = 0) =>
  fireEvent.pointerDown(el, { clientX, clientY, button, buttons: 1, pointerId: 1 });

const rows: readonly unknown[] = [1, 2, 3];

interface Props {
  total: number;
  rows: readonly unknown[];
}

function setup(el: HTMLElement, total = 1000) {
  return renderHook(({ total, rows }: Props) => useScrollRangeHold(el, total, rows), {
    initialProps: { total, rows },
  });
}

// Contract: only a primary press on the element's own scrollbar, outside its client box, counts.
describe("isScrollbarPress", () => {
  const at = (el: HTMLElement, clientX: number, clientY = 50, button = 0, target = el) =>
    isScrollbarPress(el, { target, clientX, clientY, button });

  it("should accept a press on the vertical scrollbar", () => {
    expect(at(element(), 510)).toBe(true);
  });

  it("should accept a press on the horizontal scrollbar below the client box", () => {
    expect(at(element(), 100, 310)).toBe(true);
  });

  it("should reject a press inside the client box", () => {
    expect(at(element(), 100, 50)).toBe(false);
  });

  it("should reject a non-primary button", () => {
    expect(at(element(), 510, 50, 1)).toBe(false);
  });

  it("should reject a press whose target is a child of the element", () => {
    const el = element();
    const child = document.createElement("span");
    el.append(child);
    expect(at(el, 510, 50, 0, child)).toBe(false);
  });
});

// Contract: the height follows the total, except from a scrollbar press until it is released.
describe("useScrollRangeHold", () => {
  it("should return the total while nothing is held", () => {
    const { result, rerender } = setup(element());
    expect(result.current).toBe(1000);
    rerender({ total: 1200, rows });
    expect(result.current).toBe(1200);
  });

  it("should hold the total at press time", () => {
    const el = element();
    const { result, rerender } = setup(el);
    rerender({ total: 1100, rows });
    press(el, 510);
    rerender({ total: 1500, rows });
    expect(result.current).toBe(1100);
  });

  it("should hold the committed total for a press before passive effects flush", () => {
    const el = element();
    let height = 0;
    function Viewer({ total }: { total: number }) {
      height = useScrollRangeHold(el, total, rows);
      return null;
    }
    // Presses from a later sibling's layout effect: after this commit, before its passive effects.
    function Presser({ now }: { now: boolean }) {
      useLayoutEffect(() => {
        if (now) el.dispatchEvent(createEvent.pointerDown(el, { clientX: 510, clientY: 50 }));
      }, [now]);
      return null;
    }
    const tree = (total: number, now: boolean) => (
      <>
        <Viewer total={total} />
        <Presser now={now} />
      </>
    );
    const { rerender } = render(tree(1000, false));
    rerender(tree(1100, true));
    rerender(tree(1500, true));
    expect(height).toBe(1100);
  });

  it("should not hold on a press inside the rows", () => {
    const el = element();
    const { result, rerender } = setup(el);
    press(el, 100);
    rerender({ total: 1500, rows });
    expect(result.current).toBe(1500);
  });

  it("should release on pointerup anywhere", () => {
    const el = element();
    const { result, rerender } = setup(el, 1100);
    press(el, 510);
    rerender({ total: 1500, rows });
    expect(result.current).toBe(1100);
    fireEvent.pointerUp(window);
    expect(result.current).toBe(1500);
  });

  it("should release on pointercancel anywhere", () => {
    const el = element();
    const { result, rerender } = setup(el, 1100);
    press(el, 510);
    rerender({ total: 1500, rows });
    fireEvent.pointerCancel(window);
    expect(result.current).toBe(1500);
  });

  it("should release on a pointermove with no buttons held", () => {
    const el = element();
    const { result, rerender } = setup(el, 1100);
    press(el, 510);
    rerender({ total: 1500, rows });
    fireEvent.pointerMove(window, { buttons: 1 });
    expect(result.current).toBe(1100);
    fireEvent.pointerMove(window, { buttons: 0 });
    expect(result.current).toBe(1500);
  });

  it("should release on window blur", () => {
    const el = element();
    const { result, rerender } = setup(el, 1100);
    press(el, 510);
    rerender({ total: 1500, rows });
    fireEvent.blur(window);
    expect(result.current).toBe(1500);
  });

  it("should release when the rows change", () => {
    const el = element();
    const { result, rerender } = setup(el, 1100);
    press(el, 510);
    rerender({ total: 1500, rows: [...rows] });
    expect(result.current).toBe(1500);
  });

  it("should detach its listeners on unmount", () => {
    const error = vi.spyOn(console, "error");
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const el = element();
      const { unmount } = setup(el);
      press(el, 510);
      expect(add).toHaveBeenCalled();
      unmount();
      expect(remove.mock.calls).toEqual(add.mock.calls);
      expect(() => fireEvent.pointerUp(window)).not.toThrow();
      expect(() => press(el, 510)).not.toThrow();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
