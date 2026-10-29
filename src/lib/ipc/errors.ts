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
  logStale: true,
  commitNotFound: true,
  binaryFile: true,
  operationFailed: true,
  operationInProgress: true,
  noOperation: true,
  unresolvedConflicts: true,
  mergeCommit: true,
  nothingToStash: true,
  staleStash: true,
  invalidTagName: true,
  tagExists: true,
  tagNotFound: true,
  networkFailed: true,
  noRemotes: true,
  noUpstream: true,
  detachedHead: true,
  invalidRemoteName: true,
  invalidRemoteUrl: true,
  remoteExists: true,
  invalidCredentials: true,
  hostingAuth: true,
  hostingNotFound: true,
  hostingRateLimited: true,
  hostingRejected: true,
  hostingUnreachable: true,
  keychainUnavailable: true,
  noHostingAccount: true,
  invalidHostingHost: true,
  invalidToken: true,
  invalidSettings: true,
  gitCliInvalid: true,
  noExternalTool: true,
  externalToolFailed: true,
  updateCheckFailed: true,
  branchCheckedOut: true,
  worktreeNotFound: true,
  worktreeDirty: true,
  worktreeLocked: true,
  cannotRemoveMain: true,
  cannotRemoveCurrent: true,
  pathExists: true,
  pathNotAbsolute: true,
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
