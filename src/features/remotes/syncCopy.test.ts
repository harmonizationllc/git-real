import { describe, expect, it } from "vitest";
import type { HeadState, OperationState, Tracking } from "../../lib/ipc";
import {
  CHECK_OUT_A_BRANCH,
  LOADING,
  MAKE_A_COMMIT_FIRST,
  NETWORK_BUSY,
  NO_REMOTES,
  NO_UPSTREAM,
  busyLabel,
  forcePushCopy,
  syncGates,
  upstreamRemote,
  upstreamText,
} from "./syncCopy";

const branch: HeadState = { kind: "branch", name: "main" };
const tracked: Tracking = { upstream: "origin/main", ahead: 0, behind: 0 };
const all = (reason: string) => ({
  fetch: reason,
  pull: reason,
  push: reason,
  forcePush: reason,
});

// Contract: the tooltip strings are fixed copy.
describe("syncCopy constants", () => {
  it("should hold the verbatim tooltips", () => {
    expect([
      NO_REMOTES,
      CHECK_OUT_A_BRANCH,
      MAKE_A_COMMIT_FIRST,
      NO_UPSTREAM,
      NETWORK_BUSY,
      LOADING,
    ]).toEqual([
      "No remotes configured",
      "Check out a branch to pull or push.",
      "Make a commit first",
      "This branch has no upstream",
      "Another network operation is running",
      "Loading…",
    ]);
  });
});

// Contract: why each button is disabled, in precedence order: loading, no remotes, busy, HEAD, upstream.
describe("syncGates", () => {
  it("should gate every button with Loading… while the remotes load", () => {
    expect(syncGates(branch, tracked, undefined, false)).toEqual(all("Loading…"));
  });

  it("should gate fetch, pull, push and force push with No remotes configured, before busy", () => {
    expect(syncGates(branch, tracked, 0, true)).toEqual(all("No remotes configured"));
  });

  it("should gate everything with Another network operation is running while one runs", () => {
    expect(syncGates(branch, tracked, 1, true)).toEqual(
      all("Another network operation is running"),
    );
  });

  it("should gate pull and push but not fetch while the branch list loads", () => {
    expect(syncGates(undefined, null, 1, false)).toEqual({
      fetch: null,
      pull: "Loading…",
      push: "Loading…",
      forcePush: "Loading…",
    });
  });

  it("should gate pull and push with Check out a branch to pull or push. on a detached HEAD", () => {
    const head: HeadState = { kind: "detached", oid: "a".repeat(40) };
    expect(syncGates(head, null, 1, false)).toEqual({
      fetch: null,
      pull: "Check out a branch to pull or push.",
      push: "Check out a branch to pull or push.",
      forcePush: "Check out a branch to pull or push.",
    });
  });

  it("should gate pull and push with Make a commit first on an unborn HEAD", () => {
    const head: HeadState = { kind: "unborn", name: "main" };
    expect(syncGates(head, null, 1, false)).toEqual({
      fetch: null,
      pull: "Make a commit first",
      push: "Make a commit first",
      forcePush: "Make a commit first",
    });
  });

  it("should gate pull and force push but not push when the branch has no upstream", () => {
    expect(syncGates(branch, null, 1, false)).toEqual({
      fetch: null,
      pull: "This branch has no upstream",
      push: null,
      forcePush: "This branch has no upstream",
    });
  });

  it("should enable everything for a tracked branch", () => {
    expect(syncGates(branch, tracked, 1, false)).toEqual({
      fetch: null,
      pull: null,
      push: null,
      forcePush: null,
    });
  });
});

