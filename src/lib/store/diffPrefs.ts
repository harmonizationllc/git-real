import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type DiffMode = "split" | "unified";

interface DiffPrefsState {
  mode: DiffMode;
  ignoreWhitespace: boolean;
  setMode(mode: DiffMode): void;
  setIgnoreWhitespace(on: boolean): void;
}

/** Viewer preferences shared by every repository tab; survives restarts via localStorage. */
export const useDiffPrefs = create<DiffPrefsState>()(
  persist(
    (set) => ({
      mode: "split",
      ignoreWhitespace: false,
      setMode: (mode) => set({ mode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
    }),
    {
      name: "git-real.diffPrefs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ mode: s.mode, ignoreWhitespace: s.ignoreWhitespace }),
    },
  ),
);
