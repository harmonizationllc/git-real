import type {
  AppError,
  AppErrorKind,
  HostedRepo,
  HostedRepoInfo,
  HostedRepoPage,
  HostingAccount,
  Issue,
  PullRequest,
  PullRequestDraft,
  RepoContext,
} from "../lib/ipc";

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

/** Provider info for gorlox/test-repo: default branch main, issues turned on. */
export const repoInfo = (over: Partial<HostedRepoInfo> = {}): HostedRepoInfo => ({
  defaultBranch: "main",
  issuesEnabled: true,
  ...over,
});

/** The prefill for a one-commit pull request. */
export const prDraft = (over: Partial<PullRequestDraft> = {}): PullRequestDraft => ({
  title: "Add login",
  body: "Why",
  ahead: 1,
  ...over,
});

/** An open issue `number` by alice labelled bug, updated at 1792497600. */
export const issue = (number: number, over: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  author: "alice",
  labels: ["bug"],
  updatedAt: 1792497600,
  webUrl: `https://github.com/gorlox/test-repo/issues/${number}`,
  ...over,
});

/** The repository octo/git-real on GitHub, public, with an SSH URL, updated at 1792497600. */
export const hostedRepo = (over: Partial<HostedRepo> = {}): HostedRepo => ({
  fullName: "octo/git-real",
  name: "git-real",
  owner: "octo",
  description: "A lightweight Git client",
  private: false,
  updatedAt: 1792497600,
  httpsUrl: "https://github.com/octo/git-real.git",
  sshUrl: "git@github.com:octo/git-real.git",
  webUrl: "https://github.com/octo/git-real",
  ...over,
});

/** n repositories octo/repo-<i> counting up from `start`. */
export const hostedRepos = (n: number, start = 0): HostedRepo[] =>
  Array.from({ length: n }, (_, i) => {
    const name = `repo-${start + i}`;
    return hostedRepo({
      fullName: `octo/${name}`,
      name,
      httpsUrl: `https://github.com/octo/${name}.git`,
      sshUrl: `git@github.com:octo/${name}.git`,
      webUrl: `https://github.com/octo/${name}`,
    });
  });

/** The wire page for `repos`; `hasMore` defaults to the raw page being full (50). */
export const hostedRepoPage = (
  repos: HostedRepo[],
  hasMore: boolean = repos.length === 50,
): HostedRepoPage => ({ repos, hasMore });
