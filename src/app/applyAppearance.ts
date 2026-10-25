import {
  DEFAULT_MONO,
  useAppearancePrefs,
  type ThemePref,
} from "../lib/store/appearancePrefs";

export { DEFAULT_MONO };

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

/** Applies the stored appearance now and on every later change; returns the unsubscribe. */
export function bootstrapAppearance(): () => void {
  applyAppearance(useAppearancePrefs.getState());
  return useAppearancePrefs.subscribe((state) => applyAppearance(state));
}
