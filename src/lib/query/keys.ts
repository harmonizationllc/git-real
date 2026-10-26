import type { DiffScope, DiffSide, RepoId } from "../ipc";

export const queryKeys = {
  recent: ["recent"] as const,
  gitCli: ["gitCli"] as const,
  settings: ["settings"] as const,
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
  /** The tag list; under the repo prefix so a repo change refreshes it. */
  tags: (id: RepoId) => ["repo", id, "tags"] as const,
  /** Configured remotes; under the repo prefix so a repo change refreshes them. */
  remotes: (id: RepoId) => ["repo", id, "remotes"] as const,
  /** The default pull mode (config); under the repo prefix. */
  pullMode: (id: RepoId) => ["repo", id, "pullMode"] as const,
  fastForward: (id: RepoId, branch: string) => ["repo", id, "fastForward", branch] as const,
  rebasePlan: (id: RepoId, base: string) => ["repo", id, "rebasePlan", base] as const,
  /** Connected hosting accounts; global, not per repo. */
  hostingAccounts: ["hosting", "accounts"] as const,
  /** The hosted repository behind `origin`; under the repo prefix so a remote edit refreshes it. */
  hostingContext: (id: RepoId) => ["repo", id, "hostingContext"] as const,
  /** Open pull requests; outside the repo prefix so a watcher event never calls the provider API. */
  pullRequests: (id: RepoId) => ["hosting", "pullRequests", id] as const,
  /** Default branch and issues switch; outside the repo prefix, it is a provider call. */
  hostingRepoInfo: (id: RepoId) => ["hosting", "repoInfo", id] as const,
  /** Open issues matching `query`; outside the repo prefix, like the pull requests. */
  issues: (id: RepoId, query: string) => ["hosting", "issues", id, query] as const,
  /** An account's repositories matching `query`; under 'hosting', so connect/disconnect refresh it. */
  myRepos: (accountId: string, query: string) => ["hosting", "myRepos", accountId, query] as const,
  /** The pull request prefill; a git read, under the repo prefix. */
  prDraft: (id: RepoId, target: string) => ["repo", id, "prDraft", target] as const,
};

/** Mutation keys; separate from query keys, so repo invalidation never touches them. */
export const mutationKeys = {
  /** Every stash action of a repo: one key, so any trigger can see a push or drop running elsewhere. */
  stash: (id: RepoId) => ["stash", id] as const,
  /** Every tag action of a repo: one key, so the panel and the create dialogs share one busy state. */
  tag: (id: RepoId) => ["tag", id] as const,
  /** Every network action of a repo (fetch, pull, push, tag and branch pushes): one key, so the toolbar sees any of them running. */
  network: (id: RepoId) => ["network", id] as const,
  /** Remote config edits of a repo (add, update, remove); they never touch the network. */
  remote: (id: RepoId) => ["remote", id] as const,
  /** Connecting or disconnecting a hosting account. */
  hostingAccount: ["hostingAccount"] as const,
};
