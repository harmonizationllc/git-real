import { invoke } from "@tauri-apps/api/core";
import type {
  BranchList,
  CommitConfig,
  CommitDetail,
  CommitMessage,
  CommitOutcome,
  DiffScope,
  DiffSide,
  FileDiff,
  GitCliInfo,
  HunkAction,
  HunkSelection,
  LocalBranch,
  LogPage,
  LogSummary,
  OpenedRepo,
  RecentEntry,
  RepoId,
  ResetMode,
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

export function getCommitConfig(id: RepoId): Promise<CommitConfig> {
  return invoke<CommitConfig>("get_commit_config", { id });
}

/** HEAD's message split into subject and body; null when HEAD is unborn. */
export function getHeadMessage(id: RepoId): Promise<CommitMessage | null> {
  return invoke<CommitMessage | null>("get_head_message", { id });
}

/** Commits the index through `git commit`; `amend` rewrites HEAD instead. */
export function commit(id: RepoId, message: CommitMessage, amend: boolean): Promise<CommitOutcome> {
  return invoke<CommitOutcome>("commit", { id, message, amend });
}

export function listBranches(id: RepoId): Promise<BranchList> {
  return invoke<BranchList>("list_branches", { id });
}

/** Creates `name` at `startPoint` (HEAD when null), switching to it when `checkout` is set. */
export function createBranch(
  id: RepoId,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<LocalBranch> {
  return invoke<LocalBranch>("create_branch", { id, name, startPoint, checkout });
}

export function renameBranch(id: RepoId, oldName: string, newName: string): Promise<void> {
  return invoke<void>("rename_branch", { id, oldName, newName });
}

/** Without `force`, an unmerged branch rejects with `branchNotMerged`. */
export function deleteBranch(id: RepoId, name: string, force: boolean): Promise<void> {
  return invoke<void>("delete_branch", { id, name, force });
}

export function checkoutBranch(id: RepoId, name: string): Promise<void> {
  return invoke<void>("checkout_branch", { id, name });
}

/** Switches to a local branch tracking `remote/name`, creating it when missing. */
export function checkoutRemoteBranch(id: RepoId, remote: string, name: string): Promise<void> {
  return invoke<void>("checkout_remote_branch", { id, remote, name });
}

/** Deletes `name` on `remote` through `git push --delete`. */
export function deleteRemoteBranch(id: RepoId, remote: string, name: string): Promise<void> {
  return invoke<void>("delete_remote_branch", { id, remote, name });
}

/** The cached log's generation, row count and lane width; reading it rebuilds a stale cache. */
export function getLogSummary(id: RepoId): Promise<LogSummary> {
  return invoke<LogSummary>("get_log_summary", { id });
}

/** Rejects with `logStale` when `generation` is no longer the cached one. */
export function getLogPage(
  id: RepoId,
  generation: number,
  start: number,
  count: number,
): Promise<LogPage> {
  return invoke<LogPage>("get_log_page", { id, generation, start, count });
}

/** Ascending row indices matching `query`; rejects with `logStale` like `getLogPage`. */
export function searchLog(id: RepoId, generation: number, query: string): Promise<number[]> {
  return invoke<number[]>("search_log", { id, generation, query });
}

export function getCommit(id: RepoId, oid: string): Promise<CommitDetail> {
  return invoke<CommitDetail>("get_commit", { id, oid });
}

/** Detaches HEAD at `oid` through `git switch --detach`. */
export function checkoutCommit(id: RepoId, oid: string): Promise<void> {
  return invoke<void>("checkout_commit", { id, oid });
}

export function resetToCommit(id: RepoId, oid: string, mode: ResetMode): Promise<void> {
  return invoke<void>("reset_to_commit", { id, oid, mode });
}
