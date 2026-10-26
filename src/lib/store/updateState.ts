import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How long a completed check stays fresh before the startup hook checks again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long after mount the startup check waits, so launch is not slowed. */
export const STARTUP_DELAY_MS = 10_000;

interface UpdateState {
  /** Epoch ms of the last completed startup check, or null if never. */
  lastCheckedAt: number | null;
  markChecked(at: number): void;
}

/** When the startup update check last ran; browser state, not a preference, so it stays out of settings.json. */
export const useUpdateState = create<UpdateState>()(
  persist(
    (set) => ({
      lastCheckedAt: null,
      markChecked: (at) => set({ lastCheckedAt: at }),
    }),
    {
      name: "git-real.updateState",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lastCheckedAt: s.lastCheckedAt }),
    },
  ),
);
