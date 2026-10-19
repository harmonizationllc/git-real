import { describe, expect, it } from "vitest";
import type { CommitMessage, HeadState, OperationState } from "../../lib/ipc";
import {
  IN_PROGRESS_TITLE,
  bannerTitle,
  commitButtonLabel,
  commitsThroughBox,
  headName,
  operationNoun,
  sideLabels,
} from "./operationCopy";

type Active = Exclude<OperationState, { kind: "none" }>;

const message: CommitMessage = { subject: "s", body: "" };
const oidA = "abcdef0123456789abcdef0123456789abcdef01";
const oidB = "1234567890abcdef1234567890abcdef12345678";

const merge = (branch: string | null = "feature"): Active => ({
  kind: "merge",
  head: oidA,
  branch,
  message,
});
const rebase = (over: Partial<Extract<Active, { kind: "rebase" }>> = {}): Active => ({
  kind: "rebase",
  onto: oidB,
  ontoName: "main",
  branch: "feature",
  step: 2,
  total: 5,
  ...over,
});
const pick: Active = { kind: "cherryPick", oid: oidA, message };
const revert: Active = { kind: "revert", oid: oidB, message };

// Contract: the noun names the operation in dialog titles and menu titles.
describe("operationNoun", () => {
  it.each([
    [merge(), "merge"],
    [rebase(), "rebase"],
    [pick, "cherry-pick"],
    [revert, "revert"],
  ] as const)("should name %j as %s", (state, noun) => {
    expect(operationNoun(state)).toBe(noun);
  });
});

// Contract: the current HEAD name is the branch name, else "HEAD".
describe("headName", () => {
  it("should return the branch name for a branch head", () => {
    const head: HeadState = { kind: "branch", name: "main" };
    expect(headName(head)).toBe("main");
  });

  it("should return HEAD for a detached head", () => {
    expect(headName({ kind: "detached", oid: oidA })).toBe("HEAD");
  });

  it("should return HEAD for an unborn head", () => {
    expect(headName({ kind: "unborn", name: "main" })).toBe("HEAD");
  });

  it("should return HEAD while the head is unknown", () => {
    expect(headName(undefined)).toBe("HEAD");
  });
});

// Contract: banner titles per spec 5.6 with the conflict suffix.
describe("bannerTitle", () => {
  it("should title a merge with the merged branch and current branch", () => {
    expect(bannerTitle(merge(), "main", 0)).toBe(
      "Merging feature into main, no conflicts remaining",
    );
  });

  it("should fall back to the short merge head when the merged branch is unknown", () => {
    expect(bannerTitle(merge(null), "main", 0)).toBe(
      "Merging abcdef0 into main, no conflicts remaining",
    );
  });

  it("should use the singular suffix for one conflict", () => {
    expect(bannerTitle(merge(), "main", 1)).toBe("Merging feature into main, 1 conflict remaining");
  });

  it("should use the plural suffix for two conflicts", () => {
    expect(bannerTitle(merge(), "main", 2)).toBe(
      "Merging feature into main, 2 conflicts remaining",
    );
  });

  it("should title a rebase with the branch, onto name and step", () => {
    expect(bannerTitle(rebase(), "HEAD", 3)).toBe(
      "Rebasing feature onto main, step 2 of 5, 3 conflicts remaining",
    );
  });

  it("should fall back to the short onto oid when the onto name is unknown", () => {
    expect(bannerTitle(rebase({ ontoName: null }), "HEAD", 0)).toBe(
      "Rebasing feature onto 1234567, step 2 of 5, no conflicts remaining",
    );
  });

  it("should fall back to the head name when the rebased branch is unknown", () => {
    expect(bannerTitle(rebase({ branch: null }), "HEAD", 1)).toBe(
      "Rebasing HEAD onto main, step 2 of 5, 1 conflict remaining",
    );
  });

  it("should title a cherry-pick with the short oid", () => {
    expect(bannerTitle(pick, "main", 1)).toBe("Cherry-picking abcdef0, 1 conflict remaining");
  });

  it("should title a revert with the short oid", () => {
    expect(bannerTitle(revert, "main", 0)).toBe("Reverting 1234567, no conflicts remaining");
  });
});

// Contract: conflict side labels name the two sides; neutral labels without an operation.
describe("sideLabels", () => {
  it("should label a merge with HEAD and the merged branch", () => {
    expect(sideLabels(merge(), "main")).toEqual({ ours: "main", theirs: "feature" });
  });

  it("should fall back to the short merge head for theirs", () => {
    expect(sideLabels(merge(null), "main")).toEqual({ ours: "main", theirs: "abcdef0" });
  });

  it("should label a rebase with the onto name and the rebased branch", () => {
    expect(sideLabels(rebase(), "HEAD")).toEqual({ ours: "main", theirs: "feature" });
  });

  it("should fall back to the short onto oid for ours", () => {
    expect(sideLabels(rebase({ ontoName: null }), "HEAD")).toEqual({
      ours: "1234567",
      theirs: "feature",
    });
  });

  it("should fall back to the head name for theirs when the rebased branch is unknown", () => {
    expect(sideLabels(rebase({ branch: null }), "HEAD")).toEqual({ ours: "main", theirs: "HEAD" });
  });

  it("should label a cherry-pick with HEAD and the short oid", () => {
    expect(sideLabels(pick, "main")).toEqual({ ours: "main", theirs: "abcdef0" });
  });

  it("should label a revert with HEAD and the short oid", () => {
    expect(sideLabels(revert, "main")).toEqual({ ours: "main", theirs: "1234567" });
  });

  it("should use ours and theirs when no operation is in progress", () => {
    expect(sideLabels({ kind: "none" }, "main")).toEqual({ ours: "ours", theirs: "theirs" });
  });

  it("should use ours and theirs while the state is unknown", () => {
    expect(sideLabels(undefined, "main")).toEqual({ ours: "ours", theirs: "theirs" });
  });
});

// Contract: only operations that commit through the commit box relabel its button.
describe("commitButtonLabel", () => {
  it.each([
    [merge(), "Commit and merge"],
    [pick, "Commit and cherry-pick"],
    [revert, "Commit and revert"],
  ] as const)("should label %j as %s", (state, label) => {
    expect(commitButtonLabel(state)).toBe(label);
  });

  it.each([[rebase()], [{ kind: "none" } as const], [undefined]])(
    "should return null for %j",
    (state) => {
      expect(commitButtonLabel(state)).toBeNull();
    },
  );
});

describe("commitsThroughBox", () => {
  it.each([[merge()], [pick], [revert]])("should be true for %j", (state) => {
    expect(commitsThroughBox(state)).toBe(true);
  });

  it.each([[rebase()], [{ kind: "none" } as const], [undefined]])(
    "should be false for %j",
    (state) => {
      expect(commitsThroughBox(state)).toBe(false);
    },
  );
});

describe("IN_PROGRESS_TITLE", () => {
  it("should be the verbatim disabled-reason copy", () => {
    expect(IN_PROGRESS_TITLE).toBe("Finish or abort the current operation first");
  });
});
