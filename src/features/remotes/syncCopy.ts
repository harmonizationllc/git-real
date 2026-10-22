import type { HeadState, OperationState, Tracking } from "../../lib/ipc";
import { operationNoun } from "../merge/operationCopy";

export const NO_REMOTES = "No remotes configured";
export const CHECK_OUT_A_BRANCH = "Check out a branch to pull or push.";
export const MAKE_A_COMMIT_FIRST = "Make a commit first";
export const NO_UPSTREAM = "This branch has no upstream";
export const NETWORK_BUSY = "Another network operation is running";
export const LOADING = "Loading…";

/** The pull / push tooltip while `noun` (merge, rebase, …) is in progress. */
export const finishOperationFirst = (noun: string): string => `Finish or abort the ${noun} first`;

export type SyncVerb = "fetch" | "pull" | "push";

/** Why each button is disabled (its tooltip), or null when enabled. */
export interface SyncGates {
  fetch: string | null;
  pull: string | null;
  push: string | null;
  forcePush: string | null;
}

const all = (reason: string): SyncGates => ({
  fetch: reason,
  pull: reason,
  push: reason,
  forcePush: reason,
});

function headGate(head: HeadState | undefined): string | null {
  if (head === undefined) return LOADING;
  if (head.kind === "detached") return CHECK_OUT_A_BRANCH;
  if (head.kind === "unborn") return MAKE_A_COMMIT_FIRST;
  return null;
}

/** Pull and push wait for a merge, rebase, cherry-pick or revert; none or unknown gates nothing. */
function operationGate(operation: OperationState | undefined): string | null {
  if (operation === undefined || operation.kind === "none") return null;
  return finishOperationFirst(operationNoun(operation));
}

/**
 * Precedence: remotes loading, no remotes, a network action running, an operation in progress,
 * the HEAD state, then the upstream. The operation comes before HEAD because a rebase detaches it.
 */
export function syncGates(
  head: HeadState | undefined,
  tracking: Tracking | null,
  remotes: number | undefined,
  busy: boolean,
  operation?: OperationState,
): SyncGates {
  if (remotes === undefined) return all(LOADING);
  if (remotes === 0) return all(NO_REMOTES);
  if (busy) return all(NETWORK_BUSY);
  const gate = operationGate(operation) ?? headGate(head);
  if (gate !== null) return { fetch: null, pull: gate, push: gate, forcePush: gate };
  const upstreamGate = tracking === null ? NO_UPSTREAM : null;
  return { fetch: null, pull: upstreamGate, push: null, forcePush: upstreamGate };
}

const BUSY: Record<SyncVerb, string> = {
  fetch: "Fetching…",
  pull: "Pulling…",
  push: "Pushing…",
};

export const busyLabel = (verb: SyncVerb): string => BUSY[verb];

export interface UpstreamText {
  text: string;
  ahead: number;
  behind: number;
}

export function upstreamText(
  head: HeadState | undefined,
  tracking: Tracking | null,
): UpstreamText | null {
  if (head?.kind !== "branch") return null;
  if (tracking === null) return { text: "no upstream", ahead: 0, behind: 0 };
  if (tracking.ahead === null || tracking.behind === null)
    return { text: `→ ${tracking.upstream} (upstream gone)`, ahead: 0, behind: 0 };
  return { text: `→ ${tracking.upstream}`, ahead: tracking.ahead, behind: tracking.behind };
}

/** The configured remote an upstream such as `team/a/main` belongs to: the longest name prefix. */
export function upstreamRemote(upstream: string, remotes: string[]): string | null {
  const owners = remotes
    .filter((r) => upstream.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length);
  return owners[0] ?? null;
}

export function forcePushCopy(
  local: string,
  remote: string,
  upstream: string,
): { title: string; body: string } {
  return {
    title: `Force push ${local} to ${remote}?`,
    body: `This replaces ${upstream} with your local branch. It fails safely if someone else pushed since your last fetch.`,
  };
}
