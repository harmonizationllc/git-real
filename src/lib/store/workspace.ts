import { create } from "zustand";
import type { DiffScope, RepoId } from "../ipc";

export interface SelectedFile {
  path: string;
  scope: DiffScope;
}

interface WorkspaceState {
  selected: Record<RepoId, SelectedFile | null>;
  select(repoId: RepoId, file: SelectedFile | null): void;
  clear(repoId: RepoId): void;
}

export const useWorkspace = create<WorkspaceState>()((set) => ({
  selected: {},
  select: (repoId, file) => set((state) => ({ selected: { ...state.selected, [repoId]: file } })),
  clear: (repoId) =>
    set((state) => {
      if (!(repoId in state.selected)) return state;
      const selected = { ...state.selected };
      delete selected[repoId];
      return { selected };
    }),
}));
