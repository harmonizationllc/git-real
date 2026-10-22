# GR-13a Hosting Accounts and Pull Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user connects GitHub, GitLab and Bitbucket accounts with a personal access token stored in the OS keychain (a **Hosting accounts…** dialog, opened from the start screen and from the new panel). In a repository whose `origin` is on one of those hosts, a collapsible **Pull requests** section under Tags lists the open PRs/MRs (50 per page, newest update first, **Show more**), and each row can be checked out, opened in the browser or have its link copied. Checkout fetches the head the GR-12 way and lands on the head branch (same repo) or on `pr/<n>` (fork). Every git network operation (fetch, pull, push, tag and branch pushes, clone, PR checkout) to an HTTPS URL on a connected account's host uses that account's token on the first try, without copying it into the user's credential helper. This is slice 13a of GR-13 (ACs 1, 2, 3, 5); 13b and 13c follow in their own plans.

**Architecture:** A pure provider domain, `git-real-core/src/hosting/`, parses remote URLs into a `RepoRef`, builds HTTP requests for the three REST APIs, maps statuses to new `GitError` variants and parses recorded-shape JSON into DTOs; it reaches the network only through a `Transport` trait, whose real implementation is a thin blocking `ureq` 3 (rustls) adapter. The git side of PR checkout lives in `remote/pr_checkout.rs` and follows the GR-7 prepare-then-run shape: prepare an owned `RefFetch` under the session lock, run `git fetch` through GR-12's `run_network` with the lock released, then create or move `pr/<n>` from `FETCH_HEAD` under the lock again. The app crate adds `hosting_store.rs` (the account list in `hosting_accounts.json` plus a `TokenStore` port, implemented on `keyring` 3), `commands/hosting.rs` (six commands), and a `NetworkAuth` value that every network `*_inner` function now takes instead of `Option<&Credentials>`, so a connected account's token reaches the existing GR-12 inline helper with `approve` switched off. The front end adds `features/hosting/` (hooks, `PullRequestsPanel`, `PullRequestRow`, `AccountsDialog`, `ConnectAccountDialog`, copy) and an `openExternal` wrapper in the IPC seam.

