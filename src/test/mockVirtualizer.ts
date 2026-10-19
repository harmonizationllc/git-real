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
 * How many leading items the fake reports as rendered. Infinity (the default) renders every row;
 * a finite size models a scrolled window so "not rendered" differs from "not loaded". Tests that
 * change it must reset it in beforeEach.
 */
export const mockWindow = { size: Infinity };

/** Renders every row, and calls each option callback the way the real hook would. */
export function useVirtualizer({ count, getScrollElement, estimateSize, getItemKey }: Options) {
  getScrollElement();
  const items = Array.from({ length: Math.min(count, mockWindow.size) }, (_, index) => ({
    index,
    key: getItemKey(index),
    start: index * estimateSize(index),
    size: estimateSize(index),
  }));
  return {
    getTotalSize: () => count * 22,
    getVirtualItems: () => items,
    measureElement,
    scrollToIndex,
    scrollElement: null,
  };
}
