import { describe, expect, it } from "vitest";
import type { CommitConfig, OperationState, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { commitDisabledReason as gateReason } from "./commitGate";
import type { CommitGateInput } from "./commitGate";

// The gate takes the in-progress operation; existing cases run with none unless they say otherwise.
const commitDisabledReason = (
  input: Omit<CommitGateInput, "operation"> & { operation?: OperationState },
) => gateReason({ operation: undefined, ...input });

const entry = (over: Partial<StatusEntry>): StatusEntry => ({
  path: "a.txt",
  oldPath: null,
  index: null,
  worktree: null,
  conflicted: false,
  ...over,
});
const status = (entries: StatusEntry[]): WorkingTreeStatus => ({ entries, headUnborn: false });
const config: CommitConfig = { name: "A", email: "a@b.c", signing: null };
const staged = status([entry({ index: "modified" })]);

describe("commitDisabledReason", () => {
  it("is Loading… while status or config is missing", () => {
    expect(commitDisabledReason({ amend: false, subject: "s", status: undefined, config })).toBe(
      "Loading…",
    );
    expect(
      commitDisabledReason({ amend: false, subject: "s", status: staged, config: undefined }),
    ).toBe("Loading…");
  });

  it("requires name and email", () => {
    const reason = "Set user.name and user.email in your Git config";
    expect(
      commitDisabledReason({
        amend: false,
        subject: "s",
        status: staged,
        config: { ...config, name: null },
      }),
    ).toBe(reason);
    expect(
      commitDisabledReason({
        amend: false,
        subject: "s",
        status: staged,
        config: { ...config, email: null },
      }),
    ).toBe(reason);
  });

  it("conflicts win over staged changes", () => {
    const s = status([entry({ conflicted: true }), entry({ path: "b", index: "added" })]);
    expect(commitDisabledReason({ amend: false, subject: "s", status: s, config })).toBe(
      "Resolve conflicts before committing",
    );
  });

  it("needs staged changes unless amending", () => {
    const unstaged = status([entry({ worktree: "modified" })]);
    expect(commitDisabledReason({ amend: false, subject: "s", status: unstaged, config })).toBe(
      "Stage changes to commit",
    );
    expect(
      commitDisabledReason({ amend: true, subject: "s", status: unstaged, config }),
    ).toBeNull();
  });

  it("needs a non-blank subject", () => {
    expect(commitDisabledReason({ amend: false, subject: "   ", status: staged, config })).toBe(
      "Enter a commit subject",
    );
  });

  it("returns null when everything is in place", () => {
    expect(
      commitDisabledReason({ amend: false, subject: "ok", status: staged, config }),
    ).toBeNull();
  });

  it("checks identity before conflicts and conflicts before staging", () => {
    const s = status([entry({ conflicted: true })]);
    expect(
      commitDisabledReason({
        amend: false,
        subject: "",
        status: s,
        config: { ...config, name: null },
      }),
    ).toBe("Set user.name and user.email in your Git config");
    expect(commitDisabledReason({ amend: false, subject: "", status: s, config })).toBe(
      "Resolve conflicts before committing",
    );
  });
});

// Contract (spec 5.4): a rebase continues from the banner, not the commit box.
describe("commitDisabledReason during an operation", () => {
  const REBASE_REASON = "Use Continue in the banner to resume the rebase";
  const message = { subject: "s", body: "" };
  const rebase: OperationState = {
    kind: "rebase",
    onto: "b".repeat(40),
    ontoName: "main",
    branch: "feature",
    step: 1,
    total: 2,
  };
  const ready = { amend: false, subject: "s", status: staged, config } as const;

  it("is the rebase reason when a rebase is in progress and everything else is in place", () => {
    expect(gateReason({ ...ready, operation: rebase })).toBe(REBASE_REASON);
  });

  it("puts the rebase reason before the identity check", () => {
    expect(gateReason({ ...ready, config: { ...config, name: null }, operation: rebase })).toBe(
      REBASE_REASON,
    );
  });

  it("puts the rebase reason before the conflicts check", () => {
    const s = status([entry({ conflicted: true })]);
    expect(gateReason({ ...ready, status: s, operation: rebase })).toBe(REBASE_REASON);
  });

  it("puts the rebase reason before the staged and subject checks", () => {
    const unstaged = status([entry({ worktree: "modified" })]);
    expect(gateReason({ ...ready, status: unstaged, subject: "", operation: rebase })).toBe(
      REBASE_REASON,
    );
  });

  it("keeps Loading… ahead of the rebase reason", () => {
    expect(gateReason({ ...ready, status: undefined, operation: rebase })).toBe("Loading…");
    expect(gateReason({ ...ready, config: undefined, operation: rebase })).toBe("Loading…");
  });

  it("changes nothing when the operation is undefined", () => {
    expect(gateReason({ ...ready, operation: undefined })).toBeNull();
    expect(gateReason({ ...ready, subject: "", operation: undefined })).toBe(
      "Enter a commit subject",
    );
  });

  it("changes nothing when the operation is none", () => {
    expect(gateReason({ ...ready, operation: { kind: "none" } })).toBeNull();
    expect(gateReason({ ...ready, subject: "", operation: { kind: "none" } })).toBe(
      "Enter a commit subject",
    );
  });

  it("does not block a merge, cherry-pick or revert that is ready to commit", () => {
    for (const operation of [
      { kind: "merge", head: "a".repeat(40), branch: "f", message },
      { kind: "cherryPick", oid: "a".repeat(40), message },
      { kind: "revert", oid: "a".repeat(40), message },
    ] satisfies OperationState[]) {
      expect(gateReason({ ...ready, operation })).toBeNull();
    }
  });

  it("keeps the conflicts rule during a merge", () => {
    const s = status([entry({ conflicted: true })]);
    expect(
      gateReason({
        ...ready,
        status: s,
        operation: { kind: "merge", head: "a".repeat(40), branch: "f", message },
      }),
    ).toBe("Resolve conflicts before committing");
  });

  // Contract (R3): a merge commit may be recorded with an index equal to HEAD.
  const unstagedOnly = status([entry({ worktree: "modified" })]);

  it("does not require staged changes for a merge", () => {
    expect(
      gateReason({
        ...ready,
        status: unstagedOnly,
        operation: { kind: "merge", head: "a".repeat(40), branch: "f", message },
      }),
    ).toBeNull();
  });

  it("still requires staged changes for a cherry-pick", () => {
    expect(
      gateReason({
        ...ready,
        status: unstagedOnly,
        operation: { kind: "cherryPick", oid: "a".repeat(40), message },
      }),
    ).toBe("Stage changes to commit");
  });

  it("still requires staged changes for a revert", () => {
    expect(
      gateReason({
        ...ready,
        status: unstagedOnly,
        operation: { kind: "revert", oid: "a".repeat(40), message },
      }),
    ).toBe("Stage changes to commit");
  });

  it("still requires a subject for a merge with nothing staged", () => {
    expect(
      gateReason({
        ...ready,
        status: unstagedOnly,
        subject: " ",
        operation: { kind: "merge", head: "a".repeat(40), branch: "f", message },
      }),
    ).toBe("Enter a commit subject");
  });

  it("keeps the conflicts rule for cherry-pick and revert", () => {
    const s = status([entry({ conflicted: true })]);
    for (const operation of [
      { kind: "cherryPick", oid: "a".repeat(40), message },
      { kind: "revert", oid: "a".repeat(40), message },
    ] satisfies OperationState[]) {
      expect(gateReason({ ...ready, status: s, operation })).toBe(
        "Resolve conflicts before committing",
      );
    }
  });
});

// Coverage audit: rule order and amend interplay for each operation kind.
describe("commitDisabledReason operation gaps", () => {
  const message = { subject: "s", body: "" };
  const merge: OperationState = { kind: "merge", head: "a".repeat(40), branch: "f", message };
  const ready = { amend: false, subject: "s", status: staged, config } as const;
  const unstagedOnly = status([entry({ worktree: "modified" })]);

  it("is the rebase reason even when amend is on", () => {
    const rebase: OperationState = {
      kind: "rebase",
      onto: "b".repeat(40),
      ontoName: null,
      branch: null,
      step: 1,
      total: 1,
    };
    expect(gateReason({ ...ready, amend: true, operation: rebase })).toBe(
      "Use Continue in the banner to resume the rebase",
    );
  });

  it("still demands an identity for a merge", () => {
    expect(gateReason({ ...ready, config: { ...config, email: null }, operation: merge })).toBe(
      "Set user.name and user.email in your Git config",
    );
  });

  it("puts the conflicts rule ahead of the merge staged exemption", () => {
    const s = status([entry({ conflicted: true, worktree: "conflicted" })]);
    expect(gateReason({ ...ready, status: s, operation: merge })).toBe(
      "Resolve conflicts before committing",
    );
  });

  it("keeps Loading… ahead of everything for a merge", () => {
    expect(gateReason({ ...ready, status: undefined, operation: merge })).toBe("Loading…");
  });

  it("allows a merge with an empty status and a subject", () => {
    expect(gateReason({ ...ready, status: status([]), operation: merge })).toBeNull();
  });

  it("still requires staged changes outside an operation when only the worktree changed", () => {
    expect(gateReason({ ...ready, status: unstagedOnly, operation: { kind: "none" } })).toBe(
      "Stage changes to commit",
    );
  });

  it("allows an amend of a cherry-pick with nothing staged", () => {
    expect(
      gateReason({
        ...ready,
        amend: true,
        status: unstagedOnly,
        operation: { kind: "cherryPick", oid: "a".repeat(40), message },
      }),
    ).toBeNull();
  });
});
