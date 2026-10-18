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
      null,
    ]);
  });

  it("should default fileDiff maxLines to null and include it when given", () => {
    expect(queryKeys.fileDiff(3, "a", "staged", false)).toEqual([
      "repo",
      3,
      "diff",
      "a",
      "staged",
      false,
      null,
    ]);
    expect(queryKeys.fileDiff(3, "a", "staged", false, 1_000_000).at(-1)).toBe(1_000_000);
  });

  it("should keep maxLines 0 and null as distinct fileDiff keys", () => {
    expect(queryKeys.fileDiff(1, "a", "staged", false, 0)).not.toEqual(
      queryKeys.fileDiff(1, "a", "staged", false, null),
    );
  });

  it("should differ between maxLines settings for the same file", () => {
    expect(queryKeys.fileDiff(1, "a", "staged", false)).not.toEqual(
      queryKeys.fileDiff(1, "a", "staged", false, 1_000_000),
    );
  });

  it("should define fileContent under the repo prefix", () => {
    expect(queryKeys.fileContent(3, "a.png", "unstaged", "old")).toEqual([
      "repo",
      3,
      "content",
      "a.png",
      "unstaged",
      "old",
    ]);
  });

  it("should differ between sides for the same file content", () => {
    expect(queryKeys.fileContent(1, "a", "unstaged", "old")).not.toEqual(
      queryKeys.fileContent(1, "a", "unstaged", "new"),
    );
  });

  it("should make repo(id) a prefix of fileContent(id, ...)", () => {
    expect(queryKeys.fileContent(3, "a", "staged", "new").slice(0, 2)).toEqual(queryKeys.repo(3));
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

// Contract: commit config and head message queries live under the repo prefix.
describe("commit query keys", () => {
  it("commitConfig and headMessage keys sit under the repo prefix", () => {
    expect(queryKeys.commitConfig(4)).toEqual(["repo", 4, "commitConfig"]);
    expect(queryKeys.headMessage(4)).toEqual(["repo", 4, "headMessage"]);
    expect(queryKeys.commitConfig(4).slice(0, 2)).toEqual(queryKeys.repo(4));
    expect(queryKeys.headMessage(4).slice(0, 2)).toEqual(queryKeys.repo(4));
  });

  it("commitConfig and headMessage keys differ per repo and from each other", () => {
    expect(queryKeys.commitConfig(4)).not.toEqual(queryKeys.commitConfig(5));
    expect(queryKeys.commitConfig(4)).not.toEqual(queryKeys.headMessage(4));
  });
});

// Contract: the branch list lives under the repo prefix so repo-changed refreshes it.
describe("branch query keys", () => {
  it("should define branches(id) as ['repo', id, 'branches']", () => {
    expect(queryKeys.branches(3)).toEqual(["repo", 3, "branches"]);
  });

  it("should make repo(id) a prefix of branches(id)", () => {
    expect(queryKeys.branches(3).slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should differ between repo ids and from the status key", () => {
    expect(queryKeys.branches(3)).not.toEqual(queryKeys.branches(4));
    expect(queryKeys.branches(3)).not.toEqual(queryKeys.status(3));
  });

  it("should be invalidated by repo(id) invalidation of that repo only", async () => {
    const qc = createQueryClient();
    qc.setQueryData(queryKeys.branches(1), 1);
    qc.setQueryData(queryKeys.branches(2), 1);
    await qc.invalidateQueries({ queryKey: queryKeys.repo(1) });
    expect([
      qc.getQueryState(queryKeys.branches(1))?.isInvalidated,
      qc.getQueryState(queryKeys.branches(2))?.isInvalidated,
    ]).toEqual([true, false]);
  });
});
