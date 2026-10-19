import { create } from "zustand";
import type { DiffScope, RepoId } from "../ipc";

export interface SelectedFile {
  path: string;
  scope: DiffScope;
}

interface WorkspaceState {
  selected: Record<RepoId, SelectedFile | null>;
  /** Full hex oid of the commit selected in the graph. */
  selectedCommit: Record<RepoId, string | null>;
  select(repoId: RepoId, file: SelectedFile | null): void;
  selectCommit(repoId: RepoId, oid: string | null): void;
  /** Forgets both selections of a repo. */
  clear(repoId: RepoId): void;
}

/** A copy of `record` without `key`, or `record` itself when the key is absent. */
function without<T>(record: Record<RepoId, T>, key: RepoId): Record<RepoId, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useWorkspace = create<WorkspaceState>()((set) => ({
  selected: {},
  selectedCommit: {},
  select: (repoId, file) => set((state) => ({ selected: { ...state.selected, [repoId]: file } })),
  selectCommit: (repoId, oid) =>
    set((state) => ({ selectedCommit: { ...state.selectedCommit, [repoId]: oid } })),
  clear: (repoId) =>
    set((state) => {
      if (!(repoId in state.selected) && !(repoId in state.selectedCommit)) return state;
      return {
        selected: without(state.selected, repoId),
        selectedCommit: without(state.selectedCommit, repoId),
      };
    }),
}));
