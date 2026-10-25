import { create } from "zustand";
import type { RepoId } from "../ipc";

export type SettingsSection = "appearance" | "diff" | "clone" | "tools" | "git";

export type ShellDialog =
  | null
  | { kind: "settings"; section?: SettingsSection }
  | { kind: "palette" }
  | { kind: "shortcuts" };

/** The active pane's sync verbs and their gate reasons, published for the palette to read. */
export interface RepoActions {
  repoId: RepoId;
  path: string;
  gates: { fetch: string | null; pull: string | null; push: string | null };
  fetch(): void;
  pull(): void;
  push(): void;
  fileHistory(): void;
}

/** App-level open/clone handlers, shared by the shortcuts hook and the palette. */
export interface ShellActions {
  openRepo(): void;
  cloneRepo(): void;
  openPath(path: string): void;
}

interface ShellState {
  dialog: ShellDialog;
  repoActions: RepoActions | null;
  open(d: Exclude<ShellDialog, null>): void;
  close(): void;
  publishRepoActions(a: RepoActions | null): void;
}

/** The shell's single dialog slot and the active pane's action registry; not persisted. */
export const useShell = create<ShellState>()((set) => ({
  dialog: null,
  repoActions: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
  publishRepoActions: (repoActions) => set({ repoActions }),
}));
