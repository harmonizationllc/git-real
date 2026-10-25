import { invoke } from "@tauri-apps/api/core";
import type {
  Blame,
  BranchList,
  CheckoutPrOutcome,
  CommitConfig,
  CommitDetail,
  CommitFile,
  CommitMessage,
  CommitOutcome,
  Credentials,
  ConflictSide,
  CreatePrRequest,
  DiffScope,
  DiffSide,
  FastForwardCheck,
  FileDiff,
  FileHistoryEntry,
  GitCliInfo,
  HostedRepoPage,
  HostedRepoInfo,
  HostingAccount,
  HostingProvider,
  HunkAction,
  HunkSelection,
  Issue,
  LocalBranch,
  LogPage,
  LogSummary,
  MergeMode,
  OpenedRepo,
  OperationOutcome,
  OperationState,
  PullMode,
  PullRequest,
  PullRequestDraft,
  PushTarget,
  RebaseCommit,
  RebaseStep,
  RecentEntry,
  RemoteInfo,
  RepoContext,
  RepoId,
  ResetMode,
  StashEntry,
  StashFiles,
  StashOutcome,
  TagList,
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
export function deleteRemoteBranch(
  id: RepoId,
  remote: string,
  name: string,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("delete_remote_branch", { id, remote, name, credentials });
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

/** Every file path in the HEAD tree, sorted; empty for an unborn HEAD. */
export function listTrackedFiles(id: RepoId): Promise<string[]> {
  return invoke<string[]>("list_tracked_files", { id });
}

/** The files `oid` changed against its first parent. */
export function getCommitFiles(id: RepoId, oid: string): Promise<CommitFile[]> {
  return invoke<CommitFile[]>("get_commit_files", { id, oid });
}

/** Commits of log `generation` that changed `path`, in graph order, following renames. */
export function getFileHistory(
  id: RepoId,
  generation: number,
  path: string,
): Promise<FileHistoryEntry[]> {
  return invoke<FileHistoryEntry[]>("get_file_history", { id, generation, path });
}

/** Blame of `path` at `oid`, or at HEAD when `oid` is null. */
export function getBlame(id: RepoId, path: string, oid: string | null): Promise<Blame> {
  return invoke<Blame>("get_blame", { id, path, oid });
}

export function getOperationState(id: RepoId): Promise<OperationState> {
  return invoke<OperationState>("get_operation_state", { id });
}

export function mergeBranch(
  id: RepoId,
  branch: string,
  mode: MergeMode,
): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("merge_branch", { id, branch, mode });
}

export function rebaseOnto(id: RepoId, onto: string): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("rebase_onto", { id, onto });
}

export function cherryPick(id: RepoId, oid: string): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("cherry_pick", { id, oid });
}

export function revertCommit(id: RepoId, oid: string): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("revert_commit", { id, oid });
}

export function abortOperation(id: RepoId): Promise<void> {
  return invoke<void>("abort_operation", { id });
}

export function continueRebase(id: RepoId): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("continue_rebase", { id });
}

/** Keeps `side` of each conflicted path and stages it; every path must be conflicted. */
export function resolveConflicts(id: RepoId, paths: string[], side: ConflictSide): Promise<void> {
  return invoke<void>("resolve_conflicts", { id, paths, side });
}

/** Writes an edited resolution to a conflicted path; `stage` also stages it. */
export function writeResolution(
  id: RepoId,
  path: string,
  text: string,
  stage: boolean,
): Promise<void> {
  return invoke<void>("write_resolution", { id, path, text, stage });
}

export function canFastForward(id: RepoId, branch: string): Promise<FastForwardCheck> {
  return invoke<FastForwardCheck>("can_fast_forward", { id, branch });
}

export function rebasePlan(id: RepoId, base: string): Promise<RebaseCommit[]> {
  return invoke<RebaseCommit[]>("rebase_plan", { id, base });
}

export function rebaseInteractive(
  id: RepoId,
  base: string,
  steps: RebaseStep[],
): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("rebase_interactive", { id, base, steps });
}

/** The stashes, newest first; entry n is stash@{n}. */
export function listStashes(id: RepoId): Promise<StashEntry[]> {
  return invoke<StashEntry[]>("list_stashes", { id });
}

/** A stash's tracked changes and untracked files. */
export function getStashFiles(id: RepoId, oid: string): Promise<StashFiles> {
  return invoke<StashFiles>("get_stash_files", { id, oid });
}

export function stashPush(
  id: RepoId,
  message: string | null,
  includeUntracked: boolean,
): Promise<void> {
  return invoke<void>("stash_push", { id, message, includeUntracked });
}

export function stashApply(id: RepoId, index: number, oid: string): Promise<StashOutcome> {
  return invoke<StashOutcome>("stash_apply", { id, index, oid });
}

export function stashPop(id: RepoId, index: number, oid: string): Promise<StashOutcome> {
  return invoke<StashOutcome>("stash_pop", { id, index, oid });
}

export function stashDrop(id: RepoId, index: number, oid: string): Promise<void> {
  return invoke<void>("stash_drop", { id, index, oid });
}

/** Local tags (newest first) and every configured remote. */
export function listTags(id: RepoId): Promise<TagList> {
  return invoke<TagList>("list_tags", { id });
}

