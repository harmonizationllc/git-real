import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const REFS_DEFAULT = 240;
export const SIDEBAR_DEFAULT = 320;

export type LayoutColumn = "refs" | "sidebar";

/** Which of a hosted repository's clone URLs the clone dialog fills in. */
export type CloneUrlForm = "https" | "ssh";

interface LayoutPrefsState {
  refsWidth: number;
  sidebarWidth: number;
  setRefsWidth(px: number): void;
  setSidebarWidth(px: number): void;
  reset(column: LayoutColumn): void;
  /** The Tags section is collapsed; app-wide, like the widths. */
  tagsCollapsed: boolean;
  setTagsCollapsed(collapsed: boolean): void;
  /** The Pull requests section is collapsed; app-wide, like the widths. */
  pullRequestsCollapsed: boolean;
  setPullRequestsCollapsed(collapsed: boolean): void;
  /** The Issues section is collapsed; app-wide, like the widths. */
  issuesCollapsed: boolean;
  setIssuesCollapsed(collapsed: boolean): void;
  /** The clone dialog's HTTPS/SSH choice for a picked repository; app-wide. */
  cloneUrlForm: CloneUrlForm;
  setCloneUrlForm(form: CloneUrlForm): void;
}

/** Column widths, the Tags, Pull requests and Issues sections' collapsed state and the clone URL form, shared by every repository tab; survives restarts via localStorage. */
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
      pullRequestsCollapsed: false,
      setPullRequestsCollapsed: (pullRequestsCollapsed) => set({ pullRequestsCollapsed }),
      issuesCollapsed: true,
      setIssuesCollapsed: (issuesCollapsed) => set({ issuesCollapsed }),
      cloneUrlForm: "https",
      setCloneUrlForm: (cloneUrlForm) => set({ cloneUrlForm }),
    }),
    {
      name: "git-real.layoutPrefs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        refsWidth: s.refsWidth,
        sidebarWidth: s.sidebarWidth,
        tagsCollapsed: s.tagsCollapsed,
        pullRequestsCollapsed: s.pullRequestsCollapsed,
        issuesCollapsed: s.issuesCollapsed,
        cloneUrlForm: s.cloneUrlForm,
      }),
    },
  ),
);
