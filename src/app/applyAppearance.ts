import type { ThemePref } from "../lib/ipc";
import { installFlushOnPagehide, useSettings } from "../lib/store/settings";

/** The CSS `--font-mono` stack used when no diff font family is set. */
export const DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface AppearanceSnapshot {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
}

/** Writes the appearance snapshot onto `root`: `data-theme` (absent for `system`) and the two font tokens. */
export function applyAppearance(
  prefs: AppearanceSnapshot,
  root: HTMLElement = document.documentElement,
): void {
  if (prefs.theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", prefs.theme);
  }
  root.style.setProperty("--font-mono", prefs.diffFontFamily ?? DEFAULT_MONO);
  root.style.setProperty("--diff-font-size", `${prefs.diffFontSize}px`);
}

/**
 * Applies the injected appearance now, follows later settings changes, saves pending edits when the
 * window goes away, and reconciles with the backend once; returns the uninstaller.
 */
export function bootstrapAppearance(): () => void {
  applyAppearance(useSettings.getState().settings.appearance);
  const unsubscribe = useSettings.subscribe((state, prev) => {
    if (state.settings.appearance !== prev.settings.appearance) {
      applyAppearance(state.settings.appearance);
    }
  });
  const uninstallFlush = installFlushOnPagehide();
  void useSettings.getState().reconcile();
  return () => {
    unsubscribe();
    uninstallFlush();
  };
}
