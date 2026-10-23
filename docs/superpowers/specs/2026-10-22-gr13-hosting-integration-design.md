# GR-13 — Hosting provider integration (GitHub, GitLab, Bitbucket)

- Jira: GR-13 "Hosting provider integration (GitHub, GitLab, Bitbucket)".
- Depends on: GR-3 (`CloneDialog`, `git_cli`), GR-6 (`MessageEditor`),
  GR-7 (`BranchesPanel`, branch checkout, `ContextMenu`), GR-12 (remotes,
  `remote/auth.rs` inline helper + `Credentials`, publish flow,
  `NetworkError` panel, the "tokens never in the mutation cache" rule).
- Follows: ADR 0001/0002 (`features/hosting/` was reserved for this story),
  the CLAUDE.md hybrid git rule, the IPC seam rule, the `spawn_blocking`
  rule, no direct `tokio`, and the 100% coverage gate.
- Date: 2026-10-22. The user skipped the questions and asked for a design.
  Every decision marked **(call)** is the designer's, not the user's.

## 1. Intent

The user is replacing their current Git client. Today, to see or open a pull request,
check one out, or look up an issue number for a commit message, they have
to leave the app for the browser. GR-13 brings the everyday PR and issue
tasks into Git Real for the three big hosts. It doesn't try to be a full
code-review client.

Success: from an open repository whose `origin` is on GitHub, GitLab or
Bitbucket, with an account connected, the user can:

1. see the open PRs and MRs, each with its state and a link to open it in
   the browser;
2. check one out;
3. open one for the current branch;
4. pick an issue into a commit message;
5. clone one of their own repos without copying its URL by hand.

### Goals (the ticket's acceptance criteria)

1. Connect accounts for GitHub, GitLab and Bitbucket; tokens are stored in
   the OS keychain.
2. The provider is detected from the `origin` remote URL.
3. List open PRs/MRs with their state and an open-in-browser link.
4. Create a PR/MR from the current branch with a title and a description.
5. Check out a PR branch locally.
6. List issues, and link an issue from the commit message editor.
7. The clone dialog can browse the user's repositories on a connected
   provider.

### Non-goals

- **OAuth sign-in.** The ticket allows "OAuth _or_ personal access token".
  GR-13 uses tokens only **(call)**. OAuth needs an OAuth app registered
  with each provider, under the user's own accounts. Bitbucket Cloud also
  has no device flow, and a desktop app can't keep a client secret. The
  proposal is a follow-up ticket for OAuth through the GitHub and GitLab
  device flows.
- PR review: diffs, comments, approvals, merging a PR, CI check details
  beyond a single summary state.
- Editing or closing issues or PRs; creating issues.
- Notifications, background polling, webhooks.
- Bitbucket Server / Data Center. GitHub Enterprise and self-managed
  GitLab are covered by custom hosts (§3.2).
- Jira-linked issue trackers (Bitbucket repos that use Jira). The
  repository's own tracker is the only source.

### Anti-goals (it fails even if it "works" when…)

- A token reaches the webview's memory after the connect form is
  submitted. That includes the TanStack cache, logs, error messages,
  `Debug` output, and URLs.
- A token is written anywhere except the OS keychain, such as a config
  file or `.git/config`.
- A slow or unreachable provider API freezes the UI or blocks local git
  work. Hosting is optional: with no account, or with the network down,
  every pre-GR-13 feature keeps working.
- The front end talks to provider APIs directly. The CSP stays as it is,
  and all HTTP goes through Rust.

## 2. Slices

The ticket is too big for one review cycle, so it ships in three slices,
the same way GR-10 and GR-11 did. Each slice has its own plan and gate,
and merges on its own **(call)**.

