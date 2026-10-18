import { invoke } from "@tauri-apps/api/core";
import type {
  DiffScope,
  DiffSide,
  FileDiff,
  GitCliInfo,
  HunkAction,
  HunkSelection,
  OpenedRepo,
  RecentEntry,
  RepoId,
  WorkingTreeStatus,
} from "./types";

export function openRepo(path: string): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("open_repo", { path });
}

export function initRepo(path: string): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("init_repo", { path });
}

export function cloneRepo(url: string, dest: string, cloneId: number): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("clone_repo", { url, dest, cloneId });
}

export function closeRepo(id: RepoId): Promise<void> {
  return invoke<void>("close_repo", { id });
}

export function listRecent(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("list_recent");
}

export function removeRecent(path: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("remove_recent", { path });
}

export function checkGitCli(): Promise<GitCliInfo> {
  return invoke<GitCliInfo>("check_git_cli");
}

export function getStatus(id: RepoId): Promise<WorkingTreeStatus> {
  return invoke<WorkingTreeStatus>("get_status", { id });
}

export function getFileDiff(
  id: RepoId,
  path: string,
  scope: DiffScope,
  ignoreWhitespace: boolean,
  maxLines?: number,
): Promise<FileDiff> {
  return invoke<FileDiff>("get_file_diff", {
    id,
    path,
    scope,
    ignoreWhitespace,
    maxLines: maxLines ?? null,
  });
}

/** Raw bytes of one side of a file; the backend answers with a binary IPC response. */
export function getFileContent(
  id: RepoId,
  path: string,
  scope: DiffScope,
  side: DiffSide,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("get_file_content", { id, path, scope, side });
}

export function stagePaths(id: RepoId, paths: string[]): Promise<void> {
  return invoke<void>("stage_paths", { id, paths });
}

export function unstagePaths(id: RepoId, paths: string[]): Promise<void> {
  return invoke<void>("unstage_paths", { id, paths });
}

export function stageAll(id: RepoId): Promise<void> {
  return invoke<void>("stage_all", { id });
}

export function unstageAll(id: RepoId): Promise<void> {
  return invoke<void>("unstage_all", { id });
}

export function discardPaths(id: RepoId, paths: string[]): Promise<void> {
  return invoke<void>("discard_paths", { id, paths });
}

export function applyHunk(
  id: RepoId,
  path: string,
  action: HunkAction,
  selection: HunkSelection,
): Promise<void> {
  return invoke<void>("apply_hunk", { id, path, action, selection });
}

/** Resolves the `.gitignore` pattern for `path` (appended unless already present). */
export function addToGitignore(id: RepoId, path: string): Promise<string> {
  return invoke<string>("add_to_gitignore", { id, path });
}
