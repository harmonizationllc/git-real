import type { Key } from "react";

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

/** Renders every row, and calls each option callback the way the real hook would. */
export function useVirtualizer({ count, getScrollElement, estimateSize, getItemKey }: Options) {
  getScrollElement();
  const items = Array.from({ length: count }, (_, index) => ({
    index,
    key: getItemKey(index),
    start: index * estimateSize(index),
    size: estimateSize(index),
  }));
  return { getTotalSize: () => count * 22, getVirtualItems: () => items, measureElement };
}
