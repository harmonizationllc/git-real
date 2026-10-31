import { useEffect, useEffectEvent, useRef } from "react";
import type { RefObject } from "react";

/** A commit and the row index it was shown at. */
export interface TopRow {
  oid: string;
  index: number;
}

export interface TopAnchorOptions {
  generation: number;
  /** The first visible row (overscan excluded) once its page is loaded; undefined otherwise. */
  top: TopRow | undefined;
  /**
   * The verified row of `oid` in the current generation, or undefined when it is absent or
   * `wanted` turned false while looking.
   */
  locate(oid: string, wanted: () => boolean): Promise<number | undefined>;
  /** Scrolls row `index` to the top of the viewport. */
  scrollToStart(index: number): void;
  /** The list's scroll element; user scroll input there cancels a pending anchor. */
  scrollRef: RefObject<HTMLElement | null>;
}

/**
 * The inputs by which a user scrolls the list. A `scroll` event is not one: the browser also
 * fires it when it clamps `scrollTop` to a list that got shorter.
 */
const USER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/** Swallows a rejection whose only consequence would be a missing scroll. */
const ignore = () => undefined;

/**
 * Keeps the viewport on commits rather than row numbers: when the generation changes, the commit
 * that was at the top of a scrolled list is located in the new generation and scrolled back to
 * the top. A list showing its first row, a commit gone from the new graph, a user scroll during
 * the lookup and an unmount all leave the scroll where it is.
 */
export function useTopAnchor({
  generation,
  top,
  locate,
  scrollToStart,
  scrollRef,
}: TopAnchorOptions): void {
  const recorded = useRef<TopRow | null>(null);
  const anchoredGeneration = useRef(generation);
  // Latest wins: a newer anchor, a user scroll or an unmount bumps it and drops the older one.
  const seq = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    const cancel = () => {
      seq.current += 1;
    };
    for (const type of USER_SCROLL_EVENTS) el?.addEventListener(type, cancel, { passive: true });
    return () => {
      for (const type of USER_SCROLL_EVENTS) el?.removeEventListener(type, cancel);
      cancel();
    };
  }, [scrollRef]);

  const anchor = useEffectEvent((previous: TopRow) => {
    const n = ++seq.current;
    const wanted = () => n === seq.current;
    locate(previous.oid, wanted)
      .then((index) => {
        if (index !== undefined && wanted()) scrollToStart(index);
      })
      .catch(ignore);
  });

  // Declared before the effect that records the top, so it reads the top of the previous
  // generation before the new one overwrites it.
  useEffect(() => {
    if (anchoredGeneration.current === generation) return;
    anchoredGeneration.current = generation;
    const previous = recorded.current;
    if (previous === null || previous.index === 0) return;
    anchor(previous);
  }, [generation]);

  const topOid = top?.oid;
  const topIndex = top?.index;
  useEffect(() => {
    if (topOid !== undefined && topIndex !== undefined) {
      recorded.current = { oid: topOid, index: topIndex };
    }
  }, [topOid, topIndex]);
}
