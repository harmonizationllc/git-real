import { create } from "zustand";
import type { OpenedRepo, RepoId, RepoSummary } from "../ipc";

export interface RepoTab {
  id: RepoId;
  summary: RepoSummary;
}

interface RepoTabsState {
  tabs: RepoTab[];
  activeId: RepoId | null;
  openTab(repo: OpenedRepo): void;
  closeTab(id: RepoId): void;
  /** Move the tab with `id` so it ends up at `toIndex`; out-of-range or no-op moves change nothing. */
  moveTab(id: RepoId, toIndex: number): void;
  activate(id: RepoId | null): void;
}

export const useRepoTabs = create<RepoTabsState>()((set) => ({
  tabs: [],
  activeId: null,
  openTab: (repo) =>
    set((state) => {
      const existing = state.tabs.find(
        (t) => t.id === repo.id || t.summary.path === repo.summary.path,
      );
      if (!existing) {
        return {
          tabs: [...state.tabs, { id: repo.id, summary: repo.summary }],
          activeId: repo.id,
        };
      }
      return {
        tabs: state.tabs.map((t) => (t === existing ? { ...t, summary: repo.summary } : t)),
        activeId: existing.id,
      };
    }),
  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      if (state.activeId !== id) return { tabs };
      const neighbour = state.tabs[index - 1] ?? state.tabs[index + 1];
      return { tabs, activeId: neighbour?.id ?? null };
    }),
  moveTab: (id, toIndex) =>
    set((state) => {
      const from = state.tabs.findIndex((t) => t.id === id);
      if (from === -1 || from === toIndex || toIndex < 0 || toIndex >= state.tabs.length) {
        return state;
      }
      const tabs = state.tabs.filter((t) => t.id !== id);
      tabs.splice(toIndex, 0, state.tabs[from]!);
      return { tabs };
    }),
  activate: (id) =>
    set((state) => (id === null || state.tabs.some((t) => t.id === id) ? { activeId: id } : state)),
}));
