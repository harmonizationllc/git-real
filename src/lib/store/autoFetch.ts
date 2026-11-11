import { create } from "zustand";
import type { RepoId } from "../ipc";

/** The shortest gap between two automatic fetches of one repo. */
export const COOLDOWN_MS = 30_000;

export interface AutoFetchEntry {
  lastFetchedAt: number | null;
  paused: boolean;
  /** Bumped by trigger sources; the mounted pane's hook reacts to a change. */
  requested: number;
}

export interface AutoFetchState {
  repos: Record<RepoId, AutoFetchEntry>;
  /** A trigger source (checkout, remote edit, set upstream) asks the focused pane to fetch. */
  request(repoId: RepoId): void;
  /** A fetch (manual, automatic or via pull) completed at `at`; clears the pause. */
  recordFetched(repoId: RepoId, at: number): void;
  /** A manual or automatic network action failed; pauses auto-fetch. */
  recordFailure(repoId: RepoId): void;
  /** Something changed that may make fetch work again (push succeeded, remotes edited). */
  resume(repoId: RepoId): void;
  /** The tab closed; drops the entry. */
  forget(repoId: RepoId): void;
}

const DEFAULT_ENTRY: AutoFetchEntry = { lastFetchedAt: null, paused: false, requested: 0 };

/** The repo's entry, or the default when it has none; never creates one. */
export function entryFor(state: AutoFetchState, repoId: RepoId): AutoFetchEntry {
  return state.repos[repoId] ?? DEFAULT_ENTRY;
}

/** True when a trigger should run now: not paused and outside the cooldown. */
export function dueNow(entry: AutoFetchEntry, now: number): boolean {
  return (
    !entry.paused && (entry.lastFetchedAt === null || now - entry.lastFetchedAt >= COOLDOWN_MS)
  );
}

export const useAutoFetchState = create<AutoFetchState>()((set) => {
  const patch = (repoId: RepoId, change: (entry: AutoFetchEntry) => Partial<AutoFetchEntry>) =>
    set((state) => {
      const entry = entryFor(state, repoId);
      return { repos: { ...state.repos, [repoId]: { ...entry, ...change(entry) } } };
    });
  return {
    repos: {},
    request: (repoId) => patch(repoId, (e) => ({ requested: e.requested + 1 })),
    recordFetched: (repoId, at) => patch(repoId, () => ({ lastFetchedAt: at, paused: false })),
    recordFailure: (repoId) => patch(repoId, () => ({ paused: true })),
    resume: (repoId) => patch(repoId, () => ({ paused: false })),
    forget: (repoId) =>
      set((state) => {
        if (!(repoId in state.repos)) return state;
        const repos = { ...state.repos };
        delete repos[repoId];
        return { repos };
      }),
  };
});