**Tech Stack:** Rust 2024 (rustc 1.99), git2 0.20 (`default-features = false`), `ureq` 3 (rustls), `serde_json` 1, `keyring` 3, system git CLI, Tauri 2 + `tauri-plugin-opener` 2.7 (`opener:default` already allows `https:` URLs), React 19 + TypeScript, TanStack Query 5 (`useInfiniteQuery` for the first time), zustand, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-22-gr13-hosting-integration-design.md` (slice 13a, §2 row 13a, §3, §4, §5.1, §5.2, §6, §7, §8)

## Global Constraints

- Tests come first and are written by the test role. The developer role never edits test files, fixtures or helpers: both crates' `tests/common/mod.rs`, `tests/fixtures/**`, every `*.test.ts(x)`, `src/test/*` (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/*` (ESLint `no-restricted-imports` pattern `^@tauri-apps/(?!api/mocks$)`). `git2` stays `default-features = false`. No direct `tokio`, no `reqwest`. Blocking work runs through `run_blocking`. `git-real-core` has no Tauri, keychain or platform code. Network/credentials → git CLI; config and refs → git2 (CLAUDE.md hybrid rule). All provider HTTP goes through Rust; the CSP in `tauri.conf.json` does not change.
- **Dependencies (decided, do not reopen).** `git-real-core`: `ureq = { version = "3", default-features = false, features = ["rustls", "json"] }`, `serde_json = "1"` moves from `[dev-dependencies]` to `[dependencies]`. App crate: `keyring = { version = "3", features = ["sync-secret-service", "crypto-rust", "apple-native", "windows-native"] }`. No `native-tls`/OpenSSL anywhere (`cargo tree -i openssl-sys` prints nothing). If a feature name is wrong, the step that adds it fixes the list and records it under Deviations.
- **Secrets.** A token never appears in argv, a URL, a `Debug` or `Display` text, an `AppError`, a log line, the TanStack cache, or any file but the OS keychain. It crosses IPC exactly once, inbound on `hosting_connect`. `Token` has a private field, `Debug` prints `Token("***")`, no `Display`, no `Serialize`, no `Deserialize`. `Request`'s hand-written `Debug` prints `***` for the value of any header named `authorization` (ASCII case-insensitive). A provider error message that contains the token has it replaced by `***` before it becomes an error. There is no file fallback when the keychain is unavailable.
- **GR-12 caveat carried over:** git's children inherit `GR_TOKEN`, so a repository's own `pre-push` hook can read an account token exactly as it can read a typed one.
- **Providers (spec §3.2, §3.3).** `Provider` wire values `"github" | "gitlab" | "bitbucket"`. Default hosts `github.com`, `gitlab.com`, `bitbucket.org`. API base: GitHub `https://api.github.com` for `github.com`, else `https://<host>/api/v3`; GitLab `https://<host>/api/v4`; Bitbucket `https://api.bitbucket.org/2.0` (custom host refused). REST auth header on every call: `Authorization: Bearer <token>`. `Accept: application/json`, except GitHub: `Accept: application/vnd.github+json` plus `X-GitHub-Api-Version: 2022-11-28`. `User-Agent: git-real/<git-real-core CARGO_PKG_VERSION>` (set by the transport). Timeout 15 s (global).
- **Git HTTPS usernames** for account tokens: GitHub `x-access-token`, GitLab `oauth2`, Bitbucket `x-bitbucket-api-token-auth`.
- **Endpoints** (`{base}` per above; GitLab `{proj}` is `namespace/name` percent-encoded, `/` → `%2F`; every path segment is percent-encoded leaving only `A-Za-z0-9-._~`):
  - current user: `GET {base}/user` (all three)
  - list: GitHub `GET {base}/repos/{owner}/{name}/pulls?state=open&sort=updated&direction=desc&per_page=50&page={page}`; GitLab `GET {base}/projects/{proj}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50&page={page}`; Bitbucket `GET {base}/repositories/{workspace}/{slug}/pullrequests?state=OPEN&sort=-updated_on&pagelen=50&page={page}`
  - one: GitHub `GET {base}/repos/{owner}/{name}/pulls/{n}`; GitLab `GET {base}/projects/{proj}/merge_requests/{n}`; Bitbucket `GET {base}/repositories/{workspace}/{slug}/pullrequests/{n}`
- **JSON mapping** (anything missing that is not marked optional → `HostingUnreachable { message: "unexpected response from <host>" }`):
  - user — GitHub `login`, `name`?, `avatar_url`?; GitLab `username`, `name`?, `avatar_url`?; Bitbucket `username`, else `nickname`; `display_name`?; `links.avatar.href`?
  - PR — GitHub: `number`, `title`, `user.login`, `head.ref`, `base.ref`, `from_fork` = `head.repo` is null or `head.repo.full_name != base.repo.full_name`, `fork_clone_url` = `head.repo.clone_url` when `from_fork` and it starts with `https://`, `draft`? (default false), `updated_at`, `html_url`. GitLab: `iid` (not `id`), `title`, `author.username`, `source_branch`, `target_branch`, `from_fork` = `source_project_id != target_project_id`, `fork_clone_url` None, `draft`? (default false), `updated_at`, `web_url`. Bitbucket: `id`, `title`, `author.nickname` else `author.display_name` else `""`, `source.branch.name`, `destination.branch.name`, `from_fork` = `source.repository` null or its `full_name != destination.repository.full_name`, `fork_clone_url` = `https://bitbucket.org/<source full_name>.git` when `from_fork` and `full_name` matches `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`, `draft`? (default false), `updated_on`, `links.html.href`. Bitbucket lists are `{ "values": [...] }`.
  - `ci_state` is `"none"` for every provider in 13a (a status per PR would be N+1 calls; follow-up).
  - timestamps → epoch seconds by `parse_timestamp` (RFC 3339: `YYYY-MM-DDTHH:MM:SS`, optional `.fraction` of any length, then `Z` or `±HH:MM`).
- **HTTP status mapping** (`http.rs`, first match wins; `<msg>` = the body's `message` string, else `error` string, else `error.message` string, else `HTTP <status>`; then `***` for the token, then cut to 200 chars plus `…`):
  1. 200–299 → parse the body
  2. 429, or 403 with header `x-ratelimit-remaining: 0` → `HostingRateLimited { reset_epoch }`: `x-ratelimit-reset`, else `ratelimit-reset` (epoch seconds), else `retry-after` (seconds, added to now), else `None`
  3. 401, 403 → `HostingAuth { message: <msg> }`
  4. 404 → `HostingNotFound`
  5. 500–599 → `HostingUnreachable { message: "HTTP <status>" }`
  6. anything else (400, 422, 3xx, other 4xx) → `HostingRejected { message: <msg> }`
  - transport failure (DNS, TLS, refused, timeout) → `HostingUnreachable { message: <ureq error text> }` (the URL never carries userinfo); body that is not the expected JSON → `HostingUnreachable { message: "unexpected response from <host>" }`.
- **New `GitError` variants** (after `NetworkFailed`), with their `Display` text:
  - `HostingAuth { message: String }` "the provider rejected the token: {message}"
  - `HostingNotFound` "the repository was not found, or this account cannot see it"
  - `HostingRateLimited { reset_epoch: Option<u64> }` "the provider's API rate limit was reached"
  - `HostingRejected { message: String }` "the provider refused the request: {message}"
  - `HostingUnreachable { message: String }` "could not reach the provider: {message}"
  - `KeychainUnavailable(String)` "the system keychain is unavailable: {0}"
  - `NoHostingAccount` "no account is connected for this repository's host"
  - `InvalidHostingHost(String)` "{0:?} is not a valid host name"
  - `InvalidToken` "the token is empty, longer than 4096 bytes, or contains a line break"
- **New `AppErrorKind` / TS kinds:** `hostingAuth`, `hostingNotFound`, `hostingRateLimited`, `hostingRejected`, `hostingUnreachable`, `keychainUnavailable`, `noHostingAccount`, `invalidHostingHost`, `invalidToken`. Messages are the `Display` text; `network` stays absent.
- **Token rule:** `Token::new(s)` → `InvalidToken` unless `s` is non-empty, ≤ 4096 bytes, and contains no `\n`, `\r` or `\0`. The connect command takes `token: String` and validates it, so a bad token is an `invalidToken` `AppError`, not a Tauri argument error.
- **Host rule** (`validate_host(provider, host: Option<&str>)`): `None` or empty after trim → the default host. Otherwise lower-cased, then `name[:port]` where `name` is `[a-z0-9.-]+` not starting with `-` or `.`, and `port` is 1–5 digits. Bitbucket with any host other than `bitbucket.org` → `InvalidHostingHost`. Anything else → `InvalidHostingHost(<input>)`.
- **Detection** (`detect(url, custom_hosts)`) reads the **raw** `remote.origin.url` (as `list_remotes` reports it). Forms: `https://`, `http://` (port kept unless it is the scheme default), `ssh://`, `git+ssh://` (port dropped), scp-like `[user@]host:path` (not a Windows drive path); userinfo dropped; host lower-cased; `ssh.github.com` → `github.com`, `altssh.gitlab.com` → `gitlab.com`; path: trailing `/` trimmed, then `.git` suffix stripped; segments non-empty and not `.`/`..`. Provider: a `custom_hosts` entry with an equal host first (ASCII case-insensitive), then the default hosts, else `None`. GitHub and Bitbucket need exactly `owner/name`; GitLab needs ≥ 2 segments (namespace = all but the last, joined with `/`). `web_url()` = `https://<host>/<namespace>/<name>`.
- **Accounts.** One per `(provider, host)`. `id` = keychain user = `<provider>:<host>:<username>` (e.g. `github:github.com:octo`); keychain service `git-real`. File `hosting_accounts.json` in `app_config_dir()` (beside `recent-repos.json`), a JSON array of `{ provider, host, username, displayName, avatarUrl }` — never `needsReconnect`, never a token; written to `<path>.tmp` then renamed; a missing or corrupt file loads as empty; a failed save is logged and the call still succeeds (as `RecentStore`). `needs_reconnect` is in memory only: set on a `HostingAuth` from that account's token, cleared by reconnecting (a new `Account`).
- **Account-token git auth (spec §6.3).** When the caller passed no credentials, the first URL of the operation (in the operation's URL order) whose `origin_of` is `https://<host>` with `<host>` equal (ASCII case-insensitive) to a connected account's `host` gets `Credentials::account(origin, <provider git username>, token)`. `http://` never matches. A keychain error or a missing token yields no credentials (the operation runs as before GR-13). Account credentials are never passed to `git credential approve`. Explicit credentials from the prompt always win.
- **PR checkout argv** (after `-C <workdir>` and any credential `-c` pairs): same-repo `fetch origin` (`prepare_fetch_remote("origin")`) then the existing `switch <src>` or `switch -c <src> --track refs/remotes/origin/<src>`; fork / no head refs `fetch --no-tags <source> <refspec>` with `<source>` = `origin` or a fork's `https://` URL and `<refspec>` = `refs/pull/<n>/head` (GitHub), `refs/merge-requests/<n>/head` (GitLab), `refs/heads/<src>` (Bitbucket fork URL); then `switch pr/<n>` (already contains FETCH_HEAD) or `switch -C pr/<n> <oid>` (create, fast-forward, or reset). Verb `"fetch"` for both fetches.
- **Wire shapes (camelCase):** `Account { id, provider, host, username, displayName, avatarUrl, needsReconnect }`; `RepoRef { provider, host, namespace, name }`; `RepoContext { repo, account }`; `PullRequest { number, title, author, sourceBranch, targetBranch, fromFork, forkCloneUrl, draft, ciState, updatedAt, webUrl }`; `CiState` `"passing" | "failing" | "pending" | "none"`; `CheckoutPrOutcome` `{ kind: "checkedOut", branch } | { kind: "needsReset", branch }`.
- **Commands** (JS args camelCase): `hosting_list_accounts {}` → `Account[]`; `hosting_connect { provider, host, token }` → `Account`; `hosting_disconnect { accountId }`; `hosting_repo_context { id }` → `RepoContext | null`; `hosting_list_pull_requests { id, page }` → `PullRequest[]`; `hosting_checkout_pull_request { id, number, reset, credentials }` → `CheckoutPrOutcome`. `host` and `credentials` are `null` when absent.
- **TS wrappers:** `hostingListAccounts()`, `hostingConnect(provider, host, token)`, `hostingDisconnect(accountId)`, `hostingRepoContext(id)`, `hostingListPullRequests(id, page)`, `hostingCheckoutPullRequest(id, number, reset, credentials = null)`; `openExternal(url)` in `src/lib/ipc/opener.ts` (rejects anything whose `new URL(url).protocol` is not `https:` without calling the plugin). Every wrapper sends every key, `null` included.
- **Query keys:** `queryKeys.hostingAccounts = ["hosting", "accounts"]`, `queryKeys.pullRequests(id) = ["hosting", "pullRequests", id]` (**not** under the repo prefix, see Deviations), `queryKeys.hostingContext(id) = ["repo", id, "hostingContext"]`; `mutationKeys.hostingAccount = ["hostingAccount"]`. Connect/disconnect invalidate `["hosting"]` and every `["repo", *, "hostingContext"]`. `useNetworkAction` invalidates `queryKeys.pullRequests(id)` as well as `queryKeys.repo(id)` on every settled attempt.
- **Copy (verbatim; ‹…› are values; `Provider` is `GitHub` / `GitLab` / `Bitbucket`):**
  - start screen: `Hosting accounts…`
  - accounts dialog: title `Hosting accounts`; `No accounts connected`; row `‹displayName ?? username›` / `‹username› on ‹host›`; `Token expired or revoked — reconnect`; `Reconnect` (accessible name `Reconnect ‹username› on ‹host›`); `Disconnect` (`Disconnect ‹username› on ‹host›`); `Connect account…`; `Close`; confirm `Disconnect ‹username› from ‹host›?` / `The token is removed from the system keychain.` / `Disconnect`
  - connect dialog: title `Connect account`; legend `Provider`; radios `GitHub`, `GitLab`, `Bitbucket`; `Host` with placeholder ‹default host› and hint `Leave empty for ‹default host›.` (not shown for Bitbucket); `Token` (password field); `Create a token`; `Cancel`; `Connect` / busy `Connecting…`; confirm `Replace ‹username› on ‹host›?` / `Only one account per host is supported. The old token is removed from the system keychain.` / `Replace`
  - scope hints: GitHub `Needs repository contents and pull requests (read and write) and issues (read). A classic token needs the repo scope.`; GitLab `Needs the api scope (read_api is enough to browse).`; Bitbucket `Needs read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:issue:bitbucket and read:user:bitbucket.`
  - token pages: GitHub `https://<host>/settings/personal-access-tokens/new`; GitLab `https://<host>/-/user_settings/personal_access_tokens`; Bitbucket `https://id.atlassian.com/manage-profile/security/api-tokens`
  - errors: hostingAuth `‹Provider› rejected the token. Check that it is current and has the scopes it needs.`; hostingNotFound `This repository isn't visible to your ‹Provider› account.`; hostingRateLimited `‹Provider› rate limit reached. Try again in a few minutes.`; hostingUnreachable `Couldn't reach ‹Provider›. Check your connection.`; keychainUnavailable `No system keychain is available, so Git Real can't store the token safely.`; invalidHostingHost `Enter a host name such as github.example.com, optionally with :port.`; invalidToken `Paste the token exactly as ‹Provider› showed it.`; anything else `error.message` (network failures go through `networkMessage`)
  - panel: heading `Pull requests`, `Pull requests (‹n›)`, `Pull requests (‹n›+)` while more pages exist; `Connect your ‹Provider› account to see pull requests` + `Connect…`; `Token expired or revoked — reconnect` + `Reconnect`; `Loading pull requests…`; `No open pull requests`; `Show more` / busy `Loading…`; refresh button accessible name `Refresh pull requests`; row `#‹n›` `‹title›`, `‹author› · ‹source› → ‹target›`, badge `Draft`, CI badge `CI passing` / `CI failing` / `CI pending` (nothing for `none`); open icon accessible name `Open #‹n› in browser`; menu `Check out`, `Open in browser`, `Copy link`; reset confirm `Reset ‹branch›?` / `‹branch› has commits that are not in #‹n›. Resetting moves it to the pull request's head.` / `Reset`; status `Checked out ‹branch›.`
- Checks: from `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`; from the root: `npm run test:coverage` at 100 % statements/branches/functions/lines for `src/`, `npm run lint`, `npm run typecheck`, `npx prettier --check .`.

## Review Focus

1. **A provider that echoes the token.** Some error bodies quote the request; a `message` containing the token must not reach an `AppError`, and `Debug` of a `Request` or `Token` must not show it (Task 1 tests `an_error_body_that_echoes_the_token_is_redacted` and `request_debug_redacts_authorization_in_any_case` in `hosting_http.rs`).
2. **A fork PR whose branch is called like one of the user's branches** (`main` from `bob/test-repo`). Checkout must never write into `refs/heads/main`; it lands on `pr/<n>`, and the user's `main` is untouched (Task 1 test `fork_pr_lands_on_pr_n_and_never_touches_a_same_named_local_branch` in `pr_checkout.rs`; Task 2 test `checkout_of_a_github_fork_pr_fetches_refs_pull_and_creates_pr_n` in `hosting_commands.rs`).
3. **The account token goes only to its own host, only over HTTPS, and never into the user's helper.** `fetch --all` with a GitHub account and a GitLab remote must not hand the GitHub token to GitLab; `http://` never gets it; `credential approve` is not run (Task 1 test `account_credentials_are_never_approved` in `network_cli.rs`; Task 2 tests `credentials_for_matches_only_https_urls_on_an_account_host` and `credentials_for_takes_the_first_matching_url` in `hosting_store.rs`).
4. **The PR list must not call the provider on every repository event.** Every watcher event invalidates `["repo", id]`; staging a file must not cost an API call. PRs live under `["hosting", "pullRequests", id]` and refresh only on show, Refresh, Show more, and after a network action (Task 3 test `does not refetch when the repo prefix is invalidated` in `usePullRequests.test.tsx`; Task 2 test in `keys.test.ts`).
5. **No keychain, or a locked one.** Connecting fails with the keychain message and stores nothing; fetch, pull and push for a host with an account still run (without the token) when the keychain cannot be read (Task 2 tests `connect_with_a_failing_keychain_stores_nothing` and `credentials_for_with_a_failing_keychain_is_none` in `hosting_store.rs`).

## Deviations from spec

- **PR checkout's git work lives in `remote/pr_checkout.rs`**, not under `hosting/` (spec §4.1 lists only provider files there). `hosting/` stays a pure HTTP/JSON domain; `checkout_plan` there decides _what_ to fetch, and `remote/` does the git work beside `fetch.rs`.
- **`Response` carries headers** (`headers: Vec<(String, String)>`, names lower-cased): the rate-limit mapping reads `x-ratelimit-remaining`, `x-ratelimit-reset`, `ratelimit-reset` and `retry-after`.
- **`InvalidToken` is a tenth error variant/kind**, so a malformed token is an `AppError` instead of a misleading `invalidCredentials` ("must name an http(s) origin").
- **`Token` has no `Deserialize`.** The connect command takes a `String` and validates with `Token::new` (the GR-12 `CredentialsArg` pattern), so a bad token surfaces as `invalidToken`, not as a Tauri argument error.
- **Checkout re-reads the PR from the provider** (`get_pull_request`, one more endpoint per provider) instead of trusting PR data sent back by the webview; the command keeps the spec's `(repo_id, number)` shape plus `reset` and `credentials`.
- **Detection reads the raw `remote.origin.url`**, the value `list_remotes` shows. It catches the common `url.git@github.com:.insteadOf https://github.com/` setups. It also lets the app tests point a hosted-looking `origin` at a local bare repo through `insteadOf` while git fetches offline.
- **The PR list is keyed outside the repo prefix** (`["hosting", "pullRequests", id]`). The lead's suggestion was to key it under `["repo", id]`, but `useRepoChanged` invalidates that prefix on every watcher event, which would call the provider API for each index or ref change (Review Focus 4). `useNetworkAction` invalidates it explicitly after every network attempt, which covers spec §5.1's "after a push or publish".
- **No avatar images.** The CSP's `img-src` allows only `'self' asset: http://asset.localhost data: blob:`, and the spec keeps the CSP unchanged, so a provider avatar URL cannot load. `avatarUrl` stays in the DTO for later; the dialog shows the first letter of the username in a circle.
- **Rate-limit reset time is carried but not shown.** `HostingRateLimited { reset_epoch }` keeps it. The UI says "Try again in a few minutes"; showing the time would need an extra `AppError` field (the struct is at clippy's `result_large_err` limit). Follow-up.
- **`NetworkAuth` replaces `credentials: Option<&Credentials>`** in `fetch_inner`, `fetch_remote_inner`, `pull_inner`, `push_inner`, `delete_remote_branch_inner`, `push_tag_inner`, `delete_remote_tag_inner`, and is added to `clone_repo_inner`. One value carries either the typed credentials or the account store, so each call site resolves after prepare, when the URLs are known.
- **`Credentials` gains a private `approve: bool`** (`Credentials::new` → true, `Credentials::account` → false; `pub fn approves(&self) -> bool`), and `run_network` approves only when it is true. Deserialization still goes through `new`.
- **`clone` and `clone_with` take `creds: Option<&Credentials>`** (before `sink`), applied with `auth::apply` before `clone`, so 13c's repo browser clones private HTTPS repos on the first try. Clone still has no prompt-and-retry.
- **`remote/host.rs`'s `valid`, `strip_user` and `is_drive_path` become `pub(crate)`** for `hosting::provider`. `valid` does not lower-case, accepts IPv6 literals and a leading `.`; `validate_host` and `detect` add those checks themselves. `https_host` is built on `auth::origin_of`, so there is no third URL parser.
- **`checkout_fetch_head` takes the `RefFetch` and matches FETCH_HEAD by refspec** (architect pre-flight). The session lock is released between `RefFetch::run` and the checkout, so a concurrent `fetch --all` can overwrite FETCH_HEAD; the entry whose `ref_name` equals the fetched refspec (libgit2 rebuilds `refs/heads/<x>` from `branch 'x'` lines) is used, and no match is `RevisionNotFound("FETCH_HEAD")`.
- **`CheckoutPrOutcome` lives in crate `model/`** beside `OperationOutcome` and is re-exported from `hosting`, so a git outcome stays out of the provider domain. Never `use CiState::*` (its `None` shadows `Option::None`).
- **`FETCH_HEAD` is read with git2 `Repository::fetchhead_foreach`** (first entry), and `pr/<n>` is created or moved with `git switch -C pr/<n> <oid>` (a new `SwitchTarget::Reset`), which refuses on a conflicting dirty tree like every other switch (`CheckoutFailed`, the branch-checkout message). When `pr/<n>` already contains the fetched commit, it is a plain `switch pr/<n>`.
- **The fork fetch passes `--no-tags`**, so a fork's tags never land in the user's repository.
- **Bitbucket `draft` is read when present** (default false). The lead's note said Bitbucket has no draft flag, but Bitbucket Cloud PRs now carry `draft`, and reading an optional field costs nothing.
- **The start screen owns its `AccountsDialog`** (local state in `StartScreen`), so `App.tsx` does not change.
- **The PR panel ignores the refs filter** (`useWorkspace.refsFilter`); filtering PRs is a follow-up.
- **`disconnect` keeps the entry when deleting the keychain secret fails** (`KeychainUnavailable`), so a token is never orphaned silently; deleting an unknown id is `Ok(())`.

---

### Task 1: Core hosting domain, PR-checkout git work, account-aware credentials, and the `AppError` mapping

**Files:**

- Modify: `src-tauri/crates/git-real-core/Cargo.toml` (`ureq`, `serde_json` → `[dependencies]`)
- Create: `src-tauri/crates/git-real-core/src/hosting/mod.rs`, `provider.rs`, `model.rs`, `http.rs`, `github.rs`, `gitlab.rs`, `bitbucket.rs`, `ureq_transport.rs`
- Create: `src-tauri/crates/git-real-core/src/remote/pr_checkout.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs` (`pub mod hosting;` after `pub mod history;`)
- Modify: `src-tauri/crates/git-real-core/src/error.rs` (nine variants after `NetworkFailed`)
- Modify: `src-tauri/crates/git-real-core/src/remote/auth.rs` (`approve` flag, `Credentials::account`, `approves`), `remote/mod.rs` (`pub mod pr_checkout;`, approve only when `c.approves()`), `remote/host.rs` (`valid`, `strip_user`, `is_drive_path` → `pub(crate)`), `remote/clone.rs` (`creds`), `remote/fetch.rs`, `remote/pull.rs`, `remote/push.rs`, `remote/push_tag.rs`, `remote/push_delete.rs` (`pub fn urls(&self) -> &[String]` on `Fetch`, `Pull`, `Push`, `TagPush`, `TagPushDelete`, `PushDelete`), `refs/switch.rs` (`SwitchTarget::Reset`)
- Modify (app crate, so every commit compiles): `src-tauri/src/error.rs` (nine kinds and their mapping), `src-tauri/src/commands/repo.rs` (`clone(url, dest, None, sink)`; Task 2 wires accounts)
- Create (test role): `src-tauri/crates/git-real-core/tests/fixtures/hosting/{github_user,github_pulls,gitlab_user,gitlab_merge_requests,bitbucket_user,bitbucket_pullrequests}.json`, `tests/hosting_detect.rs`, `tests/hosting_http.rs`, `tests/hosting_providers.rs`, `tests/hosting_ureq.rs`, `tests/pr_checkout.rs`
- Modify (test role): `src-tauri/crates/git-real-core/tests/common/mod.rs` (`FakeTransport`), `tests/network_cli.rs`, `tests/network_classify.rs`, `tests/clone.rs` (Step 7); `src-tauri/tests/error.rs` (Step 8)

**Interfaces:**

- Consumes (verified in code):
  - `remote/mod.rs`: `pub(crate) fn run_network(git, workdir, verb: &'static str, args: &[&str], urls: &[String], creds: Option<&Credentials>) -> Result<(), GitError>` (approves every `urls` entry `c.covers(url)` after success).
  - `remote/auth.rs`: `Credentials { origin, username, token }` (private, `#[serde(try_from = "CredentialsInput")]`, hand-written `Debug`), `Credentials::new`, `pub fn apply(cmd, creds)`, `pub fn origin_of(url) -> Option<String>`, `pub(crate) fn is_http`.
  - `remote/host.rs`: private `fn valid(host: &str) -> Option<String>`, `fn strip_user(authority) -> &str`, `fn is_drive_path(url) -> bool`.
  - `remote/fetch.rs`: `RepoSession::prepare_fetch_remote(name) -> Result<Fetch, GitError>` (`RemoteNotFound` for unknown / `-x`), `Fetch::run(creds)`; `remote/remotes.rs`: `pub(crate) fn used_url(&self, remote, Direction) -> Result<Option<String>, GitError>`, `pub fn list_remotes()`.
  - `refs/mod.rs`: `pub fn validate_branch_name(name)`, `pub fn checkout_remote_branch(&self, remote, name)`, `pub(crate) fn ensure_remote(&self, remote)`, `pub fn checkout_branch(name)`; `refs/switch.rs`: `pub(crate) enum SwitchTarget { Local, NewTracking, Detach }`, `pub(crate) fn run(git, workdir, target) -> Result<(), GitError>` (non-zero → `CheckoutFailed`).
  - `git_ops.rs`: `RepoSession::git(&self) -> Result<(PathBuf, &Path), GitError>`; `repo/session.rs`: `pub(crate) fn repo(&self) -> &Repository`.
  - `remote/clone.rs`: `pub fn clone(url, dest, sink)`, `pub fn clone_with(git, url, dest, sink)` (argv `clone --progress -- <url> <dest>`).
  - Core test helpers: `temp_repo_with_commit`, `temp_bare_clone`, `add_remote_and_fetch(path, bare, head)`, `configure_identity`, `commit_file`, `head_branch_name`, `run_git_ok`, `write_file`, `fake_git`, `git_available`.
- Produces:

```rust
// hosting/provider.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(rename_all = "lowercase")]
pub enum Provider { GitHub, GitLab, Bitbucket }
impl Provider {
    pub fn as_str(self) -> &'static str;          // "github" | "gitlab" | "bitbucket"
    pub fn default_host(self) -> &'static str;
    pub fn api_base(self, host: &str) -> String;
    pub fn git_username(self) -> &'static str;
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct RepoRef { pub provider: Provider, pub host: String, pub namespace: String, pub name: String }
impl RepoRef { pub fn web_url(&self) -> String; }
pub fn detect(url: &str, custom_hosts: &[(Provider, String)]) -> Option<RepoRef>;
pub fn validate_host(provider: Provider, host: Option<&str>) -> Result<String, GitError>;
pub fn https_host(url: &str) -> Option<String>;   // lower-cased host[:port] of an https:// URL (port 443 dropped), userinfo dropped
// hosting/model.rs
#[derive(Debug, Clone, PartialEq, Eq)] pub struct UserInfo { pub username: String, pub display_name: Option<String>, pub avatar_url: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct Account { pub id: String, pub provider: Provider, pub host: String, pub username: String,
                     pub display_name: Option<String>, pub avatar_url: Option<String>, pub needs_reconnect: bool }
impl Account { pub fn new(provider: Provider, host: &str, user: UserInfo) -> Self; pub fn key(provider: Provider, host: &str, username: &str) -> String; }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct RepoContext { pub repo: RepoRef, pub account: Option<Account> }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub enum CiState { Passing, Failing, Pending, None }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct PullRequest { pub number: u64, pub title: String, pub author: String, pub source_branch: String, pub target_branch: String,
                         pub from_fork: bool, pub fork_clone_url: Option<String>, pub draft: bool, pub ci_state: CiState,
                         pub updated_at: i64, pub web_url: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CheckoutPrOutcome { CheckedOut { branch: String }, NeedsReset { branch: String } }
// hosting/http.rs
#[derive(Clone)] pub struct Token(/* private String */);
impl Token { pub fn new(s: &str) -> Result<Self, GitError>; pub fn expose_secret(&self) -> &str; }
impl fmt::Debug for Token;                                   // Token("***")
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Method { Get, Post }
#[derive(Clone, PartialEq, Eq)] pub struct Request { pub method: Method, pub url: String, pub headers: Vec<(String, String)>, pub body: Option<String> }
impl fmt::Debug for Request;                                 // authorization value → ***
#[derive(Debug, Clone, PartialEq, Eq)] pub struct Response { pub status: u16, pub headers: Vec<(String, String)>, pub body: String }
impl Response { pub fn header(&self, name: &str) -> Option<&str>; }   // case-insensitive
pub trait Transport: Send + Sync { fn send(&self, req: &Request) -> Result<Response, GitError>; }
pub fn parse_timestamp(s: &str) -> Option<i64>;
pub(crate) fn get(url: String, token: &Token, extra: &[(&str, &str)]) -> Request;
pub(crate) fn send_json<T: serde::de::DeserializeOwned>(t: &dyn Transport, req: &Request, token: &Token, host: &str) -> Result<T, GitError>;
pub(crate) fn percent_encode(segment: &str) -> String;
// hosting/{github,gitlab,bitbucket}.rs — each:
pub fn current_user(t: &dyn Transport, host: &str, token: &Token) -> Result<UserInfo, GitError>;
pub fn list_pull_requests(t: &dyn Transport, repo: &RepoRef, token: &Token, page: u32) -> Result<Vec<PullRequest>, GitError>;
pub fn get_pull_request(t: &dyn Transport, repo: &RepoRef, token: &Token, number: u64) -> Result<PullRequest, GitError>;
// hosting/mod.rs — dispatch by provider
pub fn current_user(t: &dyn Transport, provider: Provider, host: &str, token: &Token) -> Result<UserInfo, GitError>;
pub fn list_pull_requests(t: &dyn Transport, repo: &RepoRef, token: &Token, page: u32) -> Result<Vec<PullRequest>, GitError>;
pub fn get_pull_request(t: &dyn Transport, repo: &RepoRef, token: &Token, number: u64) -> Result<PullRequest, GitError>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutPlan { TrackBranch { branch: String }, FetchHead { source: String, refspec: String } }
pub fn checkout_plan(provider: Provider, pr: &PullRequest) -> Result<CheckoutPlan, GitError>;
// every submodule is `pub mod` (tests import `hosting::provider::detect`, `hosting::http::parse_timestamp`,
// `hosting::ureq_transport::UreqTransport`); the common types are re-exported:
pub use http::{Method, Request, Response, Token, Transport};
pub use model::{Account, CheckoutPrOutcome, CiState, PullRequest, RepoContext, UserInfo};
pub use provider::{Provider, RepoRef};
// hosting/ureq_transport.rs
pub struct UreqTransport { /* ureq::Agent */ }
impl UreqTransport { pub fn new() -> Self; } impl Default for UreqTransport; impl Transport for UreqTransport;
// remote/pr_checkout.rs
#[derive(Debug)] pub struct RefFetch { /* git, workdir, source, refspec, urls */ }
impl RefFetch { pub fn urls(&self) -> &[String]; pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError>; }
impl RepoSession {
    pub fn prepare_ref_fetch(&self, source: &str, refspec: &str) -> Result<RefFetch, GitError>;
    pub fn checkout_fetch_head(&self, fetch: &RefFetch, number: u64, reset: bool) -> Result<CheckoutPrOutcome, GitError>;
}
// remote/auth.rs
impl Credentials { pub fn account(origin: &str, username: &str, token: &Token) -> Result<Self, GitError>; pub fn approves(&self) -> bool; }
// remote/clone.rs
pub fn clone(url: &str, dest: &Path, creds: Option<&Credentials>, sink: &mut dyn ProgressSink) -> Result<PathBuf, GitError>;
pub fn clone_with(git: &Path, url: &str, dest: &Path, creds: Option<&Credentials>, sink: &mut dyn ProgressSink) -> Result<PathBuf, GitError>;
// Fetch, Pull, Push, TagPush, TagPushDelete, PushDelete: pub fn urls(&self) -> &[String];
// refs/switch.rs: SwitchTarget::Reset { name: &'a str, oid: &'a str }   // switch -C <name> <oid>
```

- [ ] **Step 1: Add the core dependencies and confirm they build**

In `crates/git-real-core/Cargo.toml` add `ureq = { version = "3", default-features = false, features = ["rustls", "json"] }` and `serde_json = "1"` under `[dependencies]`, and remove `serde_json` from `[dev-dependencies]`.

Run (from `src-tauri`): `cargo build -p git-real-core && cargo tree -p git-real-core -i openssl-sys`. Expected: the build succeeds; `cargo tree` reports that `openssl-sys` is not in the graph. A wrong feature name gets fixed here and added to Deviations.

- [ ] **Step 2: Write the provider fixtures** (`tests/fixtures/hosting/`, hand-written, trimmed to the fields used, each ending with a newline)

| File                          | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_user.json`            | `{"login":"octo","name":"Octo Cat","avatar_url":"https://avatars.githubusercontent.com/u/1"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `github_pulls.json`           | `[{"number":12,"title":"Add login","user":{"login":"alice"},"draft":false,"updated_at":"2026-10-20T12:00:00Z","html_url":"https://github.com/gorlox/test-repo/pull/12","head":{"ref":"feature/login","repo":{"full_name":"gorlox/test-repo","clone_url":"https://github.com/gorlox/test-repo.git"}},"base":{"ref":"main","repo":{"full_name":"gorlox/test-repo"}}},{"number":9,"title":"Fix typo","user":{"login":"bob"},"draft":true,"updated_at":"2026-10-19T08:30:15Z","html_url":"https://github.com/gorlox/test-repo/pull/9","head":{"ref":"main","repo":{"full_name":"bob/test-repo","clone_url":"https://github.com/bob/test-repo.git"}},"base":{"ref":"main","repo":{"full_name":"gorlox/test-repo"}}}]`                                                          |
| `gitlab_user.json`            | `{"username":"octo","name":"Octo Cat","avatar_url":"https://gitlab.com/uploads/a.png"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `gitlab_merge_requests.json`  | `[{"iid":5,"id":9001,"title":"Subgroup feature","author":{"username":"alice"},"source_branch":"feat","target_branch":"main","source_project_id":100,"target_project_id":100,"draft":false,"updated_at":"2026-10-20T12:00:00.123Z","web_url":"https://gitlab.com/group/sub/proj/-/merge_requests/5"},{"iid":4,"id":9000,"title":"From a fork","author":{"username":"bob"},"source_branch":"main","target_branch":"main","source_project_id":200,"target_project_id":100,"draft":true,"updated_at":"2026-10-19T08:30:15.000+02:00","web_url":"https://gitlab.com/group/sub/proj/-/merge_requests/4"}]`                                                                                                                                                                      |
| `bitbucket_user.json`         | `{"username":"octo","display_name":"Octo Cat","links":{"avatar":{"href":"https://avatar.example/a.png"}}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bitbucket_pullrequests.json` | `{"pagelen":50,"page":1,"values":[{"id":3,"title":"Same repo","author":{"nickname":"alice","display_name":"Alice A"},"source":{"branch":{"name":"feat"},"repository":{"full_name":"ws/repo"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/repo"}},"updated_on":"2026-10-20T12:00:00.123456+00:00","links":{"html":{"href":"https://bitbucket.org/ws/repo/pull-requests/3"}}},{"id":2,"title":"From a fork","author":{"display_name":"Bob B"},"source":{"branch":{"name":"main"},"repository":{"full_name":"bob/repo"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/repo"}},"draft":true,"updated_on":"2026-10-19T08:30:15.000000+00:00","links":{"html":{"href":"https://bitbucket.org/ws/repo/pull-requests/2"}}}]}` |

Epochs used below (verified with Python): `2026-10-20T12:00:00Z` = `1792497600`, `2026-10-19T08:30:15Z` = `1792398615`, `2026-10-19T08:30:15+02:00` = `1792391415`.

Add to `tests/common/mod.rs`:

```rust
/// A scripted `Transport`: answers each `send` with the next queued response and records
/// every request (method, url, headers, body).
pub struct FakeTransport {
    pub replies: std::sync::Mutex<std::collections::VecDeque<Result<git_real_core::hosting::Response, git_real_core::GitError>>>,
    pub seen: std::sync::Mutex<Vec<git_real_core::hosting::Request>>,
}
impl FakeTransport {
    pub fn new() -> Self;                                         // empty queue
    pub fn reply(self, status: u16, body: &str) -> Self;          // headers empty
    pub fn reply_with(self, status: u16, headers: &[(&str, &str)], body: &str) -> Self;
    pub fn fail(self, error: git_real_core::GitError) -> Self;
    pub fn requests(&self) -> Vec<git_real_core::hosting::Request>;
}
// impl Transport: pops the front reply; an empty queue panics with "unexpected request <url>".
```

- [ ] **Step 3: Write the failing detection tests** (`tests/hosting_detect.rs`, pure)

```rust
//! Provider detection from a remote URL, host validation and the https host used for
//! account tokens (GR-13 spec §3.2, §4.3).

use git_real_core::GitError;
use git_real_core::hosting::provider::{detect, https_host, validate_host};
use git_real_core::hosting::{Provider as P, RepoRef};

fn r(provider: P, host: &str, namespace: &str, name: &str) -> Option<RepoRef> {
    Some(RepoRef { provider, host: host.into(), namespace: namespace.into(), name: name.into() })
}

#[test]
fn detects_every_url_form_on_the_default_hosts() {
    let cases = [
        ("https://github.com/gorlox/test-repo.git", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("https://me:pw@GitHub.com/gorlox/test-repo/", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("http://github.com/gorlox/test-repo", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("git@github.com:gorlox/test-repo.git", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("ssh://git@github.com/gorlox/test-repo.git", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("ssh://git@ssh.github.com:443/gorlox/test-repo.git", r(P::GitHub, "github.com", "gorlox", "test-repo")),
        ("git+ssh://git@gitlab.com/group/sub/proj.git", r(P::GitLab, "gitlab.com", "group/sub", "proj")),
        ("ssh://git@altssh.gitlab.com:443/group/proj.git", r(P::GitLab, "gitlab.com", "group", "proj")),
        ("https://gitlab.com/a/b/c/d", r(P::GitLab, "gitlab.com", "a/b/c", "d")),
        ("git@bitbucket.org:ws/repo.git", r(P::Bitbucket, "bitbucket.org", "ws", "repo")),
        ("https://octo@bitbucket.org/ws/repo.git", r(P::Bitbucket, "bitbucket.org", "ws", "repo")),
    ];
    for (url, want) in cases {
        assert_eq!(detect(url, &[]), want, "{url}");
    }
}

#[test]
fn custom_hosts_come_first_and_keep_https_ports() {
    let custom = [(P::GitHub, "ghe.corp:8443".to_owned()), (P::GitLab, "git.corp".to_owned())];
    assert_eq!(detect("https://ghe.corp:8443/o/r.git", &custom), r(P::GitHub, "ghe.corp:8443", "o", "r"));
    assert_eq!(detect("git@git.corp:g/s/p.git", &custom), r(P::GitLab, "git.corp", "g/s", "p"));
    assert_eq!(detect("https://GIT.CORP/g/p", &custom), r(P::GitLab, "git.corp", "g", "p"));
    assert_eq!(detect("https://github.com:443/o/r", &[]), r(P::GitHub, "github.com", "o", "r"));
    // A custom entry for a default host wins over the default provider.
    assert_eq!(detect("https://gitlab.com/o/r", &[(P::GitHub, "gitlab.com".into())]), r(P::GitHub, "gitlab.com", "o", "r"));
}

#[test]
fn refuses_unhosted_and_malformed_urls() {
    for url in [
        "/srv/repo.git", "file:///srv/repo.git", "C:\\repos\\x", "C:/repos/x", "https://example.com/o/r",
        "https://github.com/o", "https://github.com/o/r/extra", "https://bitbucket.org/ws", "https://gitlab.com/solo",
        "https://github.com//r", "https://github.com/o/../r", "ftp://github.com/o/r", "", "github.com",
        "https://-bad.com/o/r",
    ] {
        assert_eq!(detect(url, &[]), None, "{url:?}");
    }
}

#[test]
fn web_url_is_https_host_namespace_name() {
    let repo = r(P::GitLab, "git.corp:8443", "g/s", "p").unwrap();
    assert_eq!(repo.web_url(), "https://git.corp:8443/g/s/p");
}

#[test]
fn validate_host_defaults_lowercases_and_refuses() {
    assert_eq!(validate_host(P::GitHub, None).unwrap(), "github.com");
    assert_eq!(validate_host(P::GitLab, Some("  ")).unwrap(), "gitlab.com");
    assert_eq!(validate_host(P::GitHub, Some("GHE.Corp:8443")).unwrap(), "ghe.corp:8443");
    assert_eq!(validate_host(P::Bitbucket, Some("bitbucket.org")).unwrap(), "bitbucket.org");
    for (p, h) in [
        (P::Bitbucket, "bb.corp"), (P::GitHub, "https://ghe.corp"), (P::GitHub, "ghe.corp/x"), (P::GitHub, "-x.corp"),
        (P::GitHub, ".corp"), (P::GitHub, "ghe.corp:123456"), (P::GitHub, "ghe.corp:"), (P::GitLab, "a b"), (P::GitLab, "me@h"),
    ] {
        assert!(matches!(validate_host(p, Some(h)), Err(GitError::InvalidHostingHost(s)) if s == h), "{h}");
    }
}

#[test]
fn provider_constants() {
    assert_eq!(P::GitHub.api_base("github.com"), "https://api.github.com");
    assert_eq!(P::GitHub.api_base("ghe.corp:8443"), "https://ghe.corp:8443/api/v3");
    assert_eq!(P::GitLab.api_base("gitlab.com"), "https://gitlab.com/api/v4");
    assert_eq!(P::Bitbucket.api_base("bitbucket.org"), "https://api.bitbucket.org/2.0");
    assert_eq!([P::GitHub.git_username(), P::GitLab.git_username(), P::Bitbucket.git_username()],
               ["x-access-token", "oauth2", "x-bitbucket-api-token-auth"]);
    assert_eq!(serde_json::to_value(P::GitLab).unwrap(), "gitlab");
    assert_eq!(serde_json::from_value::<P>("bitbucket".into()).unwrap(), P::Bitbucket);
}

#[test]
fn https_host_reads_only_https_urls() {
    assert_eq!(https_host("https://me:pw@GitHub.com/o/r.git").as_deref(), Some("github.com"));
    assert_eq!(https_host("https://ghe.corp:8443/o/r").as_deref(), Some("ghe.corp:8443"));
    assert_eq!(https_host("https://github.com:443/o/r").as_deref(), Some("github.com"));
    for url in ["http://github.com/o/r", "git@github.com:o/r", "/srv/x.git", "ssh://github.com/o/r"] {
        assert_eq!(https_host(url), None, "{url}");
    }
}
```

- [ ] **Step 4: Write the failing HTTP-layer tests** (`tests/hosting_http.rs`)

```rust
//! Token validation and redaction, Request Debug, RFC 3339 parsing, and the HTTP status →
//! GitError mapping (exercised through GitHub's current_user, the smallest call).

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::{self, Method, Provider, Request, Token};
use git_real_core::hosting::http::parse_timestamp;

const SECRET: &str = "ghp_TOPSECRET123";

fn token() -> Token { Token::new(SECRET).unwrap() }
fn user(t: &FakeTransport) -> Result<hosting::UserInfo, GitError> {
    hosting::current_user(t, Provider::GitHub, "github.com", &token())
}

#[test]
fn token_accepts_up_to_4096_bytes_without_line_breaks() {
    assert_eq!(Token::new(&"a".repeat(4096)).unwrap().expose_secret().len(), 4096);
    for bad in ["", "a\nb", "a\rb", "a\0b", &"a".repeat(4097)] {
        assert!(matches!(Token::new(bad), Err(GitError::InvalidToken)), "{bad:?}");
    }
}

#[test]
fn token_debug_is_redacted() {
    assert_eq!(format!("{:?}", token()), r#"Token("***")"#);
}

#[test]
fn request_debug_redacts_authorization_in_any_case() {
    let req = Request {
        method: Method::Get,
        url: "https://api.github.com/user".into(),
        headers: vec![("Authorization".into(), format!("Bearer {SECRET}")), ("accept".into(), "application/json".into())],
        body: None,
    };
    let text = format!("{req:?}");
    assert!(!text.contains(SECRET), "{text}");
    assert!(text.contains("***") && text.contains("api.github.com/user") && text.contains("application/json"), "{text}");
}

#[test]
fn parse_timestamp_handles_zulu_fractions_and_offsets() {
    assert_eq!(parse_timestamp("2026-10-20T12:00:00Z"), Some(1792497600));
    assert_eq!(parse_timestamp("2026-10-20T12:00:00.123Z"), Some(1792497600));
    assert_eq!(parse_timestamp("2026-10-20T12:00:00.123456+00:00"), Some(1792497600));
    assert_eq!(parse_timestamp("2026-10-19T08:30:15.000+02:00"), Some(1792391415));
    assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_timestamp("2000-02-29T23:59:59Z"), Some(951868799));
    for bad in ["", "2026-10-20", "2026-10-20 12:00:00Z", "2026-13-01T00:00:00Z", "2026-10-20T12:00:00", "x"] {
        assert_eq!(parse_timestamp(bad), None, "{bad:?}");
    }
}

#[test]
fn the_github_request_carries_bearer_accept_and_api_version() {
    let t = FakeTransport::new().reply(200, include_str!("fixtures/hosting/github_user.json"));
    user(&t).unwrap();
    let req = &t.requests()[0];
    assert_eq!((req.method, req.url.as_str()), (Method::Get, "https://api.github.com/user"));
    let h = |n: &str| req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str());
    assert_eq!(h("authorization"), Some(format!("Bearer {SECRET}").as_str()));
    assert_eq!(h("accept"), Some("application/vnd.github+json"));
    assert_eq!(h("x-github-api-version"), Some("2022-11-28"));
}

#[test]
fn statuses_map_to_hosting_errors() {
    let auth = user(&FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#)).unwrap_err();
    assert!(matches!(auth, GitError::HostingAuth { ref message } if message == "Bad credentials"), "{auth:?}");
    let forbidden = user(&FakeTransport::new().reply(403, "not json")).unwrap_err();
    assert!(matches!(forbidden, GitError::HostingAuth { ref message } if message == "HTTP 403"));
    assert!(matches!(user(&FakeTransport::new().reply(404, "{}")).unwrap_err(), GitError::HostingNotFound));
    let limited = FakeTransport::new().reply_with(403, &[("X-RateLimit-Remaining", "0"), ("X-RateLimit-Reset", "1792497600")], "{}");
    assert!(matches!(user(&limited).unwrap_err(), GitError::HostingRateLimited { reset_epoch: Some(1792497600) }));
    let gitlab = FakeTransport::new().reply_with(429, &[("RateLimit-Reset", "1792497601")], "{}");
    assert!(matches!(user(&gitlab).unwrap_err(), GitError::HostingRateLimited { reset_epoch: Some(1792497601) }));
    let after = FakeTransport::new().reply_with(429, &[("Retry-After", "60")], "{}");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert!(matches!(user(&after).unwrap_err(), GitError::HostingRateLimited { reset_epoch: Some(t) } if t >= now + 60));
    assert!(matches!(user(&FakeTransport::new().reply(429, "")).unwrap_err(), GitError::HostingRateLimited { reset_epoch: None }));
    let rejected = user(&FakeTransport::new().reply(422, r#"{"error":{"message":"already exists"}}"#)).unwrap_err();
    assert!(matches!(rejected, GitError::HostingRejected { ref message } if message == "already exists"));
    let plain = user(&FakeTransport::new().reply(400, r#"{"error":"bad thing"}"#)).unwrap_err();
    assert!(matches!(plain, GitError::HostingRejected { ref message } if message == "bad thing"));
    assert!(matches!(user(&FakeTransport::new().reply(302, "")).unwrap_err(), GitError::HostingRejected { ref message } if message == "HTTP 302"));
    assert!(matches!(user(&FakeTransport::new().reply(502, "")).unwrap_err(), GitError::HostingUnreachable { ref message } if message == "HTTP 502"));
    let garbage = user(&FakeTransport::new().reply(200, "<html>")).unwrap_err();
    assert!(matches!(garbage, GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com"));
    let down = FakeTransport::new().fail(GitError::HostingUnreachable { message: "dns".into() });
    assert!(matches!(user(&down).unwrap_err(), GitError::HostingUnreachable { ref message } if message == "dns"));
}

#[test]
fn an_error_body_that_echoes_the_token_is_redacted() {
    let echo = format!(r#"{{"message":"token {SECRET} lacks scope repo"}}"#);
    let err = user(&FakeTransport::new().reply(403, &echo)).unwrap_err();
    assert!(matches!(err, GitError::HostingAuth { ref message } if message == "token *** lacks scope repo"), "{err:?}");
    assert!(!err.to_string().contains(SECRET));
}

#[test]
fn long_provider_messages_are_cut_to_200_chars() {
    let long = format!(r#"{{"message":"{}"}}"#, "x".repeat(500));
    let GitError::HostingRejected { message } = user(&FakeTransport::new().reply(422, &long)).unwrap_err() else { panic!() };
    assert_eq!(message.chars().count(), 201);
    assert!(message.ends_with('…'));
}
```

- [ ] **Step 5: Write the failing provider tests** (`tests/hosting_providers.rs`)

```rust
//! The three providers against hand-written fixtures through a FakeTransport: URLs, JSON
//! mapping, paging, single-PR reads and the checkout plan.

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::{self, CheckoutPlan, CiState, Provider as P, PullRequest, RepoRef, Token, UserInfo};

macro_rules! fixture { ($n:literal) => { include_str!(concat!("fixtures/hosting/", $n)) }; }

fn tok() -> Token { Token::new("t0k").unwrap() }
fn repo(provider: P, host: &str, namespace: &str, name: &str) -> RepoRef {
    RepoRef { provider, host: host.into(), namespace: namespace.into(), name: name.into() }
}
/// The JSON of element `i` of a list fixture (Bitbucket's `values`), for single-PR reads.
fn element(list: &str, i: usize) -> String {
    let v: serde_json::Value = serde_json::from_str(list).unwrap();
    v.get("values").unwrap_or(&v)[i].to_string()
}

#[test]
fn current_user_for_each_provider() {
    let want = |avatar: &str| UserInfo { username: "octo".into(), display_name: Some("Octo Cat".into()), avatar_url: Some(avatar.into()) };
    let gh = FakeTransport::new().reply(200, fixture!("github_user.json"));
    assert_eq!(hosting::current_user(&gh, P::GitHub, "ghe.corp", &tok()).unwrap(), want("https://avatars.githubusercontent.com/u/1"));
    assert_eq!(gh.requests()[0].url, "https://ghe.corp/api/v3/user");
    let gl = FakeTransport::new().reply(200, fixture!("gitlab_user.json"));
    assert_eq!(hosting::current_user(&gl, P::GitLab, "gitlab.com", &tok()).unwrap(), want("https://gitlab.com/uploads/a.png"));
    assert_eq!(gl.requests()[0].url, "https://gitlab.com/api/v4/user");
    let bb = FakeTransport::new().reply(200, fixture!("bitbucket_user.json"));
    assert_eq!(hosting::current_user(&bb, P::Bitbucket, "bitbucket.org", &tok()).unwrap(), want("https://avatar.example/a.png"));
    assert_eq!(bb.requests()[0].url, "https://api.bitbucket.org/2.0/user");
    let nick = FakeTransport::new().reply(200, r#"{"nickname":"nick"}"#);
    assert_eq!(hosting::current_user(&nick, P::Bitbucket, "bitbucket.org", &tok()).unwrap(),
               UserInfo { username: "nick".into(), display_name: None, avatar_url: None });
    let gh_no_name = FakeTransport::new().reply(200, r#"{"login":"octo","name":null}"#);
    assert_eq!(hosting::current_user(&gh_no_name, P::GitHub, "github.com", &tok()).unwrap().display_name, None);
}

#[test]
fn every_provider_sends_a_bearer_token() {
    for (p, host, body) in [(P::GitLab, "gitlab.com", fixture!("gitlab_user.json")), (P::Bitbucket, "bitbucket.org", fixture!("bitbucket_user.json"))] {
        let t = FakeTransport::new().reply(200, body);
        hosting::current_user(&t, p, host, &tok()).unwrap();
        let req = &t.requests()[0];
        assert!(req.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("authorization") && v == "Bearer t0k"), "{p:?}");
        assert!(req.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("accept") && v == "application/json"), "{p:?}");
    }
}

#[test]
fn github_lists_pull_requests() {
    let t = FakeTransport::new().reply(200, fixture!("github_pulls.json"));
    let prs = hosting::list_pull_requests(&t, &repo(P::GitHub, "github.com", "gorlox", "test-repo"), &tok(), 2).unwrap();
    assert_eq!(t.requests()[0].url,
        "https://api.github.com/repos/gorlox/test-repo/pulls?state=open&sort=updated&direction=desc&per_page=50&page=2");
    assert_eq!(prs, vec![
        PullRequest { number: 12, title: "Add login".into(), author: "alice".into(), source_branch: "feature/login".into(),
            target_branch: "main".into(), from_fork: false, fork_clone_url: None, draft: false, ci_state: CiState::None,
            updated_at: 1792497600, web_url: "https://github.com/gorlox/test-repo/pull/12".into() },
        PullRequest { number: 9, title: "Fix typo".into(), author: "bob".into(), source_branch: "main".into(),
            target_branch: "main".into(), from_fork: true, fork_clone_url: Some("https://github.com/bob/test-repo.git".into()),
            draft: true, ci_state: CiState::None, updated_at: 1792398615, web_url: "https://github.com/gorlox/test-repo/pull/9".into() },
    ]);
}

#[test]
fn github_a_deleted_fork_is_from_fork_without_a_url() {
    let body = r#"[{"number":1,"title":"t","user":{"login":"a"},"updated_at":"2026-10-20T12:00:00Z","html_url":"https://github.com/o/r/pull/1","head":{"ref":"x","repo":null},"base":{"ref":"main","repo":{"full_name":"o/r"}}}]"#;
    let prs = hosting::list_pull_requests(&FakeTransport::new().reply(200, body), &repo(P::GitHub, "github.com", "o", "r"), &tok(), 1).unwrap();
    assert!(prs[0].from_fork && prs[0].fork_clone_url.is_none() && !prs[0].draft);
}

#[test]
fn gitlab_lists_merge_requests_with_an_encoded_project_path() {
    let t = FakeTransport::new().reply(200, fixture!("gitlab_merge_requests.json"));
    let prs = hosting::list_pull_requests(&t, &repo(P::GitLab, "gitlab.com", "group/sub", "proj"), &tok(), 1).unwrap();
    assert_eq!(t.requests()[0].url,
        "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50&page=1");
    assert_eq!((prs[0].number, prs[0].from_fork, prs[0].updated_at), (5, false, 1792497600));
    assert_eq!((prs[1].number, prs[1].from_fork, prs[1].draft, prs[1].fork_clone_url.as_deref()), (4, true, true, None));
    assert_eq!(prs[1].updated_at, 1792391415);
    assert_eq!(prs[1].web_url, "https://gitlab.com/group/sub/proj/-/merge_requests/4");
}

#[test]
fn bitbucket_lists_pull_requests_from_values() {
    let t = FakeTransport::new().reply(200, fixture!("bitbucket_pullrequests.json"));
    let prs = hosting::list_pull_requests(&t, &repo(P::Bitbucket, "bitbucket.org", "ws", "repo"), &tok(), 3).unwrap();
    assert_eq!(t.requests()[0].url,
        "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?state=OPEN&sort=-updated_on&pagelen=50&page=3");
    assert_eq!((prs[0].number, prs[0].author.as_str(), prs[0].from_fork, prs[0].draft), (3, "alice", false, false));
    assert_eq!((prs[1].number, prs[1].author.as_str(), prs[1].from_fork, prs[1].draft), (2, "Bob B", true, true));
    assert_eq!(prs[1].fork_clone_url.as_deref(), Some("https://bitbucket.org/bob/repo.git"));
    assert_eq!(prs[0].updated_at, 1792497600);
}

#[test]
fn bitbucket_refuses_a_suspicious_fork_name_as_a_clone_url() {
    let body = r#"{"values":[{"id":1,"title":"t","author":{},"source":{"branch":{"name":"x"},"repository":{"full_name":"-c/x y"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/repo"}},"updated_on":"2026-10-20T12:00:00Z","links":{"html":{"href":"https://bitbucket.org/ws/repo/pull-requests/1"}}}]}"#;
    let prs = hosting::list_pull_requests(&FakeTransport::new().reply(200, body), &repo(P::Bitbucket, "bitbucket.org", "ws", "repo"), &tok(), 1).unwrap();
    assert_eq!((prs[0].from_fork, prs[0].fork_clone_url.as_deref(), prs[0].author.as_str()), (true, None, ""));
}

#[test]
fn get_pull_request_reads_one_item_for_each_provider() {
    let cases = [
        (repo(P::GitHub, "github.com", "gorlox", "test-repo"), element(fixture!("github_pulls.json"), 1), 9,
         "https://api.github.com/repos/gorlox/test-repo/pulls/9"),
        (repo(P::GitLab, "gitlab.com", "group/sub", "proj"), element(fixture!("gitlab_merge_requests.json"), 1), 4,
         "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests/4"),
        (repo(P::Bitbucket, "bitbucket.org", "ws", "repo"), element(fixture!("bitbucket_pullrequests.json"), 1), 2,
         "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/2"),
    ];
    for (r, body, n, url) in cases {
        let t = FakeTransport::new().reply(200, &body);
        let pr = hosting::get_pull_request(&t, &r, &tok(), n).unwrap();
        assert_eq!((pr.number, pr.from_fork, t.requests()[0].url.as_str()), (n, true, url));
    }
}

#[test]
fn a_list_missing_a_required_field_is_an_unexpected_response() {
    let err = hosting::list_pull_requests(&FakeTransport::new().reply(200, r#"[{"number":1}]"#),
        &repo(P::GitHub, "github.com", "o", "r"), &tok(), 1).unwrap_err();
    assert!(matches!(err, GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com"));
    let bad_time = r#"[{"iid":1,"title":"t","author":{"username":"a"},"source_branch":"x","target_branch":"main","source_project_id":1,"target_project_id":1,"updated_at":"yesterday","web_url":"https://gitlab.com/g/p/-/merge_requests/1"}]"#;
    assert!(matches!(hosting::list_pull_requests(&FakeTransport::new().reply(200, bad_time),
        &repo(P::GitLab, "gitlab.com", "g", "p"), &tok(), 1).unwrap_err(), GitError::HostingUnreachable { .. }));
}

fn pr(from_fork: bool, fork: Option<&str>, src: &str) -> PullRequest {
    PullRequest { number: 7, title: "t".into(), author: "a".into(), source_branch: src.into(), target_branch: "main".into(),
        from_fork, fork_clone_url: fork.map(Into::into), draft: false, ci_state: CiState::None, updated_at: 0,
        web_url: "https://h/x".into() }
}

#[test]
fn checkout_plans() {
    for p in [P::GitHub, P::GitLab, P::Bitbucket] {
        assert_eq!(hosting::checkout_plan(p, &pr(false, None, "feat")).unwrap(), CheckoutPlan::TrackBranch { branch: "feat".into() });
    }
    assert_eq!(hosting::checkout_plan(P::GitHub, &pr(true, None, "main")).unwrap(),
               CheckoutPlan::FetchHead { source: "origin".into(), refspec: "refs/pull/7/head".into() });
    assert_eq!(hosting::checkout_plan(P::GitLab, &pr(true, None, "main")).unwrap(),
               CheckoutPlan::FetchHead { source: "origin".into(), refspec: "refs/merge-requests/7/head".into() });
    assert_eq!(hosting::checkout_plan(P::Bitbucket, &pr(true, Some("https://bitbucket.org/bob/repo.git"), "fix")).unwrap(),
               CheckoutPlan::FetchHead { source: "https://bitbucket.org/bob/repo.git".into(), refspec: "refs/heads/fix".into() });
    assert!(matches!(hosting::checkout_plan(P::Bitbucket, &pr(true, None, "fix")), Err(GitError::HostingNotFound)));
    assert!(matches!(hosting::checkout_plan(P::Bitbucket, &pr(true, Some("https://bitbucket.org/b/r.git"), "a..b")),
                     Err(GitError::InvalidBranchName(_))));
    assert!(matches!(hosting::checkout_plan(P::GitHub, &pr(false, None, "-x")), Err(GitError::InvalidBranchName(_))));
}
```

- [ ] **Step 6: Write the failing transport smoke test** (`tests/hosting_ureq.rs`)

```rust
//! UreqTransport against a one-shot local HTTP server on 127.0.0.1 (spec §7: one smoke test
//! of the real adapter; no provider is contacted).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use git_real_core::GitError;
use git_real_core::hosting::{Method, Request, Transport};
use git_real_core::hosting::ureq_transport::UreqTransport;

/// Serves one connection with `reply` and returns the raw request text.
fn serve_once(reply: &'static str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut chunk).unwrap();
            buf.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        if let Some(len) = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())) {
            let have = buf.len() - (text.find("\r\n\r\n").unwrap() + 4);
            let mut rest = vec![0u8; len - have];
            sock.read_exact(&mut rest).unwrap();
            buf.extend_from_slice(&rest);
        }
        sock.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    (url, handle)
}

#[test]
fn a_get_returns_status_headers_and_body_without_treating_4xx_as_an_error() {
    let (base, server) = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nX-RateLimit-Remaining: 7\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    let req = Request { method: Method::Get, url: format!("{base}/user"), headers: vec![("Authorization".into(), "Bearer t0k".into())], body: None };
    let resp = UreqTransport::new().send(&req).unwrap();
    assert_eq!((resp.status, resp.body.as_str(), resp.header("x-ratelimit-remaining")), (401, "{}", Some("7")));
    let seen = server.join().unwrap().to_ascii_lowercase();
    assert!(seen.starts_with("get /user http/1.1"), "{seen}");
    assert!(seen.contains("authorization: bearer t0k") && seen.contains("user-agent: git-real/"), "{seen}");
}

#[test]
fn a_post_sends_its_body() {
    let (base, server) = serve_once("HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    let req = Request { method: Method::Post, url: format!("{base}/x"), headers: vec![("Content-Type".into(), "application/json".into())], body: Some(r#"{"a":1}"#.into()) };
    assert_eq!(UreqTransport::new().send(&req).unwrap().status, 201);
    let seen = server.join().unwrap();
    assert!(seen.starts_with("POST /x HTTP/1.1") && seen.ends_with(r#"{"a":1}"#), "{seen}");
}

#[test]
fn a_refused_connection_is_unreachable() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // dropped: closed
    let req = Request { method: Method::Get, url: format!("http://127.0.0.1:{port}/"), headers: vec![], body: None };
    assert!(matches!(UreqTransport::new().send(&req), Err(GitError::HostingUnreachable { .. })));
}
```

- [ ] **Step 7: Write the failing git-side tests**

`tests/pr_checkout.rs` (real git; each test returns early when `!common::git_available()`). Fixture `fx()`: `temp_repo_with_commit` → `path`, `configure_identity`, `temp_bare_clone(path)` → `bare`, `add_remote_and_fetch(path, bare, head)`; a helper `pr_head(bare, n, file) -> Oid` makes a commit on a side clone of `bare` and pushes it to `refs/pull/<n>/head` (`run_git_ok(side, ["push", bare, "HEAD:refs/pull/<n>/head"])`).

```rust
#[test] fn fork_pr_lands_on_pr_n_and_never_touches_a_same_named_local_branch() {
    // head branch is `main`-like (the fixture's head name); refs/pull/7/head is one commit ahead.
    // prepare_ref_fetch("origin", "refs/pull/7/head") → run(None) → checkout_fetch_head(7, false)
    // == CheckedOut { branch: "pr/7" }; HEAD is refs/heads/pr/7 at the pushed oid;
    // the head branch's oid is unchanged; `branch.pr/7.remote` is not set (no upstream).
}
#[test] fn an_existing_pr_branch_fast_forwards() {
    // check out pr/7 at commit A, push B (child of A) to refs/pull/7/head, fetch, checkout_fetch_head(7, false)
    // == CheckedOut { "pr/7" }, pr/7 at B.
}
#[test] fn a_pr_branch_that_already_contains_the_head_is_only_switched_to() {
    // pr/7 has A plus a local commit L; FETCH_HEAD is A → CheckedOut, pr/7 still at L, HEAD on pr/7.
}
#[test] fn a_diverged_pr_branch_needs_a_reset_and_reset_moves_it() {
    // pr/7 at L (not an ancestor of the fetched B) → NeedsReset { branch: "pr/7" }, pr/7 still at L, HEAD unchanged;
    // checkout_fetch_head(7, true) → CheckedOut, pr/7 at B.
}
#[test] fn a_conflicting_dirty_tree_blocks_checkout_with_checkout_failed() {
    // README edited locally; the PR head changes README → Err(CheckoutFailed { .. }); pr/7 does not exist afterwards
    // or still points where it was.
}
#[test] fn checkout_fetch_head_without_a_fetch_head_is_revision_not_found() {
    // fresh clone, RefFetch prepared but not run → Err(RevisionNotFound(s)) with s == "FETCH_HEAD".
}
#[test] fn checkout_fetch_head_ignores_other_fetch_head_entries() {
    // run the PR RefFetch, then `git fetch origin` overwrites FETCH_HEAD with the branch entry →
    // checkout_fetch_head(&pr_fetch, 7, false) == Err(RevisionNotFound("FETCH_HEAD")); pr/7 does not exist.
}
#[test] fn prepare_ref_fetch_validates_source_and_refspec() {
    // "nope" → RemoteNotFound("nope"); "-x" → RemoteNotFound; "http://h/x.git", "https://h/x y", "https://h/x\n" → InvalidRemoteUrl;
    // refspecs "pull/7/head", "+refs/pull/7/head", "refs/pull/7/head:refs/heads/main", "refs/heads/a..b", "refs/heads/x y"
    // → InvalidBranchName(refspec); ("origin", "refs/pull/7/head") → Ok with urls() == [bare path];
    // ("https://bitbucket.org/bob/repo.git", "refs/heads/fix") → Ok with urls() == ["https://bitbucket.org/bob/repo.git"].
}
```

`tests/network_cli.rs` (fake git; extend):

```rust
#[test] fn ref_fetch_argv_is_fetch_no_tags_source_refspec() {
    // origin = URL; prepare_ref_fetch("origin", "refs/pull/7/head").run(Some(&creds())):
    // after_workdir == auth_args("https://example.test") ++ ["fetch", "--no-tags", "origin", "refs/pull/7/head"];
    // a fork URL source puts the URL in that slot.
}
#[test] fn account_credentials_are_never_approved() {
    // Credentials::account("https://example.test", "x-access-token", &Token::new(TOKEN).unwrap())
    // fetch.run(Some(&c)) succeeds; env.txt holds x-access-token / TOKEN; approve-stdin.txt does not exist.
}
#[test] fn fetch_and_push_report_the_urls_they_use() {
    // prepare_fetch().urls() == [URL]; prepare_push(Upstream, false, head).urls() == [push URL];
    // prepare_pull().urls() == [URL]; tag push / remote delete prepares too.
}
```

`tests/network_classify.rs` (extend):

```rust
#[test] fn account_credentials_validate_like_typed_ones_and_do_not_approve() {
    let t = Token::new(TOKEN).unwrap();
    let c = Credentials::account("https://github.com", "x-access-token", &t).unwrap();
    assert!(!c.approves());
    assert!(Credentials::new("https://github.com", "me", TOKEN).unwrap().approves());
    assert!(matches!(Credentials::account("ssh://github.com", "x", &t), Err(GitError::InvalidCredentials)));
    assert!(!format!("{c:?}").contains(TOKEN));
}
```

`tests/clone.rs`: every `clone::clone(url, dest, sink)` / `clone_with(git, url, dest, sink)` call gains `None` before the sink; plus

```rust
#[cfg(unix)] #[test] fn clone_with_credentials_puts_the_helper_before_clone_and_the_token_in_the_env() {
    // fake git writes "$@" and $GR_TOKEN to files under a temp dir baked into the script, then exits 1;
    // argv == ["-c", "credential.https://example.test.helper=", "-c", "credential.https://example.test.helper=<HELPER>",
    //          "clone", "--progress", "--", "https://example.test/x.git", <dest>]; the token file holds TOKEN;
    // no argv element contains TOKEN.
}
```

- [ ] **Step 8: Write the failing app mapping test** (`src-tauri/tests/error.rs`, extend the kind table)

```rust
#[test]
fn hosting_errors_map_to_their_kinds_with_display_messages() {
    let cases = [
        (GitError::HostingAuth { message: "Bad credentials".into() }, AppErrorKind::HostingAuth, "the provider rejected the token: Bad credentials"),
        (GitError::HostingNotFound, AppErrorKind::HostingNotFound, "the repository was not found, or this account cannot see it"),
        (GitError::HostingRateLimited { reset_epoch: Some(1) }, AppErrorKind::HostingRateLimited, "the provider's API rate limit was reached"),
        (GitError::HostingRejected { message: "exists".into() }, AppErrorKind::HostingRejected, "the provider refused the request: exists"),
        (GitError::HostingUnreachable { message: "HTTP 502".into() }, AppErrorKind::HostingUnreachable, "could not reach the provider: HTTP 502"),
        (GitError::KeychainUnavailable("no dbus".into()), AppErrorKind::KeychainUnavailable, "the system keychain is unavailable: no dbus"),
        (GitError::NoHostingAccount, AppErrorKind::NoHostingAccount, "no account is connected for this repository's host"),
        (GitError::InvalidHostingHost("a b".into()), AppErrorKind::InvalidHostingHost, "\"a b\" is not a valid host name"),
        (GitError::InvalidToken, AppErrorKind::InvalidToken, "the token is empty, longer than 4096 bytes, or contains a line break"),
    ];
    for (err, kind, message) in cases {
        let app = AppError::from(err);
        assert_eq!((app.kind, app.message.as_str(), app.network.is_none()), (kind, message, true));
    }
    let json = serde_json::to_value(AppError::from(GitError::NoHostingAccount)).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "noHostingAccount", "message": "no account is connected for this repository's host" }));
}
```

- [ ] **Step 9: Run the new tests to verify they fail**

Run (from `src-tauri`): `cargo test --workspace`. Expected: compile errors naming the missing `hosting` module, `Credentials::account`, `prepare_ref_fetch`, the new `GitError` variants and `AppErrorKind`s.

- [ ] **Step 10: Implement the core**

- `error.rs`: the nine variants and `Display` texts from Global Constraints, after `NetworkFailed`. App `error.rs`: the nine `AppErrorKind`s (after `InvalidCredentials`) and their `From<GitError>` arms; the message is `error.to_string()`.
- `hosting/provider.rs`: `Provider`, `RepoRef`, `detect`, `validate_host`, `https_host` per Global Constraints; reuse `remote::host::{valid, strip_user, is_drive_path}` (now `pub(crate)`).
- `hosting/http.rs`: `Token`, `Method`, `Request` (Debug redaction), `Response::header`, `Transport`, `parse_timestamp` (days-from-civil; month 1–12, day 1–31, hour < 24, minute/second < 60), `get` (adds `Authorization: Bearer`, `Accept: application/json` unless `extra` overrides it), `send_json` (the status mapping, then `serde_json::from_str`, a parse failure → `unexpected response from <host>`), `percent_encode`. The message extraction reads the body as `serde_json::Value`.
- `hosting/model.rs`: the DTOs; `Account::new` sets `id = Account::key(provider, host, &user.username)`, `needs_reconnect: false`.
- `hosting/{github,gitlab,bitbucket}.rs`: private `#[derive(Deserialize)]` wire structs per the JSON mapping, converted to the DTOs (`updated_at` through `parse_timestamp`; `None` there is the unexpected-response error). Bitbucket reads `values` from list responses and ignores `next` (the page number drives paging).
- `hosting/mod.rs`: dispatch, `CheckoutPlan`, `checkout_plan` (validate `source_branch` with `refs::validate_branch_name` first, then pick a variant per Global Constraints).
- `hosting/ureq_transport.rs`: an `ureq::Agent` built from `Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).http_status_as_error(false).build()`; `send` adds `User-Agent: git-real/<version>` and the request headers; `Get` → `.call()`, `Post` → `.send(body)`; response headers lower-cased; `body_mut().read_to_string()`; any `ureq::Error` → `HostingUnreachable { message: e.to_string() }`. If ureq 3's names differ from these, use the equivalent and note it in Deviations.
- `remote/auth.rs`: private `approve: bool`; `new` → true; `account(origin, username, token)` → `new(origin, username, token.expose_secret())` with `approve = false`; `approves()`. `remote/mod.rs`: approve only when `c.approves()`.
- `remote/clone.rs`: `creds` parameter; `auth::apply(&mut cmd, creds)` right after `git_cli::command(git)`.
- `urls()` accessors on the six prepared values.
- `refs/switch.rs`: `SwitchTarget::Reset { name, oid }` → `switch -C <name> <oid>`.
- `remote/pr_checkout.rs`: `prepare_ref_fetch` (a source starting with `https://` is a URL: it must pass `origin_of` and contain no whitespace or control characters, else `InvalidRemoteUrl`; otherwise `ensure_remote(source)` and `used_url(source, Fetch)`; the refspec must start with `refs/`, contain no `:`, `+` or whitespace, and pass `git2::Reference::is_valid_name`, else `InvalidBranchName(refspec)`); `RefFetch::run` → `run_network(git, workdir, "fetch", ["fetch", "--no-tags", source, refspec], urls, creds)`; `checkout_fetch_head` — the algorithm:

```text
oid  := the FETCH_HEAD entry whose ref_name == fetch.refspec (repo.fetchhead_foreach) — none → RevisionNotFound("FETCH_HEAD")
name := "pr/<number>"
cur  := oid of local branch name, if it exists
if cur == oid or cur descends from oid      → switch <name>                     → CheckedOut
elif cur is None or oid descends from cur or reset → switch -C <name> <oid>    → CheckedOut
else                                         → NeedsReset { name }   (nothing changes)
```

- [ ] **Step 11: Run the tests and static checks**

Run (from `src-tauri`): `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`. Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add src-tauri
git commit -m "feat(core): GR-13a hosting domain, PR checkout git work, account credentials"
```

---

### Task 2: App layer — account store and keychain, hosting commands, account-token git auth, IPC seam

**Files:**

- Modify: `src-tauri/Cargo.toml` (`keyring`)
- Create: `src-tauri/src/hosting_store.rs`, `src-tauri/src/commands/hosting.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod hosting_store;` after `events`; `.manage(Arc::new(UreqTransport::new()))`; in `setup`, `app.manage(Arc::new(HostingStore::load(dir.join("hosting_accounts.json"), Box::new(KeyringTokenStore))))` beside the recent store; six handlers after `commands::remote::remove_remote`), `src-tauri/src/commands/mod.rs` (`pub mod hosting;` after `history`)
- Modify: `src-tauri/src/commands/remote.rs` (`NetworkAuth`; `fetch_inner`, `fetch_remote_inner`, `pull_inner`, `push_inner` take it; their commands take `hosting: State<'_, Arc<HostingStore>>`), `src-tauri/src/commands/refs.rs` (`delete_remote_branch_inner` / `delete_remote_branch`), `src-tauri/src/commands/tags.rs` (`push_tag_inner`, `delete_remote_tag_inner` and commands), `src-tauri/src/commands/repo.rs` (`clone_repo_inner` gains `auth: NetworkAuth<'_>` before `sink`; `clone_repo` takes the store)
- Create: `src/lib/ipc/opener.ts`
- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/commands.ts`, `src/lib/ipc/errors.ts`, `src/lib/ipc/index.ts` (`export * from "./opener";`), `src/lib/query/keys.ts`
- Test (test role): new `src-tauri/tests/hosting_store.rs`, `src-tauri/tests/keyring_store.rs`, `src-tauri/tests/hosting_commands.rs`; `src-tauri/tests/common/mod.rs` (`MemoryTokenStore`, `FailingTokenStore`, `FakeTransport`, `no_accounts()`); every call of the eight changed `*_inner` functions in `src-tauri/tests/{remote_commands,refs_commands,tag_commands,commands,stash_commands}.rs` (`None` → `NetworkAuth::None`, `Some(&c)` → `NetworkAuth::Explicit(&c)`; `clone_repo_inner(.., NetworkAuth::None, sink)`); `src/lib/ipc/{commands,errors,types,index}.test.ts`, new `src/lib/ipc/opener.test.ts`, `src/lib/query/keys.test.ts`

**Interfaces:**

- Consumes: Task 1's `hosting::{self, Account, CheckoutPlan, CheckoutPrOutcome, Provider, PullRequest, RepoContext, Token, Transport, UserInfo}`, `hosting::provider::{detect, https_host, validate_host}`, `hosting::ureq_transport::UreqTransport`, `Credentials::account`, `RepoSession::{prepare_ref_fetch, checkout_fetch_head, prepare_fetch_remote, checkout_remote_branch, list_remotes}`, `RefFetch::{urls, run}`, every prepared value's `urls()`, the new `GitError`s. App: `with_session`, `run_blocking`, `credentials_from_arg`, `CredentialsArg`, `RecentStore`'s load/save shape. Test helpers: `temp_repo_with_commit`, `temp_bare_clone`, `configure_identity`, `commit_file`, `head_branch_name`, `git_available`, `fresh_state`.
- Produces:

```rust
// hosting_store.rs
pub trait TokenStore: Send + Sync {
    fn set(&self, key: &str, token: &Token) -> Result<(), GitError>;
    fn get(&self, key: &str) -> Result<Option<Token>, GitError>;
    fn delete(&self, key: &str) -> Result<(), GitError>;     // a missing entry is Ok(())
}
pub const KEYRING_SERVICE: &str = "git-real";
pub struct KeyringTokenStore;                               // impl TokenStore via keyring::Entry::new(KEYRING_SERVICE, key)
pub fn keychain_error(e: keyring::Error) -> GitError;       // every variant → KeychainUnavailable(e.to_string())
pub struct HostingStore { /* path, accounts: Mutex<Vec<Account>>, tokens: Box<dyn TokenStore> */ }
impl HostingStore {
    pub fn load(path: PathBuf, tokens: Box<dyn TokenStore>) -> Self;
    pub fn accounts(&self) -> Vec<Account>;                   // file order
    pub fn find(&self, provider: Provider, host: &str) -> Option<Account>;
    pub fn hosts(&self) -> Vec<(Provider, String)>;
    pub fn token(&self, account: &Account) -> Result<Option<Token>, GitError>;
    pub fn connect(&self, account: Account, token: &Token) -> Result<Account, GitError>;
    pub fn disconnect(&self, account_id: &str) -> Result<(), GitError>;
    pub fn mark_needs_reconnect(&self, account_id: &str);
    pub fn credentials_for(&self, urls: &[String]) -> Option<Credentials>;
}
// commands/remote.rs
#[derive(Clone, Copy)]
pub enum NetworkAuth<'a> { None, Explicit(&'a Credentials), Accounts(&'a HostingStore) }
impl<'a> NetworkAuth<'a> {
    /// Explicit when the user typed credentials, else the account store.
    pub fn new(explicit: Option<&'a Credentials>, store: &'a HostingStore) -> Self;
    pub fn resolve(&self, urls: &[String]) -> Option<Credentials>;
}
pub fn fetch_inner(reg: &RepoRegistry, id: RepoId, auth: NetworkAuth<'_>) -> Result<(), AppError>;   // likewise the other seven
// commands/hosting.rs
pub fn hosting_list_accounts_inner(store: &HostingStore) -> Vec<Account>;
pub fn hosting_connect_inner(store: &HostingStore, t: &dyn Transport, provider: Provider, host: Option<&str>, token: &str) -> Result<Account, AppError>;
pub fn hosting_disconnect_inner(store: &HostingStore, account_id: &str) -> Result<(), AppError>;
pub fn hosting_repo_context_inner(reg: &RepoRegistry, store: &HostingStore, id: RepoId) -> Result<Option<RepoContext>, AppError>;
pub fn hosting_list_pull_requests_inner(reg: &RepoRegistry, store: &HostingStore, t: &dyn Transport, id: RepoId, page: u32) -> Result<Vec<PullRequest>, AppError>;
pub fn hosting_checkout_pull_request_inner(reg: &RepoRegistry, store: &HostingStore, t: &dyn Transport, id: RepoId, number: u64, reset: bool, credentials: Option<&Credentials>) -> Result<CheckoutPrOutcome, AppError>;
// + #[tauri::command] async hosting_list_accounts, hosting_connect, hosting_disconnect, hosting_repo_context,
//   hosting_list_pull_requests, hosting_checkout_pull_request (State<Arc<HostingStore>>, State<Arc<UreqTransport>>)
```

```ts
// types.ts
export type HostingProvider = "github" | "gitlab" | "bitbucket";
export interface HostingAccount {
  id: string;
  provider: HostingProvider;
  host: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  needsReconnect: boolean;
}
export interface HostingRepoRef {
  provider: HostingProvider;
  host: string;
  namespace: string;
  name: string;
}
export interface RepoContext {
  repo: HostingRepoRef;
  account: HostingAccount | null;
}
export type CiState = "passing" | "failing" | "pending" | "none";
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  fromFork: boolean;
  forkCloneUrl: string | null;
  draft: boolean;
  ciState: CiState;
  /** Epoch seconds. */
  updatedAt: number;
  webUrl: string;
}
export type CheckoutPrOutcome =
  { kind: "checkedOut"; branch: string } | { kind: "needsReset"; branch: string };
// AppErrorKind += "hostingAuth" | "hostingNotFound" | "hostingRateLimited" | "hostingRejected" | "hostingUnreachable"
//   | "keychainUnavailable" | "noHostingAccount" | "invalidHostingHost" | "invalidToken"
// commands.ts
export function hostingListAccounts(): Promise<HostingAccount[]>;
export function hostingConnect(
  provider: HostingProvider,
  host: string | null,
  token: string,
): Promise<HostingAccount>;
export function hostingDisconnect(accountId: string): Promise<void>;
export function hostingRepoContext(id: RepoId): Promise<RepoContext | null>;
export function hostingListPullRequests(id: RepoId, page: number): Promise<PullRequest[]>;
export function hostingCheckoutPullRequest(
  id: RepoId,
  number: number,
  reset: boolean,
  credentials?: Credentials | null,
): Promise<CheckoutPrOutcome>;
// opener.ts
export function openExternal(url: string): Promise<void>; // rejects with Error("Only https links can be opened") unless https:
// keys.ts
queryKeys.hostingAccounts; // ["hosting", "accounts"]
queryKeys.hostingContext(id); // ["repo", id, "hostingContext"]
queryKeys.pullRequests(id); // ["hosting", "pullRequests", id]
mutationKeys.hostingAccount; // ["hostingAccount"]
```

- [ ] **Step 1: Add `keyring` and confirm it builds**

In `src-tauri/Cargo.toml` `[dependencies]`: `keyring = { version = "3", features = ["sync-secret-service", "crypto-rust", "apple-native", "windows-native"] }`.

Run (from `src-tauri`): `cargo build -p git-real && cargo tree -p git-real -i openssl-sys`. Expected: builds; `openssl-sys` is not in the graph. Fix any wrong feature name here and record it under Deviations.

- [ ] **Step 2: Write the test helpers** (`src-tauri/tests/common/mod.rs`)

```rust
/// An in-memory TokenStore; `fail_get` / `fail_set` / `fail_delete` make that call return KeychainUnavailable.
/// Clones share one map, so a test keeps a clone to inspect what the store wrote.
#[derive(Clone, Default)]
pub struct MemoryTokenStore { pub map: Arc<Mutex<HashMap<String, String>>>, pub fail_get: bool, pub fail_set: bool, pub fail_delete: bool }
// impl TokenStore; get of a missing key → Ok(None); delete of a missing key → Ok(()).
pub struct FakeTransport { /* same contract as the core helper of Task 1 Step 2 */ }
/// A HostingStore at `<tmp>/hosting_accounts.json` over a MemoryTokenStore the test can inspect.
pub fn hosting_store() -> (TempDir, HostingStore, MemoryTokenStore);
pub fn hosting_store_with(tokens: MemoryTokenStore) -> (TempDir, HostingStore, MemoryTokenStore);
pub fn github_account(username: &str) -> Account;   // Account::new(GitHub, "github.com", UserInfo { username, .. None })
```

- [ ] **Step 3: Write the failing store tests** (`src-tauri/tests/hosting_store.rs`)

```rust
#[test] fn a_missing_or_corrupt_file_loads_empty() { /* "not json" and absent file → accounts() is empty, file not created */ }

#[test]
fn connect_stores_the_token_in_the_keychain_and_only_metadata_in_the_file() {
    let (dir, store, tokens) = common::hosting_store();
    let a = store.connect(common::github_account("octo"), &Token::new(SECRET).unwrap()).unwrap();
    assert_eq!(a.id, "github:github.com:octo");
    assert_eq!(tokens.map.lock().unwrap().get("github:github.com:octo").map(String::as_str), Some(SECRET));
    let text = std::fs::read_to_string(dir.path().join("hosting_accounts.json")).unwrap();
    assert!(!text.contains(SECRET) && !text.contains("needsReconnect"), "{text}");
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json, serde_json::json!([{ "provider": "github", "host": "github.com", "username": "octo", "displayName": null, "avatarUrl": null }]));
    let reloaded = HostingStore::load(dir.path().join("hosting_accounts.json"), Box::new(tokens.clone()));
    assert_eq!(reloaded.accounts(), vec![a]);
}

#[test]
fn connect_replaces_the_account_on_the_same_host_and_deletes_its_old_secret() {
    // connect octo, then connect "other" on github.com → accounts() == [other]; key "github:github.com:octo" gone;
    // a GitLab account on gitlab.com is kept alongside.
}

#[test]
fn connect_with_a_failing_keychain_stores_nothing() {
    // MemoryTokenStore { fail_set: true } → Err(KeychainUnavailable(_)); accounts() empty; file absent.
}

#[test]
fn disconnect_removes_secret_and_entry_and_ignores_unknown_ids() {
    // connect, disconnect(id) → accounts() empty, map empty, file "[]"; disconnect("nope") → Ok(()).
}

#[test]
fn disconnect_keeps_the_entry_when_the_keychain_cannot_delete() { /* fail_delete → Err(KeychainUnavailable), account still listed */ }

#[test]
fn needs_reconnect_is_in_memory_only_and_cleared_by_reconnecting() {
    // mark_needs_reconnect(id) → accounts()[0].needs_reconnect; reload from file → false;
    // connect again on the same host → false.
}

#[test]
fn credentials_for_matches_only_https_urls_on_an_account_host() {
    // github.com account with token SECRET:
    let c = store.credentials_for(&["https://GitHub.com/o/r.git".into()]).unwrap();
    assert_eq!((c.origin(), c.username(), c.approves()), ("https://github.com", "x-access-token", false));
    for urls in [vec!["http://github.com/o/r.git".to_owned()], vec!["git@github.com:o/r.git".into()],
                 vec!["https://gitlab.com/o/r.git".into()], vec!["https://github.com.evil.test/o/r".into()], vec![]] {
        assert!(store.credentials_for(&urls).is_none(), "{urls:?}");
    }
    // GitLab and Bitbucket accounts give "oauth2" and "x-bitbucket-api-token-auth".
}

#[test]
fn credentials_for_takes_the_first_matching_url() {
    // GitHub and GitLab accounts; urls ["/srv/a.git", "https://gitlab.com/g/p.git", "https://github.com/o/r.git"]
    // → origin "https://gitlab.com", username "oauth2".
}

#[test]
fn credentials_for_with_a_failing_keychain_is_none() { /* fail_get → None; also None when the token is missing */ }
```

`src-tauri/tests/keyring_store.rs` (the only test binary that installs the mock builder; it never touches a real keychain):

```rust
//! KeyringTokenStore over keyring's mock credential builder. keyring 3's mock entries share no
//! state between `Entry` values, so a get after a set cannot be observed here; the acceptance
//! walk covers the real Secret Service round trip.

fn mock() { keyring::set_default_credential_builder(keyring::mock::default_credential_builder()); }

#[test] fn set_get_and_delete_succeed_against_the_mock() {
    mock();
    let s = KeyringTokenStore;
    s.set("github:github.com:octo", &Token::new("t").unwrap()).unwrap();
    assert!(s.get("github:github.com:nobody").unwrap().is_none());   // NoEntry → None
    s.delete("github:github.com:nobody").unwrap();                   // NoEntry → Ok
}
#[test] fn keyring_errors_become_keychain_unavailable() {
    let e = keychain_error(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked"))));
    assert!(matches!(e, GitError::KeychainUnavailable(ref m) if m.contains("locked")));
    assert!(matches!(keychain_error(keyring::Error::PlatformFailure(Box::new(std::io::Error::other("no dbus")))), GitError::KeychainUnavailable(_)));
}
```

If the mock turns out to share state between entries, the tester adds the set-then-get assertion and notes it.

- [ ] **Step 4: Write the failing command tests** (`src-tauri/tests/hosting_commands.rs`)

Fixture `hosted(bare_url_path)`: `temp_repo_with_commit` → `path`, `configure_identity`, `temp_bare_clone(path)` → `bare`; `git remote add origin https://github.com/o/r.git` and `git config url.<bare path>.insteadOf https://github.com/o/r.git` in `path` (git2 and git both apply it, so the fetch is local), `git fetch origin`; the repo is registered in a fresh `RepoRegistry`. A side clone of `bare` pushes branch `feature` and `HEAD:refs/pull/7/head`. `github_pr(n, src, fork: bool)` builds GitHub single-PR JSON.

```rust
#[test] fn list_accounts_and_disconnect() { /* inner fns round-trip through the store */ }

#[test]
fn connect_checks_the_token_with_the_provider_then_stores_it() {
    let t = FakeTransport::new().reply(200, r#"{"login":"octo","name":"Octo"}"#);
    let a = hosting_connect_inner(&store, &t, Provider::GitHub, Some("GitHub.com"), SECRET).unwrap();
    assert_eq!((a.id.as_str(), a.display_name.as_deref()), ("github:github.com:octo", Some("Octo")));
    assert_eq!(t.requests()[0].url, "https://api.github.com/user");
    assert_eq!(tokens.map.lock().unwrap().get("github:github.com:octo").map(String::as_str), Some(SECRET));
}

#[test]
fn connect_refusals_store_nothing() {
    // 401 → kind HostingAuth, message has no SECRET; "a\nb" → InvalidToken (no request sent);
    // Bitbucket + Some("bb.corp") → InvalidHostingHost (no request); keychain fail_set → KeychainUnavailable.
    // In every case accounts() is empty and the token map is empty.
}

#[test]
fn repo_context_detects_origin_and_attaches_the_account() {
    // no account → Some(RepoContext { repo: github.com/o/r, account: None }); after connect → account Some;
    // a repo with no origin → None; origin "/srv/x.git" → None; unknown id → UnknownRepo.
    // Custom host: account (GitHub, "ghe.corp"), origin https://ghe.corp/o/r → provider GitHub.
}

#[test]
fn list_pull_requests_needs_an_account_and_marks_a_rejected_token() {
    // no account → NoHostingAccount; with account, 200 → two PRs and the URL ends "&page=2" for page 2;
    // page 0 is sent as page=1; a 401 → HostingAuth and store.accounts()[0].needs_reconnect == true.
}

#[test]
fn checkout_of_a_same_repo_pr_tracks_the_head_branch() {
    // PR 3 with head "feature", same repo → CheckedOut { "feature" }; HEAD is refs/heads/feature,
    // upstream refs/remotes/origin/feature.
}

#[test]
fn checkout_of_a_github_fork_pr_fetches_refs_pull_and_creates_pr_n() {
    // PR 7, head ref = the repo's head branch name, fork → CheckedOut { "pr/7" } at refs/pull/7/head's oid;
    // the local head branch is unchanged; the fake transport saw GET .../repos/o/r/pulls/7.
}

#[test]
fn checkout_reports_needs_reset_and_reset_moves_the_branch() {
    // pr/7 exists with a local commit not in the PR → NeedsReset { "pr/7" }; reset=true → CheckedOut and pr/7 at the PR head.
}

#[test]
fn checkout_without_an_account_or_with_a_rejected_token_does_no_git_work() {
    // no account → NoHostingAccount; 401 on the GET → HostingAuth and needs_reconnect; no FETCH_HEAD written.
}

#[test]
fn network_auth_prefers_typed_credentials_and_falls_back_to_accounts() {
    let typed = Credentials::new("https://github.com", "me", "typed").unwrap();
    let urls = vec!["https://github.com/o/r.git".to_owned()];
    assert_eq!(NetworkAuth::new(Some(&typed), &store).resolve(&urls).unwrap().username(), "me");
    assert_eq!(NetworkAuth::new(None, &store).resolve(&urls).unwrap().username(), "x-access-token");
    assert!(NetworkAuth::None.resolve(&urls).is_none());
}
```

- [ ] **Step 5: Write the failing IPC and key tests**

- `commands.test.ts`: each wrapper invokes the exact command with every key: `hosting_list_accounts` `{}`; `hosting_connect` `{ provider: "gitlab", host: null, token: "t" }`; `hosting_disconnect` `{ accountId: "github:github.com:octo" }`; `hosting_repo_context` `{ id: 1 }`; `hosting_list_pull_requests` `{ id: 1, page: 2 }`; `hosting_checkout_pull_request` `{ id: 1, number: 7, reset: false, credentials: null }` (and with credentials passed).
- `errors.test.ts`: `isAppError` accepts each of the nine new kinds.
- `types.test.ts`: type-level samples of `HostingAccount`, `RepoContext`, `PullRequest`, both `CheckoutPrOutcome` arms.
- `opener.test.ts` (mocks `@tauri-apps/plugin-opener`): `openExternal("https://github.com/o/r/pull/1")` calls `openUrl` with it; `http://x`, `javascript:alert(1)`, `file:///etc/passwd` and `not a url` reject with `Only https links can be opened` and never call `openUrl`.
- `index.test.ts`: `openExternal` is exported.
- `keys.test.ts`: the four keys' exact arrays; `queryKeys.pullRequests(1)` does **not** start with `queryKeys.repo(1)` (Review Focus 4).

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cargo test --workspace` (from `src-tauri`) and `npm test`. Expected: compile errors for `hosting_store`, `commands::hosting`, `NetworkAuth`; Vitest failures for the missing wrappers, kinds, keys and `opener.ts`.

- [ ] **Step 7: Implement**

- `hosting_store.rs`: per Interfaces and Global Constraints. A private `#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")] struct AccountRecord { provider, host, username, display_name, avatar_url }` is the file format; `save` follows `RecentStore::save` (tmp + rename, logged failure). `connect`: delete the keychain entry of any account on the same `(provider, host)` (its error aborts the connect), `tokens.set(account.id, token)`, replace or append the entry, save. `KeyringTokenStore`: `Entry::new(KEYRING_SERVICE, key)`, `set_password`, `get_password` (`Error::NoEntry` → `Ok(None)`, then `Token::new`), `delete_credential` (`NoEntry` → `Ok(())`); other errors through `keychain_error`.
- `commands/remote.rs`: `NetworkAuth` as declared; each changed `*_inner` prepares, then runs with `auth.resolve(prepared.urls()).as_ref()`. Commands build `NetworkAuth::new(credentials.as_ref(), &store)` inside the `run_blocking` closure from a cloned `Arc<HostingStore>`. Same for `refs.rs`, `tags.rs`, and `repo.rs` (`clone_repo_inner` resolves against `[url]`).
- `commands/hosting.rs`:
  - `connect`: `Token::new(token)` → `validate_host` → `hosting::current_user` → `Account::new` → `store.connect`.
  - `repo_context`: `with_session(.., |s| s.list_remotes())`, find `origin`, `detect(&fetch_url, &store.hosts())`, then attach `store.find(provider, host)`.
  - `list_pull_requests`: context (`None` → `NoHostingAccount`), account and token (`None` → `NoHostingAccount`), then `hosting::list_pull_requests(t, &repo, &token, page.max(1))`.
  - `checkout`: same lookups, `get_pull_request`, `checkout_plan`. `TrackBranch` → `prepare_fetch_remote("origin")`, run with the resolved auth, then `checkout_remote_branch("origin", &branch)` → `CheckedOut { branch }`. `FetchHead` → `prepare_ref_fetch(&source, &refspec)`, run, then `checkout_fetch_head(&ref_fetch, number, reset)` (keep the prepared `RefFetch` and pass it into the second `with_session`). Each prepare and each checkout step is its own `with_session` call; the fetch runs with the lock released. Never hold the accounts `Mutex` across keychain I/O (`token()`, `credentials_for`): copy the account out, drop the guard, then call the token store, so a Secret Service unlock prompt cannot stall other operations. Never glob-import `NetworkAuth::*` (its `None` shadows `Option::None`).
  - Every provider call goes through one private helper `fn with_token<T>(store, account, f: impl FnOnce(&Token) -> Result<T, GitError>) -> Result<T, AppError>`, which marks `needs_reconnect` when `f` returns `HostingAuth`.
  - The six Tauri commands wrap these in `run_blocking` with cloned `Arc`s; `hosting_connect` takes `token: String`, `hosting_checkout_pull_request` takes `credentials: Option<CredentialsArg>` through `credentials_from_arg`.
- `lib.rs` wiring as listed under Files.
- Front end: the types, the nine kinds in `KINDS`, the six wrappers, `opener.ts` (`import { openUrl } from "@tauri-apps/plugin-opener"`), the keys.

- [ ] **Step 8: Run all checks**

Run (from `src-tauri`): `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`; then from the root: `npm run test:coverage && npm run lint && npm run typecheck && npx prettier --check .`. Expected: all green; coverage 100 % (the IPC files are fully exercised by their tests).

- [ ] **Step 9: Commit**

```bash
git add src-tauri src/lib
git commit -m "feat(app): GR-13a hosting accounts, keychain, commands and account-token git auth"
```

---

### Task 3: Front end — accounts, connect dialog, Pull requests panel, checkout, mounts

**Files:**

- Create: `src/features/hosting/hostingCopy.ts`, `useHostingAccounts.ts`, `useAccountActions.ts`, `useRepoContext.ts`, `usePullRequests.ts`, `usePrActions.ts`, `PullRequestsPanel.tsx` + `.module.css`, `PullRequestRow.tsx` + `.module.css`, `AccountsDialog.tsx` + `.module.css`, `ConnectAccountDialog.tsx` + `.module.css`
- Modify: `src/lib/store/layoutPrefs.ts` (`pullRequestsCollapsed: false`, `setPullRequestsCollapsed`, persisted in `partialize`), `src/features/remotes/useNetworkAction.ts` (`onSettled` also invalidates `queryKeys.pullRequests(repoId)`), `src/app/RepoPane.tsx` (`<PullRequestsPanel repoId={tab.id} />` after `<TagsPanel …/>`), `src/features/repo/StartScreen.tsx` (`Hosting accounts…` button after `Initialize repository`, owning an `AccountsDialog`)
- Test (test role): new `src/test/hostingFixtures.ts` and a `*.test.ts(x)` beside each new file; extend `src/lib/store/layoutPrefs.test.ts`, `src/features/remotes/useNetworkAction.test.tsx`, `src/app/RepoPane.test.tsx` (mock `hostingRepoContext` → `null` by default, plus one case where the panel renders), `src/features/repo/StartScreen.test.tsx`, `src/styles/focusTargets.test.ts` (`ALLOWED_WITHOUT_ATTRIBUTE` gains `"src/features/hosting/AccountsDialog.tsx": 1` and `"src/features/hosting/ConnectAccountDialog.tsx": 1`)

**Interfaces:**

- Consumes: Task 2's wrappers, types, kinds and keys; `useNetworkAction(repoId)` (`run`, `pending`, `prompt`), `CredentialDialog`, `NetworkError`, `networkMessage`, `ConfirmDialog`, `ContextMenu` / `MenuItem`, `useRestoreFocus`, `copyText`, `toAppError`, `useLayoutPrefs`, `RepoError`. `PullRequestsPanel.module.css` **mirrors** the TagsPanel section rules (`root`, `header`, `heading`, `toggle`, `empty`, `list`) as StashesPanel.module.css does; no feature imports another feature's CSS module.
- Produces:

```ts
// hostingCopy.ts
export const PROVIDER_LABEL: Record<HostingProvider, string>; // GitHub, GitLab, Bitbucket
export const DEFAULT_HOST: Record<HostingProvider, string>;
export const SCOPE_HINT: Record<HostingProvider, string>;
export function tokenPageUrl(provider: HostingProvider, host: string): string;
export function hostingErrorText(error: AppError, provider: HostingProvider): string;
/** hosting kinds → { title: hostingErrorText, hint: null, action: null, details: null }; anything else → networkMessage(error). */
export function hostingMessage(error: AppError, provider: HostingProvider): NetworkMessage;
export function prCountLabel(count: number | null, more: boolean): string;
export const RECONNECT_TEXT = "Token expired or revoked — reconnect";
// useHostingAccounts.ts
export function useHostingAccounts(): {
  accounts: HostingAccount[] | undefined;
  error: AppError | null;
  refetch(): void;
};
/** Invalidates ["hosting"] and every ["repo", *, "hostingContext"]. */
export function invalidateHosting(queryClient: QueryClient): Promise<void>;
// useAccountActions.ts — each resolves with the AppError or null, never rejects
export function useAccountActions(): {
  connect(
    provider: HostingProvider,
    host: string | null,
    token: string,
  ): Promise<{ account: HostingAccount } | { error: AppError }>;
  disconnect(accountId: string): Promise<AppError | null>;
  pending: boolean;
};
// useRepoContext.ts
export function useRepoContext(repoId: RepoId): {
  context: RepoContext | null | undefined;
  error: AppError | null;
};
// usePullRequests.ts
export function usePullRequests(
  repoId: RepoId,
  enabled: boolean,
): {
  pullRequests: PullRequest[] | undefined;
  error: AppError | null;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  refetch(): void;
  loadMore(): void;
};
// usePrActions.ts
export interface ResetRequest {
  pr: PullRequest;
  branch: string;
}
export function usePrActions(repoId: RepoId): {
  checkout(pr: PullRequest, reset?: boolean): Promise<void>;
  open(pr: PullRequest): void;
  copyLink(pr: PullRequest): void;
  /** Set when checkout answered needsReset; the panel confirms, then calls checkout(pr, true). */
  resetRequest: ResetRequest | null;
  clearResetRequest(): void;
  status: string | null; // "Checked out ‹branch›." — built from outcome.branch (a fork PR lands on pr/<n>), never pr.sourceBranch
  error: AppError | null;
  clearError(): void;
  pending: boolean;
  prompt: CredentialPrompt | null;
};
// components
export function PullRequestsPanel(props: { repoId: RepoId }): React.JSX.Element | null;
export function PullRequestRow(props: {
  pr: PullRequest;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
}): React.JSX.Element;
export interface AccountsPreset {
  provider: HostingProvider;
  host: string;
}
export function AccountsDialog(props: {
  open: boolean;
  onClose(): void;
  preset?: AccountsPreset;
  fallbackFocus?: RefObject<HTMLElement | null>;
}): React.JSX.Element | null;
export function ConnectAccountDialog(props: {
  preset?: AccountsPreset;
  accounts: HostingAccount[];
  onDone(account: HostingAccount): void;
  onCancel(): void;
}): React.JSX.Element;
// layoutPrefs: pullRequestsCollapsed: boolean (default false); setPullRequestsCollapsed(collapsed: boolean): void
```

- [ ] **Step 1: Write the fixtures** (`src/test/hostingFixtures.ts`)

```ts
export const hostingAccount = (over: Partial<HostingAccount> = {}): HostingAccount => ({
  id: "github:github.com:octo", provider: "github", host: "github.com", username: "octo",
  displayName: "Octo Cat", avatarUrl: null, needsReconnect: false, ...over,
});
export const repoContext = (account: HostingAccount | null = hostingAccount()): RepoContext => ({
  repo: { provider: "github", host: "github.com", namespace: "gorlox", name: "test-repo" }, account,
});
export const pullRequest = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number, title: `PR ${number}`, author: "alice", sourceBranch: `feature-${number}`, targetBranch: "main",
  fromFork: false, forkCloneUrl: null, draft: false, ciState: "none", updatedAt: 1792497600,
  webUrl: `https://github.com/gorlox/test-repo/pull/${number}`, ...over,
});
export const hostingError = (kind: AppErrorKind, message = "provider said no"): AppError => ({ kind, message });
/** n pull requests numbered from `start` down. */
export const pullRequests = (n: number, start = 100): PullRequest[];
```

- [ ] **Step 2: Write the failing hook and copy tests**

- `hostingCopy.test.ts`: every Global Constraints error string per kind and provider (e.g. `hostingErrorText(hostingError("hostingNotFound"), "gitlab")` → `This repository isn't visible to your GitLab account.`); `default` → `error.message`; `hostingMessage` of `networkFailed` equals `networkMessage` of it; `tokenPageUrl("github", "ghe.corp")` → `https://ghe.corp/settings/personal-access-tokens/new`, `("gitlab", "gitlab.com")` → `https://gitlab.com/-/user_settings/personal_access_tokens`, `("bitbucket", "bitbucket.org")` → the Atlassian URL; `prCountLabel(null, false)` → `Pull requests`, `(3, false)` → `Pull requests (3)`, `(50, true)` → `Pull requests (50+)`.
- `useHostingAccounts.test.tsx`: loads `hostingListAccounts`; an error becomes an `AppError` via `toAppError`; `invalidateHosting` refetches `["hosting","accounts"]`, `["hosting","pullRequests",1]` and `["repo",1,"hostingContext"]` but not `["repo",1,"status"]`.
- `useAccountActions.test.tsx`: `connect` resolves `{ account }` and calls `hostingConnect("github", null, "t")`; a rejection resolves `{ error }` with the `AppError`; after it settles, `queryClient.getMutationCache().getAll()` contains no mutation whose variables or state hold `"t"` (`JSON.stringify` of the cache does not include the token); success and failure both call `invalidateHosting`; `disconnect` resolves `null` / the error; `pending` is true while either runs.
- `useRepoContext.test.tsx`: key `["repo", 1, "hostingContext"]`; `null` passes through; errors map through `toAppError`; a `["repo", 1]` invalidation refetches it.
- `usePullRequests.test.tsx`: not called while `enabled` is false; page 1 on enable; `hasMore` is true when the last page has 50 items and `loadMore` requests page 2 and appends it; `hasMore` false for a page under 50; `refetch` re-requests; errors map through `toAppError`; **`does not refetch when the repo prefix is invalidated`** (invalidate `queryKeys.repo(1)`, assert `hostingListPullRequests` was called once); no refetch on window focus.
- `usePrActions.test.tsx`: `checkout(pr)` runs through `useNetworkAction` and calls `hostingCheckoutPullRequest(1, 7, false, null)`, then sets `status` `Checked out feature-7.` (from the outcome's `branch`); a fork outcome `{ kind: "checkedOut", branch: "pr/7" }` gives `Checked out pr/7.`; `needsReset` sets `resetRequest { pr, branch: "pr/7" }` and no status; `checkout(pr, true)` sends `reset: true` and clears `resetRequest`; a `networkFailed` with `httpsAuthRequired` and an origin raises `prompt`, and submitting retries with the typed credentials; a failure sets `error`; a cancelled prompt sets nothing; `open(pr)` calls `openExternal(pr.webUrl)` and a rejection becomes `error`; `copyLink` calls `copyText(pr.webUrl)` and a rejection becomes `error`; `clearError` and `clearResetRequest` reset.
- `useNetworkAction.test.tsx` (extend): a settled attempt invalidates `["hosting", "pullRequests", 1]` as well as `["repo", 1]`.
- `layoutPrefs.test.ts` (extend): `pullRequestsCollapsed` defaults to false, toggles, and is persisted.

- [ ] **Step 3: Write the failing component tests**

`PullRequestRow.test.tsx`:

- renders `#12`, the title, `alice · feature-12 → main`; `Draft` only when `draft`; `CI passing` / `CI failing` / `CI pending` for those states and no CI text for `none`;
- the open button (name `Open #12 in browser`) calls `onOpen` and nothing else;
- right-click calls `onContextMenu(clientX, clientY)` and prevents the default; Shift+F10 and the ContextMenu key on the row call it with the row rect's `left` / `bottom`; Enter and a click on the row call neither callback;
- the title renders as text: `pullRequest(1, { title: "<img src=x onerror=alert(1)>" })` puts no `img` in the DOM.

`PullRequestsPanel.test.tsx` (mocks `../../lib/ipc`):

- renders nothing while the context loads, when it is `null`, and when it errors;
- no account: `Connect your GitHub account to see pull requests` and `Connect…`, which opens `Hosting accounts` with the connect form preset to GitHub / `github.com`; `hostingListPullRequests` is never called;
- `needsReconnect` account, or a `hostingAuth` list error: `Token expired or revoked — reconnect` and `Reconnect` (opens the preset connect form);
- list: heading `Pull requests (2)` after load, `Loading pull requests…` before; `No open pull requests` for `[]`; a 50-item page shows `Pull requests (50+)` and `Show more`, which loads page 2 (`Loading…` while it runs);
- the heading toggle collapses (sets `pullRequestsCollapsed`, `aria-expanded` false, the list is gone) and fetching starts only when expanded;
- `Refresh pull requests` refetches and is disabled while fetching;
- a `hostingNotFound` / `hostingUnreachable` / `hostingRateLimited` list error shows its `hostingErrorText` in a `NetworkError` (role `alert`) with `Dismiss`, which refetches;
- context menu `Check out` calls `hostingCheckoutPullRequest`; on `checkedOut` the status `Checked out feature-12.` shows; on `needsReset` a `Reset pr/9?` dialog with the copy from Global Constraints opens, and `Reset` calls again with `reset: true`, while `Cancel` closes it without a call; `Open in browser` and the row's open button call `openExternal` with the PR's `webUrl`; `Copy link` calls `copyText` with it; a checkout `networkFailed` shows `networkMessage`'s title; an `httpsAuthRequired` failure shows the `CredentialDialog`;
- menu items are disabled while an action is pending; `aria-busy` is set on the section.

`AccountsDialog.test.tsx`:

- closed → nothing; open → title `Hosting accounts`, `No accounts connected` for `[]`;
- a row shows the initial `O`, `Octo Cat`, `octo on github.com` and no `img` element; `needsReconnect` adds `Token expired or revoked — reconnect` and a `Reconnect octo on github.com` button that opens the connect form preset to that provider and host;
- `Disconnect octo on github.com` opens `Disconnect octo from github.com?` / `The token is removed from the system keychain.`; confirming calls `hostingDisconnect("github:github.com:octo")`; an error shows its `hostingErrorText`;
- `Connect account…` shows `ConnectAccountDialog`; finishing returns to the list, which refetches; `preset` opens straight into the connect form;
- Escape and `Close` call `onClose`; focus returns to the opener (`useRestoreFocus`), else to `fallbackFocus`.

`ConnectAccountDialog.test.tsx`:

- `GitHub` is checked by default (or the preset's provider); `Host` has placeholder `github.com` and the hint `Leave empty for github.com.`; choosing `Bitbucket` hides `Host` and shows the Bitbucket scope hint; each provider's `SCOPE_HINT` shows for it;
- the token field has `type="password"` and `autocomplete="off"`; `Connect` is disabled until the token is non-empty;
- submit calls `hostingConnect("gitlab", "git.corp", "glpat-x")` with the host trimmed (empty → `null`), shows `Connecting…`, and the token input is empty at once, before the call resolves; on success `onDone(account)` runs;
- with an existing account on the same provider and resolved host, submit first asks `Replace octo on github.com?` (body and `Replace` as in Global Constraints); `Cancel` keeps the form (token still filled) and calls nothing; `Replace` submits;
- a failure (`hostingAuth`, `invalidHostingHost`, `keychainUnavailable`, `invalidToken`) shows its text in `role="alert"` and leaves the token empty;
- `Create a token` calls `openExternal(tokenPageUrl(provider, host || default))` (GitLab with host `git.corp` → `https://git.corp/-/user_settings/personal_access_tokens`); a rejection shows its message;
- `Cancel` and Escape call `onCancel`.

`StartScreen.test.tsx` (extend): a `Hosting accounts…` button opens `Hosting accounts`; closing it returns focus to the button.

`RepoPane.test.tsx` (extend): with `hostingRepoContext` resolving `repoContext(null)`, a `Pull requests` section appears after `Tags`; with `null`, there is none.

- [ ] **Step 4: Run them to verify they fail**

Run: `npm test`. Expected: failures for the missing modules and the unmet assertions in the extended tests.

- [ ] **Step 5: Implement**

- `useHostingAccounts`, `useRepoContext`: `useQuery` with the Task 2 keys, `toAppError` in `queryFn` (the `useTags` shape).
- `useAccountActions`: one `useMutation` with `mutationKey: mutationKeys.hostingAccount`, `gcTime: 0`, whose variable is an opaque thunk (`() => Promise<unknown>`), `.finally(reset)` after each call, and `onSettled: () => invalidateHosting(queryClient)` (the `useNetworkAction` pattern; the token never becomes mutation data).
- `usePullRequests`: `useInfiniteQuery` with key `queryKeys.pullRequests(repoId)`, `initialPageParam: 1`, `getNextPageParam: (last, all) => (last.length === 50 ? all.length + 1 : undefined)`, `enabled`, `refetchOnWindowFocus: false`; `pullRequests` = the flattened pages.
- `usePrActions`: `useNetworkAction(repoId).run((c) => hostingCheckoutPullRequest(repoId, pr.number, reset, c))`, then handle the outcome; `open` / `copyLink` catch into `error`.
- `PullRequestsPanel`: `useRepoContext`; returns `null` unless the context is non-null. Copy the `TagsPanel` structure: heading toggle, Refresh button in the header, body states in the order no account → reconnect → error → loading → empty → list (+ `Show more`), `ContextMenu` with `fallbackFocus` on the heading, `ConfirmDialog` for the reset, status line `role="status"`, `AccountsDialog` with the preset, and `CredentialDialog` last. `enabled` for the list query = expanded and the account is present and not `needsReconnect`.
- `PullRequestRow`: the `TagRow` shape (an `li` around a `button` with no `onClick`, the Shift+F10 / ContextMenu handler) plus a sibling open button with the `↗` glyph, the draft and CI badges.
- `AccountsDialog`, `ConnectAccountDialog`: the `CredentialDialog` / `RemotesDialog` modal pattern (backdrop, `role="dialog"`, `aria-modal`, `tabIndex={-1}` box, `useRestoreFocus`, Escape). Nested dialogs follow RemotesDialog.tsx: the AccountsDialog box stays mounted and becomes `inert` while ConnectAccountDialog, the Disconnect ConfirmDialog or the Replace ConfirmDialog is open, and those render as siblings **after** the box, never inside it (Escape on the inner dialog must not close the outer one; the mounted box keeps the `Connect account…` button for focus restoration). PullRequestsPanel calls every hook before its `return null`; the row button without onClick gets a `title` so it does not announce as a dead control. The connect form keeps the token in component state only and clears it in the submit handler before awaiting `connect`.
- `layoutPrefs`, `useNetworkAction`, `RepoPane`, `StartScreen`: the one-line changes listed under Files.

- [ ] **Step 6: Run the full front-end gate**

Run: `npm run test:coverage && npm run lint && npm run typecheck && npx prettier --check .`. Expected: all green; the "All files" row reads 100 for % Stmts, % Branch, % Funcs and % Lines.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat(ui): GR-13a hosting accounts dialog and pull requests panel"
```

---

## Execution: batched agent cycles

Work on the branch `feature/gr-13a-hosting` (already cut from `main`, holding the spec).

| Cycle | Tasks                                                                                   | architect + tdd-tester | developer | tdd-tester-coverage + code-reviewer |
| ----- | --------------------------------------------------------------------------------------- | ---------------------- | --------- | ----------------------------------- |
| 1     | T1 (core hosting domain, PR-checkout git work, account credentials, `AppError` mapping) | 1 + 1                  | 1         | 1 + 1                               |
| 2     | T2 (store, keyring, commands, `NetworkAuth`, IPC, keys)                                 | 1 + 1                  | 1         | 1 + 1                               |
| 3     | T3 (hooks, panel, dialogs, mounts)                                                      | 1 + 1                  | 1         | 1 + 1                               |

- 5 dispatches per cycle × 3 cycles = 15, plus one final `architect` sign-off on the whole branch = **16 dispatches**. A reviewer's BLOCKING issues loop back to `developer` and add dispatches.
- Models: `architect` and `developer` **opus**; `tdd-tester`, `tdd-tester-coverage` and `code-reviewer` **sonnet**. Pass the model explicitly on every dispatch. Name agents with a `gr13a-` prefix (for example `gr13a-c1-developer`) so `SendMessage` never resumes an older agent of the same name; address follow-ups by agent id.
- Each cycle's architect validates file placement before its files are created: in cycle 1 that covers `hosting/` and `remote/pr_checkout.rs`; in cycle 2, `hosting_store.rs` and `commands/hosting.rs`; in cycle 3, `features/hosting/`.
- Cycle 2 starts after cycle 1's developer has committed; Task 1's Interfaces fix every Rust name it needs. Cycle 3 depends only on Task 2's IPC names. Cycle 3's tester writes `src/test/hostingFixtures.ts` before any other test.
- The test role owns every edit to existing test files, fixtures and helpers: both crates' `tests/common/mod.rs`, `tests/fixtures/hosting/*`, the core `network_cli.rs`, `network_classify.rs` and `clone.rs`, the app `error.rs`, `remote_commands.rs`, `refs_commands.rs`, `tag_commands.rs`, `commands.rs` and `stash_commands.rs`, the IPC and keys tests, `useNetworkAction.test.tsx`, `layoutPrefs.test.ts`, `RepoPane.test.tsx`, `StartScreen.test.tsx`, `focusTargets.test.ts`, and `src/test/hostingFixtures.ts`. The developer must not touch them.
- Commit messages end with the attribution lines from the session's system reminder.
- The user usually asks for every architect follow-up (BLOCKING or not) to be fixed before merge. Plan a short fix loop after the final architect review rather than listing follow-ups as deferred.

## Verification gate

Work is not done until all three of the following are green:

1. **Green tests and static checks.** From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, and `cargo tree -i openssl-sys` printing nothing for either crate. From the repo root: `npm run test:coverage` (the "All files" row reads 100 for % Stmts, % Branch, % Funcs and % Lines), `npm run lint`, `npm run typecheck`, `npx prettier --check .`.
2. **Full coverage confirmed by `tdd-tester-coverage`** for every cycle.
3. **Final `architect` approval** of file placement, design and conventions across the branch.

Acceptance walk (spec §8): the running app via `npm run tauri dev`, driven through the WebKit remote inspector as in earlier walks, against the real GitHub repo `gorlox/test-repo` cloned over HTTPS. The user supplies a fine-grained GitHub token and opens one PR from a branch of the repo and one from a fork, if a fork is available. GitLab and Bitbucket are walked only if the user has accounts; otherwise the walk notes that they rest on the fixture tests in `hosting_providers.rs`.

1. Start screen → `Hosting accounts…` → `No accounts connected` → `Connect account…` → GitHub, paste the token → `Connect`: the token field empties at once, the account row shows `octo on github.com`. `secret-tool search service git-real` lists `github:github.com:<user>`; `hosting_accounts.json` holds no token.
2. A wrong token → `GitHub rejected the token…`; nothing is stored.
3. Open `gorlox/test-repo`: `Pull requests (n)` appears under Tags with the open PRs, newest first; draft badges match GitHub.
4. `Open in browser` and the row icon open the PR page; `Copy link` puts its URL on the clipboard.
5. `Check out` the same-repo PR → the header shows its branch, tracking `origin/<branch>`. `Check out` the fork PR → `pr/<n>`; the local branch of the same name, if any, is untouched.
6. Commit locally on `pr/<n>`, push a new commit to the fork's PR, then `Check out` again → `Reset pr/<n>?`; `Reset` moves it.
7. Fetch, pull and push on the HTTPS clone complete without a credential prompt, and `git config --get-all credential.helper` storage (if any) gained no entry for the account token.
8. Disconnect → confirm → the account and the keychain entry are gone; the panel shows `Connect your GitHub account to see pull requests`, and `Connect…` opens the preset form.
9. Revoke the token on GitHub while connected → Refresh → `Token expired or revoked — reconnect`; the Accounts dialog shows the same; reconnecting clears it.
10. A repo with a local-path `origin` and a repo without `origin`: no Pull requests section; every GR-12 action still works.
11. Stop the Secret Service (`systemctl --user stop gnome-keyring-daemon` or the COSMIC equivalent), then Connect → the keychain message, and nothing is written. Fetch still works (with a prompt on HTTPS auth).

## After the last task

- Merge `--no-ff` into `main` and delete the branch. Post a Jira comment on GR-13 saying slice 13a is done (merge commit, ACs 1, 2, 3 and 5 met, the walk results, follow-ups) and that slices 13b (create PR, issues, link issue) and 13c (clone repo browser) are pending; GR-13 stays open. Add `gr13a-status.md` to memory with its MEMORY.md line: merge commit, date, and follow-ups (CI summary per provider, showing the rate-limit reset time, avatars through a Rust image proxy or a CSP decision, marking `needsReconnect` when git rejects an account token, a PR filter, the fork-as-origin layout, OAuth device flow).
