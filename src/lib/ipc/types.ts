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
  | "unknownRepo";

export interface AppError {
  kind: AppErrorKind;
  message: string;
}

export interface GitCliInfo {
  available: boolean;
  path: string | null;
}
