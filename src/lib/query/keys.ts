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
};