/** Annotated when `message` is non-null (signed if tag.gpgSign is set), else lightweight. */
export function createTag(
  id: RepoId,
  name: string,
  oid: string,
  message: string | null,
): Promise<void> {
  return invoke<void>("create_tag", { id, name, oid, message });
}

export function deleteTag(id: RepoId, name: string): Promise<void> {
  return invoke<void>("delete_tag", { id, name });
}

export function pushTag(
  id: RepoId,
  remote: string,
  name: string,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("push_tag", { id, remote, name, credentials });
}

export function deleteRemoteTag(
  id: RepoId,
  remote: string,
  name: string,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("delete_remote_tag", { id, remote, name, credentials });
}

/** `git fetch --all`. Not named `fetch`, which would shadow the global. */
export function fetchAll(id: RepoId, credentials: Credentials | null = null): Promise<void> {
  return invoke<void>("fetch", { id, credentials });
}

/** `git fetch <remote>`: one remote only. */
export function fetchRemote(
  id: RepoId,
  remote: string,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("fetch_remote", { id, remote, credentials });
}

/** `branch.<head>.rebase`, else `pull.rebase`, else merge. */
export function pullDefaultMode(id: RepoId): Promise<PullMode> {
  return invoke<PullMode>("pull_default_mode", { id });
}

/** Fetches the upstream's remote, then fast-forwards, merges or rebases. */
export function pull(
  id: RepoId,
  mode: PullMode,
  credentials: Credentials | null = null,
): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("pull", { id, mode, credentials });
}

/** Pushes `expectedBranch`, which must still be HEAD's branch, to `target`. */
export function push(
  id: RepoId,
  target: PushTarget,
  force: boolean,
  expectedBranch: string,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("push", { id, target, force, expectedBranch, credentials });
}

export function listRemotes(id: RepoId): Promise<RemoteInfo[]> {
  return invoke<RemoteInfo[]>("list_remotes", { id });
}

export function addRemote(
  id: RepoId,
  name: string,
  url: string,
  pushUrl: string | null,
): Promise<void> {
  return invoke<void>("add_remote", { id, name, url, pushUrl });
}

export function updateRemote(
  id: RepoId,
  name: string,
  newName: string,
  url: string,
  pushUrl: string | null,
): Promise<void> {
  return invoke<void>("update_remote", { id, name, newName, url, pushUrl });
}

export function removeRemote(id: RepoId, name: string): Promise<void> {
  return invoke<void>("remove_remote", { id, name });
}

export function hostingListAccounts(): Promise<HostingAccount[]> {
  return invoke<HostingAccount[]>("hosting_list_accounts", {});
}

/** Checks `token` with the provider, then stores it in the system keychain. `host` null is the provider's default. */
export function hostingConnect(
  provider: HostingProvider,
  host: string | null,
  token: string,
): Promise<HostingAccount> {
  return invoke<HostingAccount>("hosting_connect", { provider, host, token });
}

export function hostingDisconnect(accountId: string): Promise<void> {
  return invoke<void>("hosting_disconnect", { accountId });
}

/** The hosted repository behind `origin`; null when no provider hosts it. */
export function hostingRepoContext(id: RepoId): Promise<RepoContext | null> {
  return invoke<RepoContext | null>("hosting_repo_context", { id });
}

/** One page (1-based, 50 per page) of open pull requests, newest update first. */
export function hostingListPullRequests(id: RepoId, page: number): Promise<PullRequest[]> {
  return invoke<PullRequest[]>("hosting_list_pull_requests", { id, page });
}

/** Fetches pull request `number` and checks it out; `reset` moves a diverged `pr/<n>`. */
export function hostingCheckoutPullRequest(
  id: RepoId,
  number: number,
  reset: boolean,
  credentials: Credentials | null = null,
): Promise<CheckoutPrOutcome> {
  return invoke<CheckoutPrOutcome>("hosting_checkout_pull_request", {
    id,
    number,
    reset,
    credentials,
  });
}

/** The default branch of the hosted repository and whether its issues are turned on. */
export function hostingRepoInfo(id: RepoId): Promise<HostedRepoInfo> {
  return invoke<HostedRepoInfo>("hosting_repo_info", { id });
}

/** One page (1-based, 50 per page) of open issues matching `query` (all when blank), newest update first. */
export function hostingListIssues(id: RepoId, query: string, page: number): Promise<Issue[]> {
  return invoke<Issue[]>("hosting_list_issues", { id, query, page });
}

/**
 * One page (1-based, 50 per page) of the repositories `accountId` can clone, matching `query` by
 * name (all when blank), newest update first. `hasMore` comes from the raw page, before unusable
 * rows were dropped.
 */
export function hostingListMyRepos(
  accountId: string,
  query: string,
  page: number,
): Promise<HostedRepoPage> {
  return invoke<HostedRepoPage>("hosting_list_my_repos", { accountId, query, page });
}

/** Commits ahead of `origin/<target>` and the title and description prefill. */
export function hostingPullRequestDraft(id: RepoId, target: string): Promise<PullRequestDraft> {
  return invoke<PullRequestDraft>("hosting_pull_request_draft", { id, target });
}

/** Runs `request.push` when set, then opens the pull request. */
export function hostingCreatePullRequest(
  id: RepoId,
  request: CreatePrRequest,
  credentials: Credentials | null = null,
): Promise<PullRequest> {
  return invoke<PullRequest>("hosting_create_pull_request", { id, request, credentials });
}
