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
  | "commitFailed";

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

export type DiffScope = "staged" | "unstaged";

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
