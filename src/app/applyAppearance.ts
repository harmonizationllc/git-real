import { syncWindowBackground, type ThemePref } from "../lib/ipc";
import { installFlushOnPagehide, useSettings } from "../lib/store/settings";
import { detectPlatform } from "../lib/platform";
import { startFontWarmup } from "./fontWarmup";

export interface AppearanceSnapshot {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
}

/**
 * Writes the appearance snapshot onto `root`: `data-theme` (absent for `system`), `data-platform`,
 * and the two font tokens. A null diff font family removes the inline `--font-mono`, so the
 * stylesheet's `--font-mono` (which follows the per-platform `--font-mono-ui`) applies.
 */
export function applyAppearance(
  prefs: AppearanceSnapshot,
  root: HTMLElement = document.documentElement,
): void {
  if (prefs.theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", prefs.theme);
  }
  root.setAttribute("data-platform", detectPlatform());
  if (prefs.diffFontFamily === null) {
    // Guard: happy-dom's removeProperty calls removeAttribute("style"), which trips the no-removeAttribute test.
    if (root.style.getPropertyValue("--font-mono") !== "") root.style.removeProperty("--font-mono");
  } else {
    root.style.setProperty("--font-mono", prefs.diffFontFamily);
  }
  root.style.setProperty("--diff-font-size", `${prefs.diffFontSize}px`);
}

/**
 * Applies the injected appearance now, follows later settings changes, saves pending edits when the
 * window goes away, and reconciles with the backend once; returns the uninstaller.
 *
 * After launch the page is the only writer of the native window background: it reports every theme
 * change in the store, and every desktop colour-scheme change while the theme is `system`, to Rust.
 * Reports go one at a time in the order they were made, each carrying the theme and scheme read when
 * it was requested; a failed report does not hold up the next. Rust already coloured the window at
 * creation, so there is no startup sync.
 */
export function bootstrapAppearance(): () => void {
  applyAppearance(useSettings.getState().settings.appearance);
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  let busy = false;
  const waiting: Array<() => void> = [];
  const requestSync = () => {
    const theme = useSettings.getState().settings.appearance.theme;
    const dark = mql.matches;
    const run = () => {
      busy = true;
      // The executor runs at once, so an idle send stays synchronous; a synchronous throw becomes
      // a rejection, so it cannot leave the queue busy.
      void new Promise<void>((resolve) => resolve(syncWindowBackground(theme, dark)))
        .catch(() => {})
        .finally(() => {
          busy = false;
          waiting.shift()?.();
        });
    };
    if (busy) waiting.push(run);
    else run();
  };
  const onSchemeChange = () => {
    if (useSettings.getState().settings.appearance.theme === "system") requestSync();
  };
  mql.addEventListener("change", onSchemeChange);
  const unsubscribe = useSettings.subscribe((state, prev) => {
    if (state.settings.appearance !== prev.settings.appearance) {
      applyAppearance(state.settings.appearance);
      startFontWarmup();
      if (state.settings.appearance.theme !== prev.settings.appearance.theme) requestSync();
    }
  });
  const uninstallFlush = installFlushOnPagehide();
  void useSettings.getState().reconcile();
  return () => {
    unsubscribe();
    uninstallFlush();
    mql.removeEventListener("change", onSchemeChange);
  };
}
