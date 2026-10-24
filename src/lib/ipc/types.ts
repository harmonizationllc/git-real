// Mirrors the Rust DTOs (camelCase serde output). Declarations only, no runtime code.

export type RepoId = number;

export interface RepoSummary {
  path: string;
  name: string;
  headBranch: string | null;
  isBare: boolean;
}

export interface OpenedRepo {
  id: RepoId;
  summary: RepoSummary;
}

export interface RecentEntry {
  path: string;
  name: string;
  /** Unix seconds; multiply by 1000 for a `Date`. */
  lastOpened: number;
}

export type ProgressPhase =
  "counting" | "compressing" | "receiving" | "resolving" | "checkingOut" | "other";

export interface Progress {
  phase: ProgressPhase;
  percent: number | null;
  message: string;
}

export interface CloneProgressPayload {
  cloneId: number;
  progress: Progress;
}

export type AppErrorKind =
  | "notARepository"
  | "alreadyARepository"
  | "pathNotFound"
  | "gitCliMissing"
  | "cloneFailed"
  | "io"
  | "git"
  | "unknownRepo"
  | "noChanges"
  | "badSelection"
  | "applyFailed"
  | "tooLarge"
  | "emptyMessage"
  | "nothingToCommit"
  | "commitFailed"
  | "invalidBranchName"
  | "branchExists"
  | "branchNotFound"
  | "branchNotMerged"
  | "cannotDeleteCurrent"
  | "unbornHead"
  | "revisionNotFound"
  | "remoteNotFound"
  | "checkoutFailed"
  | "logStale"
  | "commitNotFound"
  | "binaryFile"
  | "operationFailed"
  | "operationInProgress"
  | "noOperation"
  | "unresolvedConflicts"
  | "mergeCommit"
  | "nothingToStash"
  | "staleStash"
  | "invalidTagName"
  | "tagExists"
  | "tagNotFound"
  | "networkFailed"
  | "noRemotes"
  | "noUpstream"
  | "detachedHead"
  | "invalidRemoteName"
  | "invalidRemoteUrl"
  | "remoteExists"
  | "invalidCredentials"
  | "hostingAuth"
  | "hostingNotFound"
  | "hostingRateLimited"
  | "hostingRejected"
  | "hostingUnreachable"
  | "keychainUnavailable"
  | "noHostingAccount"
  | "invalidHostingHost"
  | "invalidToken";

export interface AppError {
  kind: AppErrorKind;
  message: string;
  /** Present on `networkFailed` only. */
  network?: NetworkErrorInfo;
}

export interface GitCliInfo {
  available: boolean;
  path: string | null;
}

export type ChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "typeChange" | "untracked" | "conflicted";

export interface StatusEntry {
  path: string;
  oldPath: string | null;
  index: ChangeKind | null;
  worktree: ChangeKind | null;
  conflicted: boolean;
}

export interface WorkingTreeStatus {
  entries: StatusEntry[];
  headUnborn: boolean;
}

/** A working-tree side, or one commit against its first parent (serde externally tagged). */
export type DiffScope = "staged" | "unstaged" | { commit: string };

export type DiffSide = "old" | "new";

export type TextEncoding = "utf8" | "utf16Le" | "utf16Be" | "utf32Le" | "utf32Be";

export type DiffLineKind = "context" | "addition" | "deletion";

export interface DiffLine {
  kind: DiffLineKind;
  oldLineno: number | null;
  newLineno: number | null;
  content: string;
  noNewlineAtEof: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  scope: DiffScope;
  change: ChangeKind | null;
  isBinary: boolean;
  hunks: Hunk[];
  truncated: boolean;
  oldEncoding: TextEncoding | null;
  newEncoding: TextEncoding | null;
}

export interface HunkSelection {
  hunkIndex: number;
  /** Line indices within the hunk; null selects the whole hunk. */
  lines: number[] | null;
}

export type HunkAction = "stage" | "unstage" | "discard";

export interface CommitMessage {
  subject: string;
  body: string;
}

export type SigningFormat = "openPgp" | "x509" | "ssh";

export interface CommitConfig {
  name: string | null;
  email: string | null;
  /** Non-null when `commit.gpgsign` is true. */
  signing: SigningFormat | null;
}

