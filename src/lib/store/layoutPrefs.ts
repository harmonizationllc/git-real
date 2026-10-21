import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const REFS_DEFAULT = 240;
export const SIDEBAR_DEFAULT = 320;

export type LayoutColumn = "refs" | "sidebar";

interface LayoutPrefsState {
  refsWidth: number;
  sidebarWidth: number;
  setRefsWidth(px: number): void;
  setSidebarWidth(px: number): void;
  reset(column: LayoutColumn): void;
  /** The Tags section is collapsed; app-wide, like the widths. */
  tagsCollapsed: boolean;
  setTagsCollapsed(collapsed: boolean): void;
}

/** Column widths and the Tags section's collapsed state, shared by every repository tab; survives restarts via localStorage. */
export const useLayoutPrefs = create<LayoutPrefsState>()(
  persist(
    (set) => ({
      refsWidth: REFS_DEFAULT,
      sidebarWidth: SIDEBAR_DEFAULT,
      setRefsWidth: (refsWidth) => set({ refsWidth }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      reset: (column) =>
        set(column === "refs" ? { refsWidth: REFS_DEFAULT } : { sidebarWidth: SIDEBAR_DEFAULT }),
      tagsCollapsed: true,
      setTagsCollapsed: (tagsCollapsed) => set({ tagsCollapsed }),
    }),
    {
      name: "git-real.layoutPrefs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        refsWidth: s.refsWidth,
        sidebarWidth: s.sidebarWidth,
        tagsCollapsed: s.tagsCollapsed,
      }),
    },
  ),
);
