import { useEffect, useRef, useState } from "react";

/**
 * True for a primary-button press on `el`'s own scrollbar: the target is `el` itself (never a
 * row inside it) and the point lies outside its client box, right of it or below it.
 */
export function isScrollbarPress(
  el: HTMLElement,
  e: Pick<PointerEvent, "target" | "clientX" | "clientY" | "button">,
): boolean {
  if (e.button !== 0 || e.target !== el) return false;
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left - el.clientLeft;
  const y = e.clientY - rect.top - el.clientTop;
  return x >= el.clientWidth || y >= el.clientHeight;
}

/**
 * The height to give a virtualized list's inner element: `total`, except from a press on the
 * scroll element's scrollbar until the button is released, when it stays at the total the press
 * saw. Chromium (WebView2) drops a scrollbar thumb drag's motion whenever the scroller's length
 * changes under it, which measuring rows mid-drag would do; WebKitGTK is unaffected. A release
 * is a `pointerup` or `pointercancel` anywhere, a window `blur`, a `pointermove` with no buttons
 * held (the release happened where no event reached us), or `rows` changing identity.
 */
export function useScrollRangeHold(
  scrollEl: HTMLElement | null,
  total: number,
  rows: readonly unknown[],
): number {
  const [held, setHeld] = useState<number | null>(null);
  const [seenRows, setSeenRows] = useState(rows);

  // Reset during render (not in an effect) so new rows never paint at a stale height.
  let height = held;
  if (seenRows !== rows) {
    setSeenRows(rows);
    setHeld(null);
    height = null;
  }

  // Read at press time, so the hold starts from the latest render's total.
  const totalRef = useRef(total);
  useEffect(() => {
    totalRef.current = total;
  });

  useEffect(() => {
    if (!scrollEl) return;
    const onDown = (e: PointerEvent) => {
      if (isScrollbarPress(scrollEl, e)) setHeld(totalRef.current);
    };
    scrollEl.addEventListener("pointerdown", onDown);
    return () => scrollEl.removeEventListener("pointerdown", onDown);
  }, [scrollEl]);

  const holding = held !== null;
  useEffect(() => {
    if (!holding) return;
    const release = () => setHeld(null);
    const onMove = (e: PointerEvent) => {
      if (e.buttons === 0) release();
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    window.addEventListener("pointermove", onMove, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointermove", onMove, true);
    };
  }, [holding]);

  return height ?? total;
}
