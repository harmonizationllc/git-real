import type { DiffScope, DiffSide, RepoId } from "../ipc";

export const queryKeys = {
  recent: ["recent"] as const,
  gitCli: ["gitCli"] as const,
  /** Prefix of every per-repo key: invalidating it refreshes all of that repo's queries. */
  repo: (id: RepoId) => ["repo", id] as const,
  status: (id: RepoId) => ["repo", id, "status"] as const,
  fileDiff: (
    id: RepoId,
    path: string,
    scope: DiffScope,
    ignoreWs: boolean,
    maxLines: number | null = null,
  ) => ["repo", id, "diff", path, scope, ignoreWs, maxLines] as const,
  fileContent: (id: RepoId, path: string, scope: DiffScope, side: DiffSide) =>
    ["repo", id, "content", path, scope, side] as const,
  commitConfig: (id: RepoId) => ["repo", id, "commitConfig"] as const,
  headMessage: (id: RepoId) => ["repo", id, "headMessage"] as const,
  branches: (id: RepoId) => ["repo", id, "branches"] as const,
  /** The log summary; under the repo prefix so every repo change re-checks the generation. */
  log: (id: RepoId) => ["repo", id, "log"] as const,
  /** Prefix of per-repo data that never changes once fetched; repo invalidation skips it. */
  repoImmutable: (id: RepoId) => ["repoImmutable", id] as const,
  logPage: (id: RepoId, generation: number, page: number) =>
    ["repoImmutable", id, "logPage", generation, page] as const,
  logSearch: (id: RepoId, generation: number, query: string) =>
    ["repoImmutable", id, "logSearch", generation, query] as const,
  commit: (id: RepoId, oid: string) => ["repoImmutable", id, "commit", oid] as const,
  commitFiles: (id: RepoId, oid: string) => ["repoImmutable", id, "commitFiles", oid] as const,
  /** A stash commit never changes, so its files are immutable. */
  stashFiles: (id: RepoId, oid: string) => ["repoImmutable", id, "stashFiles", oid] as const,
  fileHistory: (id: RepoId, generation: number, path: string) =>
    ["repoImmutable", id, "fileHistory", generation, path] as const,
  /** Blame at a fixed commit never changes. */
  blameAt: (id: RepoId, path: string, oid: string) =>
    ["repoImmutable", id, "blame", path, oid] as const,
  /** Blame at HEAD; under the repo prefix so a new HEAD refreshes it. */
  blameHead: (id: RepoId, path: string) => ["repo", id, "blame", path] as const,
  trackedFiles: (id: RepoId) => ["repo", id, "trackedFiles"] as const,
  operation: (id: RepoId) => ["repo", id, "operation"] as const,
  /** The stash list; under the repo prefix so a repo change refreshes it. */
  stashes: (id: RepoId) => ["repo", id, "stashes"] as const,
  fastForward: (id: RepoId, branch: string) => ["repo", id, "fastForward", branch] as const,
  rebasePlan: (id: RepoId, base: string) => ["repo", id, "rebasePlan", base] as const,
};
