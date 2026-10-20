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
  | "pushFailed"
  | "logStale"
  | "commitNotFound"
  | "binaryFile"
  | "operationFailed"
  | "operationInProgress"
  | "noOperation"
  | "unresolvedConflicts"
  | "mergeCommit";

export interface AppError {
  kind: AppErrorKind;
  message: string;
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

export type ConflictSide = "ours" | "theirs";

export type FastForwardCheck = "possible" | "upToDate" | "diverged";
