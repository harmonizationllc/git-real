import { create } from "zustand";
import type { DiffScope, RepoId } from "../ipc";

export interface SelectedFile {
  path: string;
  scope: DiffScope;
  /** Set when opened from a stash; such a file has no blame. */
  source?: "stash";
}

/** What the centre pane shows for the selected file. */
export type CentreView = "diff" | "blame";

interface WorkspaceState {
  selected: Record<RepoId, SelectedFile | null>;
  /** Full hex oid of the commit selected in the graph. */
  selectedCommit: Record<RepoId, string | null>;
  /** Full hex oid of the stash shown in the sidebar; never set together with selectedCommit. */
  selectedStash: Record<RepoId, string | null>;
  /** The file whose history is shown, or null when none is. */
  historyPath: Record<RepoId, string | null>;
  /** Survives selecting another file, so Blame stays on while browsing. */
  centreView: Record<RepoId, CentreView>;
  /** The branch and tag filter text of the refs column; shared by BranchesPanel and TagsPanel. */
  refsFilter: Record<RepoId, string>;
  select(repoId: RepoId, file: SelectedFile | null): void;
  /** A non-null oid also clears the selected stash. */
  selectCommit(repoId: RepoId, oid: string | null): void;
  /** A non-null oid also clears the selected commit. */
  selectStash(repoId: RepoId, oid: string | null): void;
  showHistory(repoId: RepoId, path: string | null): void;
  setCentreView(repoId: RepoId, view: CentreView): void;
  setRefsFilter(repoId: RepoId, text: string): void;
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
  selectedStash: {},
  historyPath: {},
  centreView: {},
  refsFilter: {},
  select: (repoId, file) => set((state) => ({ selected: { ...state.selected, [repoId]: file } })),
  selectCommit: (repoId, oid) =>
    set((state) => ({
      selectedCommit: { ...state.selectedCommit, [repoId]: oid },
      ...(oid !== null && { selectedStash: { ...state.selectedStash, [repoId]: null } }),
    })),
  selectStash: (repoId, oid) =>
    set((state) => ({
      selectedStash: { ...state.selectedStash, [repoId]: oid },
      ...(oid !== null && { selectedCommit: { ...state.selectedCommit, [repoId]: null } }),
    })),
  showHistory: (repoId, path) =>
    set((state) => ({ historyPath: { ...state.historyPath, [repoId]: path } })),
  setCentreView: (repoId, view) =>
    set((state) => ({ centreView: { ...state.centreView, [repoId]: view } })),
  setRefsFilter: (repoId, text) =>
    set((state) => ({ refsFilter: { ...state.refsFilter, [repoId]: text } })),
  clear: (repoId) =>
    set((state) => {
      const { selected, selectedCommit, selectedStash, historyPath, centreView, refsFilter } =
        state;
      const records = [
        selected,
        selectedCommit,
        selectedStash,
        historyPath,
        centreView,
        refsFilter,
      ];
      if (!records.some((r) => repoId in r)) {
        return state;
      }
      return {
        selected: without(selected, repoId),
        selectedCommit: without(selectedCommit, repoId),
        selectedStash: without(selectedStash, repoId),
        historyPath: without(historyPath, repoId),
        centreView: without(centreView, repoId),
        refsFilter: without(refsFilter, repoId),
      };
    }),
}));
