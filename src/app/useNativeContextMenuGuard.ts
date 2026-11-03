import { useEffect } from "react";

const EDITABLE =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Suppresses the webview's own context menu everywhere except inside a text-editing element, where
 * it still offers cut/copy/paste (GR-53). WebKitGTK's native menu has a Reload item that reloads
 * the webview and drops the app's in-memory state, closing every repository. Components with their
 * own `ContextMenu` already `preventDefault`, so they are unaffected.
 */
export function useNativeContextMenuGuard(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as Element).closest(EDITABLE) === null) e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
