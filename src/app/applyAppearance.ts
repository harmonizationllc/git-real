import { syncWindowBackground, type ThemePref } from "../lib/ipc";
import { installFlushOnPagehide, useSettings } from "../lib/store/settings";
import type { Platform } from "../styles/fontTokens";
import { startFontWarmup } from "./fontWarmup";

export interface AppearanceSnapshot {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
}

/**
 * Maps `navigator.platform` to the `data-platform` value that tokens.css uses to pick the monospace
 * UI family (`--font-mono-ui`). Anything that is not macOS or Windows is `linux`.
 */
export function detectPlatform(platform: string = navigator.platform): Platform {
  if (platform.startsWith("Mac")) return "macos";
  if (platform.startsWith("Win")) return "windows";
  return "linux";
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
 * While the theme is `system`, desktop colour-scheme changes are reported to Rust so the window
 * background follows them: on Linux the page is the only reliable source after launch. Rust already
 * coloured the window at creation, so there is no startup sync.
 */
export function bootstrapAppearance(): () => void {
  applyAppearance(useSettings.getState().settings.appearance);
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (useSettings.getState().settings.appearance.theme === "system") {
      void syncWindowBackground(mql.matches);
    }
  };
  mql.addEventListener("change", onSchemeChange);
  const unsubscribe = useSettings.subscribe((state, prev) => {
    if (state.settings.appearance !== prev.settings.appearance) {
      applyAppearance(state.settings.appearance);
      startFontWarmup();
      if (
        state.settings.appearance.theme === "system" &&
        prev.settings.appearance.theme !== "system"
      ) {
        void syncWindowBackground(mql.matches);
      }
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
