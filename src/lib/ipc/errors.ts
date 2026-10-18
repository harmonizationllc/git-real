import type { AppError, AppErrorKind } from "./types";

// Record keyed by the union keeps this table and AppErrorKind in sync at compile time.
const KINDS: Record<AppErrorKind, true> = {
  notARepository: true,
  alreadyARepository: true,
  pathNotFound: true,
  gitCliMissing: true,
  cloneFailed: true,
  io: true,
  git: true,
  unknownRepo: true,
  noChanges: true,
  badSelection: true,
  applyFailed: true,
  tooLarge: true,
  emptyMessage: true,
  nothingToCommit: true,
  commitFailed: true,
  invalidBranchName: true,
  branchExists: true,
  branchNotFound: true,
  branchNotMerged: true,
  cannotDeleteCurrent: true,
  unbornHead: true,
  revisionNotFound: true,
  remoteNotFound: true,
  checkoutFailed: true,
  pushFailed: true,
};

export function isAppError(e: unknown): e is AppError {
  if (typeof e !== "object" || e === null) return false;
  const { kind, message } = e as Record<string, unknown>;
  return (
    typeof kind === "string" &&
    Object.prototype.hasOwnProperty.call(KINDS, kind) &&
    typeof message === "string"
  );
}

/** Passes an AppError through unchanged; anything else becomes an `io` error. */
export function toAppError(e: unknown): AppError {
  return isAppError(e) ? e : { kind: "io", message: e instanceof Error ? e.message : String(e) };
}
