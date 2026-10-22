import type { AppError, AppErrorKind, HostingAccount, PullRequest, RepoContext } from "../lib/ipc";

/** A connected GitHub account `octo` that needs no reconnect, unless overridden. */
export const hostingAccount = (over: Partial<HostingAccount> = {}): HostingAccount => ({
  id: "github:github.com:octo",
  provider: "github",
  host: "github.com",
  username: "octo",
  displayName: "Octo Cat",
  avatarUrl: null,
  needsReconnect: false,
  ...over,
});

/** The hosted repository gorlox/test-repo on GitHub with `account` connected (or none). */
export const repoContext = (account: HostingAccount | null = hostingAccount()): RepoContext => ({
  repo: { provider: "github", host: "github.com", namespace: "gorlox", name: "test-repo" },
  account,
});

/** An open, non-draft, same-repo pull request `number` into main, updated at 1792497600. */
export const pullRequest = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  author: "alice",
  sourceBranch: `feature-${number}`,
  targetBranch: "main",
  fromFork: false,
  forkCloneUrl: null,
  draft: false,
  ciState: "none",
  updatedAt: 1792497600,
  webUrl: `https://github.com/gorlox/test-repo/pull/${number}`,
  ...over,
});

export const hostingError = (kind: AppErrorKind, message = "provider said no"): AppError => ({
  kind,
  message,
});

/** n pull requests numbered from `start` down. */
export const pullRequests = (n: number, start = 100): PullRequest[] =>
  Array.from({ length: n }, (_, i) => pullRequest(start - i));
