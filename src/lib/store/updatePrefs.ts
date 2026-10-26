import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How long a completed check stays fresh before the startup hook checks again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long after mount the startup check waits, so launch is not slowed. */
export const STARTUP_DELAY_MS = 10_000;

interface UpdatePrefsState {
  /** Whether the app checks for updates on startup. */
  checkOnStartup: boolean;
  /** Epoch ms of the last completed startup check, or null if never. */
  lastCheckedAt: number | null;
  setCheckOnStartup(on: boolean): void;
  markChecked(at: number): void;
}

/** The update-check preferences; survives restarts via localStorage. */
export const useUpdatePrefs = create<UpdatePrefsState>()(
  persist(
    (set) => ({
      checkOnStartup: true,
      lastCheckedAt: null,
      setCheckOnStartup: (on) => set({ checkOnStartup: on }),
      markChecked: (at) => set({ lastCheckedAt: at }),
    }),
    {
      name: "git-real.updatePrefs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ checkOnStartup: s.checkOnStartup, lastCheckedAt: s.lastCheckedAt }),
    },
  ),
);
