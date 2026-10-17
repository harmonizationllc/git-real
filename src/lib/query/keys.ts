import type { DiffScope, RepoId } from "../ipc";

export const queryKeys = {
  recent: ["recent"] as const,
  gitCli: ["gitCli"] as const,
  /** Prefix of every per-repo key: invalidating it refreshes all of that repo's queries. */
  repo: (id: RepoId) => ["repo", id] as const,
  status: (id: RepoId) => ["repo", id, "status"] as const,
  fileDiff: (id: RepoId, path: string, scope: DiffScope, ignoreWs: boolean) =>
    ["repo", id, "diff", path, scope, ignoreWs] as const,
};
