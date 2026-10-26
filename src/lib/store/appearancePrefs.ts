import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ThemePref = "system" | "light" | "dark";

/** The CSS `--font-mono` stack used when no diff font family is set. */
export const DEFAULT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const DIFF_FONT_MIN = 10;
export const DIFF_FONT_MAX = 24;
export const DIFF_FONT_DEFAULT = 13;

interface AppearancePrefsState {
  theme: ThemePref;
  diffFontFamily: string | null;
  diffFontSize: number;
  setTheme(t: ThemePref): void;
  setDiffFontFamily(f: string | null): void;
  setDiffFontSize(px: number): void;
}

/** Window theme and diff font, applied to `<html>` before React paints; survives restarts via localStorage. */
export const useAppearancePrefs = create<AppearancePrefsState>()(
  persist(
    (set) => ({
      theme: "system",
      diffFontFamily: null,
      diffFontSize: DIFF_FONT_DEFAULT,
      setTheme: (theme) => set({ theme }),
      setDiffFontFamily: (f) => {
        const trimmed = f === null ? null : f.trim();
        set({ diffFontFamily: trimmed ? trimmed : null });
      },
      setDiffFontSize: (px) => {
        if (Number.isNaN(px)) return;
        const clamped = Math.min(DIFF_FONT_MAX, Math.max(DIFF_FONT_MIN, Math.round(px)));
        set({ diffFontSize: clamped });
      },
    }),
    {
      name: "git-real.appearancePrefs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        theme: s.theme,
        diffFontFamily: s.diffFontFamily,
        diffFontSize: s.diffFontSize,
      }),
    },
  ),
);
