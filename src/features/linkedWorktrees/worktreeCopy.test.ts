import { describe, expect, it } from "vitest";
import { oidOf } from "../../test/graphFixtures";
import { linkedWorktree } from "../../test/worktreeFixtures";
import { headText, openTitle, removeTitle } from "./worktreeCopy";

const linked = linkedWorktree({ name: "a", path: "/repos/app-a", isMain: false, isCurrent: false });

// Contract: a row's head text follows the repo header's wording.
describe("headText", () => {
  it("shows a branch by name", () => {
    expect(headText({ kind: "branch", name: "feat/a" })).toBe("feat/a");
  });

  it("shows a detached head by its short oid", () => {
    expect(headText({ kind: "detached", oid: oidOf(5) })).toBe(
      `detached at ${oidOf(5).slice(0, 7)}`,
    );
  });

  it("shows an unborn branch with no commits yet", () => {
    expect(headText({ kind: "unborn", name: "main" })).toBe("main (no commits yet)");
  });

  it("shows unknown HEAD when the head could not be read", () => {
    expect(headText(null)).toBe("unknown HEAD");
  });
});

// Contract: Remove… explains why it is disabled, and is allowed otherwise.
describe("removeTitle", () => {
  it("refuses the main worktree", () => {
    expect(removeTitle(linkedWorktree({ isCurrent: false }))).toBe(
      "The main worktree cannot be removed",
    );
  });

  it("refuses the current worktree", () => {
    expect(removeTitle({ ...linked, isCurrent: true })).toBe(
      "Close this tab and remove it from another worktree",
    );
  });

  it("refuses a locked worktree with its reason", () => {
    expect(removeTitle({ ...linked, locked: "on a USB disk" })).toBe("Locked: on a USB disk");
  });

  it("refuses a locked worktree without a reason", () => {
    expect(removeTitle({ ...linked, locked: "" })).toBe("Locked");
  });

  it("allows a removable worktree", () => {
    expect(removeTitle(linked)).toBeUndefined();
  });
});

// Contract: Open explains why it is disabled, and is allowed otherwise.
describe("openTitle", () => {
  it("refuses the current worktree", () => {
    expect(openTitle({ ...linked, isCurrent: true })).toBe("Already open in this tab");
  });

  it("refuses a missing worktree", () => {
    expect(openTitle({ ...linked, missing: true })).toBe("Folder not found");
  });

  it("allows an openable worktree", () => {
    expect(openTitle(linked)).toBeUndefined();
  });
});
