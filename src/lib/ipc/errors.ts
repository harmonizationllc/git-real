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