export interface CommitOutcome {
  /** Full hex object id. */
  oid: string;
  summary: string;
}

export interface RepoChangedPayload {
  repoId: RepoId;
}

export type HeadState =
  | { kind: "branch"; name: string }
  | { kind: "detached"; oid: string }
  | { kind: "unborn"; name: string };

export interface Tracking {
  /** Upstream short name, e.g. `origin/main`. */
  upstream: string;
  /** Both null when the upstream is gone. */
  ahead: number | null;
  behind: number | null;
}

export interface LocalBranch {
  name: string;
  oid: string;
  isHead: boolean;
  tracking: Tracking | null;
}

export interface RemoteBranch {
  remote: string;
  name: string;
  oid: string;
}

export interface RemoteGroup {
  remote: string;
  branches: RemoteBranch[];
}

export interface BranchList {
  head: HeadState;
  local: LocalBranch[];
  remotes: RemoteGroup[];
}

export type RefKind = "head" | "branch" | "remote" | "tag";

export interface RefLabel {
  kind: RefKind;
  name: string;
  isHead: boolean;
}

/** One segment of a row: the column it occupies at the row's top and bottom; null means at the dot. */
export interface GraphEdge {
  top: number | null;
  bottom: number | null;
}

export interface GraphRow {
  /** Full hex object id. */
  oid: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  lane: number;
  edges: GraphEdge[];
  refs: RefLabel[];
}

export interface LogSummary {
  generation: number;
  total: number;
  maxLanes: number;
}

export interface LogPage {
  start: number;
  rows: GraphRow[];
}

export interface Signature {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
}

export interface CommitDetail {
  oid: string;
  parents: string[];
  message: CommitMessage;
  author: Signature;
  committer: Signature;
}

export type ResetMode = "soft" | "mixed" | "hard";

/** One file a commit changed against its first parent. */
export interface CommitFile {
  path: string;
  oldPath: string | null;
  change: ChangeKind;
}

/** One commit that touched a file, following renames. */
export interface FileHistoryEntry {
  oid: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  change: ChangeKind;
  /** The file's path in this commit. */
  path: string;
  oldPath: string | null;
}

export interface BlameHunk {
  /** 1-based first line. */
  start: number;
  lines: number;
  oid: string;
  author: Signature;
  summary: string;
}

export interface Blame {
  /** The commit blamed at. */
  oid: string;
  path: string;
  hunks: BlameHunk[];
  lines: string[];
}

export type MergeMode = "merge" | "fastForward";

/** The operation git has in progress (serde internally tagged on `kind`); oids are full hex. */
export type OperationState =
  | { kind: "none" }
  | { kind: "merge"; head: string; branch: string | null; message: CommitMessage }
  | {
      kind: "rebase";
      onto: string;
      ontoName: string | null;
      branch: string | null;
      step: number;
      total: number;
      /** git stopped at an `edit` step; staged changes are amended on continue. */
      stoppedForEdit: boolean;
    }
  | { kind: "cherryPick"; oid: string; message: CommitMessage }
  | { kind: "revert"; oid: string; message: CommitMessage };

/** `stopped`: git exited 0 with the rebase still in progress (an `edit` step). */
export type OperationOutcome = "completed" | "conflicts" | "stopped";

/** One line of an interactive rebase todo. */
export type RebaseAction = "pick" | "squash" | "fixup" | "edit" | "drop";

/** A commit an interactive rebase would replay; `oid` is full hex. */
export interface RebaseCommit {
  oid: string;
  subject: string;
  author: Signature;
}

/** One entry of the plan, in the order git applies them (oldest first). */
export interface RebaseStep {
  action: RebaseAction;
  oid: string;
}

/** One `refs/stash` reflog entry; `index` is n in `stash@{n}`, oids are full hex. */
export interface StashEntry {
  index: number;
  oid: string;
  message: string;
  /** Parsed from the message; null for "(no branch)" or an unparseable message. */
  branch: string | null;
  /** Unix seconds. */
  time: number;
  /** The commit the stash was made on. */
  base: string;
  hasUntracked: boolean;
}

/** A stash's tracked changes and untracked files. */
export interface StashFiles {
  tracked: CommitFile[];
  untracked: CommitFile[];
  untrackedOid: string | null;
}