| Slice   | Contents                                                                                                                                                                         | ACs        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **13a** | Accounts dialog, keychain, provider detection, HTTP layer for all three providers, **PR list** + open in browser, **PR checkout**, connected accounts feed git HTTPS auth (§6.3) | 1, 2, 3, 5 |
| **13b** | **Create PR** (with publish-first), **issue list**, **link issue** in the commit editor                                                                                          | 4, 6       |
| **13c** | Clone dialog **repo browser** (clone reuses 13a's account-token git auth)                                                                                                        | 7          |

13a carries all the shared infrastructure, so 13b and 13c are mostly UI
plus a few API calls each.

## 3. Accounts and tokens

### 3.1 What an account is

`Account { id, provider: GitHub | GitLab | Bitbucket, host, username,
display_name, avatar_url? }`. `host` is the web host (`github.com`,
`gitlab.com`, `bitbucket.org`, or a custom one). Only one account per
`(provider, host)` **(call)**. Connecting a second account for the same
host replaces the first, after a confirmation. Several accounts per host
can come later.

The account list without tokens lives in a JSON file in the app config dir
(`hosting_accounts.json`). It uses the same mechanism as `recent_store.rs`.
The token is stored in the OS keychain under service `git-real` and user
`<provider>:<host>:<username>`.

### 3.2 Hosts and API bases

| Provider  | Default host  | API base                        | Custom host allowed                 |
| --------- | ------------- | ------------------------------- | ----------------------------------- |
| GitHub    | github.com    | `https://api.github.com`        | yes → `https://<host>/api/v3` (GHE) |
| GitLab    | gitlab.com    | `https://gitlab.com/api/v4`     | yes → `https://<host>/api/v4`       |
| Bitbucket | bitbucket.org | `https://api.bitbucket.org/2.0` | no (Cloud only)                     |

Only HTTPS is allowed. A custom host must be a bare host name, optionally
with a port, and is validated the same strict way as `remote/host.rs`.

### 3.3 Tokens per provider

- **GitHub:** a fine-grained or classic PAT, sent as `Authorization: Bearer`.
  The connect form names the scopes it needs: repo read/write, pull
  requests read/write, issues read.
- **GitLab:** a PAT with the `api` scope, sent as `Authorization: Bearer`
  (`read_api` is enough until 13b's create MR).
- **Bitbucket:** an Atlassian **API token** (scoped; app passwords stopped
  working on 2026-06-09 and are not offered), sent as
  `Authorization: Bearer`. Confirmed against Atlassian's "Using API
  tokens" page on 2026-10-22: the REST API accepts Bearer with the token
  alone (Basic with `email:token` also works but needs the email), and git
  over HTTPS uses the static username `x-bitbucket-api-token-auth` with
  the token as the password. The connect form names the scopes:
  `read:repository:bitbucket`, `write:repository:bitbucket`,
  `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`,
  `read:issue:bitbucket`, `read:user:bitbucket`.

The connect dialog has a provider picker, an optional custom host, and the
token (a password field); no email is needed for any provider. It also
has a "Create a token" link that opens the provider's token page in the
browser. On submit, the backend calls the provider's "current user"
endpoint. Only on success does it store the token and the account and
return the `Account`. The front end clears the token field at once and
never holds the token after that (the GR-12 rule: an opaque thunk,
`gcTime: 0`, reset when it settles).

**Keychain unavailable** (no Secret Service, or a locked keyring the user
won't unlock): the connect fails with a clear message ("No system keychain
is available, so Git Real can't store the token safely."). There is no
file fallback (anti-goal).

### 3.4 Where accounts are managed

There is an **Accounts…** dialog, opened from two places **(call)**:

- a "Hosting accounts…" button on the start screen;
- the new hosting panel's empty state (§5.1).

Settings is GR-14, which can later move this dialog into Settings. The
dialog lists the accounts with avatar, username and host. It offers
**Connect account…** and, per account, **Disconnect**, which removes both
the token and the entry and needs a confirmation. A provider rejecting a
token that used to work (401) shows "Token expired or revoked — reconnect"
on that account and in the panel. **(call)** This "needs reconnect" state lives
in memory only: `Account` carries a `needs_reconnect: bool` set by the
backend after a 401/403 from that account's token, and cleared by a
successful reconnect. It is not persisted, so a restart retries the token
once.

**Replace (call).** The "replace existing account?" confirmation lives in
the front end only. `hosting_connect` always replaces any account for the
same `(provider, host)`, and it deletes the old keychain entry, even when
the username differs, so no orphaned secret is left behind.

## 4. Backend architecture

### 4.1 Placement

- **`git-real-core/src/hosting/`**: the pure provider domain, with no
  Tauri, no keychain and no platform code.
  - `provider.rs`: `Provider` enum, `RepoRef { provider, host, owner/namespace, name }`,
    and detection from a remote URL (§4.3).
  - `model.rs`: DTOs `Account`, `PullRequest`, `Issue`, `HostedRepo`,
    `NewPullRequest`, all serde, all with timestamps as epoch seconds.
  - `http.rs`: a `Transport` port (trait) for one request/response, a
    `Request` value, and the auth header building. `Debug` is implemented
    by hand and redacts `Authorization`.
  - `github.rs`, `gitlab.rs`, `bitbucket.rs`: build requests and parse
    JSON into the DTOs. They are pure functions over `Transport`, so they
    unit-test against a fake transport with recorded JSON fixtures.
  - `ureq_transport.rs`: the real `Transport` on **`ureq` 3 (rustls,
    blocking)**. It is blocking because every call already runs inside
    `spawn_blocking`, and that keeps `tokio`/`reqwest` out of the tree. It
    has a 15 s timeout and a `git-real/<version>` user agent.
- **App (`src-tauri/src`)**:
  - `hosting_store.rs`: the account list file plus a `TokenStore` trait,
    implemented by `KeyringTokenStore` on the **`keyring` 3** crate (Secret
    Service on Linux, Keychain on macOS, Credential Manager on Windows).
    Tests use an in-memory `TokenStore`.
  - `commands/hosting.rs`: thin commands (§4.4). Each one reads the token
    from the store inside `spawn_blocking`, calls core, and drops the
    token.
- **Front end**: `src/features/hosting/`, with typed wrappers in
  `src/lib/ipc/commands.ts` as usual.

`serde_json` moves from a dev-dependency to a dependency of
`git-real-core`. New dependencies: `ureq` (core) and `keyring` (app). The
architect validates file placement before any of these files are created
(as the global rules require).

### 4.2 Errors

New `GitError`/`AppError` kinds:

- `HostingAuth`: 401/403, a revoked or under-scoped token. The message
  names the scope that's missing when the provider says.
- `HostingNotFound`: the repository is not visible to this account.
- `HostingRateLimited`: carries the reset time when one is given.
- `HostingUnreachable`: DNS, TLS, timeout, or 5xx.
- `HostingRejected`: 422/400 with the provider's own message, for example
  "a pull request already exists for this branch".
- `KeychainUnavailable`.
- `NoHostingAccount`: the repo's provider has no connected account.

No error message ever contains a request header or a URL with userinfo.

### 4.3 Provider detection

The repo's provider comes from the `origin` remote's URL, which is parsed
for HTTPS, `ssh://` and scp-like forms. Detection order **(call)**:

1. a connected account whose `host` equals the URL's host (this covers GHE
   and self-managed GitLab);
2. the default hosts in §3.2;
3. otherwise "not a hosted repo", and the hosting panel stays hidden.

`.git` suffixes are stripped. GitLab subgroups are kept (namespace
`group/sub`). For SSH hosts like `ssh.github.com:443`, a port-443 SSH
GitHub URL is mapped to `github.com`. With no `origin`, the hosting panel
stays hidden. Choosing a different remote is a follow-up. **(call)** The
fork-as-origin layout (`origin` = the user's fork, `upstream` = where the
PRs live) is intentionally not handled in GR-13: the panel shows
`origin`'s PRs.

### 4.4 Commands

| Command                                                                                  | Slice |
| ---------------------------------------------------------------------------------------- | ----- |
| `hosting_list_accounts() -> Account[]`                                                   | a     |
| `hosting_connect(provider, host?, token) -> Account`                                     | a     |
| `hosting_disconnect(account_id)`                                                         | a     |
| `hosting_repo_context(repo_id) -> { repo: RepoRef, account: Account? } \| null`          | a     |
| `hosting_list_pull_requests(repo_id) -> PullRequest[]`                                   | a     |
| `hosting_checkout_pull_request(repo_id, number) -> CheckoutResult`                       | a     |
| `hosting_create_pull_request(repo_id, NewPullRequest) -> PullRequest`                    | b     |
| `hosting_list_issues(repo_id, query?) -> Issue[]`                                        | b     |
| `hosting_list_my_repos(account_id, query?, page) -> { repos: HostedRepo[], next_page? }` | c     |

Lists fetch the first 50 open items, sorted by last update **(call)**. A
"Show more" control pages further. `PullRequest` carries the number,
title, author, source and target branches, whether it comes from a fork
(with the fork's clone URL), draft, a summary CI state (`passing |
failing | pending | none`, taken from the provider's combined status when
it comes cheaply in the list call; otherwise `none`, see §7), the
updated-at time, and the web URL.

## 5. Front end

### 5.1 Hosting panel (13a)

There is a new collapsible **Pull requests** section in the left sidebar,
under Tags. It uses the same section pattern as `BranchesPanel`,
`StashesPanel` and `TagsPanel` **(call)**. Issues get a sibling
**Issues** section in 13b. Both are hidden when the repo has no hosted
`origin`.

States:

- **No account for this provider:** "Connect your GitHub account to see
  pull requests", with a button that opens the Accounts dialog, pre-set to
  that provider and host.
- **Loading / error:** errors use the existing panel error style.
  `HostingAuth` offers "Reconnect".
- **List:** each row shows `#123 Title`, then the author, the source branch
  → the target branch, a draft badge, and the CI state. A double-click or
  Enter on a row does nothing yet **(call: no detail view in GR-13)**. The
  context menu offers **Check out**, **Open in browser** and **Copy link**.
  A row-level "open" icon also opens it in the browser.
- **Refresh** button. The list is refetched when the panel is shown and
  after a push or publish from GR-12. There is no polling (non-goal).

Opening in the browser uses the existing `opener` plugin through the IPC
seam. URLs come only from provider responses, and only `https:` URLs are
opened.

### 5.2 Checkout (13a)

**Same-repo PR:** the app fetches `origin` the GR-12 way, then checks out
the head branch the way the Branches panel checks out a remote branch: it
creates a local tracking branch, or switches to it if one already exists.

**Fork PR, or a provider without head refs:**

- GitHub fetches `refs/pull/<n>/head`.
- GitLab fetches `refs/merge-requests/<n>/head` from `origin`.
- Bitbucket fetches the source branch from the fork's clone URL, as a
  one-off fetch with no new remote.

Either way the result lands in a local branch `pr/<n>`, with no upstream
**(call)**. If `pr/<n>` already exists, it is fast-forwarded when
possible; otherwise the user is asked whether to reset it, using the
existing `ConfirmDialog`.

The fetch is a git CLI network operation (hybrid rule). It uses GR-12's
auth path: the account token goes first (§6.3), then the prompt and
retry on HTTPS as a fallback. Branch creation and
checkout use the existing git2 code. A dirty working tree blocks checkout
with the same message branch checkout already gives.

### 5.3 Create PR (13b)

A **Create pull request…** item goes in the Push ▾ split menu and on the
current branch's context menu in the Branches panel. It is also a button
in the PR panel header **(call)**.

The dialog has:

- **Source:** the current branch, read-only.
- **Target:** a dropdown of the remote's branches, defaulting to the
  hosted repo's default branch.
- **Title:** pre-filled from the newest commit's subject when the branch
  has exactly one commit ahead of the target. Otherwise it is filled from
  the branch name, humanized.
- **Description:** pre-filled from that commit's body, or empty.

Before the request is sent:

- **No upstream:** the dialog says "This branch isn't on the remote yet —
  it will be published first". On submit it runs GR-12's publish (to
  `origin`), then creates the PR.
- **Ahead of upstream:** the dialog offers "Push N commits first"
  (checked by default).

On success, the dialog closes, the new PR is shown at the top of the
list, and a toast says "Opened #124" with an Open in browser link. A
`HostingRejected` message, such as "a PR already exists", is shown inline
in the dialog.

Fork workflows (opening a PR from a fork into its upstream) are out of
scope for 13b. The PR target is always `origin`'s own repo.

### 5.4 Issues and linking (13b)

The **Issues** sidebar section lists open issues the same way as PRs
(`#n Title`, author, labels), with Open in browser and Copy link. When the
provider reports that issues are disabled (common on Bitbucket), it shows
"Issues are turned off for this repository".

**Link issue** in the commit editor:

- a small **#** button beside the `MessageEditor` textarea, plus
  **Ctrl/Cmd+Shift+I** while the textarea has focus, opens a searchable
  issue picker (a popover with type-to-filter, served by the provider's
  search);
- choosing an issue inserts `#<n>` at the cursor **(call)**. GitHub,
  GitLab and Bitbucket all link a plain `#n` in commit messages. The user
  types the closing keyword themselves;
- with no hosted repo or no account, the button is hidden.

### 5.5 Clone repo browser (13c)

`CloneDialog` gets a second tab, **From account**, beside the existing URL
entry. It has:

- an account picker (shown when there's more than one account);
- a search box (server-side search with a debounce; the user's own and
  member repos);
- a paged list showing name, owner, a private badge, the description and
  the last updated time.

Selecting a repo fills the existing URL field with its clone URL, and the
rest of the clone flow is unchanged. The URL form follows the user's
choice of **HTTPS / SSH**, defaulting to HTTPS **(call)**. That choice is
remembered in `localStorage`, which is acceptable because it's a UI
preference.

## 6. Security

1. A token crosses IPC exactly once, inbound on `hosting_connect`. It is
   never returned, logged or put in an error. The `Debug` output of
   `Request` and of the connect input redacts it.
2. The keychain is the only place a token is stored.
3. **13a: connected accounts feed git HTTPS auth.** (Moved from 13c
   **(call)**, because 13a's PR checkout needs it.) When a git network
   operation (clone, fetch, pull, push, PR checkout) targets an HTTPS URL
   whose host matches a connected account, the backend supplies that
   account's token through GR-12's inline-helper path on the _first_ try,
   instead of prompting after a failure. That makes private HTTPS clone
   from the repo browser work, and it partly addresses GR-12's "clone has
   no credential retry" follow-up. The git username per provider is
   `x-access-token` for GitHub, `oauth2` for GitLab and
   `x-bitbucket-api-token-auth` for Bitbucket (§3.3). GR-12's caveat (a pre-push
   hook can read `GR_TOKEN`) applies here too, and the slice's plan
   records it. GR-12's `git credential approve` step is skipped for
   account tokens, so they aren't copied into the user's own helper.
4. Provider responses are untrusted. Strings render as text (never HTML).
   Only `https:` web URLs are opened, and clone URLs are validated before
   they reach `git`.

## 7. Left to the builder

- Exact JSON field mapping per provider. Use the current REST APIs
  (GitHub REST v3, GitLab v4, Bitbucket 2.0) and keep fixtures in the
  core crate's test data.
- How the CI summary is obtained per provider. If it costs one extra call
  per PR, ship `none` in 13a and note it as a follow-up rather than making
  N+1 calls.
- The exact `keyring` features for Linux (Secret Service via the
  `sync-secret-service` + rustls/crypto-rust feature set, so there's no
  OpenSSL), and macOS/Windows parity. Only Linux is walked.
- Component split inside `features/hosting/`. Follow the existing
  `*Panel` / `use*` hook / `*Dialog` conventions.
- Query keys: put them under the existing query-key layout. Hosting
  queries are keyed by repo id and account id, and are invalidated on
  connect and disconnect.
- Whether a local HTTP test server is needed beyond the fake `Transport`.
  One smoke test of `UreqTransport` against a local server is enough.
- Testing the native adapters **(call)**. Keep `UreqTransport` and
  `KeyringTokenStore` thin. `UreqTransport` is covered by the local-server
  smoke test, and `KeyringTokenStore` by `keyring`'s mock credential
  builder. No test may need a real Secret Service, so CI and test runs
  without a keyring stay green. The real keychain is exercised only in the
  acceptance walk.

## 8. Verification (per slice)

Each slice uses the standard gate: green Rust and Vitest suites, 100%
front-end coverage plus the coverage agent's sign-off, clippy, fmt, lint
and typecheck clean, and architect approval.

The acceptance walk runs in the live app against a real GitHub repo
(`gorlox/test-repo`). GitLab and Bitbucket are walked too if the user has
accounts on them; otherwise they rest on their fixture tests, and the walk
notes that.
