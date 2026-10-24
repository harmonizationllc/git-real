import type { HostedRepoInfo, PushTarget, Tracking } from "../../lib/ipc";
import { upstreamRemote } from "../remotes/syncCopy";

/** The remote a pull request's head branch must be on. */
const ORIGIN = "origin";

export type PrPushPlan = { kind: "publish" } | { kind: "push"; ahead: number } | { kind: "none" };

/** publish when no upstream, upstream not on origin, or upstream gone (ahead === null); push when ahead > 0; else none. */
export function prPushPlan(tracking: Tracking | null, remotes: string[]): PrPushPlan {
  if (tracking === null || upstreamRemote(tracking.upstream, remotes) !== ORIGIN) {
    return { kind: "publish" };
  }
  if (tracking.ahead === null) return { kind: "publish" };
  return tracking.ahead > 0 ? { kind: "push", ahead: tracking.ahead } : { kind: "none" };
}

/** The head branch's name on origin: the local name when publishing, else tracking.upstream without "origin/". */
export function originBranchName(
  local: string,
  tracking: Tracking | null,
  plan: PrPushPlan,
): string {
  if (plan.kind === "publish" || tracking === null) return local;
  return tracking.upstream.slice(ORIGIN.length + 1);
}

/** info.defaultBranch when present among `originBranches` (names), else "main" when present, else the first, else null. */
export function defaultTarget(
  info: HostedRepoInfo | undefined,
  originBranches: string[],
): string | null {
  const preferred = info?.defaultBranch;
  if (preferred != null && originBranches.includes(preferred)) return preferred;
  if (originBranches.includes("main")) return "main";
  return originBranches[0] ?? null;
}

/** What the create command pushes first: always the publish, the ahead commits only when asked. */
export function pushTargetFor(
  plan: PrPushPlan,
  pushFirst: boolean,
  local: string,
): PushTarget | null {
  switch (plan.kind) {
    case "publish":
      return { kind: "setUpstream", remote: ORIGIN, branch: local };
    case "push":
      return pushFirst ? { kind: "upstream" } : null;
    case "none":
      return null;
  }
}
