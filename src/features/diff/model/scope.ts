import type { DiffScope } from "../../../lib/ipc";

/** A commit scope: a committed diff, never staged, unstaged or discarded. */
export type CommitScope = Extract<DiffScope, { commit: string }>;

/** A string identity for keys: `staged`, `unstaged` or `commit:<oid>`. */
export const scopeId = (s: DiffScope): string => (typeof s === "string" ? s : `commit:${s.commit}`);

/** The commit a scope names, or null for a working-tree scope. */
export const commitOf = (s: DiffScope): string | null => (typeof s === "string" ? null : s.commit);

/** True for a commit scope, which offers no hunk actions. */
export const isReadOnly = (s: DiffScope): s is CommitScope => typeof s !== "string";
