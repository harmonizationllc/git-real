import { describe, expect, it } from "vitest";
import type { CommitConfig, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { commitDisabledReason } from "./commitGate";

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
