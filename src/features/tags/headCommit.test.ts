import { describe, expect, it } from "vitest";
import type { BranchList } from "../../lib/ipc";
import { oidOf } from "../../test/graphFixtures";
import { headCommit } from "./headCommit";

const list = (over: Partial<BranchList> = {}): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    { name: "other", oid: oidOf(5), isHead: false, tracking: null },
    { name: "main", oid: oidOf(1), isHead: true, tracking: null },
  ],
  remotes: [],
  ...over,
});

// Contract: HEAD's full commit id, or null while loading, on an unborn branch or when unknown.
describe("headCommit", () => {
  it("should be null while the branch list is loading", () => {
    expect(headCommit(undefined)).toBeNull();
  });

  it("should be null on an unborn branch", () => {
    expect(headCommit(list({ head: { kind: "unborn", name: "main" }, local: [] }))).toBeNull();
  });

  it("should be the detached oid on a detached HEAD", () => {
    expect(headCommit(list({ head: { kind: "detached", oid: oidOf(9) }, local: [] }))).toBe(
      oidOf(9),
    );
  });

  it("should be the oid of the isHead local branch on a branch", () => {
    expect(headCommit(list())).toBe(oidOf(1));
  });

  it("should be null on a branch with no isHead local branch in the list", () => {
    expect(
      headCommit(
        list({ local: [{ name: "other", oid: oidOf(5), isHead: false, tracking: null }] }),
      ),
    ).toBeNull();
  });
});
