import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** An element focus can go back to: still in the document, enabled, and not the body. */
const restorable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el !== document.body && el.isConnected && !el.matches(":disabled");

/**
 * On unmount, returns focus to the element that held it at mount if it can still take it;
 * otherwise to the fallback's element at that moment. An opener that is gone, disabled or never
 * had focus (WebKit does not focus clicked buttons) cannot take it back.
 * Call it before the effect that moves focus into the dialog: layout effects run in call order,
 * so it must read document.activeElement first. Pass a stable ref (useRef).
 */
export function useRestoreFocus(fallbackFocus?: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (restorable(previous)) previous.focus();
      // Reading the ref at close is the point: the host may have re-rendered its element.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      else fallbackFocus?.current?.focus();
    };
  }, [fallbackFocus]);
}
