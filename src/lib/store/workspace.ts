import { create } from "zustand";
import type { DiffScope, RepoId } from "../ipc";

export interface SelectedFile {
  path: string;
  scope: DiffScope;
}

/** What the centre pane shows for the selected file. */
export type CentreView = "diff" | "blame";

interface WorkspaceState {
  selected: Record<RepoId, SelectedFile | null>;
  /** Full hex oid of the commit selected in the graph. */
  selectedCommit: Record<RepoId, string | null>;
  /** The file whose history is shown, or null when none is. */
  historyPath: Record<RepoId, string | null>;
  /** Survives selecting another file, so Blame stays on while browsing. */
  centreView: Record<RepoId, CentreView>;
  select(repoId: RepoId, file: SelectedFile | null): void;
  selectCommit(repoId: RepoId, oid: string | null): void;
  showHistory(repoId: RepoId, path: string | null): void;
  setCentreView(repoId: RepoId, view: CentreView): void;
  /** Forgets everything stored for a repo. */
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
  historyPath: {},
  centreView: {},
  select: (repoId, file) => set((state) => ({ selected: { ...state.selected, [repoId]: file } })),
  selectCommit: (repoId, oid) =>
    set((state) => ({ selectedCommit: { ...state.selectedCommit, [repoId]: oid } })),
  showHistory: (repoId, path) =>
    set((state) => ({ historyPath: { ...state.historyPath, [repoId]: path } })),
  setCentreView: (repoId, view) =>
    set((state) => ({ centreView: { ...state.centreView, [repoId]: view } })),
  clear: (repoId) =>
    set((state) => {
      const { selected, selectedCommit, historyPath, centreView } = state;
      if (![selected, selectedCommit, historyPath, centreView].some((r) => repoId in r)) {
        return state;
      }
      return {
        selected: without(selected, repoId),
        selectedCommit: without(selectedCommit, repoId),
        historyPath: without(historyPath, repoId),
        centreView: without(centreView, repoId),
      };
    }),
}));
