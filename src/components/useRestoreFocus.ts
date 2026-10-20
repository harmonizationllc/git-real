import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** An element focus can go back to: still in the document, enabled, and not the body. */
const restorable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el !== document.body && el.isConnected && !el.matches(":disabled");

/**
 * On unmount, returns focus to the element that held it at mount if it can still take it;
 * otherwise to the fallback's element at that moment. An opener that is gone, disabled or never
 * had focus (WebKit does not focus clicked buttons) cannot take it back.
 * Call it before the effect that moves focus into the dialog: layout effects run in call order,
 * so it must read document.activeElement first. The fallback is read from the latest render, so
 * a new ref object on re-render neither restores focus early nor goes stale.
 * StrictMode (development only): the simulated unmount runs the restore once at mount, so with no
 * restorable opener the fallback takes focus and the remount records it as the opener. Close then
 * focuses that element (the fallback's element at mount, not at close). Production mounts once.
 */
export function useRestoreFocus(fallbackFocus?: RefObject<HTMLElement | null>): void {
  const latest = useRef(fallbackFocus);
  useLayoutEffect(() => {
    latest.current = fallbackFocus;
  });
  useLayoutEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (restorable(previous)) previous.focus();
      // Reading the ref at close is the point: the host may have re-rendered its element.
      else latest.current?.current?.focus();
    };
  }, []);
}
