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

// Contract: the log summary sits under the repo prefix; pages, searches and commits are immutable.
describe("commit graph query keys", () => {
  it("should define log(id) as ['repo', id, 'log'] under the repo prefix", () => {
    expect(queryKeys.log(3)).toEqual(["repo", 3, "log"]);
    expect(queryKeys.log(3).slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should define repoImmutable(id) as ['repoImmutable', id]", () => {
    expect(queryKeys.repoImmutable(3)).toEqual(["repoImmutable", 3]);
  });

  it("should define logPage with generation and page", () => {
    expect(queryKeys.logPage(3, 7, 2)).toEqual(["repoImmutable", 3, "logPage", 7, 2]);
  });

  it("should define logSearch with generation and query", () => {
    expect(queryKeys.logSearch(3, 7, "fix")).toEqual(["repoImmutable", 3, "logSearch", 7, "fix"]);
  });

  it("should define commit with the oid", () => {
    expect(queryKeys.commit(3, "abc")).toEqual(["repoImmutable", 3, "commit", "abc"]);
  });

  it.each([
    ["logPage", () => queryKeys.logPage(3, 7, 2)],
    ["logSearch", () => queryKeys.logSearch(3, 7, "fix")],
    ["commit", () => queryKeys.commit(3, "abc")],
  ])("should not start %s with the repo prefix", (_name, key) => {
    expect(key().slice(0, 2)).not.toEqual(queryKeys.repo(3));
  });

  it("should start logPage, logSearch and commit with repoImmutable(id)", () => {
    expect([
      queryKeys.logPage(3, 7, 2).slice(0, 2),
      queryKeys.logSearch(3, 7, "x").slice(0, 2),
      queryKeys.commit(3, "abc").slice(0, 2),
    ]).toEqual([
      queryKeys.repoImmutable(3),
      queryKeys.repoImmutable(3),
      queryKeys.repoImmutable(3),
    ]);
  });

  it("should differ between generations, pages, queries and oids", () => {
    expect(queryKeys.logPage(3, 7, 2)).not.toEqual(queryKeys.logPage(3, 8, 2));
    expect(queryKeys.logPage(3, 7, 2)).not.toEqual(queryKeys.logPage(3, 7, 3));
    expect(queryKeys.logSearch(3, 7, "a")).not.toEqual(queryKeys.logSearch(3, 7, "b"));
    expect(queryKeys.commit(3, "a")).not.toEqual(queryKeys.commit(3, "b"));
  });

  it("should invalidate the log summary but keep immutable entries when repo(id) is invalidated", async () => {
    const qc = createQueryClient();
    qc.setQueryData(queryKeys.log(1), 1);
    qc.setQueryData(queryKeys.logPage(1, 7, 0), 1);
    qc.setQueryData(queryKeys.logSearch(1, 7, "x"), 1);
    qc.setQueryData(queryKeys.commit(1, "abc"), 1);
    await qc.invalidateQueries({ queryKey: queryKeys.repo(1) });
    expect([
      qc.getQueryState(queryKeys.log(1))?.isInvalidated,
      qc.getQueryState(queryKeys.logPage(1, 7, 0))?.isInvalidated,
      qc.getQueryState(queryKeys.logSearch(1, 7, "x"))?.isInvalidated,
      qc.getQueryState(queryKeys.commit(1, "abc"))?.isInvalidated,
    ]).toEqual([true, false, false, false]);
  });
});

// Contract: GR-9 keys; immutable data lives under repoImmutable, HEAD-relative data under repo.
describe("queryKeys history keys", () => {
  it("should define commitFiles under the repoImmutable prefix", () => {
    expect(queryKeys.commitFiles(3, "abc")).toEqual(["repoImmutable", 3, "commitFiles", "abc"]);
  });

  it("should define fileHistory with generation and path under repoImmutable", () => {
    expect(queryKeys.fileHistory(3, 9, "a.ts")).toEqual([
      "repoImmutable",
      3,
      "fileHistory",
      9,
      "a.ts",
    ]);
  });

  it("should define blameAt under the repoImmutable prefix", () => {
    expect(queryKeys.blameAt(3, "a.ts", "abc")).toEqual([
      "repoImmutable",
      3,
      "blame",
      "a.ts",
      "abc",
    ]);
  });

  it("should define blameHead under the repo prefix", () => {
    expect(queryKeys.blameHead(3, "a.ts")).toEqual(["repo", 3, "blame", "a.ts"]);
  });

  it("should define trackedFiles under the repo prefix", () => {
    expect(queryKeys.trackedFiles(3)).toEqual(["repo", 3, "trackedFiles"]);
  });

  it("should differ between blame at two commits of the same file", () => {
    expect(queryKeys.blameAt(1, "a", "x")).not.toEqual(queryKeys.blameAt(1, "a", "y"));
  });

  it("should make repo(id) a prefix of blameHead and trackedFiles", () => {
    expect(queryKeys.blameHead(3, "a").slice(0, 2)).toEqual(queryKeys.repo(3));
    expect(queryKeys.trackedFiles(3).slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should not put blameAt under the repo prefix", () => {
    expect(queryKeys.blameAt(3, "a", "x")[0]).not.toBe("repo");
  });

  it("should give an object-scoped fileDiff a stable key that differs from a string scope", () => {
    const a = queryKeys.fileDiff(1, "a", { commit: "abc" }, false);
    expect(a).toEqual(queryKeys.fileDiff(1, "a", { commit: "abc" }, false));
    expect(a).not.toEqual(queryKeys.fileDiff(1, "a", "staged", false));
  });

  it("should differ between two commit scopes for the same file", () => {
    expect(queryKeys.fileDiff(1, "a", { commit: "x" }, false)).not.toEqual(
      queryKeys.fileDiff(1, "a", { commit: "y" }, false),
    );
  });
});

// Contract: the operation keys live under the repo prefix so one invalidation refreshes them.
describe("queryKeys merge operation keys", () => {
  it("should define operation(id) under the repo prefix", () => {
    expect(queryKeys.operation(3)).toEqual(["repo", 3, "operation"]);
  });

  it("should define fastForward(id, branch) under the repo prefix", () => {
    expect(queryKeys.fastForward(3, "feature")).toEqual(["repo", 3, "fastForward", "feature"]);
  });

  it("should start both keys with the repo key", () => {
    expect(queryKeys.operation(3).slice(0, 2)).toEqual(queryKeys.repo(3));
    expect(queryKeys.fastForward(3, "a").slice(0, 2)).toEqual(queryKeys.repo(3));
  });

  it("should differ between two branches for the fast-forward key", () => {
    expect(queryKeys.fastForward(1, "a")).not.toEqual(queryKeys.fastForward(1, "b"));
  });

  it("should differ between two repos for the operation key", () => {
    expect(queryKeys.operation(1)).not.toEqual(queryKeys.operation(2));
  });
});

// Contract: the rebase plan key lives under the repo prefix and varies with the base.
describe("queryKeys rebasePlan", () => {
  it("should define rebasePlan(id, base) under the repo prefix", () => {
    expect(queryKeys.rebasePlan(1, "main")).toEqual(["repo", 1, "rebasePlan", "main"]);
  });

  it("should start with the repo key", () => {
    expect(queryKeys.rebasePlan(1, "main").slice(0, 2)).toEqual(queryKeys.repo(1));
  });

  it("should differ between two bases", () => {
    expect(queryKeys.rebasePlan(1, "a")).not.toEqual(queryKeys.rebasePlan(1, "b"));
  });

  it("should differ between two repos", () => {
    expect(queryKeys.rebasePlan(1, "a")).not.toEqual(queryKeys.rebasePlan(2, "a"));
  });
});
