import type { Key } from "react";
import { vi } from "vitest";

// happy-dom has no layout, so the real virtualizer would render nothing. Tests load this
// module as a fake through a hoisted factory:
//   vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

interface Options {
  count: number;
  getScrollElement(): Element | null;
  estimateSize(index: number): number;
  getItemKey(index: number): Key;
}

const measureElement = (): void => undefined; // stable, like the real instance method
/** Stable and shared so tests can assert calls; reset it in beforeEach where it is used. */
export const scrollToIndex =
  vi.fn<(index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void>();

/**
 * The window the fake reports as rendered: `size` items from index `start`. Infinity (the
 * default size) renders every row; a finite size models a scrolled window so "not rendered"
 * differs from "not loaded", and a `start` above 0 models a list scrolled down. `visibleStart`
 * is the first visible row the fake reports as `range.startIndex` (null means `start`), so a
 * test can model overscan rendering rows above the viewport. Tests that change any of them must
 * reset them in beforeEach.
 */
export const mockWindow = { size: Infinity, start: 0, visibleStart: null as number | null };

/** Renders every row, and calls each option callback the way the real hook would. */
export function useVirtualizer({ count, getScrollElement, estimateSize, getItemKey }: Options) {
  getScrollElement();
  const first = Math.min(mockWindow.start, count);
  const length = Math.min(count - first, mockWindow.size);
  const items = Array.from({ length }, (_, i) => {
    const index = first + i;
    return {
      index,
      key: getItemKey(index),
      start: index * estimateSize(index),
      size: estimateSize(index),
    };
  });
  const range =
    length === 0
      ? null
      : { startIndex: mockWindow.visibleStart ?? first, endIndex: first + length - 1 };
  return {
    range,
    getTotalSize: () => count * 22,
    getVirtualItems: () => items,
    measureElement,
    scrollToIndex,
    scrollElement: null,
  };
}
