import { describe, expect, it } from "vitest";
import { createQueryClient } from "./client";
import { queryKeys } from "./keys";

// Contract: the git CLI availability check has its own cache key, distinct from other queries.
describe("queryKeys", () => {
  it("should define a gitCli key", () => {
    expect(queryKeys.gitCli).toEqual(["gitCli"]);
  });

  it("should use a gitCli key that differs from the recent key", () => {
    expect(queryKeys.gitCli).not.toEqual(queryKeys.recent);
  });
});

// Contract: repo(id) is a prefix of every per-repo key so one invalidation refreshes them all.
describe("queryKeys per-repo keys", () => {
  it("should define repo(id) as ['repo', id]", () => {
    expect(queryKeys.repo(3)).toEqual(["repo", 3]);
  });

  it("should define status(id) under the repo prefix", () => {
    expect(queryKeys.status(3)).toEqual(["repo", 3, "status"]);
  });

  it("should define fileDiff with path, scope and ignoreWhitespace under the repo prefix", () => {
    expect(queryKeys.fileDiff(3, "a.txt", "staged", true)).toEqual([
      "repo",
      3,
      "diff",
      "a.txt",
      "staged",
      true,
    ]);
  });

  it("should make repo(id) a prefix of status(id)", () => {
    expect(queryKeys.status(3).slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should make repo(id) a prefix of fileDiff(id, ...)", () => {
    expect(queryKeys.fileDiff(3, "a", "unstaged", false).slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should differ between repo ids", () => {
    expect(queryKeys.status(1)).not.toEqual(queryKeys.status(2));
  });

  it("should differ between scopes for the same file", () => {
    expect(queryKeys.fileDiff(1, "a", "staged", false)).not.toEqual(
      queryKeys.fileDiff(1, "a", "unstaged", false),
    );
  });

  it("should differ between ignoreWhitespace settings for the same file", () => {
    expect(queryKeys.fileDiff(1, "a", "staged", false)).not.toEqual(
      queryKeys.fileDiff(1, "a", "staged", true),
    );
  });
});

// Contract: invalidating repo(id) marks that repo's queries stale and nothing else.
describe("queryKeys prefix invalidation", () => {
  async function invalidated() {
    const qc = createQueryClient();
    const keys = {
      status1: queryKeys.status(1),
      diff1: queryKeys.fileDiff(1, "a", "staged", false),
      status2: queryKeys.status(2),
      recent: queryKeys.recent,
      gitCli: queryKeys.gitCli,
    };
    for (const k of Object.values(keys)) qc.setQueryData(k, 1);
    await qc.invalidateQueries({ queryKey: queryKeys.repo(1) });
    return (k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated;
  }

  it("should invalidate status and diff queries of that repo", async () => {
    const is = await invalidated();
    expect([is(queryKeys.status(1)), is(queryKeys.fileDiff(1, "a", "staged", false))]).toEqual([
      true,
      true,
    ]);
  });

  it("should leave other repos and unrelated queries valid", async () => {
    const is = await invalidated();
    expect([is(queryKeys.status(2)), is(queryKeys.recent), is(queryKeys.gitCli)]).toEqual([
      false,
      false,
      false,
    ]);
  });
});