/**
 * How an apply or pop ended; conflicts are an outcome, not an error.
 * `appliedNotDropped`: only from pop, which applied cleanly but could not drop the stash.
 */
export type StashOutcome = "applied" | "conflicts" | "appliedNotDropped";

/** A local tag that peels to a commit. */
export interface TagEntry {
  /** Short name, without `refs/tags/`. */
  name: string;
  /** Full hex id of the commit the tag peels to. */
  target: string;
  annotated: boolean;
  /** First line of an annotated tag's message, trimmed; null when blank or lightweight. */
  subject: string | null;
  /** Tagger time (annotated) or the commit's time (lightweight), in Unix seconds. */
  time: number;
}

export interface TagList {
  /** Newest first by `time`, then by name. */
  tags: TagEntry[];
  /** Every configured remote, sorted. */
  remotes: string[];
}

export type NetworkErrorKind =
  | "httpsAuthRequired"
  | "httpsAuthRejected"
  | "sshAuthFailed"
  | "hostKeyUnverified"
  | "hostUnreachable"
  | "repoNotFound"
  | "pushRejectedNonFastForward"
  | "leaseStale"
  | "remoteRejected"
  | "other";

export interface NetworkErrorInfo {
  verb: "fetch" | "pull" | "push";
  kind: NetworkErrorKind;
  https: boolean;
  /** `scheme://host[:port]` git asked credentials for; null unless an HTTPS auth kind. */
  origin: string | null;
  /** The SSH host named by an SSH auth or host-key failure, when known. */
  host: string | null;
  /** The server's reason for a `remoteRejected` push, when it gave one. */
  reason: string | null;
}

/** Sent for one network call only; never stored by the app. */
export interface Credentials {
  origin: string;
  username: string;
  token: string;
}

export type PullMode = "merge" | "rebase";

export type PushTarget =
  { kind: "upstream" } | { kind: "setUpstream"; remote: string; branch: string };

export interface RemoteInfo {
  name: string;
  /** Raw `remote.<name>.url`, as configured. */
  fetchUrl: string;
  /** Raw `remote.<name>.pushurl`; null when unset. */
  pushUrl: string | null;
}

export type ConflictSide = "ours" | "theirs";

export type FastForwardCheck = "possible" | "upToDate" | "diverged";

export type HostingProvider = "github" | "gitlab" | "bitbucket";

/** A connected account; its token stays in the system keychain and never reaches the webview. */
export interface HostingAccount {
  /** `<provider>:<host>:<username>`. */
  id: string;
  provider: HostingProvider;
  host: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** The provider rejected the token; reconnecting clears it. */
  needsReconnect: boolean;
}

export interface HostingRepoRef {
  provider: HostingProvider;
  host: string;
  /** GitLab namespaces may hold several `/`-separated groups. */
  namespace: string;
  name: string;
}

/** The hosted repository behind `origin` and the account connected for its host. */
export interface RepoContext {
  repo: HostingRepoRef;
  account: HostingAccount | null;
}

export type CiState = "passing" | "failing" | "pending" | "none";

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  fromFork: boolean;
  forkCloneUrl: string | null;
  draft: boolean;
  ciState: CiState;
  /** Epoch seconds. */
  updatedAt: number;
  webUrl: string;
}

/** What the provider says about the hosted repository beyond its pull requests. */
export interface HostedRepoInfo {
  /** Null for an empty repository. */
  defaultBranch: string | null;
  /** False when the repository has its issue tracker turned off. */
  issuesEnabled: boolean;
}

export interface Issue {
  number: number;
  title: string;
  author: string;
  labels: string[];
  /** Epoch seconds. */
  updatedAt: number;
  webUrl: string;
}

/** A pull request to open: `sourceBranch` into `targetBranch`, both on the hosted repository. */
export interface NewPullRequest {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
}

/** The prefill for a new pull request from the current branch. */
export interface PullRequestDraft {
  title: string;
  body: string;
  /** Commits on HEAD and not on `origin/<target>`, counted up to 1000. */
  ahead: number;
}

/** `branch` is the branch HEAD must still be on; `push` runs first when set. */
export interface CreatePrRequest {
  branch: string;
  push: PushTarget | null;
  pr: NewPullRequest;
}

export type CheckoutPrOutcome =
  { kind: "checkedOut"; branch: string } | { kind: "needsReset"; branch: string };