// Contract (W2): while a merge, rebase, cherry-pick or revert is in progress, pull, push and force
// push are gated with "Finish or abort the <operation> first"; fetch stays enabled. The check
// follows loading and no-remotes and precedes HEAD, upstream and busy. The operation is the
// optional fifth argument; undefined (still loading) and kind "none" gate nothing.
describe("syncGates during an in-progress operation", () => {
  const merge: OperationState = {
    kind: "merge",
    head: "a".repeat(40),
    branch: "topic",
    message: { subject: "Merge", body: "" },
  };
  const rebase: OperationState = {
    kind: "rebase",
    onto: "b".repeat(40),
    ontoName: "main",
    branch: "topic",
    step: 1,
    total: 2,
    stoppedForEdit: false,
  };
  const cherryPick: OperationState = {
    kind: "cherryPick",
    oid: "c".repeat(40),
    message: { subject: "Pick", body: "" },
  };
  const revert: OperationState = {
    kind: "revert",
    oid: "d".repeat(40),
    message: { subject: "Revert", body: "" },
  };
  const blocked = (noun: string) => ({
    fetch: null,
    pull: `Finish or abort the ${noun} first`,
    push: `Finish or abort the ${noun} first`,
    forcePush: `Finish or abort the ${noun} first`,
  });

  it.each<[string, OperationState]>([
    ["merge", merge],
    ["rebase", rebase],
    ["cherry-pick", cherryPick],
    ["revert", revert],
  ])("should gate pull, push and force push but not fetch during a %s", (noun, operation) => {
    expect(syncGates(branch, tracked, 1, false, operation)).toEqual(blocked(noun));
  });

  it("should gate nothing when the operation state is none", () => {
    expect(syncGates(branch, tracked, 1, false, { kind: "none" })).toEqual({
      fetch: null,
      pull: null,
      push: null,
      forcePush: null,
    });
  });

  it("should gate nothing while the operation state is still loading", () => {
    expect(syncGates(branch, tracked, 1, false, undefined)).toEqual({
      fetch: null,
      pull: null,
      push: null,
      forcePush: null,
    });
  });

  it("should keep Loading… for every button while the remotes load, before the operation", () => {
    expect(syncGates(branch, tracked, undefined, false, merge)).toEqual(all("Loading…"));
  });

  it("should keep No remotes configured for every button, before the operation", () => {
    expect(syncGates(branch, tracked, 0, false, merge)).toEqual(all("No remotes configured"));
  });

  it("should name the operation before the no-upstream gate", () => {
    expect(syncGates(branch, null, 1, false, merge)).toEqual(blocked("merge"));
  });

  it("should name the operation before the busy gate for pull, push and force push", () => {
    const gates = syncGates(branch, tracked, 1, true, merge);
    expect([gates.pull, gates.push, gates.forcePush]).toEqual([
      "Finish or abort the merge first",
      "Finish or abort the merge first",
      "Finish or abort the merge first",
    ]);
  });

  // A rebase stops on a detached HEAD, so naming the operation must win over the detached copy.
  it("should name the rebase rather than the detached HEAD when a rebase has detached HEAD", () => {
    const head: HeadState = { kind: "detached", oid: "a".repeat(40) };
    expect(syncGates(head, null, 1, false, rebase)).toEqual(blocked("rebase"));
  });
});

describe("busyLabel", () => {
  it("should give Fetching…, Pulling… and Pushing…", () => {
    expect([busyLabel("fetch"), busyLabel("pull"), busyLabel("push")]).toEqual([
      "Fetching…",
      "Pulling…",
      "Pushing…",
    ]);
  });
});

// Contract: the toolbar's upstream text omits the branch name and shows counts separately.
describe("upstreamText", () => {
  it.each<[string, HeadState | undefined]>([
    ["an unknown head", undefined],
    ["a detached HEAD", { kind: "detached", oid: "a".repeat(40) }],
    ["an unborn HEAD", { kind: "unborn", name: "main" }],
  ])("should be null for %s", (_name, head) => {
    expect(upstreamText(head, tracked)).toBeNull();
  });

  it("should say no upstream with zero counts when tracking is null", () => {
    expect(upstreamText(branch, null)).toEqual({ text: "no upstream", ahead: 0, behind: 0 });
  });

  it("should flag a gone upstream when the counts are null", () => {
    expect(upstreamText(branch, { upstream: "origin/main", ahead: null, behind: null })).toEqual({
      text: "→ origin/main (upstream gone)",
      ahead: 0,
      behind: 0,
    });
  });

  it("should show the upstream with its counts", () => {
    expect(upstreamText(branch, { upstream: "origin/main", ahead: 2, behind: 3 })).toEqual({
      text: "→ origin/main",
      ahead: 2,
      behind: 3,
    });
  });
});

describe("upstreamRemote", () => {
  it("should pick the longest configured prefix", () => {
    expect(upstreamRemote("team/a/main", ["team", "team/a"])).toBe("team/a");
  });

  it("should not match a remote that only shares a name prefix", () => {
    expect(upstreamRemote("origin/main", ["orig", "origin"])).toBe("origin");
  });

  it("should be null when no remote matches", () => {
    expect(upstreamRemote("origin/main", ["upstream"])).toBeNull();
  });

  it("should be null with no remotes", () => {
    expect(upstreamRemote("origin/main", [])).toBeNull();
  });
});

describe("forcePushCopy", () => {
  it("should name the branch and remote in the title and the upstream in the body", () => {
    expect(forcePushCopy("main", "origin", "origin/main")).toEqual({
      title: "Force push main to origin?",
      body: "This replaces origin/main with your local branch. It fails safely if someone else pushed since your last fetch.",
    });
  });
});
