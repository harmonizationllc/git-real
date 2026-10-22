# GR-12 Remotes Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a toolbar in the repository header, or with Ctrl/Cmd+Shift+F/L/P, the user fetches, pulls (merge or rebase) and pushes the current branch. A push without an upstream asks where to publish and sets the upstream; force push uses `--force-with-lease` behind a confirmation. The header shows the upstream with ahead/behind counts. A Remotes dialog adds, edits and removes remotes (also reachable from the Branches panel's remote headings). SSH uses the system `ssh`; HTTPS uses the user's credential helper, and when it has nothing the app asks for a username and token, retries, and hands working credentials to the helper. Every network or auth failure says what to do next. This closes GR-12.

**Architecture:** All network work runs the git CLI through one runner, `remote::run_network`, which adds the credential arguments, classifies a failure's stderr into a `NetworkErrorKind`, and reports `GitError::NetworkFailed` (replacing `PushFailed`, whose callers — tag push, remote tag delete, remote branch delete — move over). Credentials never reach argv: a one-shot inline helper, scoped to the failing origin with `credential.<origin>.helper`, reads them from two environment variables; after a successful run they are stored with `git credential approve`. Fetch, pull and push follow the GR-7 prepare-then-run pattern: `prepare_fetch` / `prepare_pull` / `prepare_push` validate under the session lock and return owned `Fetch` / `Pull` / `Push` values that run after the lock is released. Pull is `git fetch <remote>` followed, under the lock again, by the existing `can_fast_forward` + `merge_branch` or `rebase_onto`, so conflicts reuse the GR-10 banner. Remote CRUD is git2 (`remote`, `remote_rename`, `remote_set_url`, `remote_set_pushurl`, `remote_delete`). The app layer adds `commands/remote.rs`, eight commands, eight error kinds and an optional `network` payload on `AppError`. The front end adds `features/remotes/` (the `useNetworkAction` gate with its `CredentialDialog`, `networkMessage`, `NetworkError`, `SetUpstreamDialog`, `SyncToolbar`, `useSyncActions`, `RemotesDialog`), moves tag push/delete and remote branch delete onto the gate, and gives remote group headings a context menu.

**Tech Stack:** Rust 2024 + git2 0.20.4 (`default-features = false`), system git CLI (behaviour verified with git 2.43.0, `/bin/sh` = dash), Tauri 2, React 19 + TypeScript, TanStack Query 5, zustand, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-22-gr12-remotes-sync-design.md`

## Global Constraints

- Tests come first and are written by the test role. The developer role never edits test files, fixtures or helpers: both crates' `tests/common/mod.rs`, `tests/fixtures/**`, `src/test/*` (CLAUDE.md).
- Only `src/lib/ipc` imports `@tauri-apps/api/*`. `git2` stays `default-features = false`. No direct `tokio`. Blocking work runs through `run_blocking`. `git-real-core` has no Tauri dependency. Network, credentials → git CLI; remote config and refs → git2 (CLAUDE.md hybrid rule).
- **Secrets.** A token (and username) never appears in argv, in a `Debug` or `Display` text, in an `AppError`, or in a log. `Credentials` has private fields, a hand-written `Debug` printing `token: "***"`, and no public token accessor. The only places a token goes are the env var `GR_TOKEN` of one git run and the stdin of `git credential approve`.
- argv shapes, everything after `-C <workdir>`, each a separate element:
  - fetch: `fetch --all`
  - pull's fetch: `fetch <remote>`; then the existing `merge --ff-only <upstream>` / `merge --no-ff --no-edit <upstream>` / `rebase <upstream>` (`<upstream>` short, e.g. `origin/main`)
  - push: `push [-u] [--force-with-lease=refs/heads/<branch>:<oid>] <remote> HEAD:refs/heads/<branch>`; `-u` only for `SetUpstream`; `<oid>` is the full hex of the remote-tracking ref read at prepare time, or empty (`refs/heads/<branch>:`) when that ref does not exist
  - tag push / remote tag delete / remote branch delete: unchanged (`push <remote> refs/tags/<name>`, `push <remote> --delete tags/<name>`, `push <remote> --delete heads/<name>`)
  - with credentials, `-c credential.<origin>.helper= -c credential.<origin>.helper=<HELPER>` go **between `-C <workdir>` and the subcommand**, and the run's env gains `GR_USERNAME` and `GR_TOKEN`
  - `HELPER` (verbatim): `!f() { test "$1" = get || return 0; printf '%s\n' "username=$GR_USERNAME" "password=$GR_TOKEN"; }; f`
  - approve: `credential approve` with stdin `url=<url>\nusername=<username>\npassword=<token>\n\n`; its exit status and spawn errors are ignored
- Network failure mapping (`run_network`): non-zero exit → `NetworkFailed { verb, kind: classify(stderr), https, origin, code, stdout, stderr }`. `verb` is `"fetch"` (Fetch), `"pull"` (Pull's fetch), `"push"` (Push, tag push, remote tag delete, remote branch delete). `https` is true when any URL the operation uses starts with `http://` or `https://` (ASCII case-insensitive). The URLs used are git2's `Remote::url()` (fetch) and `Remote::pushurl()` falling back to `url()` (push), which already apply `url.<base>.insteadOf` and `pushInsteadOf` (verified). `origin` is `auth_origin(stderr)` when `kind` is `HttpsAuthRequired` or `HttpsAuthRejected`, else `None`. After a **successful** run with credentials, every used URL whose `origin_of` equals the credentials' origin is approved, in the operation's URL order.
- `classify(stderr)`, first match wins: `HttpsAuthRequired` ("could not read Username", "could not read Password", "terminal prompts disabled"); `HttpsAuthRejected` ("Authentication failed for", "returned error: 401", "returned error: 403"); `SshAuthFailed` ("Permission denied (publickey"); `HostKeyUnverified` ("Host key verification failed"); `HostUnreachable` ("Could not resolve host", "Connection refused", "Connection timed out", "Network is unreachable", "Failed to connect to", "Couldn't connect to server"); `RepoNotFound` ("Repository not found", "does not appear to be a git repository", or a line starting `fatal: repository '` and ending `' not found`); `PushRejectedNonFastForward` ("[rejected]" and ("(fetch first)" or "(non-fast-forward)")); `LeaseStale` ("[rejected]" and "(stale info)"); else `Other`. Case-sensitive substring tests.
- `auth_origin(stderr)`: the first line starting with `fatal: ` that contains a `'`-quoted `http://` or `https://` URL; the result is `origin_of(that URL)`. Lines from the server (`remote: …`) never count. `origin_of(url)`: lower-cased scheme `http`/`https` only, userinfo and path dropped, `scheme://host[:port]`, and `None` unless the result passes the origin rule.
- Origin rule (`Credentials::new` and `origin_of`): `http://` or `https://` (lower case), then a host of ASCII letters, digits, `.` and `-` (non-empty) or a bracketed IPv6 literal of hex digits, `:` and `.`, then optionally `:` and 1–5 digits, and nothing else. Username and token: non-empty, no `\n`, `\r` or `\0`. Anything else is `InvalidCredentials`.
- Checks, in order:
  - `prepare_fetch()`: no remotes → `NoRemotes`; then `git_cli::locate()`.
  - `prepare_pull()`: `ensure_clean` → `OperationInProgress`; HEAD unborn → `UnbornHead`; HEAD detached → `DetachedHead`; no upstream, an upstream on remote `.`, or `branch.<b>.merge` not under `refs/heads/` → `NoUpstream`; the upstream's remote fails `ensure_remote` → `RemoteNotFound`.
  - `prepare_push(target, force)`: HEAD unborn → `UnbornHead`; detached → `DetachedHead`; `Upstream` without a usable upstream (as for pull) → `NoUpstream`; `SetUpstream { remote, branch }`: `ensure_remote(remote)` → `RemoteNotFound` (leading `-` included), then `validate_branch_name(branch)` → `InvalidBranchName`.
  - `add_remote(name, url, push_url)`: remote-name rule → `InvalidRemoteName`; exists → `RemoteExists`; `url`, then `push_url` if `Some`, URL rule → `InvalidRemoteUrl`.
  - `update_remote(name, new_name, url, push_url)`: `ensure_remote(name)` → `RemoteNotFound`; `new_name` rule → `InvalidRemoteName`; URL rule on `url`, then `push_url` → `InvalidRemoteUrl`; `new_name != name` and `new_name` exists → `RemoteExists`.
  - `remove_remote(name)`: `ensure_remote(name)` → `RemoteNotFound`.
- Remote-name rule: `!name.contains('\0') && !name.starts_with('-') && git2::Remote::is_valid_name(name)` (git2 accepts `-x` and panics on a NUL byte — verified). URL rule: `!url.trim().is_empty() && !url.starts_with('-') && !url.contains(['\n', '\r', '\0'])`.
- `pull_default_mode()`: `branch.<head>.rebase` when HEAD is on a branch and the key is set, else `pull.rebase`, else `Merge`. A value git2 `get_bool` parses (`true`/`yes`/`on`/`1` and their negatives) maps true → `Rebase`, false → `Merge`; otherwise `merges`, `m`, `interactive`, `i` → `Rebase`, anything else → `Merge`.
- `integrate_pull(pull, mode)`: `Rebase` → `rebase_onto(upstream)`; `Merge` → `can_fast_forward(upstream)`: `UpToDate` → `Ok(Completed)` without running git, `Possible` → `merge_branch(upstream, FastForward)`, `Diverged` → `merge_branch(upstream, Merge)`.
- `list_remotes()`: every `repo.remotes()` name (UTF-8), sorted by name; `fetch_url` and `push_url` are the **raw config values** `remote.<name>.url` / `remote.<name>.pushurl` (what the user typed, not rewritten), `push_url` `None` when unset.
- New `GitError` (Display text), after `TagNotFound`; `PushFailed` is **removed**:
  - `NoRemotes` "this repository has no remotes"
  - `NoUpstream` "the current branch has no upstream branch"
  - `DetachedHead` "HEAD is not on a branch"
  - `InvalidRemoteName(String)` "{0} is not a valid remote name"
  - `InvalidRemoteUrl(String)` "{0:?} is not a valid remote URL"
  - `RemoteExists(String)` "a remote named {0} already exists"
  - `InvalidCredentials` "the credentials must name an http(s) origin and contain no line breaks"
  - `NetworkFailed { verb: &'static str, kind: NetworkErrorKind, https: bool, origin: Option<String>, code: Option<i32>, stdout: String, stderr: String }` "git {verb} failed (exit code {code:?}): {stderr}"
- New `AppErrorKind` / TS kinds: `networkFailed`, `noRemotes`, `noUpstream`, `detachedHead`, `invalidRemoteName`, `invalidRemoteUrl`, `remoteExists`, `invalidCredentials`; `pushFailed` removed. `AppError` gains `network: Option<NetworkInfo>`, serialized only when `Some` (`#[serde(skip_serializing_if = "Option::is_none")]`), so every existing payload stays `{ kind, message }`. `NetworkInfo { verb: String, kind: NetworkErrorKind, https: bool, origin: Option<String> }` (camelCase). A `NetworkFailed` message is `cli_failure_message(verb, code, stdout, stderr)` (stderr trimmed, else stdout, else "git <verb> failed with exit code N" / "… was terminated by a signal"), exactly as `PushFailed` was.
- Wire values (camelCase): `NetworkErrorKind` `httpsAuthRequired | httpsAuthRejected | sshAuthFailed | hostKeyUnverified | hostUnreachable | repoNotFound | pushRejectedNonFastForward | leaseStale | other`; `PullMode` `"merge" | "rebase"`; `PushTarget` `{ "kind": "upstream" } | { "kind": "setUpstream", "remote": …, "branch": … }`; `RemoteInfo` `{ name, fetchUrl, pushUrl }`; `Credentials` (deserialize only) `{ origin, username, token }`.
- Tauri commands (JS args camelCase; every command takes `id` like the existing ones): `fetch {id, credentials}` → `void`; `pull_default_mode {id}` → `PullMode`; `pull {id, mode, credentials}` → `OperationOutcome`; `push {id, target, force, credentials}` → `void`; `list_remotes {id}` → `RemoteInfo[]`; `add_remote {id, name, url, pushUrl}`; `update_remote {id, name, newName, url, pushUrl}`; `remove_remote {id, name}`. `push_tag`, `delete_remote_tag` and `delete_remote_branch` gain `credentials`. `credentials` and `pushUrl` are `null` when absent.
- TS wrappers (`commands.ts`): `fetchAll(id, credentials = null)` (not `fetch`, which would shadow the global), `pullDefaultMode(id)`, `pull(id, mode, credentials = null)`, `push(id, target, force, credentials = null)`, `listRemotes(id)`, `addRemote(id, name, url, pushUrl)`, `updateRemote(id, name, newName, url, pushUrl)`, `removeRemote(id, name)`; `pushTag`, `deleteRemoteTag`, `deleteRemoteBranch` gain a last `credentials: Credentials | null = null`. Every wrapper sends every key, `null` included.
- Query keys `queryKeys.remotes(id) = ["repo", id, "remotes"]`, `queryKeys.pullMode(id) = ["repo", id, "pullMode"]`; mutation key `mutationKeys.network(id) = ["network", id]`. Every network attempt and every remote add/update/remove invalidates `queryKeys.repo(id)` on settle (success and failure), which covers branches, log, tags, status, operation, remotes and pullMode.
- Copy (verbatim, spec §5; the spec's backticks mark code and are not shown):
  - toolbar `Fetch`, `Pull`, `Push`, `Remotes…`; split menus `Pull (merge)`, `Pull (rebase)`, `Force push (with lease)…`; busy labels `Fetching…`, `Pulling…`, `Pushing…`
  - messages (title / hint / action): `SSH key was refused` / `Add your key to the agent with ssh-add, and check it is registered with the host.`; `Host key not trusted` / `Connect once from a terminal (ssh -T <host>) to verify and save the host key.`; `Could not reach the remote` / `Check your network connection and the remote URL.`; `Repository not found` / `Check the remote URL, and that your account can access it.` / `Edit remote…`; `The remote has commits you don't have` / `Pull, then push again.` / `Pull`; `The remote branch moved since your last fetch` / `Fetch and review the new commits before forcing again.` / `Fetch`; `Other`: `git ‹verb› failed`; `noRemotes`: `No remotes configured` / action `Add remote…`; `detachedHead`: `Check out a branch to pull or push.`
  - credential dialog: title `Sign in to ‹host›`, `Username`, `Token or password`, `Your git credential helper will store these if one is configured.`, `Cancel`, `Sign in`, rejected note `Those credentials were rejected`
  - force push: `Force push ‹local› to ‹remote›?` / `This replaces ‹upstream› with your local branch. It fails safely if someone else pushed since your last fetch.` / `Force push`
  - set upstream: `Publish` (confirm label)
  - remotes: `Fetch after adding`; remove confirm `Remove remote ‹name›?` / `Its remote-tracking branches are deleted locally. Nothing changes on the server.` / `Remove`; heading menu `Edit remote…`, `Remove remote…`
  - Plan-chosen copy (not in the spec): split-button names `Pull options`, `Push options`; tooltips `No remotes configured`, `Check out a branch to pull or push.`, `Make a commit first`, `This branch has no upstream`, `Another network operation is running`, `Loading…`; upstream text `→ ‹upstream›`, `↑n` (label `n ahead`), `↓m` (label `m behind`), `→ ‹upstream› (upstream gone)`, `no upstream`; message hints `Add a remote to fetch, pull or push.` (noRemotes) and, for an HTTPS auth error that cannot prompt, title `Sign-in required` / hint `Set up a git credential helper for this host, then try again.`; error panel `Details`, `Dismiss`; set-upstream dialog title `Publish ‹branch›`, labels `Remote`, `Branch name`, inline `‹name› is not a valid branch name.`; remotes dialog title `Remotes`, `No remotes`, row buttons `Edit` / `Remove` (accessible names `Edit ‹name›` / `Remove ‹name›`), `Add remote`, form labels `Name`, `URL`, `Push URL (optional)`, buttons `Add` / `Save` / `Cancel` / `Close`, inline `‹name› is not a valid remote name.`, `A remote named ‹name› already exists.`, `Enter a valid URL.`
- Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check` (all from `src-tauri`); `npm run test:coverage` at 100 % statements/branches/functions/lines for `src/`; `npm run lint`; `npm run typecheck`; `npx prettier --check .`.

## Review Focus

1. **The inline helper must survive any token.** The spec's `echo "password=$GR_TOKEN"` breaks under dash, which expands backslash escapes: a token `s3cr\et` reached the server as `s3cr<ESC>t` and the fetch failed with "Authentication failed" (verified, git 2.43, `/bin/sh` → dash). The helper uses `printf '%s\n'` and answers only `get` (Task 1 test `inline_helper_passes_backslashes_quotes_and_dollars_through_real_git` in `credential_helper.rs`).
2. **The token never reaches argv and is never offered to another host.** `fetch --all` talks to every remote; an unscoped `credential.helper` would hand a GitLab token to GitHub. The helper is installed as `credential.<origin>.helper`, the token goes only into `GR_TOKEN`, and approve runs only for URLs on that origin (Task 1 tests `fetch_with_credentials_scopes_the_helper_and_keeps_the_token_out_of_argv` and `a_successful_run_with_credentials_approves_only_urls_on_the_credentials_origin` in `network_cli.rs`, `inline_helper_does_not_answer_another_origin` in `credential_helper.rs`).
3. **A merge-mode pull fast-forwards.** `merge_branch(_, MergeMode::Merge)` is `--no-ff`; calling it for every pull would record a merge commit on each pull of a branch that is merely behind. `integrate_pull` asks `can_fast_forward` first (Task 1 test `pull_merge_fast_forwards_without_a_merge_commit`).
4. **The empty lease never overwrites.** With no remote-tracking ref the lease is `refs/heads/<b>:` ("expect absent"); git rejects it as `(stale info)` when the remote already has the branch (verified), so a force push to a branch the user never fetched cannot clobber it (Task 1 test `force_push_without_a_tracking_ref_is_lease_stale_when_the_remote_branch_exists`).
5. **The `https` flag follows the URL git actually uses.** A push uses `pushurl` (and `pushInsteadOf`), a fetch uses `url` (and `insteadOf`); git2 applies both rewrites (verified with git2 0.20.4). Reading the raw config value would offer a credential prompt for an SSH push, or none for a `gh:`-style alias (Task 1 tests `push_https_flag_follows_the_push_url_not_the_fetch_url` and `https_flag_follows_insteadof_rewrites`).

## Deviations from spec

- **Credentials carry an `origin`, and the helper is scoped to it.** `Credentials { origin, username, token }`, and `apply` adds `-c credential.<origin>.helper=` (resetting the helper list for that origin only) then `-c credential.<origin>.helper=<HELPER>`, instead of a global `-c credential.helper=`. Verified: the reset clears a stored wrong credential for that origin, a different origin never gets an answer, and other hosts' stored helpers keep working during `fetch --all`. The origin comes from git's own `fatal:` line (`could not read Username for 'https://github.com'`, `Authentication failed for 'https://github.com/me/x.git/'`), so `NetworkFailed` and the `network` payload gain `origin`; the dialog title shows its host. Approve likewise runs only for the operation's URLs on that origin (spec: every HTTPS remote's URL), so a token is never stored for another host.
- **The helper prints with `printf '%s\n'`, not `echo`, and ignores `store` / `erase`.** See Review Focus 1.
- **`git credential approve` gets `url=<remote URL>` then `username` and `password`**, not `protocol` / `host` / `path` parsed by us. git parses the URL itself (later keys override a username in the URL), and the full URL keeps `credential.useHttpPath` users working. Verified: `credential approve` with `credential.helper=store` writes the entry, and with no helper configured exits 0.
- **The `-c` arguments go after `-C <workdir>`**, not first, so every fake-git test can keep reading the workdir from `$2`. git accepts global options in any order before the subcommand.
- **`NetworkFailed` also carries `origin`, `code` and `stdout`.** `code` and `stdout` keep the existing message fallbacks ("git push failed with exit code 1"); `origin` drives the prompt.
- **`InvalidCredentials` is a new variant / kind.** `Credentials` deserializes through `#[serde(try_from)]` and `Credentials::new`, so an origin that could inject config through the `-c` key, or a value with a line break that could inject helper output, never reaches git.
- **Merge-mode pull fast-forwards when it can** and does nothing when up to date (Review Focus 3). `pull.ff` is not read.
- **`pull_default_mode` honours `branch.<name>.rebase` before `pull.rebase`** (git's precedence) and returns `Result<PullMode, GitError>` because reading config can fail. `merges` and `interactive` both run a plain `git rebase <upstream>`, as the spec maps them.
- **`prepare_pull` checks `ensure_clean` and the HEAD state before fetching**, so a pull during a merge fails at once instead of fetching first. An upstream on remote `.` (a local branch) counts as `NoUpstream` for pull and push.
- **`add_remote` takes an optional push URL**, because the Add form has the field (spec §5.2); one git2 call sequence instead of add + update.
- **Remote names refuse a leading `-` and a NUL byte before `Remote::is_valid_name`**, which accepts `-x` and panics on NUL (verified).
- **`list_remotes` reports the raw config URLs**, while the `https` flag and approve use git2's rewritten URLs. Showing the rewritten URL would make Save write it back and silently drop the user's `insteadOf`.
- **The DTOs (`NetworkErrorKind`, `PullMode`, `PushTarget`, `RemoteInfo`) live in `model/remote.rs`** beside the other DTOs; `remote/classify.rs` holds `classify` and `auth_origin`, `remote/remotes.rs` the CRUD.
- **No explicit `REPO_CHANGED` emit.** No existing command emits it: the watcher reports every change under `.git` except objects and `*.lock` (refs, `packed-refs`, `config`, `FETCH_HEAD`), and every front-end network and remote action invalidates `queryKeys.repo(id)` on settle.
- **Commands take `id`, not `repo_id`**, like every existing command.
- **`run_push` keeps its role but gains `urls` and `creds`**; `PushDelete`, `TagPush` and `TagPushDelete` store their push URL and their `run` takes `Option<&Credentials>`.
- **`ensure_remote` and `is_not_found` in `refs/mod.rs` become `pub(crate)`**, used by `remote::{pull, push, remotes}`.
- **`auth::apply` is `pub`** (spec: `pub(crate)`) so a test can run the exact arguments through real `git credential fill`.
- **Errors render in a new `NetworkError` panel** (title, hint, action button, `Details` disclosure, `Dismiss`) instead of `RepoError variant="panel"`, which shows only `error.message`.
- **The toolbar's upstream text omits the branch name** (`→ origin/main`, `↑2`, `↓3`): the header line beside it already shows `main`.
- **`useNetworkAction` returns a `prompt` and a result; it does not map errors.** The consumer renders `<CredentialDialog prompt={…} />` (so the hook stays a `.ts` file) and maps a failure with `networkMessage`. Cancel resolves `{ status: "cancelled" }` and shows nothing. It invalidates `queryKeys.repo(id)` (not four separate keys) on every settled attempt.
- **Push opens the set-upstream dialog on the `noUpstream` error**, as the spec says; Force push is disabled without an upstream.
- **A configured askpass still wins.** git consults `GIT_ASKPASS` / `core.askPass` / `SSH_ASKPASS` before giving up on a prompt; the runner leaves them alone, so the app's dialog appears only when the user has none.

---

### Task 1: Core — credentials, classification, `NetworkFailed`, fetch, pull, push, remote CRUD — and the `AppError` mapping

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/remote.rs` (`NetworkErrorKind`, `PullMode`, `PushTarget`, `RemoteInfo`)
- Create: `src-tauri/crates/git-real-core/src/remote/auth.rs`, `classify.rs`, `fetch.rs`, `pull.rs`, `push.rs`, `remotes.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs` (`mod remote;` + `pub use remote::{NetworkErrorKind, PullMode, PushTarget, RemoteInfo};`, alphabetical after `recent`)
- Modify: `src-tauri/crates/git-real-core/src/remote/mod.rs` (`pub mod auth; pub mod classify; pub mod fetch; pub mod pull; pub mod push; pub(crate) mod remotes;`, `run_network`, `run_push` reshaped)
- Modify: `src-tauri/crates/git-real-core/src/remote/push_tag.rs`, `remote/push_delete.rs` (`urls` field, `run(creds)`)
- Modify: `src-tauri/crates/git-real-core/src/refs/mod.rs` (`ensure_remote` and `is_not_found` become `pub(crate)`; `prepare_remote_delete` passes the push URL), `src-tauri/crates/git-real-core/src/refs/tags.rs` (both prepares pass the push URL)
- Modify: `src-tauri/crates/git-real-core/src/error.rs` (eight variants after `TagNotFound`; `PushFailed` removed), `src-tauri/crates/git-real-core/src/lib.rs` (`pub use remote::auth::Credentials;`)
- Create (test role): `src-tauri/crates/git-real-core/tests/fixtures/network_stderr/*.txt` (20 files, Step 1), `tests/network_classify.rs`, `tests/credential_helper.rs`, `tests/remote_sync.rs`, `tests/network_cli.rs`
- Modify (test role): `tests/tags.rs`, `tests/cli_argv.rs`, `tests/push_delete.rs`, `tests/cli_unavailable.rs` (Step 6)
- Modify (app crate, so every commit compiles): `src-tauri/src/error.rs` (eight kinds, `NetworkInfo`, `network` field; `PushFailed` removed), `src-tauri/src/commands/mod.rs` (`run_blocking`'s `AppError` literal gains `network: None`), `src-tauri/src/commands/refs.rs` and `src-tauri/src/commands/tags.rs` (`.run(None)` only; the `credentials` arguments are Task 2's)
- Modify (test role, app crate): `src-tauri/tests/error.rs`, `src-tauri/tests/refs_commands.rs`, `src-tauri/tests/tag_commands.rs` (Step 6b)

**Interfaces:**

- Consumes (verified in code):
  - `git_cli.rs`: `pub fn command(git: &Path) -> Command` (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, repo env cleared), `pub fn locate()`, `pub(crate) fn capture(cmd)` (stdin null), `pub(crate) fn capture_with_input(cmd, input: &[u8])`.
  - `git_ops.rs`: `RepoSession::git(&self) -> Result<(PathBuf, &Path), GitError>`, `ensure_clean()` (`OperationInProgress`), `ensure_born()`.
  - `merge/mod.rs`: `pub fn merge_branch(&self, branch: &str, mode: MergeMode) -> Result<OperationOutcome, GitError>` (`Merge` = `--no-ff --no-edit`, `FastForward` = `--ff-only`), `pub fn rebase_onto(&self, onto: &str)`, `pub fn can_fast_forward(&self, branch: &str) -> Result<FastForwardCheck, GitError>`; all three accept `remote/name` through `resolve_branch` and check `ensure_clean` / `ensure_born` themselves.
  - `refs/mod.rs`: `pub fn validate_branch_name(name)`, private `fn ensure_remote(&self, remote)` (leading `-` or unknown → `RemoteNotFound`), private `fn is_not_found(e: &git2::Error)`, `prepare_remote_delete` → `PushDelete::new(git, workdir, remote, name)`; `refs/tags.rs`: `prepare_tag_push` / `prepare_remote_tag_delete` → `TagPush::new` / `TagPushDelete::new(git, workdir, remote, name)`.
  - `remote/mod.rs`: `pub(crate) fn run_push(git, workdir, remote, args) -> Result<(), GitError>` (non-zero → `PushFailed { code, stdout, stderr }`), used by `PushDelete::run`, `TagPush::run`, `TagPushDelete::run`.
  - git2 0.20.4 (verified): `Remote::{is_valid_name (panics on NUL; accepts "-x"), url, url_bytes, pushurl, pushurl_bytes}` — `url()` applies `insteadOf`, `pushurl()` applies `pushInsteadOf` and returns the rewritten fetch URL when only `pushInsteadOf` matches; `Repository::{remotes, find_remote, remote, remote_rename (moves `branch._.remote`and`refs/remotes/<old>/_`), remote_set_url, remote_set_pushurl, remote_delete (drops tracking refs and `branch.*.remote/merge`), branch_upstream_remote (`"."` for a local upstream; NotFound without config), branch_upstream_name, refname_to_id}`; `Config::{get_bool, get_string}`.
  - Core test helpers (`tests/common`): `temp_repo_with_commit`, `temp_repo_unborn`, `temp_bare_clone`, `add_remote_and_fetch(path, bare, head_name)` (sets the upstream), `fetch_remote(path, remote)`, `head_branch_name`, `configure_identity`, `commit_file`, `tag_lightweight`, `run_git_ok(root, args)` (`git -C root …`), `fake_git(dir, script)`, `git_available`.
- Produces:

```rust
// model/remote.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub enum NetworkErrorKind { HttpsAuthRequired, HttpsAuthRejected, SshAuthFailed, HostKeyUnverified, HostUnreachable, RepoNotFound, PushRejectedNonFastForward, LeaseStale, Other }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub enum PullMode { Merge, Rebase }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PushTarget { Upstream, SetUpstream { remote: String, branch: String } }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
pub struct RemoteInfo { pub name: String, pub fetch_url: String, pub push_url: Option<String> }
// remote/auth.rs
pub const HELPER: &str;
#[derive(Clone, Deserialize)] #[serde(try_from = "CredentialsInput")]
pub struct Credentials { /* origin, username, token: private */ }
impl Credentials { pub fn new(origin: &str, username: &str, token: &str) -> Result<Self, GitError>; pub fn origin(&self) -> &str; pub fn username(&self) -> &str; }
impl fmt::Debug for Credentials; // token: "***"
pub fn apply(cmd: &mut Command, creds: Option<&Credentials>);
pub fn origin_of(url: &str) -> Option<String>;
pub(crate) fn is_http(url: &str) -> bool;
pub(crate) fn approve(git: &Path, workdir: &Path, url: &str, creds: &Credentials);
// remote/classify.rs
pub fn classify(stderr: &str) -> NetworkErrorKind;
pub fn auth_origin(stderr: &str) -> Option<String>;
// remote/mod.rs
pub(crate) fn run_network(git: &Path, workdir: &Path, verb: &'static str, args: &[&str], urls: &[String], creds: Option<&Credentials>) -> Result<(), GitError>;
pub(crate) fn run_push(git: &Path, workdir: &Path, remote: &str, args: &[&str], urls: &[String], creds: Option<&Credentials>) -> Result<(), GitError>;
// remote/fetch.rs, pull.rs, push.rs (#[derive(Debug)], owned, no credentials stored)
pub struct Fetch; impl Fetch { pub fn https(&self) -> bool; pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError>; }
pub struct Pull;  impl Pull { pub fn remote(&self) -> &str; pub fn upstream(&self) -> &str; pub fn https(&self) -> bool; pub fn fetch(&self, creds: Option<&Credentials>) -> Result<(), GitError>; }
pub struct Push;  impl Push { pub fn remote(&self) -> &str; pub fn branch(&self) -> &str; pub fn lease(&self) -> Option<&str>; pub fn https(&self) -> bool; pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError>; }
impl RepoSession {
    pub fn prepare_fetch(&self) -> Result<Fetch, GitError>;
    pub fn pull_default_mode(&self) -> Result<PullMode, GitError>;
    pub fn prepare_pull(&self) -> Result<Pull, GitError>;
    pub fn integrate_pull(&self, pull: &Pull, mode: PullMode) -> Result<OperationOutcome, GitError>;
    pub fn prepare_push(&self, target: &PushTarget, force: bool) -> Result<Push, GitError>;
    // remote/remotes.rs
    pub fn list_remotes(&self) -> Result<Vec<RemoteInfo>, GitError>;
    pub fn add_remote(&self, name: &str, url: &str, push_url: Option<&str>) -> Result<(), GitError>;
    pub fn update_remote(&self, name: &str, new_name: &str, url: &str, push_url: Option<&str>) -> Result<(), GitError>;
    pub fn remove_remote(&self, name: &str) -> Result<(), GitError>;
    pub(crate) fn remote_names(&self) -> Result<Vec<String>, GitError>;          // sorted
    pub(crate) fn used_url(&self, remote: &str, direction: Direction) -> Result<Option<String>, GitError>;
    pub(crate) fn head_branch(&self) -> Result<String, GitError>;               // UnbornHead / DetachedHead
    pub(crate) fn upstream_of(&self, branch: &str) -> Result<Option<Upstream>, GitError>;
}
// push_tag.rs / push_delete.rs: new(git, workdir, remote, name, urls: Vec<String>); run(&self, creds: Option<&Credentials>)
// GitError: NoRemotes, NoUpstream, DetachedHead, InvalidRemoteName(String), InvalidRemoteUrl(String), RemoteExists(String), InvalidCredentials, NetworkFailed { .. }; PushFailed removed
```

- [ ] **Step 1: Write the stderr fixtures** (`src-tauri/crates/git-real-core/tests/fixtures/network_stderr/`, one file each, ending with a newline). "Verified" samples were captured from git 2.43.0 against local bare repos, `example.invalid`, `127.0.0.1:1`, and a local HTTP server running `git http-backend` behind Basic auth (401 / 403 / 404); only paths and hosts were shortened or substituted. "Hand-written" samples come from the OpenSSH and GitHub message strings (no sshd or GitHub was reachable offline).

| File                        | Content                                                                                                                                                                                                    | Source                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `https_username_prompt.txt` | `fatal: could not read Username for 'https://github.com': terminal prompts disabled`                                                                                                                       | verified (host substituted)                                  |
| `https_password_prompt.txt` | `fatal: could not read Password for 'https://me@github.com': terminal prompts disabled`                                                                                                                    | verified (host substituted)                                  |
| `https_auth_failed.txt`     | `remote: Invalid username or password.` / `fatal: Authentication failed for 'https://github.com/me/x.git/'`                                                                                                | fatal line verified, remote line hand-written                |
| `https_403.txt`             | `fatal: unable to access 'https://github.com/me/x.git/': The requested URL returned error: 403`                                                                                                            | verified (host substituted)                                  |
| `ssh_publickey.txt`         | `git@github.com: Permission denied (publickey).` + the four-line `fatal: Could not read from remote repository.` block                                                                                     | hand-written                                                 |
| `ssh_host_key.txt`          | `No ED25519 host key is known for github.com and you have requested strict checking.` / `Host key verification failed.` + the block                                                                        | hand-written                                                 |
| `https_dns.txt`             | `fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid`                                                                                                        | verified                                                     |
| `ssh_dns.txt`               | `ssh: Could not resolve hostname example.invalid: Name or service not known` + the block                                                                                                                   | verified                                                     |
| `http_refused.txt`          | `fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server`                                                                        | verified                                                     |
| `ssh_refused.txt`           | `ssh: connect to host 127.0.0.1 port 1: Connection refused` + the block                                                                                                                                    | verified                                                     |
| `ssh_timeout.txt`           | `ssh: connect to host example.com port 22: Connection timed out` + the block                                                                                                                               | hand-written                                                 |
| `local_not_a_repo.txt`      | `fatal: '/srv/nope.git' does not appear to be a git repository` + the block                                                                                                                                | verified (path shortened)                                    |
| `https_404.txt`             | `fatal: repository 'http://127.0.0.1:18431/nope.git/' not found`                                                                                                                                           | verified                                                     |
| `github_repo_not_found.txt` | `remote: Repository not found.` / `fatal: repository 'https://github.com/me/nope.git/' not found`                                                                                                          | fatal line verified form, remote line hand-written           |
| `push_fetch_first.txt`      | `To /srv/bare.git` / ` ! [rejected]        HEAD -> main (fetch first)` / `error: failed to push some refs to '/srv/bare.git'` / the five `hint:` lines git prints                                          | verified                                                     |
| `push_non_fast_forward.txt` | as above with `(non-fast-forward)` and its four `hint:` lines                                                                                                                                              | verified                                                     |
| `push_stale_info.txt`       | `To /srv/bare.git` / ` ! [rejected]        HEAD -> main (stale info)` / `error: failed to push some refs to '/srv/bare.git'`                                                                               | verified (also the empty-expect lease on an existing branch) |
| `push_tag_exists.txt`       | `To /srv/bare.git` / ` ! [rejected]        v9 -> v9 (already exists)` / `error: failed to push some refs to '/srv/bare.git'` / `hint: Updates were rejected because the tag already exists in the remote.` | verified                                                     |
| `remote_ref_missing.txt`    | `error: unable to delete 'heads/nosuch': remote ref does not exist` / `error: failed to push some refs to '/srv/bare.git'`                                                                                 | verified                                                     |
| `fetch_all_partial.txt`     | `Fetching origin` / `Fetching bad` / `fatal: '/srv/nope.git' does not appear to be a git repository` + the block / `error: could not fetch bad`                                                            | verified (`fetch --all`, exit 1)                             |

"The block" is, verbatim:

```text
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
```

- [ ] **Step 2: Write the failing pure tests** (`tests/network_classify.rs`, no git needed)

```rust
//! Pure GR-12 network helpers: stderr classification against samples of real
//! git output, the origin parsed from git's own `fatal:` line, credential
//! validation and redaction, and the arguments `auth::apply` adds.

use std::ffi::OsStr;
use std::process::Command;

use git_real_core::remote::auth::{self, Credentials, HELPER, origin_of};
use git_real_core::remote::classify::{auth_origin, classify};
use git_real_core::{GitError, NetworkErrorKind as K};

const TOKEN: &str = "TOPSECRET-123";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("fixtures/network_stderr/", $name))
    };
}

#[test]
fn classifies_every_fixture() {
    let cases = [
        (fixture!("https_username_prompt.txt"), K::HttpsAuthRequired),
        (fixture!("https_password_prompt.txt"), K::HttpsAuthRequired),
        (fixture!("https_auth_failed.txt"), K::HttpsAuthRejected),
        (fixture!("https_403.txt"), K::HttpsAuthRejected),
        (fixture!("ssh_publickey.txt"), K::SshAuthFailed),
        (fixture!("ssh_host_key.txt"), K::HostKeyUnverified),
        (fixture!("https_dns.txt"), K::HostUnreachable),
        (fixture!("ssh_dns.txt"), K::HostUnreachable),
        (fixture!("http_refused.txt"), K::HostUnreachable),
        (fixture!("ssh_refused.txt"), K::HostUnreachable),
        (fixture!("ssh_timeout.txt"), K::HostUnreachable),
        (fixture!("local_not_a_repo.txt"), K::RepoNotFound),
        (fixture!("https_404.txt"), K::RepoNotFound),
        (fixture!("github_repo_not_found.txt"), K::RepoNotFound),
        (fixture!("fetch_all_partial.txt"), K::RepoNotFound),
        (fixture!("push_fetch_first.txt"), K::PushRejectedNonFastForward),
        (fixture!("push_non_fast_forward.txt"), K::PushRejectedNonFastForward),
        (fixture!("push_stale_info.txt"), K::LeaseStale),
        (fixture!("push_tag_exists.txt"), K::Other),
        (fixture!("remote_ref_missing.txt"), K::Other),
    ];
    for (stderr, want) in cases {
        assert_eq!(classify(stderr), want, "{stderr}");
    }
}

#[test]
fn classify_is_other_for_empty_and_unknown_output() {
    assert_eq!(classify(""), K::Other);
    assert_eq!(classify("error: src refspec nope does not match any\n"), K::Other);
}

#[test]
fn classify_takes_the_first_matching_kind() {
    let auth_and_dns = "fatal: could not read Username for 'https://h': terminal prompts disabled\nCould not resolve host: h\n";
    assert_eq!(classify(auth_and_dns), K::HttpsAuthRequired);
    let rejected_and_refused = " ! [rejected]        main -> main (fetch first)\nssh: connect to host h port 22: Connection refused\n";
    assert_eq!(classify(rejected_and_refused), K::HostUnreachable);
}

#[test]
fn a_reason_without_a_rejection_is_other() {
    assert_eq!(classify("(stale info)\n"), K::Other);
    assert_eq!(classify("(fetch first)\n"), K::Other);
}

#[test]
fn auth_origin_reads_git_s_fatal_line() {
    assert_eq!(auth_origin(fixture!("https_username_prompt.txt")).as_deref(), Some("https://github.com"));
    assert_eq!(auth_origin(fixture!("https_password_prompt.txt")).as_deref(), Some("https://github.com"));
    assert_eq!(auth_origin(fixture!("https_auth_failed.txt")).as_deref(), Some("https://github.com"));
    assert_eq!(auth_origin(fixture!("https_403.txt")).as_deref(), Some("https://github.com"));
    assert_eq!(
        auth_origin("fatal: could not read Username for 'http://127.0.0.1:18431': terminal prompts disabled\n").as_deref(),
        Some("http://127.0.0.1:18431")
    );
}

#[test]
fn auth_origin_ignores_server_lines_and_non_http_output() {
    assert_eq!(auth_origin("remote: fatal: could not read Username for 'https://evil.test': x\n"), None);
    assert_eq!(auth_origin(fixture!("ssh_publickey.txt")), None);
    assert_eq!(auth_origin(fixture!("local_not_a_repo.txt")), None);
    assert_eq!(auth_origin("fatal: Authentication failed for 'https://bad host/x'\n"), None);
}

#[test]
fn origin_of_keeps_scheme_host_and_port_only() {
    assert_eq!(origin_of("https://me:pw@github.com/me/x.git").as_deref(), Some("https://github.com"));
    assert_eq!(origin_of("HTTP://127.0.0.1:8080/r.git").as_deref(), Some("http://127.0.0.1:8080"));
    assert_eq!(origin_of("https://[::1]:8443/r").as_deref(), Some("https://[::1]:8443"));
    for url in ["ssh://git@github.com/x.git", "git@github.com:me/x.git", "/srv/bare.git", "file:///srv/x", "https://", "https://h:123456/x", "https://h_x/y"] {
        assert_eq!(origin_of(url), None, "{url}");
    }
}

#[test]
fn credentials_accept_http_and_https_origins() {
    for origin in ["https://github.com", "http://127.0.0.1:8080", "https://[::1]:8443", "https://git.example-host.org"] {
        let c = Credentials::new(origin, "me", TOKEN).unwrap();
        assert_eq!((c.origin(), c.username()), (origin, "me"));
    }
}

#[test]
fn credentials_refuse_other_origins_and_line_breaks() {
    let bad_origins = [
        "github.com", "ssh://github.com", "https://github.com/", "https://me@github.com",
        "https://h:123456", "HTTPS://h", "https://h\n", "https://h.helper=x", "https://",
    ];
    for origin in bad_origins {
        assert!(matches!(Credentials::new(origin, "me", TOKEN), Err(GitError::InvalidCredentials)), "{origin:?}");
    }
    for (user, token) in [("", TOKEN), ("me", ""), ("m\ne", TOKEN), ("me", "a\rb"), ("me", "a\0b"), ("me", "a\nusername=evil")] {
        assert!(matches!(Credentials::new("https://h", user, token), Err(GitError::InvalidCredentials)), "{user:?}");
    }
}

#[test]
fn credentials_debug_redacts_the_token() {
    let c = Credentials::new("https://github.com", "me", TOKEN).unwrap();
    let text = format!("{c:?}");
    assert!(!text.contains(TOKEN), "{text}");
    assert!(text.contains(r#"token: "***""#) && text.contains("https://github.com") && text.contains(r#""me""#), "{text}");
}

#[test]
fn credentials_deserialize_through_validation_without_echoing_the_token() {
    let ok: Credentials = serde_json::from_value(serde_json::json!({ "origin": "https://h", "username": "me", "token": TOKEN })).unwrap();
    assert_eq!(ok.origin(), "https://h");
    let err = serde_json::from_value::<Credentials>(serde_json::json!({ "origin": "ftp://h", "username": "me", "token": TOKEN })).unwrap_err();
    assert!(!err.to_string().contains(TOKEN), "{err}");
}

fn args(cmd: &Command) -> Vec<String> {
    cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
}

#[test]
fn apply_scopes_the_helper_and_puts_secrets_only_in_the_environment() {
    let c = Credentials::new("https://github.com", "me", TOKEN).unwrap();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg("/w");
    auth::apply(&mut cmd, Some(&c));
    cmd.arg("fetch");
    let helper = format!("credential.https://github.com.helper={HELPER}");
    assert_eq!(args(&cmd), ["-C", "/w", "-c", "credential.https://github.com.helper=", "-c", helper.as_str(), "fetch"]);
    assert!(!args(&cmd).iter().any(|a| a.contains(TOKEN)));
    let envs: Vec<_> = cmd.get_envs().collect();
    assert!(envs.contains(&(OsStr::new("GR_USERNAME"), Some(OsStr::new("me")))), "{envs:?}");
    assert!(envs.contains(&(OsStr::new("GR_TOKEN"), Some(OsStr::new(TOKEN)))), "{envs:?}");
}

#[test]
fn apply_without_credentials_adds_nothing() {
    let mut cmd = Command::new("git");
    auth::apply(&mut cmd, None);
    assert!(args(&cmd).is_empty());
    assert_eq!(cmd.get_envs().count(), 0);
}

#[test]
fn the_helper_is_the_verified_printf_form() {
    assert_eq!(HELPER, r#"!f() { test "$1" = get || return 0; printf '%s\n' "username=$GR_USERNAME" "password=$GR_TOKEN"; }; f"#);
}
```

- [ ] **Step 3: Write the failing real-git helper tests** (`tests/credential_helper.rs`)

```rust
//! The inline credential helper through real `git credential fill` (GR-12):
//! the exact `-c` arguments `auth::apply` adds, in a scratch HOME with no
//! system or global config, so the developer's own helpers never answer.

mod common;

use std::io::Write;
use std::process::{Output, Stdio};

use git_real_core::git_cli;
use git_real_core::remote::auth::{self, Credentials};

/// `git [-c extra]... [auth] credential fill` for `url`.
fn fill(creds: &Credentials, extra: &[&str], url: &str) -> Output {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = git_cli::command(&git_cli::locate().unwrap());
    cmd.current_dir(home.path())
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.path().join("none"));
    for c in extra {
        cmd.arg("-c").arg(c);
    }
    auth::apply(&mut cmd, Some(creds));
    cmd.args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    child.stdin.take().unwrap().write_all(format!("url={url}\n\n").as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn inline_helper_passes_backslashes_quotes_and_dollars_through_real_git() {
    if !common::git_available() { return; }
    let token = r#"a\b$c'd %s "e"#;
    let creds = Credentials::new("https://example.test", "al ice", token).unwrap();
    let out = fill(&creds, &[], "https://example.test/me/x.git");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("username=al ice\n"), "{stdout}");
    assert!(stdout.contains(&format!("password={token}\n")), "{stdout}");
}

#[test]
fn inline_helper_does_not_answer_another_origin() {
    if !common::git_available() { return; }
    let creds = Credentials::new("https://example.test", "me", "TOKEN-123").unwrap();
    let out = fill(&creds, &[], "https://other.test/me/x.git");
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("TOKEN-123"));
}

#[test]
fn inline_helper_replaces_a_configured_helper_for_its_origin() {
    if !common::git_available() { return; }
    let creds = Credentials::new("https://example.test", "me", "fresh").unwrap();
    let stale = "credential.helper=!f() { echo username=old; echo password=stale; }; f";
    let stdout = String::from_utf8(fill(&creds, &[stale], "https://example.test/me/x.git").stdout).unwrap();
    assert!(stdout.contains("password=fresh\n") && !stdout.contains("stale"), "{stdout}");
}

#[test]
fn inline_helper_matches_a_url_with_a_port_and_a_username() {
    if !common::git_available() { return; }
    let creds = Credentials::new("http://127.0.0.1:8080", "me", "tok").unwrap();
    let stdout = String::from_utf8(fill(&creds, &[], "http://bob@127.0.0.1:8080/r.git").stdout).unwrap();
    assert!(stdout.contains("password=tok\n"), "{stdout}");
}
```

- [ ] **Step 4: Write the failing real-repository tests** (`tests/remote_sync.rs`. Every test that runs git or builds `fx()` starts with `if !common::git_available() { return; }`; pure git2 tests do not. A test that changes config or remotes after `fx()` reopens the session, so libgit2's config cache can never hide the change.)

```rust
//! GR-12 fetch, pull, push and remote management against real temp
//! repositories, with local bare repositories as remotes (no network) and the
//! system git CLI.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    GitError, NetworkErrorKind, OperationOutcome, OperationState, PullMode, PushTarget, RemoteInfo,
    RepoSession,
};
use git2::{BranchType, Repository};
use tempfile::TempDir;

/// `path` tracks `origin` (a bare clone of it) on its HEAD branch; `other` is
/// a second clone of the bare repo that pushes "someone else's" commits.
struct Fx {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    other: PathBuf,
    head: String,
    session: RepoSession,
}

fn fx() -> Fx {
    let (d1, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    let d3 = tempfile::tempdir().unwrap();
    common::run_git_ok(d3.path(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    let other = d3.path().join("other");
    common::configure_identity(&other);
    let session = RepoSession::open(&path).unwrap();
    Fx { _dirs: [d1, d2, d3], path, bare, other, head, session }
}

impl Fx {
    /// Commits `file` in `other` and pushes it; returns the new tip.
    fn push_from_other(&self, file: &str, content: &str) -> String {
        let oid = common::commit_file(&self.other, file, content, "from other").to_string();
        common::run_git_ok(&self.other, &["push", "-q", "origin", "HEAD"]);
        oid
    }
    fn commit_here(&self, file: &str, content: &str) -> String {
        common::commit_file(&self.path, file, content, "local").to_string()
    }
    fn head_oid(&self) -> String {
        tip(&self.path, "HEAD").unwrap()
    }
    fn bare_tip(&self, branch: &str) -> Option<String> {
        tip(&self.bare, &format!("refs/heads/{branch}"))
    }
    fn tracking(&self) -> Option<String> {
        tip(&self.path, &format!("refs/remotes/origin/{}", self.head))
    }
    fn fetch(&self) {
        self.session.prepare_fetch().unwrap().run(None).unwrap();
    }
    fn set_config(&self, key: &str, value: &str) {
        Repository::open(&self.path).unwrap().config().unwrap().set_str(key, value).unwrap();
    }
    fn reopen(&self) -> RepoSession {
        RepoSession::open(&self.path).unwrap()
    }
}

fn tip(repo: &Path, spec: &str) -> Option<String> {
    let repo = Repository::open(repo).ok()?;
    let commit = repo.revparse_single(spec).ok()?.peel_to_commit().ok()?;
    Some(commit.id().to_string())
}

#[track_caller]
fn network_failure(err: GitError) -> (&'static str, NetworkErrorKind, bool, String) {
    match err {
        GitError::NetworkFailed { verb, kind, https, stderr, .. } => (verb, kind, https, stderr),
        other => panic!("expected NetworkFailed, got {other:?}"),
    }
}

/// A repo whose HEAD branch tracks `origin` (git2 only, no CLI).
fn tracked() -> (TempDir, TempDir, PathBuf, String, RepoSession) {
    let (d1, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    let session = RepoSession::open(&path).unwrap();
    (d1, d2, path, head, session)
}

fn plain() -> (TempDir, PathBuf, RepoSession) {
    let (d, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).unwrap();
    (d, path, session)
}

fn info(name: &str, url: &str, push: Option<&str>) -> RemoteInfo {
    RemoteInfo { name: name.into(), fetch_url: url.into(), push_url: push.map(Into::into) }
}

fn set_upstream(remote: &str, branch: &str) -> PushTarget {
    PushTarget::SetUpstream { remote: remote.into(), branch: branch.into() }
}

// ---------- fetch ----------

#[test]
fn prepare_fetch_without_remotes_is_no_remotes() {
    let (_d, _p, session) = plain();
    assert!(matches!(session.prepare_fetch(), Err(GitError::NoRemotes)));
}

#[test]
fn fetch_updates_the_remote_tracking_refs() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.fetch();
    assert_eq!(fx.tracking().as_deref(), Some(theirs.as_str()));
}

#[test]
fn fetch_fetches_every_remote() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote("mirror", fx.bare.to_str().unwrap()).unwrap();
    fx.reopen().prepare_fetch().unwrap().run(None).unwrap();
    assert!(tip(&fx.path, &format!("refs/remotes/mirror/{}", fx.head)).is_some());
}

#[test]
fn fetch_of_a_missing_remote_is_network_failed_repo_not_found() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote("gone", "/nonexistent/gone.git").unwrap();
    let err = fx.reopen().prepare_fetch().unwrap().run(None).unwrap_err();
    let (verb, kind, https, stderr) = network_failure(err);
    assert_eq!((verb, kind, https), ("fetch", NetworkErrorKind::RepoNotFound, false), "{stderr}");
}

#[test]
fn https_flag_is_false_for_local_and_ssh_remotes() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote("ssh", "git@example.test:me/x.git").unwrap();
    assert!(!fx.reopen().prepare_fetch().unwrap().https());
}

#[test]
fn https_flag_follows_insteadof_rewrites() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote("gh", "gh:me/x.git").unwrap();
    assert!(!fx.reopen().prepare_fetch().unwrap().https());
    fx.set_config("url.https://github.com/.insteadOf", "gh:");
    assert!(fx.reopen().prepare_fetch().unwrap().https());
}

// ---------- pull ----------

#[test]
fn pull_default_mode_follows_pull_rebase() {
    let (_d, path, session) = plain();
    let global_unset = git2::Config::open_default().and_then(|c| c.get_string("pull.rebase")).is_err();
    if global_unset {
        assert_eq!(session.pull_default_mode().unwrap(), PullMode::Merge);
    }
    let cases = [
        ("false", PullMode::Merge), ("no", PullMode::Merge), ("true", PullMode::Rebase), ("yes", PullMode::Rebase),
        ("1", PullMode::Rebase), ("merges", PullMode::Rebase), ("interactive", PullMode::Rebase), ("bogus", PullMode::Merge),
    ];
    for (value, want) in cases {
        Repository::open(&path).unwrap().config().unwrap().set_str("pull.rebase", value).unwrap();
        assert_eq!(RepoSession::open(&path).unwrap().pull_default_mode().unwrap(), want, "{value}");
    }
}

#[test]
fn branch_rebase_overrides_pull_rebase() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config.set_str("pull.rebase", "true").unwrap();
    config.set_str(&format!("branch.{head}.rebase"), "false").unwrap();
    assert_eq!(RepoSession::open(&path).unwrap().pull_default_mode().unwrap(), PullMode::Merge);
    config.set_str("pull.rebase", "false").unwrap();
    config.set_str(&format!("branch.{head}.rebase"), "true").unwrap();
    assert_eq!(RepoSession::open(&path).unwrap().pull_default_mode().unwrap(), PullMode::Rebase);
}

#[test]
fn prepare_pull_and_push_on_an_unborn_head_are_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::UnbornHead)));
    assert!(matches!(session.prepare_push(&PushTarget::Upstream, false), Err(GitError::UnbornHead)));
}

#[test]
fn prepare_pull_and_push_on_a_detached_head_are_detached_head() {
    let (_d, path, _s) = plain();
    let repo = Repository::open(&path).unwrap();
    repo.set_head_detached(repo.head().unwrap().target().unwrap()).unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::DetachedHead)));
    assert!(matches!(session.prepare_push(&PushTarget::Upstream, false), Err(GitError::DetachedHead)));
    assert!(matches!(session.prepare_push(&set_upstream("origin", "b"), true), Err(GitError::DetachedHead)));
}

#[test]
fn prepare_pull_and_push_without_an_upstream_are_no_upstream() {
    let (_d, _p, session) = plain();
    assert!(matches!(session.prepare_pull(), Err(GitError::NoUpstream)));
    assert!(matches!(session.prepare_push(&PushTarget::Upstream, false), Err(GitError::NoUpstream)));
}

#[test]
fn an_upstream_on_the_local_repository_is_no_upstream() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config.set_str(&format!("branch.{head}.remote"), ".").unwrap();
    config.set_str(&format!("branch.{head}.merge"), &format!("refs/heads/{head}")).unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::NoUpstream)));
    assert!(matches!(session.prepare_push(&PushTarget::Upstream, false), Err(GitError::NoUpstream)));
}

#[test]
fn prepare_pull_during_a_merge_is_operation_in_progress() {
    let (_d, path, _s) = plain();
    let head = Repository::open(&path).unwrap().head().unwrap().target().unwrap();
    std::fs::write(path.join(".git").join("MERGE_HEAD"), format!("{head}\n")).unwrap();
    assert!(matches!(RepoSession::open(&path).unwrap().prepare_pull(), Err(GitError::OperationInProgress)));
}

#[test]
fn prepare_pull_names_the_upstream_remote_and_ref() {
    if !common::git_available() { return; }
    let fx = fx();
    let pull = fx.session.prepare_pull().unwrap();
    assert_eq!((pull.remote(), pull.upstream()), ("origin", format!("origin/{}", fx.head).as_str()));
    assert!(!pull.https());
}

#[test]
fn pull_merge_fast_forwards_without_a_merge_commit() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(), OperationOutcome::Completed);
    assert_eq!(fx.head_oid(), theirs);
}

#[test]
fn pull_when_up_to_date_completes_and_changes_nothing() {
    if !common::git_available() { return; }
    let fx = fx();
    let before = fx.head_oid();
    for mode in [PullMode::Merge, PullMode::Rebase] {
        let pull = fx.session.prepare_pull().unwrap();
        pull.fetch(None).unwrap();
        assert_eq!(fx.session.integrate_pull(&pull, mode).unwrap(), OperationOutcome::Completed);
        assert_eq!(fx.head_oid(), before);
    }
}

#[test]
fn pull_merge_of_diverged_history_records_a_merge_commit() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let ours = fx.commit_here("c.txt", "c\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(), OperationOutcome::Completed);
    let repo = Repository::open(&fx.path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let parents: Vec<String> = head.parent_ids().map(|o| o.to_string()).collect();
    assert_eq!(parents, [ours, theirs]);
}

#[test]
fn pull_rebase_replays_local_commits_onto_the_upstream() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.commit_here("c.txt", "c\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(fx.session.integrate_pull(&pull, PullMode::Rebase).unwrap(), OperationOutcome::Completed);
    let repo = Repository::open(&fx.path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.parent_id(0).unwrap().to_string(), theirs);
    assert!(head.tree().unwrap().get_name("c.txt").is_some());
}

#[test]
fn pull_with_conflicting_changes_reports_conflicts() {
    if !common::git_available() { return; }
    let fx = fx();
    fx.push_from_other("README.md", "theirs\n");
    fx.commit_here("README.md", "ours\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(), OperationOutcome::Conflicts);
    assert!(matches!(fx.session.operation_state(), OperationState::Merge { .. }));
}

#[test]
fn pull_fetch_failure_is_network_failed_with_verb_pull() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote_set_url("origin", "/nonexistent/gone.git").unwrap();
    let err = fx.reopen().prepare_pull().unwrap().fetch(None).unwrap_err();
    let (verb, kind, https, _) = network_failure(err);
    assert_eq!((verb, kind, https), ("pull", NetworkErrorKind::RepoNotFound, false));
}

#[test]
fn pull_https_flag_follows_the_upstream_remote_url() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote_set_url("origin", "https://example.test/me/x.git").unwrap();
    assert!(fx.reopen().prepare_pull().unwrap().https());
}

// ---------- push ----------

#[test]
fn prepare_set_upstream_push_checks_the_remote_then_the_branch_name() {
    let (_d, path, _s) = plain();
    Repository::open(&path).unwrap().remote("origin", "/srv/x.git").unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_push(&set_upstream("nope", "b"), false), Err(GitError::RemoteNotFound(r)) if r == "nope"));
    assert!(matches!(session.prepare_push(&set_upstream("-x", "b"), false), Err(GitError::RemoteNotFound(_))));
    assert!(matches!(session.prepare_push(&set_upstream("nope", "bad..name"), false), Err(GitError::RemoteNotFound(_))));
    for bad in ["bad..name", "-b", ""] {
        assert!(matches!(session.prepare_push(&set_upstream("origin", bad), false), Err(GitError::InvalidBranchName(_))), "{bad:?}");
    }
}

#[test]
fn push_sends_head_to_the_upstream_branch() {
    if !common::git_available() { return; }
    let fx = fx();
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx.session.prepare_push(&PushTarget::Upstream, false).unwrap();
    assert_eq!((push.remote(), push.branch(), push.lease()), ("origin", fx.head.as_str(), None));
    assert!(!push.https());
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(ours.as_str()));
}

#[test]
fn push_to_an_upstream_with_another_name_updates_that_branch() {
    if !common::git_available() { return; }
    let fx = fx();
    common::run_git_ok(&fx.path, &["push", "-q", "origin", "HEAD:refs/heads/published"]);
    common::fetch_remote(&fx.path, "origin");
    Repository::open(&fx.path).unwrap().find_branch(&fx.head, BranchType::Local).unwrap()
        .set_upstream(Some("origin/published")).unwrap();
    let before = fx.bare_tip(&fx.head);
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx.reopen().prepare_push(&PushTarget::Upstream, false).unwrap();
    assert_eq!(push.branch(), "published");
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip("published").as_deref(), Some(ours.as_str()));
    assert_eq!(fx.bare_tip(&fx.head), before);
}

#[test]
fn set_upstream_push_publishes_the_branch_and_records_the_upstream() {
    if !common::git_available() { return; }
    let fx = fx();
    fx.session.create_and_checkout_branch("topic", None).unwrap();
    let ours = fx.commit_here("t.txt", "t\n");
    let push = fx.session.prepare_push(&set_upstream("origin", "topic-pub"), false).unwrap();
    assert_eq!((push.remote(), push.branch(), push.lease()), ("origin", "topic-pub", None));
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip("topic-pub").as_deref(), Some(ours.as_str()));
    let config = Repository::open(&fx.path).unwrap().config().unwrap().snapshot().unwrap();
    assert_eq!(config.get_str("branch.topic.remote").unwrap(), "origin");
    assert_eq!(config.get_str("branch.topic.merge").unwrap(), "refs/heads/topic-pub");
}

#[test]
fn push_behind_the_remote_is_push_rejected_non_fast_forward() {
    if !common::git_available() { return; }
    let fx = fx();
    fx.push_from_other("b.txt", "b\n");
    fx.commit_here("c.txt", "c\n");
    let err = fx.session.prepare_push(&PushTarget::Upstream, false).unwrap().run(None).unwrap_err();
    let (verb, kind, https, stderr) = network_failure(err);
    assert_eq!((verb, kind, https), ("push", NetworkErrorKind::PushRejectedNonFastForward, false), "{stderr}");
    assert!(stderr.contains("(fetch first)"), "{stderr}");
    fx.fetch();
    let err = fx.session.prepare_push(&PushTarget::Upstream, false).unwrap().run(None).unwrap_err();
    let (_, kind, _, stderr) = network_failure(err);
    assert_eq!(kind, NetworkErrorKind::PushRejectedNonFastForward);
    assert!(stderr.contains("(non-fast-forward)"), "{stderr}");
}

#[test]
fn force_push_with_a_holding_lease_replaces_the_remote_branch() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.fetch();
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx.session.prepare_push(&PushTarget::Upstream, true).unwrap();
    assert_eq!(push.lease(), Some(format!("refs/heads/{}:{theirs}", fx.head).as_str()));
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(ours.as_str()));
}

#[test]
fn force_push_is_lease_stale_when_the_remote_moved_after_the_last_fetch() {
    if !common::git_available() { return; }
    let fx = fx();
    fx.commit_here("c.txt", "c\n");
    let push = fx.session.prepare_push(&PushTarget::Upstream, true).unwrap();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let (_, kind, _, stderr) = network_failure(push.run(None).unwrap_err());
    assert_eq!(kind, NetworkErrorKind::LeaseStale, "{stderr}");
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(theirs.as_str()));
}

#[test]
fn force_push_without_a_tracking_ref_is_lease_stale_when_the_remote_branch_exists() {
    if !common::git_available() { return; }
    let fx = fx();
    common::run_git_ok(&fx.other, &["push", "-q", "origin", "HEAD:refs/heads/theirs-only"]);
    let before = fx.bare_tip("theirs-only");
    fx.commit_here("c.txt", "c\n");
    let push = fx.session.prepare_push(&set_upstream("origin", "theirs-only"), true).unwrap();
    assert_eq!(push.lease(), Some("refs/heads/theirs-only:"));
    let (_, kind, _, _) = network_failure(push.run(None).unwrap_err());
    assert_eq!(kind, NetworkErrorKind::LeaseStale);
    assert_eq!(fx.bare_tip("theirs-only"), before);
}

#[test]
fn force_push_without_a_tracking_ref_creates_a_new_remote_branch() {
    if !common::git_available() { return; }
    let fx = fx();
    let ours = fx.head_oid();
    fx.session.prepare_push(&set_upstream("origin", "fresh"), true).unwrap().run(None).unwrap();
    assert_eq!(fx.bare_tip("fresh").as_deref(), Some(ours.as_str()));
}

#[test]
fn push_https_flag_follows_the_push_url_not_the_fetch_url() {
    if !common::git_available() { return; }
    let fx = fx();
    let repo = Repository::open(&fx.path).unwrap();
    repo.remote_set_pushurl("origin", Some("https://example.test/me/x.git")).unwrap();
    assert!(fx.reopen().prepare_push(&PushTarget::Upstream, false).unwrap().https());
    repo.remote_set_url("origin", "https://example.test/me/x.git").unwrap();
    repo.remote_set_pushurl("origin", Some("git@example.test:me/x.git")).unwrap();
    let session = fx.reopen();
    assert!(!session.prepare_push(&PushTarget::Upstream, false).unwrap().https());
    assert!(session.prepare_fetch().unwrap().https());
}

#[test]
fn push_https_flag_follows_push_insteadof() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote_set_url("origin", "https://c.example/z.git").unwrap();
    fx.set_config("url.ssh://git@c.example/.pushInsteadOf", "https://c.example/");
    assert!(!fx.reopen().prepare_push(&PushTarget::Upstream, false).unwrap().https());
}

// ---------- remotes (git2) ----------

#[test]
fn list_remotes_is_sorted_with_the_raw_config_urls() {
    let (_d, path, _s) = plain();
    let repo = Repository::open(&path).unwrap();
    repo.remote("zeta", "gh:me/z.git").unwrap();
    repo.remote("alpha", "https://a.test/a.git").unwrap();
    repo.remote_set_pushurl("alpha", Some("git@a.test:a.git")).unwrap();
    repo.config().unwrap().set_str("url.https://github.com/.insteadOf", "gh:").unwrap();
    assert_eq!(
        RepoSession::open(&path).unwrap().list_remotes().unwrap(),
        [info("alpha", "https://a.test/a.git", Some("git@a.test:a.git")), info("zeta", "gh:me/z.git", None)]
    );
}

#[test]
fn add_remote_creates_it_with_the_default_refspec_and_an_optional_push_url() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "https://h.test/x.git", None).unwrap();
    session.add_remote("mirror", "/srv/m.git", Some("git@h.test:m.git")).unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("mirror", "/srv/m.git", Some("git@h.test:m.git")), info("origin", "https://h.test/x.git", None)]
    );
    let repo = Repository::open(&path).unwrap();
    let origin = repo.find_remote("origin").unwrap();
    assert_eq!(origin.fetch_refspecs().unwrap().get(0), Some("+refs/heads/*:refs/remotes/origin/*"));
}

#[test]
fn add_remote_with_an_invalid_name_is_invalid_remote_name() {
    let (_d, _p, session) = plain();
    for bad in ["", "a b", "-x", "a\0b", "bad..name"] {
        assert!(matches!(session.add_remote(bad, "/srv/x.git", None), Err(GitError::InvalidRemoteName(n)) if n == bad), "{bad:?}");
    }
    assert!(session.list_remotes().unwrap().is_empty());
}

#[test]
fn add_remote_with_a_taken_name_is_remote_exists() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    assert!(matches!(session.add_remote("origin", "/srv/b.git", None), Err(GitError::RemoteExists(n)) if n == "origin"));
    assert_eq!(session.list_remotes().unwrap(), [info("origin", "/srv/a.git", None)]);
}

#[test]
fn add_remote_with_an_invalid_url_is_invalid_remote_url() {
    let (_d, _p, session) = plain();
    for bad in ["", "   ", "-oProxyCommand=x", "a\nb"] {
        assert!(matches!(session.add_remote("origin", bad, None), Err(GitError::InvalidRemoteUrl(u)) if u == bad), "{bad:?}");
    }
    assert!(matches!(session.add_remote("origin", "/srv/x.git", Some("")), Err(GitError::InvalidRemoteUrl(_))));
    assert!(session.list_remotes().unwrap().is_empty());
}

#[test]
fn add_remote_checks_the_name_before_the_url() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    assert!(matches!(session.add_remote("a b", "", None), Err(GitError::InvalidRemoteName(_))));
    assert!(matches!(session.add_remote("origin", "", None), Err(GitError::RemoteExists(_))));
}

#[test]
fn update_remote_sets_the_urls_and_none_clears_the_push_url() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", Some("/srv/push.git")).unwrap();
    session.update_remote("origin", "origin", "/srv/b.git", None).unwrap();
    assert_eq!(session.list_remotes().unwrap(), [info("origin", "/srv/b.git", None)]);
    session.update_remote("origin", "origin", "/srv/b.git", None).unwrap(); // no push URL to clear
    session.update_remote("origin", "origin", "/srv/b.git", Some("/srv/p2.git")).unwrap();
    assert_eq!(session.list_remotes().unwrap(), [info("origin", "/srv/b.git", Some("/srv/p2.git"))]);
}

#[test]
fn update_remote_rename_moves_tracking_refs_and_upstream_config() {
    let (_d1, _d2, path, head, session) = tracked();
    let url = session.list_remotes().unwrap()[0].fetch_url.clone();
    session.update_remote("origin", "upstream", &url, None).unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_reference(&format!("refs/remotes/upstream/{head}")).is_ok());
    assert!(repo.find_reference(&format!("refs/remotes/origin/{head}")).is_err());
    let config = repo.config().unwrap().snapshot().unwrap();
    assert_eq!(config.get_str(&format!("branch.{head}.remote")).unwrap(), "upstream");
    assert_eq!(session.list_remotes().unwrap(), [info("upstream", &url, None)]);
}

#[test]
fn update_remote_reports_errors_in_order_and_changes_nothing() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    session.add_remote("other", "/srv/b.git", None).unwrap();
    assert!(matches!(session.update_remote("ghost", "ghost", "/x", None), Err(GitError::RemoteNotFound(_))));
    assert!(matches!(session.update_remote("-x", "y", "/x", None), Err(GitError::RemoteNotFound(_))));
    assert!(matches!(session.update_remote("origin", "a b", "", None), Err(GitError::InvalidRemoteName(_))));
    assert!(matches!(session.update_remote("origin", "other", " ", None), Err(GitError::InvalidRemoteUrl(_))));
    assert!(matches!(session.update_remote("origin", "origin", "/x", Some("")), Err(GitError::InvalidRemoteUrl(_))));
    assert!(matches!(session.update_remote("origin", "other", "/x", None), Err(GitError::RemoteExists(n)) if n == "other"));
    assert_eq!(session.list_remotes().unwrap(), [info("origin", "/srv/a.git", None), info("other", "/srv/b.git", None)]);
}

#[test]
fn remove_remote_deletes_tracking_refs_and_upstream_config() {
    let (_d1, _d2, path, head, session) = tracked();
    session.remove_remote("origin").unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_reference(&format!("refs/remotes/origin/{head}")).is_err());
    assert!(repo.config().unwrap().snapshot().unwrap().get_str(&format!("branch.{head}.remote")).is_err());
    assert!(session.list_remotes().unwrap().is_empty());
    assert!(matches!(session.remove_remote("origin"), Err(GitError::RemoteNotFound(_))));
    assert!(matches!(session.remove_remote("-x"), Err(GitError::RemoteNotFound(_))));
}
```

- [ ] **Step 5: Write the failing argv and secrets tests** (`tests/network_cli.rs`, its own test binary because `PATH` is process-wide)

```rust
//! The exact argv, environment and approve input of the GR-12 network runs,
//! observed through a scripted stand-in for `git` first on `PATH` (set once,
//! before any test body). Under `<workdir>/.git/` the stand-in records
//! `argv.txt` and `env.txt` for an operation, `helper-out.txt` (what the inline
//! helper prints when asked `get`), and, for `credential approve`,
//! `approve-argv.txt` plus every approve input appended to `approve-stdin.txt`.
//! `<workdir>/.git/behaviour`, when present, is sourced to script the outcome.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git_real_core::remote::auth::{Credentials, HELPER};
use git_real_core::{GitError, NetworkErrorKind, PushTarget, RepoSession};
use git2::Repository;

const SCRIPT: &str = r#"d="$2/.git"
if [ "$3" = credential ]; then
  printf '%s\n' "$@" > "$d/approve-argv.txt"
  cat >> "$d/approve-stdin.txt"
  exit 0
fi
printf '%s\n' "$@" > "$d/argv.txt"
printf '%s\n' "${GR_USERNAME-<unset>}" "${GR_TOKEN-<unset>}" > "$d/env.txt"
prev=
for a in "$@"; do
  if [ "$prev" = -c ]; then
    case "$a" in
      credential.*.helper=!*) h="${a#*.helper=!}"; sh -c "$h get" > "$d/helper-out.txt" ;;
    esac
  fi
  prev="$a"
done
[ -f "$d/behaviour" ] && . "$d/behaviour"
exit 0"#;

const TOKEN: &str = "TOPSECRET-123";
const URL: &str = "https://example.test/me/x.git";

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

fn use_fake_git() {
    FAKE_DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), SCRIPT);
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before any test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        dir
    });
}

fn read(path: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(path.join(".git").join(file)).ok()
}

/// Everything after `-C <workdir>` of the last operation.
fn after_workdir(path: &Path) -> Vec<String> {
    let args: Vec<String> = read(path, "argv.txt").expect("git was not run").lines().map(str::to_owned).collect();
    assert_eq!(args[0], "-C", "{args:?}");
    args[2..].to_vec()
}

fn behaviour(path: &Path, body: &str) {
    std::fs::write(path.join(".git").join("behaviour"), body).unwrap();
}

fn creds() -> Credentials {
    Credentials::new("https://example.test", "me", TOKEN).unwrap()
}

fn auth_args(origin: &str) -> Vec<String> {
    vec![
        "-c".into(),
        format!("credential.{origin}.helper="),
        "-c".into(),
        format!("credential.{origin}.helper={HELPER}"),
    ]
}

fn approved(url: &str) -> String {
    format!("url={url}\nusername=me\npassword={TOKEN}\n\n")
}

/// A repo whose HEAD branch tracks `origin`, fetched from a local bare repo
/// with git2 and then re-pointed at an HTTPS URL the stand-in never contacts.
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, String) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    Repository::open(&path).unwrap().remote_set_url("origin", URL).unwrap();
    (dir, bare_dir, path, head)
}

fn session(path: &Path) -> RepoSession {
    RepoSession::open(path).unwrap()
}

// ---------- argv ----------

#[test]
fn fetch_runs_fetch_all_without_credentials() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_fetch().unwrap().run(None).unwrap();
    assert_eq!(after_workdir(&path), ["fetch", "--all"]);
    assert_eq!(read(&path, "env.txt").unwrap(), "<unset>\n<unset>\n");
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn pull_fetches_only_the_upstream_remote() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_pull().unwrap().fetch(None).unwrap();
    assert_eq!(after_workdir(&path), ["fetch", "origin"]);
}

#[test]
fn push_to_the_upstream_names_the_remote_branch() {
    let (_d, _b, path, head) = fixture();
    session(&path).prepare_push(&PushTarget::Upstream, false).unwrap().run(None).unwrap();
    assert_eq!(after_workdir(&path), ["push", "origin", &format!("HEAD:refs/heads/{head}")]);
}

#[test]
fn set_upstream_push_adds_dash_u() {
    let (_d, _b, path, _h) = fixture();
    let target = PushTarget::SetUpstream { remote: "origin".into(), branch: "topic/x".into() };
    session(&path).prepare_push(&target, false).unwrap().run(None).unwrap();
    assert_eq!(after_workdir(&path), ["push", "-u", "origin", "HEAD:refs/heads/topic/x"]);
}

#[test]
fn force_push_carries_the_lease_before_the_remote() {
    let (_d, _b, path, head) = fixture();
    let oid = Repository::open(&path).unwrap().refname_to_id(&format!("refs/remotes/origin/{head}")).unwrap();
    session(&path).prepare_push(&PushTarget::Upstream, true).unwrap().run(None).unwrap();
    assert_eq!(
        after_workdir(&path),
        ["push", &format!("--force-with-lease=refs/heads/{head}:{oid}"), "origin", &format!("HEAD:refs/heads/{head}")]
    );
}

#[test]
fn set_upstream_force_push_without_a_tracking_ref_uses_an_empty_lease() {
    let (_d, _b, path, _h) = fixture();
    let target = PushTarget::SetUpstream { remote: "origin".into(), branch: "fresh".into() };
    session(&path).prepare_push(&target, true).unwrap().run(None).unwrap();
    assert_eq!(after_workdir(&path), ["push", "-u", "--force-with-lease=refs/heads/fresh:", "origin", "HEAD:refs/heads/fresh"]);
}

// ---------- credentials ----------

#[test]
fn fetch_with_credentials_scopes_the_helper_and_keeps_the_token_out_of_argv() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_fetch().unwrap().run(Some(&creds())).unwrap();
    let mut want = auth_args("https://example.test");
    want.extend(["fetch".to_owned(), "--all".to_owned()]);
    assert_eq!(after_workdir(&path), want);
    assert!(!read(&path, "argv.txt").unwrap().contains(TOKEN));
    assert_eq!(read(&path, "env.txt").unwrap(), format!("me\n{TOKEN}\n"));
    assert_eq!(read(&path, "helper-out.txt").unwrap(), format!("username=me\npassword={TOKEN}\n"));
}

#[test]
fn a_successful_run_with_credentials_approves_only_urls_on_the_credentials_origin() {
    let (_d, _b, path, _h) = fixture();
    {
        let repo = Repository::open(&path).unwrap();
        repo.remote("mirror", "https://example.test/me/mirror.git").unwrap();
        repo.remote("elsewhere", "https://other.test/me/x.git").unwrap();
        repo.remote("local", "/srv/x.git").unwrap();
    }
    session(&path).prepare_fetch().unwrap().run(Some(&creds())).unwrap();
    assert_eq!(
        read(&path, "approve-stdin.txt").unwrap(),
        format!("{}{}", approved("https://example.test/me/mirror.git"), approved(URL))
    );
    let approve_argv = read(&path, "approve-argv.txt").unwrap();
    assert_eq!(approve_argv.lines().skip(2).collect::<Vec<_>>(), ["credential", "approve"]);
    assert!(!approve_argv.contains(TOKEN));
}

#[test]
fn a_failed_run_never_approves() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "echo boom >&2\nexit 128");
    assert!(session(&path).prepare_fetch().unwrap().run(Some(&creds())).is_err());
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn pull_with_credentials_approves_the_upstream_url() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_pull().unwrap().fetch(Some(&creds())).unwrap();
    assert_eq!(after_workdir(&path)[4..], ["fetch", "origin"]);
    assert_eq!(read(&path, "approve-stdin.txt").unwrap(), approved(URL));
}

#[test]
fn push_with_credentials_approves_the_push_url_only() {
    let (_d, _b, path, head) = fixture();
    Repository::open(&path).unwrap().remote_set_pushurl("origin", Some("https://push.example.test/me/x.git")).unwrap();
    let push_creds = Credentials::new("https://push.example.test", "me", TOKEN).unwrap();
    session(&path).prepare_push(&PushTarget::Upstream, false).unwrap().run(Some(&push_creds)).unwrap();
    let mut want = auth_args("https://push.example.test");
    want.extend(["push".to_owned(), "origin".to_owned(), format!("HEAD:refs/heads/{head}")]);
    assert_eq!(after_workdir(&path), want);
    assert_eq!(read(&path, "approve-stdin.txt").unwrap(), approved("https://push.example.test/me/x.git"));
}

#[test]
fn tag_push_and_remote_deletes_pass_credentials_through() {
    let (_d, _b, path, head) = fixture();
    common::tag_lightweight(&path, "v1", Repository::open(&path).unwrap().head().unwrap().target().unwrap());
    let session = session(&path);
    let c = creds();
    session.prepare_tag_push("origin", "v1").unwrap().run(Some(&c)).unwrap();
    assert_eq!(after_workdir(&path)[..4], auth_args("https://example.test")[..]);
    assert_eq!(after_workdir(&path)[4..], ["push", "origin", "refs/tags/v1"]);
    session.prepare_remote_tag_delete("origin", "v1").unwrap().run(Some(&c)).unwrap();
    assert_eq!(after_workdir(&path)[4..], ["push", "origin", "--delete", "tags/v1"]);
    session.prepare_remote_delete("origin", &head).unwrap().run(Some(&c)).unwrap();
    assert_eq!(after_workdir(&path)[4..], ["push", "origin", "--delete", &format!("heads/{head}")]);
    assert_eq!(read(&path, "approve-stdin.txt").unwrap(), approved(URL).repeat(3));
}

// ---------- failure mapping ----------

#[test]
fn an_https_auth_failure_carries_kind_https_origin_and_output() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, r#"echo out
printf "fatal: could not read Username for 'https://example.test': terminal prompts disabled\n" >&2
exit 128"#);
    match session(&path).prepare_fetch().unwrap().run(None).unwrap_err() {
        GitError::NetworkFailed { verb, kind, https, origin, code, stdout, stderr } => {
            assert_eq!(
                (verb, kind, https, origin.as_deref(), code),
                ("fetch", NetworkErrorKind::HttpsAuthRequired, true, Some("https://example.test"), Some(128))
            );
            assert_eq!(stdout, "out\n");
            assert!(stderr.starts_with("fatal: could not read Username"), "{stderr}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_non_auth_failure_has_no_origin() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "printf ' ! [rejected]        HEAD -> main (fetch first)\\n' >&2\nexit 1");
    let err = session(&path).prepare_push(&PushTarget::Upstream, false).unwrap().run(None).unwrap_err();
    assert!(matches!(
        err,
        GitError::NetworkFailed { verb: "push", kind: NetworkErrorKind::PushRejectedNonFastForward, https: true, origin: None, code: Some(1), .. }
    ), "{err:?}");
}

#[test]
fn a_failure_on_a_local_remote_is_not_https() {
    let (_d, _b, path, _h) = fixture();
    Repository::open(&path).unwrap().remote_set_url("origin", "/srv/x.git").unwrap();
    behaviour(&path, "exit 1");
    let err = session(&path).prepare_pull().unwrap().fetch(None).unwrap_err();
    assert!(matches!(err, GitError::NetworkFailed { verb: "pull", https: false, kind: NetworkErrorKind::Other, .. }), "{err:?}");
}

#[test]
fn a_killed_run_reports_no_exit_code() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "kill -9 $$");
    let err = session(&path).prepare_fetch().unwrap().run(None).unwrap_err();
    assert!(matches!(err, GitError::NetworkFailed { code: None, kind: NetworkErrorKind::Other, .. }), "{err:?}");
}

#[test]
fn credentials_never_appear_in_a_network_error() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "printf '%s\\n' \"$@\" >&2\nexit 1");
    let err = session(&path).prepare_fetch().unwrap().run(Some(&creds())).unwrap_err();
    for text in [format!("{err:?}"), err.to_string()] {
        assert!(!text.contains(TOKEN), "{text}");
    }
}
```

- [ ] **Step 6: Migrate the existing push tests (test role)**

- `tests/tags.rs`, `tests/cli_argv.rs`, `tests/push_delete.rs`, `tests/cli_unavailable.rs`: every `.run()` on a `PushDelete`, `TagPush` or `TagPushDelete` becomes `.run(None)`.
- `GitError::PushFailed { … }` patterns become `GitError::NetworkFailed { … }` with the same fields plus `..` (`tags.rs` three sites; `push_delete.rs` two sites; `cli_argv.rs` three tests). In `cli_argv.rs`, `push_failure_carries_exit_code_stdout_and_stderr_separately` also asserts `verb == "push"` and `kind == NetworkErrorKind::Other`; `tag_push_failure_is_push_failed_with_git_output` is renamed `tag_push_failure_is_network_failed_with_git_output`.
- `push_delete.rs` `run_reports_push_failure_when_the_remote_is_unreachable` additionally asserts `kind == NetworkErrorKind::RepoNotFound` (its remote is a missing local path).

- [ ] **Step 6b: Migrate and extend the app crate's error tests (test role)**

`src-tauri/tests/error.rs`:

- `app_error_kind_for_each_git_error_variant`: drop the `GitError::PushFailed` case; add `(GitError::NoRemotes, AppErrorKind::NoRemotes, None)`, `NoUpstream`, `DetachedHead`, `InvalidRemoteName("a b".into())`, `InvalidRemoteUrl(String::new())`, `RemoteExists("origin".into())` and `InvalidCredentials` the same way; the loop's `AppError { kind: expected, message }` gains `network: None`, as do the three other `AppError { … }` literals in the file.
- `branch_error_kinds_serialize_camel_case` drops `(AppErrorKind::PushFailed, "pushFailed")`.
- The `push_failed(code, stdout, stderr)` helper becomes `network_failed(code, stdout, stderr)`, building `GitError::NetworkFailed { verb: "push", kind: NetworkErrorKind::Other, https: false, origin: None, code, stdout, stderr }`; the four `push_failed_message_*` tests become `network_failed_message_*` with the same expected messages and `kind == AppErrorKind::NetworkFailed`.
- New:

```rust
#[test]
fn remote_kinds_serialize_camel_case() {
    let cases = [
        (AppErrorKind::NetworkFailed, "networkFailed"),
        (AppErrorKind::NoRemotes, "noRemotes"),
        (AppErrorKind::NoUpstream, "noUpstream"),
        (AppErrorKind::DetachedHead, "detachedHead"),
        (AppErrorKind::InvalidRemoteName, "invalidRemoteName"),
        (AppErrorKind::InvalidRemoteUrl, "invalidRemoteUrl"),
        (AppErrorKind::RemoteExists, "remoteExists"),
        (AppErrorKind::InvalidCredentials, "invalidCredentials"),
    ];
    for (kind, expected) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(expected));
    }
}

#[test]
fn network_failed_carries_the_network_payload() {
    let stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    let app: AppError = GitError::NetworkFailed {
        verb: "fetch",
        kind: NetworkErrorKind::HttpsAuthRequired,
        https: true,
        origin: Some("https://github.com".into()),
        code: Some(128),
        stdout: String::new(),
        stderr: stderr.into(),
    }
    .into();
    assert_eq!(app.kind, AppErrorKind::NetworkFailed);
    assert_eq!(app.message, stderr.trim());
    assert_eq!(
        app.network,
        Some(NetworkInfo { verb: "fetch".into(), kind: NetworkErrorKind::HttpsAuthRequired, https: true, origin: Some("https://github.com".into()) })
    );
    assert_eq!(
        serde_json::to_value(&app).unwrap(),
        json!({
            "kind": "networkFailed",
            "message": stderr.trim(),
            "network": { "verb": "fetch", "kind": "httpsAuthRequired", "https": true, "origin": "https://github.com" }
        })
    );
}

#[test]
fn other_errors_serialize_without_a_network_key() {
    assert_eq!(
        serde_json::to_value(AppError::from(GitError::NoUpstream)).unwrap(),
        json!({ "kind": "noUpstream", "message": "the current branch has no upstream branch" })
    );
}

#[test]
fn remote_error_messages_use_the_core_display_text() {
    let msg = |e: GitError| AppError::from(e).message;
    assert_eq!(msg(GitError::NoRemotes), "this repository has no remotes");
    assert_eq!(msg(GitError::DetachedHead), "HEAD is not on a branch");
    assert_eq!(msg(GitError::InvalidRemoteName("a b".into())), "a b is not a valid remote name");
    assert_eq!(msg(GitError::InvalidRemoteUrl(String::new())), "\"\" is not a valid remote URL");
    assert_eq!(msg(GitError::RemoteExists("origin".into())), "a remote named origin already exists");
    assert_eq!(msg(GitError::InvalidCredentials), "the credentials must name an http(s) origin and contain no line breaks");
}
```

`src-tauri/tests/refs_commands.rs` (the remote-delete failure test) and `src-tauri/tests/tag_commands.rs` (`push_tag_and_delete_remote_tag_inner_round_trip`): `AppErrorKind::PushFailed` becomes `AppErrorKind::NetworkFailed`, and each also asserts `err.network.unwrap().verb == "push"`.

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test network_classify --test credential_helper --test remote_sync --test network_cli`. Expected: compile errors (no `remote::auth`, `NetworkErrorKind`, `prepare_fetch`, …). `cargo test --test error` fails to compile too (no `NetworkInfo`, `GitError::NetworkFailed`).

- [ ] **Step 8: Implement the model and errors**

`model/remote.rs` holds the four DTOs exactly as in Interfaces, each with a one-line doc (`RemoteInfo.push_url`: "The configured `remote.<name>.pushurl`, `None` when unset."). `error.rs`: remove `PushFailed`; after `TagNotFound` add, with `use crate::model::NetworkErrorKind;`:

```rust
    #[error("this repository has no remotes")]
    NoRemotes,
    #[error("the current branch has no upstream branch")]
    NoUpstream,
    #[error("HEAD is not on a branch")]
    DetachedHead,
    #[error("{0} is not a valid remote name")]
    InvalidRemoteName(String),
    #[error("{0:?} is not a valid remote URL")]
    InvalidRemoteUrl(String),
    #[error("a remote named {0} already exists")]
    RemoteExists(String),
    #[error("the credentials must name an http(s) origin and contain no line breaks")]
    InvalidCredentials,
    /// A fetch, pull or push that git refused; `kind` says what to do next.
    #[error("git {verb} failed (exit code {code:?}): {stderr}")]
    NetworkFailed {
        verb: &'static str,
        kind: NetworkErrorKind,
        /// The operation talks to an `http(s)://` URL, so a credential prompt can help.
        https: bool,
        /// `scheme://host[:port]` git asked credentials for (HTTPS auth kinds only).
        origin: Option<String>,
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
```

- [ ] **Step 9: Implement `remote/auth.rs` and `remote/classify.rs`**

```rust
//! HTTPS credentials for one git run (spec §3.1): a one-shot inline helper,
//! scoped to one origin, reads them from the environment, so they never reach
//! the command line; after a successful run `git credential approve` hands
//! them to the user's own helper.

use std::fmt;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

use crate::error::GitError;
use crate::git_cli;

/// The inline helper. `printf '%s\n'`, not `echo`: dash's `echo` expands
/// backslash escapes and would corrupt a token. Only `get` is answered.
pub const HELPER: &str = r#"!f() { test "$1" = get || return 0; printf '%s\n' "username=$GR_USERNAME" "password=$GR_TOKEN"; }; f"#;
const USERNAME_ENV: &str = "GR_USERNAME";
const TOKEN_ENV: &str = "GR_TOKEN";

/// A username and token for one `http(s)://host[:port]` origin.
#[derive(Clone, Deserialize)]
#[serde(try_from = "CredentialsInput")]
pub struct Credentials {
    origin: String,
    username: String,
    token: String,
}

/// The IPC shape, validated through [`Credentials::new`]. No `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsInput {
    origin: String,
    username: String,
    token: String,
}

impl TryFrom<CredentialsInput> for Credentials {
    type Error = GitError;
    fn try_from(input: CredentialsInput) -> Result<Self, GitError> {
        Self::new(&input.origin, &input.username, &input.token)
    }
}

impl Credentials {
    /// `InvalidCredentials` unless `origin` passes the origin rule and both
    /// values are non-empty without line breaks or NUL (which could forge
    /// helper output or config).
    pub fn new(origin: &str, username: &str, token: &str) -> Result<Self, GitError> {
        let clean = |s: &str| !s.is_empty() && !s.contains(['\n', '\r', '\0']);
        if !is_valid_origin(origin) || !clean(username) || !clean(token) {
            return Err(GitError::InvalidCredentials);
        }
        Ok(Self { origin: origin.to_owned(), username: username.to_owned(), token: token.to_owned() })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn username(&self) -> &str {
        &self.username
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("token", &"***")
            .finish()
    }
}

/// Adds the scoped helper (`-c credential.<origin>.helper=` resets the list
/// for that origin only, then the inline helper) and the two env vars. Call it
/// after `-C <workdir>` and before the subcommand. `None` adds nothing.
pub fn apply(cmd: &mut Command, creds: Option<&Credentials>) {
    let Some(c) = creds else { return };
    let key = format!("credential.{}.helper", c.origin);
    cmd.arg("-c")
        .arg(format!("{key}="))
        .arg("-c")
        .arg(format!("{key}={HELPER}"))
        .env(USERNAME_ENV, &c.username)
        .env(TOKEN_ENV, &c.token);
}

/// Stores `creds` for `url` in the user's credential helper. Failure is
/// ignored: no helper configured is not an error.
pub(crate) fn approve(git: &Path, workdir: &Path, url: &str, creds: &Credentials) {
    if url.contains(['\n', '\r', '\0']) {
        return;
    }
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).args(["credential", "approve"]);
    let input = format!("url={url}\nusername={}\npassword={}\n\n", creds.username, creds.token);
    let _ = git_cli::capture_with_input(&mut cmd, input.as_bytes());
}

/// True for an `http://` or `https://` URL (ASCII case-insensitive).
pub(crate) fn is_http(url: &str) -> bool {
    ["http://", "https://"]
        .iter()
        .any(|p| url.get(..p.len()).is_some_and(|s| s.eq_ignore_ascii_case(p)))
}

/// `scheme://host[:port]` of an HTTP(S) URL, userinfo and path dropped.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let origin = format!("{scheme}://{host}");
    is_valid_origin(&origin).then_some(origin)
}

/// The origin rule (Global Constraints): it becomes part of a `-c` config key.
fn is_valid_origin(origin: &str) -> bool {
    let Some(authority) = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")) else {
        return false;
    };
    let (host_ok, port) = match authority.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((h, port)) => (!h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.'), port),
            None => return false,
        },
        None => {
            let (h, port) = authority.find(':').map_or((authority, ""), |i| authority.split_at(i));
            (!h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'), port)
        }
    };
    let port_ok = port.is_empty()
        || port.strip_prefix(':').is_some_and(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    host_ok && port_ok
}
```

```rust
//! Turning git's stderr into a [`NetworkErrorKind`] the UI can act on, and
//! finding the origin git asked credentials for.

use super::auth::origin_of;
use crate::model::NetworkErrorKind;

const UNREACHABLE: [&str; 6] = [
    "Could not resolve host",
    "Connection refused",
    "Connection timed out",
    "Network is unreachable",
    "Failed to connect to",
    "Couldn't connect to server",
];

/// First match wins, in the order of the Global Constraints list.
pub fn classify(stderr: &str) -> NetworkErrorKind {
    let has = |s: &str| stderr.contains(s);
    let rejected = has("[rejected]");
    if has("could not read Username") || has("could not read Password") || has("terminal prompts disabled") {
        NetworkErrorKind::HttpsAuthRequired
    } else if has("Authentication failed for") || has("returned error: 401") || has("returned error: 403") {
        NetworkErrorKind::HttpsAuthRejected
    } else if has("Permission denied (publickey") {
        NetworkErrorKind::SshAuthFailed
    } else if has("Host key verification failed") {
        NetworkErrorKind::HostKeyUnverified
    } else if UNREACHABLE.iter().any(|s| has(s)) {
        NetworkErrorKind::HostUnreachable
    } else if has("Repository not found")
        || has("does not appear to be a git repository")
        || stderr.lines().any(is_missing_repository_line)
    {
        NetworkErrorKind::RepoNotFound
    } else if rejected && (has("(fetch first)") || has("(non-fast-forward)")) {
        NetworkErrorKind::PushRejectedNonFastForward
    } else if rejected && has("(stale info)") {
        NetworkErrorKind::LeaseStale
    } else {
        NetworkErrorKind::Other
    }
}

/// git's HTTP 404: `fatal: repository '<url>' not found`.
fn is_missing_repository_line(line: &str) -> bool {
    line.starts_with("fatal: repository '") && line.trim_end().ends_with("' not found")
}

/// The origin of the first `'`-quoted HTTP(S) URL on one of git's own
/// `fatal:` lines; a server's `remote:` lines never count.
pub fn auth_origin(stderr: &str) -> Option<String> {
    stderr.lines().filter(|l| l.starts_with("fatal: ")).find_map(|line| {
        let (_, rest) = line.split_once('\'')?;
        let (url, _) = rest.split_once('\'')?;
        origin_of(url)
    })
}
```

- [ ] **Step 10: Implement the shared runner, `remotes.rs`, and the push-type migration**

`remote/mod.rs` (module list per Files; `run_push` replaced):

```rust
/// Runs `git -C <workdir> [credential args] <args...>` for a network
/// operation. A non-zero exit is `NetworkFailed`; after a successful run with
/// credentials, each of `urls` on the credentials' origin is approved.
pub(crate) fn run_network(
    git: &Path,
    workdir: &Path,
    verb: &'static str,
    args: &[&str],
    urls: &[String],
    creds: Option<&Credentials>,
) -> Result<(), GitError> {
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir);
    auth::apply(&mut cmd, creds);
    cmd.args(args);
    let output = git_cli::capture(&mut cmd)?;
    if output.status.success() {
        if let Some(c) = creds {
            for url in urls.iter().filter(|u| auth::origin_of(u).as_deref() == Some(c.origin())) {
                auth::approve(git, workdir, url, c);
            }
        }
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let kind = classify::classify(&stderr);
    let auth = matches!(kind, NetworkErrorKind::HttpsAuthRequired | NetworkErrorKind::HttpsAuthRejected);
    Err(GitError::NetworkFailed {
        verb,
        kind,
        https: urls.iter().any(|u| auth::is_http(u)),
        origin: if auth { classify::auth_origin(&stderr) } else { None },
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr,
    })
}

/// `git push <remote> <args...>` through [`run_network`] with verb `push`.
pub(crate) fn run_push(
    git: &Path,
    workdir: &Path,
    remote: &str,
    args: &[&str],
    urls: &[String],
    creds: Option<&Credentials>,
) -> Result<(), GitError> {
    let mut argv = vec!["push", remote];
    argv.extend_from_slice(args);
    run_network(git, workdir, "push", &argv, urls, creds)
}
```

`PushDelete`, `TagPush`, `TagPushDelete`: a fourth field `urls: Vec<String>` (the push URL, empty when the remote has none), `new(git, workdir, remote, name, urls)`, and `pub fn run(&self, creds: Option<&Credentials>)` calling `run_push(&self.git, &self.workdir, &self.remote, &[…as today…], &self.urls, creds)`. Their docs drop "`PushFailed`". `refs/mod.rs` `prepare_remote_delete` and `refs/tags.rs` both prepares pass `self.used_url(remote, Direction::Push)?.into_iter().collect()` after their existing checks. `refs/mod.rs`: `pub(crate) fn ensure_remote`, `pub(crate) fn is_not_found`.

`remote/remotes.rs`:

```rust
//! Remote configuration through git2 (ADR 0001: config and ref writes are
//! local), plus the HEAD, upstream and URL lookups the network operations use.

use git2::ErrorCode;

use crate::error::GitError;
use crate::model::RemoteInfo;
use crate::refs::is_not_found;
use crate::repo::RepoSession;

/// Which of a remote's URLs an operation talks to.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Direction {
    Fetch,
    Push,
}

/// A local branch's upstream on a configured remote.
#[derive(Debug)]
pub(crate) struct Upstream {
    pub(crate) remote: String,
    /// The branch on the remote (`branch.<b>.merge` without `refs/heads/`).
    pub(crate) branch: String,
    /// The remote-tracking refname, such as `refs/remotes/origin/main`.
    pub(crate) tracking_ref: String,
}

fn validate_remote_name(name: &str) -> Result<(), GitError> {
    // `Remote::is_valid_name` unwraps a CString, so a NUL byte is refused first.
    if name.contains('\0') || name.starts_with('-') || !git2::Remote::is_valid_name(name) {
        return Err(GitError::InvalidRemoteName(name.to_owned()));
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), GitError> {
    if url.trim().is_empty() || url.starts_with('-') || url.contains(['\n', '\r', '\0']) {
        return Err(GitError::InvalidRemoteUrl(url.to_owned()));
    }
    Ok(())
}

impl RepoSession {
    /// Every remote, sorted by name, with the URLs as configured (not rewritten).
    pub fn list_remotes(&self) -> Result<Vec<RemoteInfo>, GitError> {
        let config = self.repo().config()?;
        let mut remotes: Vec<RemoteInfo> = self
            .remote_names()?
            .into_iter()
            .map(|name| RemoteInfo {
                fetch_url: config.get_string(&format!("remote.{name}.url")).unwrap_or_default(),
                push_url: config.get_string(&format!("remote.{name}.pushurl")).ok(),
                name,
            })
            .collect();
        remotes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(remotes)
    }

    pub fn add_remote(&self, name: &str, url: &str, push_url: Option<&str>) -> Result<(), GitError> {
        validate_remote_name(name)?;
        let repo = self.repo();
        if repo.find_remote(name).is_ok() {
            return Err(GitError::RemoteExists(name.to_owned()));
        }
        validate_url(url)?;
        push_url.map(validate_url).transpose()?;
        repo.remote(name, url)?;
        if push_url.is_some() {
            repo.remote_set_pushurl(name, push_url)?;
        }
        Ok(())
    }

    /// Renames first (git2 moves the tracking refs and `branch.*.remote`), then
    /// sets the URL and the push URL (`None` clears it).
    pub fn update_remote(&self, name: &str, new_name: &str, url: &str, push_url: Option<&str>) -> Result<(), GitError> {
        self.ensure_remote(name)?;
        validate_remote_name(new_name)?;
        validate_url(url)?;
        push_url.map(validate_url).transpose()?;
        let repo = self.repo();
        if new_name != name {
            if repo.find_remote(new_name).is_ok() {
                return Err(GitError::RemoteExists(new_name.to_owned()));
            }
            repo.remote_rename(name, new_name)?;
        }
        repo.remote_set_url(new_name, url)?;
        repo.remote_set_pushurl(new_name, push_url)?;
        Ok(())
    }

    /// git2 also deletes the remote's tracking refs and its branches' upstream config.
    pub fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.ensure_remote(name)?;
        self.repo().remote_delete(name)?;
        Ok(())
    }

    pub(crate) fn remote_names(&self) -> Result<Vec<String>, GitError> {
        let mut names: Vec<String> = self.repo().remotes()?.iter().flatten().map(str::to_owned).collect();
        names.sort();
        Ok(names)
    }

    /// The URL git uses for `remote` in `direction`; git2 applies `insteadOf`
    /// and `pushInsteadOf`. `None` when the remote has no URL.
    pub(crate) fn used_url(&self, remote: &str, direction: Direction) -> Result<Option<String>, GitError> {
        let r = self.repo().find_remote(remote)?;
        let bytes = match direction {
            Direction::Fetch => r.url_bytes(),
            Direction::Push => r.pushurl_bytes().unwrap_or(r.url_bytes()),
        };
        Ok((!bytes.is_empty()).then(|| String::from_utf8_lossy(bytes).into_owned()))
    }

    /// The local branch HEAD is on.
    pub(crate) fn head_branch(&self) -> Result<String, GitError> {
        match self.repo().head() {
            Ok(head) if head.is_branch() => Ok(String::from_utf8_lossy(head.shorthand_bytes()).into_owned()),
            Ok(_) => Err(GitError::DetachedHead),
            Err(e) if e.code() == ErrorCode::UnbornBranch => Err(GitError::UnbornHead),
            Err(e) => Err(e.into()),
        }
    }

    /// `branch`'s upstream; `None` without one, for an upstream on `.`, or for
    /// a merge ref outside `refs/heads/`.
    pub(crate) fn upstream_of(&self, branch: &str) -> Result<Option<Upstream>, GitError> {
        let repo = self.repo();
        let refname = format!("refs/heads/{branch}");
        let remote = match repo.branch_upstream_remote(&refname) {
            Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if remote == "." {
            return Ok(None);
        }
        let merge = match repo.config()?.get_string(&format!("branch.{branch}.merge")) {
            Ok(m) => m,
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let Some(remote_branch) = merge.strip_prefix("refs/heads/") else {
            return Ok(None);
        };
        let tracking_ref = match repo.branch_upstream_name(&refname) {
            Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
            Err(e) if is_not_found(&e) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        self.ensure_remote(&remote)?;
        Ok(Some(Upstream { remote, branch: remote_branch.to_owned(), tracking_ref }))
    }
}
```

If libgit2 reports clearing an absent push URL as NotFound (test `update_remote_sets_the_urls_and_none_clears_the_push_url` calls it twice), the developer treats that NotFound as success in `update_remote`.

- [ ] **Step 11: Implement `fetch.rs`, `pull.rs`, `push.rs`**

```rust
//! `git fetch --all` (spec §3.4).

use std::path::PathBuf;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::repo::RepoSession;

/// A validated fetch of every remote, ready to run once the session lock is released.
#[derive(Debug)]
pub struct Fetch {
    git: PathBuf,
    workdir: PathBuf,
    /// Every remote's fetch URL, in remote-name order.
    urls: Vec<String>,
}

impl Fetch {
    /// True when any remote's fetch URL is HTTP(S), so a credential prompt can help.
    pub fn https(&self) -> bool {
        self.urls.iter().any(|u| is_http(u))
    }

    /// Runs `git -C <workdir> fetch --all`; pruning follows the user's `fetch.prune`.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        run_network(&self.git, &self.workdir, "fetch", &["fetch", "--all"], &self.urls, creds)
    }
}

impl RepoSession {
    /// `NoRemotes` when there is nothing to fetch (`git fetch --all` would exit 0 silently).
    pub fn prepare_fetch(&self) -> Result<Fetch, GitError> {
        let names = self.remote_names()?;
        if names.is_empty() {
            return Err(GitError::NoRemotes);
        }
        let mut urls = Vec::new();
        for name in &names {
            urls.extend(self.used_url(name, Direction::Fetch)?);
        }
        let (git, workdir) = self.git()?;
        Ok(Fetch { git, workdir: workdir.to_path_buf(), urls })
    }
}
```

`pull.rs`:

```rust
//! Pull = `git fetch <remote>` (after the session lock is released) and then,
//! under the lock again, the existing fast-forward, merge or rebase (spec §3.5).

use std::path::PathBuf;

use git2::Config;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::model::{FastForwardCheck, MergeMode, OperationOutcome, PullMode};
use crate::refs::is_not_found;
use crate::repo::RepoSession;

#[derive(Debug)]
pub struct Pull {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    /// Short upstream name for merge / rebase, such as `origin/main`.
    upstream: String,
    urls: Vec<String>,
}

impl Pull {
    pub fn remote(&self) -> &str { &self.remote }
    pub fn upstream(&self) -> &str { &self.upstream }
    pub fn https(&self) -> bool { self.urls.iter().any(|u| is_http(u)) }

    /// Runs `git -C <workdir> fetch <remote>`; a failure has verb `pull`.
    pub fn fetch(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        run_network(&self.git, &self.workdir, "pull", &["fetch", &self.remote], &self.urls, creds)
    }
}

/// `Some(mode)` when `key` is set: a boolean, or git's `merges` / `interactive` spellings.
fn rebase_setting(config: &Config, key: &str) -> Result<Option<PullMode>, GitError> {
    match config.get_bool(key) {
        Ok(true) => Ok(Some(PullMode::Rebase)),
        Ok(false) => Ok(Some(PullMode::Merge)),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(_) => {
            let value = config.get_string(key).unwrap_or_default();
            Ok(Some(if matches!(value.as_str(), "merges" | "m" | "interactive" | "i") { PullMode::Rebase } else { PullMode::Merge }))
        }
    }
}

impl RepoSession {
    /// `branch.<head>.rebase`, else `pull.rebase`, else `Merge`.
    pub fn pull_default_mode(&self) -> Result<PullMode, GitError> {
        let config = self.repo().config()?;
        if let Ok(branch) = self.head_branch() {
            if let Some(mode) = rebase_setting(&config, &format!("branch.{branch}.rebase"))? {
                return Ok(mode);
            }
        }
        Ok(rebase_setting(&config, "pull.rebase")?.unwrap_or(PullMode::Merge))
    }

    pub fn prepare_pull(&self) -> Result<Pull, GitError> {
        self.ensure_clean()?;
        let branch = self.head_branch()?;
        let up = self.upstream_of(&branch)?.ok_or(GitError::NoUpstream)?;
        let upstream = up.tracking_ref.strip_prefix("refs/remotes/").unwrap_or(&up.tracking_ref).to_owned();
        let urls = self.used_url(&up.remote, Direction::Fetch)?.into_iter().collect();
        let (git, workdir) = self.git()?;
        Ok(Pull { git, workdir: workdir.to_path_buf(), remote: up.remote, upstream, urls })
    }

    /// Integrates the fetched upstream: `Rebase` replays onto it; `Merge`
    /// fast-forwards when it can, records a merge commit when the histories
    /// diverged, and does nothing when HEAD already contains it.
    pub fn integrate_pull(&self, pull: &Pull, mode: PullMode) -> Result<OperationOutcome, GitError> {
        match mode {
            PullMode::Rebase => self.rebase_onto(&pull.upstream),
            PullMode::Merge => match self.can_fast_forward(&pull.upstream)? {
                FastForwardCheck::UpToDate => Ok(OperationOutcome::Completed),
                FastForwardCheck::Possible => self.merge_branch(&pull.upstream, MergeMode::FastForward),
                FastForwardCheck::Diverged => self.merge_branch(&pull.upstream, MergeMode::Merge),
            },
        }
    }
}
```

(rustfmt expands the one-line accessors.) `push.rs`:

```rust
//! `git push` of the current branch to its upstream or a new one, optionally
//! with `--force-with-lease` (spec §3.6).

use std::path::PathBuf;

use super::auth::{Credentials, is_http};
use super::remotes::Direction;
use super::run_network;
use crate::error::GitError;
use crate::model::PushTarget;
use crate::refs::validate_branch_name;
use crate::repo::RepoSession;

#[derive(Debug)]
pub struct Push {
    git: PathBuf,
    workdir: PathBuf,
    remote: String,
    /// The branch on the remote.
    branch: String,
    /// `refs/heads/<branch>:<oid>`, `<oid>` empty when there was no tracking ref.
    lease: Option<String>,
    set_upstream: bool,
    urls: Vec<String>,
}

impl Push {
    pub fn remote(&self) -> &str { &self.remote }
    pub fn branch(&self) -> &str { &self.branch }
    pub fn lease(&self) -> Option<&str> { self.lease.as_deref() }
    pub fn https(&self) -> bool { self.urls.iter().any(|u| is_http(u)) }

    /// `git push [-u] [--force-with-lease=<lease>] <remote> HEAD:refs/heads/<branch>`.
    pub fn run(&self, creds: Option<&Credentials>) -> Result<(), GitError> {
        let lease = self.lease.as_ref().map(|l| format!("--force-with-lease={l}"));
        let refspec = format!("HEAD:refs/heads/{}", self.branch);
        let mut args = vec!["push"];
        if self.set_upstream {
            args.push("-u");
        }
        if let Some(lease) = &lease {
            args.push(lease);
        }
        args.extend([self.remote.as_str(), refspec.as_str()]);
        run_network(&self.git, &self.workdir, "push", &args, &self.urls, creds)
    }
}

impl RepoSession {
    pub fn prepare_push(&self, target: &PushTarget, force: bool) -> Result<Push, GitError> {
        let local = self.head_branch()?;
        let (remote, branch, tracking_ref, set_upstream) = match target {
            PushTarget::Upstream => {
                let up = self.upstream_of(&local)?.ok_or(GitError::NoUpstream)?;
                (up.remote, up.branch, up.tracking_ref, false)
            }
            PushTarget::SetUpstream { remote, branch } => {
                self.ensure_remote(remote)?;
                validate_branch_name(branch)?;
                (remote.clone(), branch.clone(), format!("refs/remotes/{remote}/{branch}"), true)
            }
        };
        // A missing tracking ref leases "expect absent": git refuses to replace a branch we never saw.
        let lease = force.then(|| {
            let oid = self.repo().refname_to_id(&tracking_ref).map(|o| o.to_string()).unwrap_or_default();
            format!("refs/heads/{branch}:{oid}")
        });
        let urls = self.used_url(&remote, Direction::Push)?.into_iter().collect();
        let (git, workdir) = self.git()?;
        Ok(Push { git, workdir: workdir.to_path_buf(), remote, branch, lease, set_upstream, urls })
    }
}
```

`lib.rs`: `pub use remote::auth::Credentials;` after `pub use recent::RecentRepos;`.

- [ ] **Step 12: Implement the `AppError` mapping**

`src-tauri/src/error.rs`: drop `PushFailed` from `AppErrorKind` and its arms; after `TagNotFound` add `NetworkFailed, NoRemotes, NoUpstream, DetachedHead, InvalidRemoteName, InvalidRemoteUrl, RemoteExists, InvalidCredentials` with one arm each. Then:

```rust
/// What the UI needs to act on a network failure; stderr stays in `message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub verb: String,
    pub kind: NetworkErrorKind,
    pub https: bool,
    pub origin: Option<String>,
}

pub struct AppError {
    pub kind: AppErrorKind,
    pub message: String,
    /// Present for `networkFailed` only; omitted from the JSON otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkInfo>,
}
```

In `From<GitError>`, the message arm `GitError::NetworkFailed { verb, code, stdout, stderr, .. } => cli_failure_message(verb, *code, stdout, stderr)` replaces the `PushFailed` one, and

```rust
        let network = match &error {
            GitError::NetworkFailed { verb, kind, https, origin, .. } => Some(NetworkInfo {
                verb: (*verb).to_owned(),
                kind: *kind,
                https: *https,
                origin: origin.clone(),
            }),
            _ => None,
        };
```

`AppError::unknown_repo` and `run_blocking`'s literal set `network: None`. `commands/refs.rs` `delete_remote_branch_inner` and `commands/tags.rs` `push_tag_inner` / `delete_remote_tag_inner` call `.run(None)` (their `credentials` parameters arrive in Task 2).

- [ ] **Step 13: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`. Expected: all green, the migrated GR-7 / GR-11b push tests included.

- [ ] **Step 14: Commit**

```bash
git add src-tauri
git commit -m "feat(core): GR-12 fetch, pull, push, credentials and remote management"
```

---

### Task 2: App layer commands and the IPC seam

**Files:**

- Create: `src-tauri/src/commands/remote.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod remote;` after `refs`), `src-tauri/src/lib.rs` (eight handlers after `commands::tags::delete_remote_tag`), `src-tauri/src/commands/refs.rs` and `src-tauri/src/commands/tags.rs` (`credentials` on `delete_remote_branch`, `push_tag`, `delete_remote_tag`)
- Modify: `src/lib/ipc/types.ts`, `src/lib/ipc/commands.ts`, `src/lib/ipc/errors.ts`, `src/lib/query/keys.ts`
- Test: `src-tauri/tests/remote_commands.rs` (new); `src-tauri/tests/refs_commands.rs`, `src-tauri/tests/tag_commands.rs` (calls gain `None`); `src/lib/ipc/commands.test.ts`, `src/lib/ipc/errors.test.ts`, `src/lib/ipc/types.test.ts`, `src/lib/ipc/index.test.ts`, `src/lib/query/keys.test.ts` (extend); the `"pushFailed"` literals in `src/features/branches/BranchesPanel.test.tsx`, `src/features/tags/tagCopy.test.ts`, `src/features/tags/TagsPanel.test.tsx`, `src/features/tags/useTagActions.test.tsx` (Step 3)

**Interfaces:**

- Consumes: Task 1's `RepoSession::{prepare_fetch, pull_default_mode, prepare_pull, integrate_pull, prepare_push, list_remotes, add_remote, update_remote, remove_remote}`, `Fetch::run`, `Pull::fetch`, `Push::run`, `Credentials` (`Deserialize` through validation), `PullMode`, `PushTarget`, `RemoteInfo`, `NetworkErrorKind`, `NetworkInfo`, the new `AppErrorKind`s. App: `with_session`, `run_blocking`, the prepare-then-run shape of `delete_remote_branch_inner`. App test helpers (`src-tauri/tests/common`): `temp_repo_with_commit`, `temp_bare_clone`, `add_remote_and_fetch(path, bare)` (no upstream), `configure_identity`, `commit_file`, `head_branch_name`, `git_available`. Front end: `invoke` (only in `commands.ts`), `KINDS` in `errors.ts`, `queryKeys` / `mutationKeys`.
- Produces:

```rust
// commands/remote.rs
pub fn fetch_inner(reg: &RepoRegistry, id: RepoId, credentials: Option<&Credentials>) -> Result<(), AppError>;
pub fn pull_default_mode_inner(reg: &RepoRegistry, id: RepoId) -> Result<PullMode, AppError>;
pub fn pull_inner(reg: &RepoRegistry, id: RepoId, mode: PullMode, credentials: Option<&Credentials>) -> Result<OperationOutcome, AppError>;
pub fn push_inner(reg: &RepoRegistry, id: RepoId, target: &PushTarget, force: bool, credentials: Option<&Credentials>) -> Result<(), AppError>;
pub fn list_remotes_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<RemoteInfo>, AppError>;
pub fn add_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str, url: &str, push_url: Option<&str>) -> Result<(), AppError>;
pub fn update_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str, new_name: &str, url: &str, push_url: Option<&str>) -> Result<(), AppError>;
pub fn remove_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError>;
// + #[tauri::command] async fetch, pull_default_mode, pull, push, list_remotes, add_remote, update_remote, remove_remote
// refs.rs / tags.rs: delete_remote_branch_inner, push_tag_inner, delete_remote_tag_inner gain a last `credentials: Option<&Credentials>`;
// their commands gain `credentials: Option<Credentials>`.
```

```ts
// types.ts
export type NetworkErrorKind =
  | "httpsAuthRequired"
  | "httpsAuthRejected"
  | "sshAuthFailed"
  | "hostKeyUnverified"
  | "hostUnreachable"
  | "repoNotFound"
  | "pushRejectedNonFastForward"
  | "leaseStale"
  | "other";
export interface NetworkErrorInfo {
  verb: "fetch" | "pull" | "push";
  kind: NetworkErrorKind;
  https: boolean;
  /** `scheme://host[:port]` git asked credentials for; null unless an HTTPS auth kind. */
  origin: string | null;
}
export interface AppError {
  kind: AppErrorKind;
  message: string;
  /** Present on `networkFailed` only. */
  network?: NetworkErrorInfo;
}
export interface Credentials {
  origin: string;
  username: string;
  token: string;
}
export type PullMode = "merge" | "rebase";
export type PushTarget =
  { kind: "upstream" } | { kind: "setUpstream"; remote: string; branch: string };
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string | null;
}
// AppErrorKind: minus "pushFailed"; plus "networkFailed" | "noRemotes" | "noUpstream" | "detachedHead"
//   | "invalidRemoteName" | "invalidRemoteUrl" | "remoteExists" | "invalidCredentials"
// commands.ts
export function fetchAll(id: RepoId, credentials?: Credentials | null): Promise<void>;
export function pullDefaultMode(id: RepoId): Promise<PullMode>;
export function pull(
  id: RepoId,
  mode: PullMode,
  credentials?: Credentials | null,
): Promise<OperationOutcome>;
export function push(
  id: RepoId,
  target: PushTarget,
  force: boolean,
  credentials?: Credentials | null,
): Promise<void>;
export function listRemotes(id: RepoId): Promise<RemoteInfo[]>;
export function addRemote(
  id: RepoId,
  name: string,
  url: string,
  pushUrl: string | null,
): Promise<void>;
export function updateRemote(
  id: RepoId,
  name: string,
  newName: string,
  url: string,
  pushUrl: string | null,
): Promise<void>;
export function removeRemote(id: RepoId, name: string): Promise<void>;
// pushTag, deleteRemoteTag, deleteRemoteBranch gain `credentials: Credentials | null = null`
// keys.ts
queryKeys.remotes(id); // ["repo", id, "remotes"]
queryKeys.pullMode(id); // ["repo", id, "pullMode"]
mutationKeys.network(id); // ["network", id]
```

- [ ] **Step 1: Write the failing app-layer tests** (`src-tauri/tests/remote_commands.rs`, new)

```rust
//! Integration tests for the GR-12 remote command `*_inner` functions, against
//! real temp repositories with local bare remotes (no network beyond a refused
//! loopback port).

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{Credentials, NetworkErrorKind, OperationOutcome, PullMode, PushTarget, RemoteInfo, RepoSession};
use git_real_lib::commands::refs::delete_remote_branch_inner;
use git_real_lib::commands::remote::{
    add_remote_inner, fetch_inner, list_remotes_inner, pull_default_mode_inner, pull_inner, push_inner,
    remove_remote_inner, update_remote_inner,
};
use git_real_lib::commands::tags::{delete_remote_tag_inner, push_tag_inner};
use git_real_lib::error::{AppErrorKind, NetworkInfo};
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{BranchType, Repository};
use serde_json::json;
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;
const TOKEN: &str = "TOPSECRET-123";

/// `path` tracks `origin` (a local bare clone) on its HEAD branch; `other` is
/// a second clone of the bare repo that pushes.
struct Fx {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    other: PathBuf,
    head: String,
}

fn fx() -> Fx {
    let (d1, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare);
    Repository::open(&path).unwrap().find_branch(&head, BranchType::Local).unwrap()
        .set_upstream(Some(&format!("origin/{head}"))).unwrap();
    let d3 = tempfile::tempdir().unwrap();
    git(d3.path(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    let other = d3.path().join("other");
    common::configure_identity(&other);
    Fx { _dirs: [d1, d2, d3], path, bare, other, head }
}

/// A registry holding a fresh session of `path` (opened after any config change).
fn registered(path: &Path) -> (RepoRegistry, RepoId) {
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(path).unwrap());
    (reg, id)
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn tip(repo: &Path, spec: &str) -> String {
    let repo = Repository::open(repo).unwrap();
    let id = repo.revparse_single(spec).unwrap().peel_to_commit().unwrap().id();
    id.to_string()
}

fn push_from_other(fx: &Fx, file: &str, content: &str) -> String {
    let oid = common::commit_file(&fx.other, file, content, "theirs").to_string();
    git(&fx.other, &["push", "-q", "origin", "HEAD"]);
    oid
}

#[test]
fn fetch_inner_updates_the_tracking_refs() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    let (reg, id) = registered(&fx.path);
    fetch_inner(&reg, id, None).unwrap();
    assert_eq!(tip(&fx.path, &format!("refs/remotes/origin/{}", fx.head)), theirs);
}

#[test]
fn fetch_inner_without_remotes_is_no_remotes() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    let err = fetch_inner(&reg, id, None).unwrap_err();
    assert_eq!((err.kind, err.network), (AppErrorKind::NoRemotes, None));
}

#[test]
fn pull_default_mode_inner_reads_pull_rebase() {
    let (_d, path) = common::temp_repo_with_commit();
    Repository::open(&path).unwrap().config().unwrap().set_str("pull.rebase", "true").unwrap();
    let (reg, id) = registered(&path);
    assert_eq!(pull_default_mode_inner(&reg, id).unwrap(), PullMode::Rebase);
    assert_eq!(serde_json::to_value(PullMode::Rebase).unwrap(), json!("rebase"));
    assert_eq!(serde_json::to_value(PullMode::Merge).unwrap(), json!("merge"));
}

#[test]
fn pull_inner_fast_forwards_to_the_upstream() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    let (reg, id) = registered(&fx.path);
    assert_eq!(pull_inner(&reg, id, PullMode::Merge, None).unwrap(), OperationOutcome::Completed);
    assert_eq!(tip(&fx.path, "HEAD"), theirs);
}

#[test]
fn pull_inner_rebase_mode_replays_local_commits() {
    if !common::git_available() { return; }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    assert_eq!(pull_inner(&reg, id, PullMode::Rebase, None).unwrap(), OperationOutcome::Completed);
    assert_eq!(tip(&fx.path, "HEAD~1"), theirs);
}

#[test]
fn pull_inner_reports_conflicts_for_the_banner() {
    if !common::git_available() { return; }
    let fx = fx();
    push_from_other(&fx, "README.md", "theirs\n");
    common::commit_file(&fx.path, "README.md", "ours\n", "ours");
    let (reg, id) = registered(&fx.path);
    let outcome = pull_inner(&reg, id, PullMode::Merge, None).unwrap();
    assert_eq!(serde_json::to_value(outcome).unwrap(), json!("conflicts"));
}

#[test]
fn pull_and_push_inner_map_head_and_upstream_errors() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    assert_eq!(pull_inner(&reg, id, PullMode::Merge, None).unwrap_err().kind, AppErrorKind::NoUpstream);
    assert_eq!(push_inner(&reg, id, &PushTarget::Upstream, false, None).unwrap_err().kind, AppErrorKind::NoUpstream);
    let repo = Repository::open(&path).unwrap();
    repo.set_head_detached(repo.head().unwrap().target().unwrap()).unwrap();
    assert_eq!(pull_inner(&reg, id, PullMode::Merge, None).unwrap_err().kind, AppErrorKind::DetachedHead);
    assert_eq!(push_inner(&reg, id, &PushTarget::Upstream, false, None).unwrap_err().kind, AppErrorKind::DetachedHead);
}

#[test]
fn push_inner_pushes_to_the_upstream_and_publishes_a_new_branch() {
    if !common::git_available() { return; }
    let fx = fx();
    let ours = common::commit_file(&fx.path, "c.txt", "c\n", "ours").to_string();
    let (reg, id) = registered(&fx.path);
    push_inner(&reg, id, &PushTarget::Upstream, false, None).unwrap();
    assert_eq!(tip(&fx.bare, &format!("refs/heads/{}", fx.head)), ours);
    let target: PushTarget = serde_json::from_value(json!({ "kind": "setUpstream", "remote": "origin", "branch": "pub" })).unwrap();
    push_inner(&reg, id, &target, false, None).unwrap();
    assert_eq!(tip(&fx.bare, "refs/heads/pub"), ours);
}

#[test]
fn a_rejected_push_maps_to_network_failed_with_its_payload() {
    if !common::git_available() { return; }
    let fx = fx();
    push_from_other(&fx, "b.txt", "b\n");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, false, None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(
        err.network,
        Some(NetworkInfo { verb: "push".into(), kind: NetworkErrorKind::PushRejectedNonFastForward, https: false, origin: None })
    );
    assert!(err.message.contains("[rejected]"), "{}", err.message);
    let value = serde_json::to_value(&err).unwrap();
    assert_eq!(value["network"], json!({ "verb": "push", "kind": "pushRejectedNonFastForward", "https": false, "origin": null }));
}

#[test]
fn a_force_push_over_an_unseen_remote_update_is_lease_stale() {
    if !common::git_available() { return; }
    let fx = fx();
    push_from_other(&fx, "b.txt", "b\n"); // not fetched: the tracking ref is stale
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, true, None).unwrap_err();
    assert_eq!(err.network.map(|n| n.kind), Some(NetworkErrorKind::LeaseStale));
}

#[test]
fn credentials_never_appear_in_an_app_error() {
    if !common::git_available() { return; }
    let fx = fx();
    Repository::open(&fx.path).unwrap().remote_set_url("origin", "http://127.0.0.1:1/x.git").unwrap();
    let (reg, id) = registered(&fx.path);
    let creds = Credentials::new("http://127.0.0.1:1", "me", TOKEN).unwrap();
    let errors = [
        fetch_inner(&reg, id, Some(&creds)).unwrap_err(),
        pull_inner(&reg, id, PullMode::Merge, Some(&creds)).unwrap_err(),
        push_inner(&reg, id, &PushTarget::Upstream, false, Some(&creds)).unwrap_err(),
    ];
    for err in errors {
        assert_eq!(err.kind, AppErrorKind::NetworkFailed);
        let info = err.network.clone().unwrap();
        assert_eq!((info.kind, info.https, info.origin), (NetworkErrorKind::HostUnreachable, true, None));
        for text in [format!("{err:?}"), serde_json::to_string(&err).unwrap()] {
            assert!(!text.contains(TOKEN), "{text}");
        }
    }
}

#[test]
fn tag_and_remote_branch_pushes_take_credentials_and_map_network_failures() {
    if !common::git_available() { return; }
    let fx = fx();
    {
        let repo = Repository::open(&fx.path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.tag_lightweight("v1", head.as_object(), false).unwrap();
    }
    git(&fx.other, &["push", "-q", "origin", "HEAD:refs/heads/gone-soon"]);
    let (reg, id) = registered(&fx.path);
    fetch_inner(&reg, id, None).unwrap();
    push_tag_inner(&reg, id, "origin", "v1", None).unwrap();
    delete_remote_tag_inner(&reg, id, "origin", "v1", None).unwrap();
    let err = delete_remote_tag_inner(&reg, id, "origin", "v1", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(err.network.map(|n| (n.verb, n.kind)), Some(("push".to_owned(), NetworkErrorKind::Other)));
    assert!(err.message.contains("remote ref does not exist"), "{}", err.message);
    delete_remote_branch_inner(&reg, id, "origin", "gone-soon", None).unwrap();
    assert!(Repository::open_bare(&fx.bare).unwrap().find_reference("refs/heads/gone-soon").is_err());
}

#[test]
fn remote_crud_through_the_commands() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    add_remote_inner(&reg, id, "origin", "https://h.test/x.git", None).unwrap();
    add_remote_inner(&reg, id, "mirror", "/srv/m.git", Some("git@h.test:m.git")).unwrap();
    assert_eq!(
        list_remotes_inner(&reg, id).unwrap(),
        vec![
            RemoteInfo { name: "mirror".into(), fetch_url: "/srv/m.git".into(), push_url: Some("git@h.test:m.git".into()) },
            RemoteInfo { name: "origin".into(), fetch_url: "https://h.test/x.git".into(), push_url: None },
        ]
    );
    update_remote_inner(&reg, id, "mirror", "backup", "/srv/b.git", None).unwrap();
    remove_remote_inner(&reg, id, "origin").unwrap();
    assert_eq!(
        list_remotes_inner(&reg, id).unwrap(),
        vec![RemoteInfo { name: "backup".into(), fetch_url: "/srv/b.git".into(), push_url: None }]
    );
}

#[test]
fn remote_commands_map_the_new_kinds() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    add_remote_inner(&reg, id, "origin", "/srv/a.git", None).unwrap();
    add_remote_inner(&reg, id, "other", "/srv/b.git", None).unwrap();
    assert_eq!(add_remote_inner(&reg, id, "a b", "/x", None).unwrap_err().kind, AppErrorKind::InvalidRemoteName);
    assert_eq!(add_remote_inner(&reg, id, "origin", "/x", None).unwrap_err().kind, AppErrorKind::RemoteExists);
    assert_eq!(add_remote_inner(&reg, id, "new", " ", None).unwrap_err().kind, AppErrorKind::InvalidRemoteUrl);
    assert_eq!(update_remote_inner(&reg, id, "ghost", "ghost", "/x", None).unwrap_err().kind, AppErrorKind::RemoteNotFound);
    assert_eq!(update_remote_inner(&reg, id, "origin", "other", "/x", None).unwrap_err().kind, AppErrorKind::RemoteExists);
    assert_eq!(remove_remote_inner(&reg, id, "ghost").unwrap_err().kind, AppErrorKind::RemoteNotFound);
    let set_upstream = PushTarget::SetUpstream { remote: "nope".into(), branch: "b".into() };
    assert_eq!(push_inner(&reg, id, &set_upstream, false, None).unwrap_err().kind, AppErrorKind::RemoteNotFound);
}

#[test]
fn remote_commands_report_unknown_repo() {
    let reg = RepoRegistry::default();
    let kinds = [
        fetch_inner(&reg, MISSING_ID, None).unwrap_err().kind,
        pull_default_mode_inner(&reg, MISSING_ID).unwrap_err().kind,
        pull_inner(&reg, MISSING_ID, PullMode::Merge, None).unwrap_err().kind,
        push_inner(&reg, MISSING_ID, &PushTarget::Upstream, false, None).unwrap_err().kind,
        list_remotes_inner(&reg, MISSING_ID).unwrap_err().kind,
        add_remote_inner(&reg, MISSING_ID, "o", "/x", None).unwrap_err().kind,
        update_remote_inner(&reg, MISSING_ID, "o", "o", "/x", None).unwrap_err().kind,
        remove_remote_inner(&reg, MISSING_ID, "o").unwrap_err().kind,
    ];
    assert!(kinds.iter().all(|k| *k == AppErrorKind::UnknownRepo), "{kinds:?}");
}

#[test]
fn remote_models_cross_the_seam_in_camel_case() {
    let info = RemoteInfo { name: "o".into(), fetch_url: "/f".into(), push_url: None };
    assert_eq!(serde_json::to_value(info).unwrap(), json!({ "name": "o", "fetchUrl": "/f", "pushUrl": null }));
    assert_eq!(serde_json::from_value::<PushTarget>(json!({ "kind": "upstream" })).unwrap(), PushTarget::Upstream);
    assert_eq!(serde_json::from_value::<PullMode>(json!("merge")).unwrap(), PullMode::Merge);
    let creds: Credentials = serde_json::from_value(json!({ "origin": "https://h", "username": "me", "token": TOKEN })).unwrap();
    assert_eq!(creds.origin(), "https://h");
    assert_eq!(serde_json::to_value(NetworkErrorKind::LeaseStale).unwrap(), json!("leaseStale"));
}
```

`tests/refs_commands.rs` and `tests/tag_commands.rs`: every `delete_remote_branch_inner(…)`, `push_tag_inner(…)` and `delete_remote_tag_inner(…)` call gains a last `None`.

- [ ] **Step 2: Write the failing IPC tests**

`src/lib/ipc/commands.test.ts`, new `describe("remote command wrappers", …)` with `mockWith` / `mockThrowing` (`const creds = { origin: "https://h", username: "me", token: "t" }`):

- `fetchAll sends fetch with id and null credentials`: `calls` equals `[{ cmd: "fetch", args: { id: 2, credentials: null } }]`.
- `fetchAll sends the credentials through`.
- `pullDefaultMode sends pull_default_mode with id` and passes `"rebase"` through.
- `pull sends mode and credentials`: `pull(2, "rebase")` → `{ id: 2, mode: "rebase", credentials: null }`; the outcome passes through.
- `push sends target, force and credentials`: `push(2, { kind: "setUpstream", remote: "origin", branch: "b" }, true, creds)`.
- `listRemotes sends list_remotes`; `addRemote sends name, url and a null pushUrl` (`{ id, name, url, pushUrl: null }`); `updateRemote sends name, newName, url and pushUrl`; `removeRemote sends name`.
- `pushTag, deleteRemoteTag and deleteRemoteBranch send null credentials by default`, and `… send the given credentials` (args gain `credentials`).
- `it.each` "rejects with the backend AppError" for all eight new wrappers, the value `{ kind: "networkFailed", message: "x", network: { verb: "fetch", kind: "hostUnreachable", https: false, origin: null } }` passing through intact.

`errors.test.ts`: `it.each(["networkFailed", "noRemotes", "noUpstream", "detachedHead", "invalidRemoteName", "invalidRemoteUrl", "remoteExists", "invalidCredentials"] as const)("isAppError accepts kind %s", …)`; `isAppError rejects the removed pushFailed kind`; `toAppError keeps the network payload` (`toAppError(e)` is `e`). The tester removes `"pushFailed"` from the existing accepted-kinds list. `types.test.ts`: the kinds list loses `pushFailed` and gains the eight; literal type checks for `NetworkErrorInfo` (`origin: null`), `Credentials`, both `PushTarget` shapes, `RemoteInfo` (`pushUrl: null`), `PullMode`. `index.test.ts`: barrel list gains `fetchAll`, `pullDefaultMode`, `pull`, `push`, `listRemotes`, `addRemote`, `updateRemote`, `removeRemote`. `keys.test.ts`: `remotes(3)` equals `["repo", 3, "remotes"]` and `pullMode(3)` equals `["repo", 3, "pullMode"]`, both refreshed by the repo prefix; `mutationKeys.network(3)` equals `["network", 3]`, differs per repo and from `tag(3)` / `stash(3)`, and its first element is not `queryKeys.repo(3)[0]`.

- [ ] **Step 3: Replace the removed kind in feature tests (test role)**

In `BranchesPanel.test.tsx`, `tagCopy.test.ts`, `TagsPanel.test.tsx` and `useTagActions.test.tsx`, every `"pushFailed"` becomes `"networkFailed"`, and an `AppError` object literal gains `network: { verb: "push", kind: "other", https: false, origin: null }`. Assertions stay as they are (those panels still render `error.message` until Task 3), so these suites stay green and `npm run typecheck` passes.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test remote_commands` → compile error (no `commands::remote`). `npm test -- src/lib` → missing exports; `npm run typecheck` → `"pushFailed"` is no longer an `AppErrorKind` until Step 6.

- [ ] **Step 5: Implement the app layer**

`src-tauri/src/commands/remote.rs`:

```rust
//! Remote commands: fetch, pull, push and remote management (GR-12).
//!
//! Network work follows the GR-7 shape: validate under the session lock, run
//! git with the lock released (a slow network never blocks the repository),
//! and, for pull, integrate under the lock again. `credentials` live only for
//! the call; they are never logged, stored, or put into an error.

use std::sync::Arc;

use git_real_core::{Credentials, OperationOutcome, PullMode, PushTarget, RemoteInfo};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn fetch_inner(reg: &RepoRegistry, id: RepoId, credentials: Option<&Credentials>) -> Result<(), AppError> {
    let fetch = with_session(reg, id, |s| s.prepare_fetch())?;
    fetch.run(credentials).map_err(AppError::from)
}

pub fn pull_default_mode_inner(reg: &RepoRegistry, id: RepoId) -> Result<PullMode, AppError> {
    with_session(reg, id, |s| s.pull_default_mode())
}

pub fn pull_inner(
    reg: &RepoRegistry,
    id: RepoId,
    mode: PullMode,
    credentials: Option<&Credentials>,
) -> Result<OperationOutcome, AppError> {
    let pull = with_session(reg, id, |s| s.prepare_pull())?;
    pull.fetch(credentials).map_err(AppError::from)?;
    with_session(reg, id, |s| s.integrate_pull(&pull, mode))
}

pub fn push_inner(
    reg: &RepoRegistry,
    id: RepoId,
    target: &PushTarget,
    force: bool,
    credentials: Option<&Credentials>,
) -> Result<(), AppError> {
    let push = with_session(reg, id, |s| s.prepare_push(target, force))?;
    push.run(credentials).map_err(AppError::from)
}

pub fn list_remotes_inner(reg: &RepoRegistry, id: RepoId) -> Result<Vec<RemoteInfo>, AppError> {
    with_session(reg, id, |s| s.list_remotes())
}

pub fn add_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str, url: &str, push_url: Option<&str>) -> Result<(), AppError> {
    with_session(reg, id, |s| s.add_remote(name, url, push_url))
}

pub fn update_remote_inner(
    reg: &RepoRegistry,
    id: RepoId,
    name: &str,
    new_name: &str,
    url: &str,
    push_url: Option<&str>,
) -> Result<(), AppError> {
    with_session(reg, id, |s| s.update_remote(name, new_name, url, push_url))
}

pub fn remove_remote_inner(reg: &RepoRegistry, id: RepoId, name: &str) -> Result<(), AppError> {
    with_session(reg, id, |s| s.remove_remote(name))
}

#[tauri::command]
pub async fn pull(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    mode: PullMode,
    credentials: Option<Credentials>,
) -> Result<OperationOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || pull_inner(&reg, id, mode, credentials.as_ref())).await
}
// fetch(reg, id, credentials), pull_default_mode(reg, id), push(reg, id, target: PushTarget, force: bool, credentials),
// list_remotes(reg, id), add_remote(reg, id, name: String, url: String, push_url: Option<String>),
// update_remote(reg, id, name, new_name: String, url, push_url: Option<String>), remove_remote(reg, id, name)
// follow the same shape (`push_url.as_deref()`, `&target`).
```

`refs.rs` / `tags.rs`: the three `_inner` functions take `credentials: Option<&Credentials>` and pass it to `run`; their commands take `credentials: Option<Credentials>` and pass `credentials.as_ref()`. `commands/mod.rs`: `pub mod remote;`. `lib.rs`: register `commands::remote::{fetch, pull_default_mode, pull, push, list_remotes, add_remote, update_remote, remove_remote}` after `commands::tags::delete_remote_tag`.

- [ ] **Step 6: Implement the IPC layer**

`types.ts`: the types from Interfaces (after `TagList`); `AppErrorKind` loses `"pushFailed"` and gains the eight kinds at the end. `errors.ts`: `KINDS` loses `pushFailed` and gains the eight. `commands.ts` (after the tag wrappers; import the new types):

```ts
/** `git fetch --all`. Not named `fetch`, which would shadow the global. */
export function fetchAll(id: RepoId, credentials: Credentials | null = null): Promise<void> {
  return invoke<void>("fetch", { id, credentials });
}

/** `branch.<head>.rebase`, else `pull.rebase`, else merge. */
export function pullDefaultMode(id: RepoId): Promise<PullMode> {
  return invoke<PullMode>("pull_default_mode", { id });
}

/** Fetches the upstream's remote, then fast-forwards, merges or rebases. */
export function pull(
  id: RepoId,
  mode: PullMode,
  credentials: Credentials | null = null,
): Promise<OperationOutcome> {
  return invoke<OperationOutcome>("pull", { id, mode, credentials });
}

export function push(
  id: RepoId,
  target: PushTarget,
  force: boolean,
  credentials: Credentials | null = null,
): Promise<void> {
  return invoke<void>("push", { id, target, force, credentials });
}

export function listRemotes(id: RepoId): Promise<RemoteInfo[]> {
  return invoke<RemoteInfo[]>("list_remotes", { id });
}

export function addRemote(
  id: RepoId,
  name: string,
  url: string,
  pushUrl: string | null,
): Promise<void> {
  return invoke<void>("add_remote", { id, name, url, pushUrl });
}

export function updateRemote(
  id: RepoId,
  name: string,
  newName: string,
  url: string,
  pushUrl: string | null,
): Promise<void> {
  return invoke<void>("update_remote", { id, name, newName, url, pushUrl });
}

export function removeRemote(id: RepoId, name: string): Promise<void> {
  return invoke<void>("remove_remote", { id, name });
}
```

`pushTag`, `deleteRemoteTag`, `deleteRemoteBranch` gain `credentials: Credentials | null = null` and send it. `keys.ts`: `/** Configured remotes; under the repo prefix so a repo change refreshes them. */ remotes`, `/** The default pull mode (config); under the repo prefix. */ pullMode`, and in `mutationKeys` `/** Every network action of a repo (fetch, pull, push, tag and branch pushes): one key, so the toolbar sees any of them running. */ network`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check`, then `npm test && npm run typecheck && npm run lint`. Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src-tauri src/lib src/features
git commit -m "feat(app): GR-12 remote commands, credentials on pushes, IPC wrappers and keys"
```

---

### Task 3: Front-end sync — the network gate, messages, dialogs, toolbar, shortcuts, and the tag / remote-branch migration

**Files:**

- Create: `src/features/remotes/networkMessage.ts`, `syncCopy.ts`, `remotesTarget.ts`, `useNetworkAction.ts`, `useRemotes.ts`, `usePullMode.ts`, `useSyncActions.ts`, `NetworkError.tsx` (+ `NetworkError.module.css`), `CredentialDialog.tsx`, `SetUpstreamDialog.tsx` (both reuse `PromptDialog.module.css` classes through their own `*.module.css` that `composes:` them, or copy its five rules), `SyncToolbar.tsx` (+ `SyncToolbar.module.css`)
- Create (test role): `src/test/remoteFixtures.ts`; a `*.test.ts(x)` beside every new source
- Modify: `src/app/RepoPane.tsx` (+ `RepoPane.module.css`: the header gains a row for the branch line and the toolbar), `src/features/tags/useTagActions.ts`, `src/features/tags/TagFeedback.tsx`, `src/features/tags/TagsPanel.tsx`, `src/features/branches/useBranchActions.ts` (drops `deleteRemote`), `src/features/branches/BranchesPanel.tsx`
- Modify (test role): `src/app/RepoPane.test.tsx`, `src/features/tags/useTagActions.test.tsx`, `src/features/tags/TagsPanel.test.tsx`, `src/features/branches/useBranchActions.test.tsx`, `src/features/branches/BranchesPanel.test.tsx`, `src/styles/focusTargets.test.ts` (`"src/features/remotes/CredentialDialog.tsx": 1`, `"src/features/remotes/SetUpstreamDialog.tsx": 1`)

**Interfaces:**

- Consumes: Task 2's wrappers, types and keys. `useBranches(repoId)` (`branches.head`, `local[].isHead`, `local[].tracking`), `ContextMenu` / `MenuItem`, `ConfirmDialog` (`pending` shows `Working…`), the `PromptDialog` structure and its focus rules (`useRestoreFocus` first, then focus the first input; hold focus on the dialog while pending), `RepoError`, `toAppError`, `renderWithProviders` / `renderHookWithProviders`, `oidOf`. In `RepoPane.tsx`: the window `keydown` effect for Ctrl/Cmd+Shift+H (ignores repeats while any `[role="dialog"]` exists, compares `e.key.toLowerCase()`). In `useTagActions.ts`: `mutationKeys.tag`, the `busy` counter, `status`, `lastName`. In `BranchesPanel.tsx`: `confirmDeleteRemote`, the `deleteRemote` ConfirmDialog, `panelError`.
- Produces:

```ts
// remotesTarget.ts
export type RemotesTarget = { mode: "list" } | { mode: "add" } | { mode: "edit"; name: string };
// networkMessage.ts
export type MessageAction = "pull" | "fetch" | "editRemote" | "addRemote";
export interface NetworkMessage {
  title: string;
  hint: string | null;
  action: { kind: MessageAction; label: string } | null;
  /** git's output for the Details disclosure; null when there is none worth showing. */
  details: string | null;
}
export function networkMessage(error: AppError): NetworkMessage;
// useNetworkAction.ts
export interface CredentialPrompt {
  origin: string;
  /** `origin` without the scheme, for the title. */
  host: string;
  /** True after credentials the user entered were refused. */
  rejected: boolean;
  submit(username: string, token: string): void;
  cancel(): void;
}
export type NetworkResult<T> =
  { status: "ok"; value: T } | { status: "failed"; error: AppError } | { status: "cancelled" };
export interface UseNetworkAction {
  run<T>(action: (credentials: Credentials | null) => Promise<T>): Promise<NetworkResult<T>>;
  /** A run of this instance is in flight (prompt included), or any network action of the repo runs. */
  pending: boolean;
  prompt: CredentialPrompt | null;
}
export function needsCredentials(error: AppError): boolean;
export function useNetworkAction(repoId: RepoId): UseNetworkAction;
// useRemotes.ts / usePullMode.ts
export function useRemotes(repoId: RepoId): {
  remotes: RemoteInfo[] | undefined;
  error: AppError | null;
  refetch(): void;
};
export function usePullMode(repoId: RepoId): PullMode; // "merge" until loaded or on error
// syncCopy.ts
export const NO_REMOTES = "No remotes configured";
export const CHECK_OUT_A_BRANCH = "Check out a branch to pull or push.";
export const MAKE_A_COMMIT_FIRST = "Make a commit first";
export const NO_UPSTREAM = "This branch has no upstream";
export const NETWORK_BUSY = "Another network operation is running";
export const LOADING = "Loading…";
export type SyncVerb = "fetch" | "pull" | "push";
/** Why each button is disabled (its tooltip), or null when enabled. */
export interface SyncGates {
  fetch: string | null;
  pull: string | null;
  push: string | null;
  forcePush: string | null;
}
export function syncGates(
  head: HeadState | undefined,
  tracking: Tracking | null,
  remotes: number | undefined,
  busy: boolean,
): SyncGates;
export function busyLabel(verb: SyncVerb): string; // "Fetching…" | "Pulling…" | "Pushing…"
export interface UpstreamText {
  text: string;
  ahead: number;
  behind: number;
}
export function upstreamText(
  head: HeadState | undefined,
  tracking: Tracking | null,
): UpstreamText | null;
/** The configured remote an upstream such as `team/a/main` belongs to: the longest name prefix. */
export function upstreamRemote(upstream: string, remotes: string[]): string | null;
export function forcePushCopy(
  local: string,
  remote: string,
  upstream: string,
): { title: string; body: string };
// useSyncActions.ts
export interface SyncActions {
  gates: SyncGates;
  upstream: UpstreamText | null;
  /** The remote of the current upstream, for "Edit remote…". */
  upstreamRemote: string | null;
  /** The verb this instance is running, for the busy label. */
  running: SyncVerb | null;
  fetch(): void;
  pull(mode?: PullMode): void; // default: usePullMode
  push(): void;
  requestForcePush(): void;
  message: NetworkMessage | null;
  dismissMessage(): void;
  prompt: CredentialPrompt | null;
  setUpstream: { remotes: string[]; branch: string; error: AppError | null } | null;
  publish(remote: string, branch: string): void;
  cancelSetUpstream(): void;
  forcePush: { local: string; remote: string; upstream: string } | null;
  confirmForcePush(): void;
  cancelForcePush(): void;
}
export function useSyncActions(repoId: RepoId): SyncActions;
// NetworkError.tsx
export interface NetworkErrorProps {
  message: NetworkMessage;
  onAction?(kind: MessageAction): void;
  onDismiss(): void;
}
// CredentialDialog.tsx
export interface CredentialDialogProps {
  prompt: CredentialPrompt | null;
  fallbackFocus?: RefObject<HTMLElement | null>;
}
// SetUpstreamDialog.tsx
export interface SetUpstreamDialogProps {
  remotes: string[];
  branch: string;
  error: AppError | null;
  pending: boolean;
  onPublish(remote: string, branch: string): void;
  onCancel(): void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}
// SyncToolbar.tsx
export interface SyncToolbarProps {
  sync: SyncActions;
  onOpenRemotes(target: RemotesTarget): void;
}
// useTagActions.ts: UseTagActions gains `prompt: CredentialPrompt | null`; push / deleteRemote resolve null when cancelled
// src/test/remoteFixtures.ts
export const remoteInfo: (name: string, over?: Partial<RemoteInfo>) => RemoteInfo; // fetchUrl `/srv/${name}.git`, pushUrl null
export const networkError: (
  kind: NetworkErrorKind,
  over?: Partial<NetworkErrorInfo>,
  message?: string,
) => AppError; // verb "push", https false, origin null, message "git output"
export const authError: (kind?: "httpsAuthRequired" | "httpsAuthRejected") => AppError; // https true, origin "https://github.com"
export const trackedList: (tracking: Tracking | null, head?: HeadState) => BranchList; // one local "main" (isHead, oidOf(1)), no remote groups
```

- [ ] **Step 1: Write the failing pure tests**

`networkMessage.test.ts`:

- `it.each` over `sshAuthFailed`, `hostKeyUnverified`, `hostUnreachable`, `repoNotFound`, `pushRejectedNonFastForward`, `leaseStale`: `networkMessage(networkError(kind))` equals `{ title, hint, action, details: "git output" }` with the verbatim copy of Global Constraints (actions: `repoNotFound` → `{ kind: "editRemote", label: "Edit remote…" }`, `pushRejectedNonFastForward` → `{ kind: "pull", label: "Pull" }`, `leaseStale` → `{ kind: "fetch", label: "Fetch" }`, others `null`).
- `other names the verb and keeps git's output as details`: verbs `fetch` / `pull` / `push` → titles `git fetch failed` / `git pull failed` / `git push failed`, `hint: null`, `action: null`.
- `an HTTPS auth error that cannot prompt asks for a credential helper`: `authError()` with `origin: null` → `Sign-in required` / `Set up a git credential helper for this host, then try again.`
- `noRemotes offers Add remote…`: `{ title: "No remotes configured", hint: "Add a remote to fetch, pull or push.", action: { kind: "addRemote", label: "Add remote…" }, details: null }`.
- `detachedHead tells the user to check out a branch`: title `Check out a branch to pull or push.`, everything else null.
- `any other error shows its own message`: `{ kind: "operationInProgress", message: "m" }` → `{ title: "m", hint: null, action: null, details: null }`; a `networkFailed` without a `network` payload is treated the same way.

`syncCopy.test.ts`:

- `syncGates` (with `const branch = { kind: "branch", name: "main" }`, `const tracked = { upstream: "origin/main", ahead: 0, behind: 0 }`):
  - `remotes still loading gates every button with Loading…`
  - `no remotes gates fetch, pull, push and force push with No remotes configured, before busy`
  - `a running network action gates everything with Another network operation is running`
  - `a loading branch list gates pull and push but not fetch`
  - `a detached HEAD gates pull and push with Check out a branch to pull or push.`
  - `an unborn HEAD gates pull and push with Make a commit first`
  - `a branch without an upstream gates pull and force push with This branch has no upstream, not push`
  - `a tracked branch enables everything`
- `busyLabel gives Fetching…, Pulling… and Pushing…`
- `upstreamText`: `null` for `undefined`, detached and unborn heads; `no upstream` with zero counts when `tracking` is null; `→ origin/main (upstream gone)` when `ahead` / `behind` are null; `→ origin/main` with `ahead: 2, behind: 3`.
- `upstreamRemote picks the longest configured prefix`: `("team/a/main", ["team", "team/a"])` → `"team/a"`; `("origin/main", ["orig", "origin"])` → `"origin"`; no match → `null`.
- `forcePushCopy`: `("main", "origin", "origin/main")` → `{ title: "Force push main to origin?", body: "This replaces origin/main with your local branch. It fails safely if someone else pushed since your last fetch." }`.

- [ ] **Step 2: Write the failing hook tests**

`useNetworkAction.test.tsx` (actions are `vi.fn()`s; no IPC mock needed):

- `runs the action with null credentials and resolves ok with its value`
- `a non-auth failure resolves failed without prompting`
- `an auth failure without https or without an origin resolves failed without prompting`
- `auth required opens a prompt naming the origin's host` (`host` `github.com`, `rejected` false)
- `submitting reruns the action with the entered credentials and the origin` (second call receives `{ origin: "https://github.com", username: "me", token: "tok" }`; resolves ok; `prompt` back to null)
- `entered credentials that are refused reopen the prompt marked rejected`
- `the first prompt is not marked rejected even when the stored credentials were refused` (`authError("httpsAuthRejected")`)
- `cancel resolves cancelled and closes the prompt`
- `a non-auth failure after a retry resolves failed`
- `a plain Error rejection becomes an io AppError`
- `invalidates the repo queries after every attempt, success or failure` (spy `invalidateQueries`, `{ queryKey: ["repo", 1] }`)
- `pending is true from the start of a run until it settles, prompt included`
- `pending is true while another instance of the same repo runs, and not for another repo` (`useIsMutating` on `mutationKeys.network`)
- `needsCredentials is true only for networkFailed with https, an origin and an HTTPS auth kind`

`useRemotes.test.tsx` / `usePullMode.test.tsx` (mock `listRemotes` / `pullDefaultMode`): `calls the wrapper with the repo id`, `exposes the data`, `caches under queryKeys.remotes / pullMode`, `maps a rejection into error` (useRemotes), `is merge until loaded and on error` (usePullMode), `refetches when the repo prefix is invalidated`.

`useSyncActions.test.tsx` (mock `listBranches`, `listRemotes`, `pullDefaultMode`, `fetchAll`, `pull`, `push`; default: branch `main` tracking `origin/main` 0/0, remotes `[remoteInfo("origin")]`, mode `"merge"`):

- `gates and upstream follow the branch list, the remotes and the network state`
- `fetch runs fetchAll with null credentials and reports running fetch until it settles`
- `fetch, pull and push are ignored while gated` (no remotes → no wrapper call)
- `pull uses the default mode unless one is given` (`pullDefaultMode` → `"rebase"`; `pull()` → `pull(1, "rebase", null)`; `pull("merge")` → `"merge"`)
- `a pull that stops on conflicts shows no message`
- `push pushes to the upstream without force`
- `push without an upstream opens the set-upstream dialog with every remote and the branch name` (push rejects `{ kind: "noUpstream" }`; `setUpstream` equals `{ remotes: ["origin", "upstream"], branch: "main", error: null }`)
- `publish pushes with setUpstream and closes the dialog`
- `publish with an invalid branch name keeps the dialog open with the error`
- `publish that fails on the network closes the dialog and shows the message`
- `requestForcePush opens the confirmation naming the branch, remote and upstream`
- `confirmForcePush pushes with force and closes the confirmation, success or failure`
- `a failure becomes a message and dismissMessage clears it`
- `the next action clears the previous message`
- `a cancelled sign-in shows no message`
- `upstreamRemote is the remote of the tracked upstream`

- [ ] **Step 3: Write the failing component tests**

`NetworkError.test.tsx`: `renders the title, the hint and git's output under Details` (`<details>` with `<summary>Details</summary>`), `omits the hint and Details when null`, `the action button calls onAction with its kind`, `no action button without onAction`, `Dismiss calls onDismiss`, `is an alert`.

`CredentialDialog.test.tsx`: `renders nothing without a prompt`; `shows Sign in to github.com, Username, a password field labelled Token or password, and the helper note`; `focus starts in Username`; `Sign in is disabled until both fields have text`; `Sign in submits the username trimmed and the token as typed`; `Enter in the token field submits`; `Cancel and Escape cancel`; `shows Those credentials were rejected only when rejected`; `a rejected prompt starts with empty fields`; `returns focus to the opener when it closes`.

`SetUpstreamDialog.test.tsx`: `titles Publish main and focuses Branch name`; `the remote defaults to origin when present, else the first remote`; `the branch name defaults to the local name`; `Publish sends the chosen remote and the trimmed branch name`; `Publish is disabled for a blank name`; `shows bad..x is not a valid branch name. for invalidBranchName and the message for other errors`; `pending disables the form and labels Publish Working…`; `Cancel and Escape cancel unless pending`.

`SyncToolbar.test.tsx` (a hand-built `SyncActions` from a local `fakeSync(over)`):

- `shows → origin/main with ↑2 and ↓3 labelled 2 ahead and 3 behind`; `hides a zero count`; `shows → origin/main (upstream gone)`; `shows no upstream`; `shows no upstream text for a detached HEAD`.
- `Fetch, Pull and Push are disabled with their gate as the title` (each gate string from `syncCopy`).
- `the running verb's button reads Fetching…, Pulling… or Pushing…`
- `Fetch, Pull and Push call the sync actions`
- `Pull options lists Pull (merge) and Pull (rebase), which pull in that mode`
- `Push options lists Force push (with lease)…, which requests a force push`; `Force push (with lease)… is disabled with the force-push gate as its title`
- `Remotes… opens the remotes list`
- `a message renders a NetworkError whose Pull and Fetch actions run them`
- `Edit remote… opens the remote of the upstream, or the list without one`; `Add remote… opens the add form`; `Dismiss clears the message`
- `renders the credential dialog, the set-upstream dialog and the force-push confirmation from sync state` (force copy verbatim; Force push → `confirmForcePush`, Cancel → `cancelForcePush`; set-upstream Publish → `publish`, Cancel → `cancelSetUpstream`)

`RepoPane.test.tsx` (the ipc mock gains `listRemotes`, `pullDefaultMode`, `fetchAll`, `pull`, `push`, resolved `[remoteInfo("origin")]`, `"merge"`, `undefined`, `"completed"`, `undefined` in `beforeEach`; the branch list tracks `origin/main`):

- `renders the sync toolbar in the header`
- `Ctrl+Shift+F fetches, Ctrl+Shift+L pulls in the default mode and Ctrl+Shift+P pushes`
- `Cmd+Shift+P pushes and an upper-case key (Caps Lock) still matches`
- `the sync shortcuts are ignored while a dialog is open`
- `the sync shortcuts are ignored while the action is disabled` (no remotes → no `fetchAll`)
- `Ctrl+F without Shift does nothing`
- `Ctrl+Shift+H still opens the file picker`

Migration (the tester rewrites the affected existing tests):

- `useTagActions.test.tsx`: `push and deleteRemote pass null credentials first` (`pushTag(1, "origin", "v1", null)`); `push asks for credentials on an HTTPS auth failure and retries with them` (`prompt` exposed; after `submit` the status is `pushed`); `a cancelled sign-in resolves null with no status and no error`; `a network failure resolves with the AppError and mirrors it in error`; `pending covers a network action of this repo`; the invalidation tests for push / deleteRemote expect `{ queryKey: ["repo", 1] }`.
- `TagsPanel.test.tsx`: the four `shows git's output on …` tests now expect `git push failed` and the output under `Details`; new `opens the credential dialog when a push needs sign-in`.
- `useBranchActions.test.tsx`: the `deleteRemote` tests are removed with the action.
- `BranchesPanel.test.tsx`: `deleting a remote branch calls deleteRemoteBranch with null credentials`; `a remote delete that needs sign-in opens the credential dialog and retries with the credentials`; `a remote delete network failure closes the confirm and shows a NetworkError`; `a cancelled sign-in closes the confirm with no error`; `the confirm is pending while the network action runs`.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- src/features/remotes src/features/tags src/features/branches src/app src/styles`. Expected: missing modules under `features/remotes`, no toolbar in the header, `pushTag` called without `null`.

- [ ] **Step 5: Implement the pure modules**

`networkMessage.ts`:

```ts
import type { AppError, NetworkErrorKind } from "../../lib/ipc";

export type MessageAction = "pull" | "fetch" | "editRemote" | "addRemote";

export interface NetworkMessage {
  title: string;
  hint: string | null;
  action: { kind: MessageAction; label: string } | null;
  details: string | null;
}

type Copy = Omit<NetworkMessage, "details">;

const SIGN_IN: Copy = {
  title: "Sign-in required",
  hint: "Set up a git credential helper for this host, then try again.",
  action: null,
};

const BY_KIND: Record<Exclude<NetworkErrorKind, "other">, Copy> = {
  httpsAuthRequired: SIGN_IN,
  httpsAuthRejected: SIGN_IN,
  sshAuthFailed: {
    title: "SSH key was refused",
    hint: "Add your key to the agent with ssh-add, and check it is registered with the host.",
    action: null,
  },
  hostKeyUnverified: {
    title: "Host key not trusted",
    hint: "Connect once from a terminal (ssh -T <host>) to verify and save the host key.",
    action: null,
  },
  hostUnreachable: {
    title: "Could not reach the remote",
    hint: "Check your network connection and the remote URL.",
    action: null,
  },
  repoNotFound: {
    title: "Repository not found",
    hint: "Check the remote URL, and that your account can access it.",
    action: { kind: "editRemote", label: "Edit remote…" },
  },
  pushRejectedNonFastForward: {
    title: "The remote has commits you don't have",
    hint: "Pull, then push again.",
    action: { kind: "pull", label: "Pull" },
  },
  leaseStale: {
    title: "The remote branch moved since your last fetch",
    hint: "Fetch and review the new commits before forcing again.",
    action: { kind: "fetch", label: "Fetch" },
  },
};

/** What to tell the user about a failed network or sync action. */
export function networkMessage(error: AppError): NetworkMessage {
  if (error.kind === "networkFailed" && error.network) {
    const { kind, verb } = error.network;
    const copy =
      kind === "other" ? { title: `git ${verb} failed`, hint: null, action: null } : BY_KIND[kind];
    return { ...copy, details: error.message };
  }
  switch (error.kind) {
    case "noRemotes":
      return {
        title: "No remotes configured",
        hint: "Add a remote to fetch, pull or push.",
        action: { kind: "addRemote", label: "Add remote…" },
        details: null,
      };
    case "detachedHead":
      return {
        title: "Check out a branch to pull or push.",
        hint: null,
        action: null,
        details: null,
      };
    default:
      return { title: error.message, hint: null, action: null, details: null };
  }
}
```

`syncCopy.ts`:

```ts
import type { HeadState, Tracking } from "../../lib/ipc";

export const NO_REMOTES = "No remotes configured";
export const CHECK_OUT_A_BRANCH = "Check out a branch to pull or push.";
export const MAKE_A_COMMIT_FIRST = "Make a commit first";
export const NO_UPSTREAM = "This branch has no upstream";
export const NETWORK_BUSY = "Another network operation is running";
export const LOADING = "Loading…";

export type SyncVerb = "fetch" | "pull" | "push";

export interface SyncGates {
  fetch: string | null;
  pull: string | null;
  push: string | null;
  forcePush: string | null;
}

const all = (reason: string): SyncGates => ({
  fetch: reason,
  pull: reason,
  push: reason,
  forcePush: reason,
});

/** Precedence: remotes loading, no remotes, a network action running, then the HEAD state. */
export function syncGates(
  head: HeadState | undefined,
  tracking: Tracking | null,
  remotes: number | undefined,
  busy: boolean,
): SyncGates {
  if (remotes === undefined) return all(LOADING);
  if (remotes === 0) return all(NO_REMOTES);
  if (busy) return all(NETWORK_BUSY);
  const headGate =
    head === undefined
      ? LOADING
      : head.kind === "detached"
        ? CHECK_OUT_A_BRANCH
        : head.kind === "unborn"
          ? MAKE_A_COMMIT_FIRST
          : null;
  if (headGate !== null)
    return { fetch: null, pull: headGate, push: headGate, forcePush: headGate };
  const upstreamGate = tracking === null ? NO_UPSTREAM : null;
  return { fetch: null, pull: upstreamGate, push: null, forcePush: upstreamGate };
}

const BUSY: Record<SyncVerb, string> = { fetch: "Fetching…", pull: "Pulling…", push: "Pushing…" };
export const busyLabel = (verb: SyncVerb): string => BUSY[verb];

export interface UpstreamText {
  text: string;
  ahead: number;
  behind: number;
}

export function upstreamText(
  head: HeadState | undefined,
  tracking: Tracking | null,
): UpstreamText | null {
  if (head?.kind !== "branch") return null;
  if (tracking === null) return { text: "no upstream", ahead: 0, behind: 0 };
  if (tracking.ahead === null || tracking.behind === null)
    return { text: `→ ${tracking.upstream} (upstream gone)`, ahead: 0, behind: 0 };
  return { text: `→ ${tracking.upstream}`, ahead: tracking.ahead, behind: tracking.behind };
}

export function upstreamRemote(upstream: string, remotes: string[]): string | null {
  const owners = remotes.filter((r) => upstream.startsWith(`${r}/`));
  return owners.length === 0 ? null : owners.reduce((a, b) => (b.length > a.length ? b : a));
}

export const forcePushCopy = (local: string, remote: string, upstream: string) => ({
  title: `Force push ${local} to ${remote}?`,
  body: `This replaces ${upstream} with your local branch. It fails safely if someone else pushed since your last fetch.`,
});
```

(Prettier may reflow the nested ternary; keep its output.)

- [ ] **Step 6: Implement `useNetworkAction`**

```ts
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toAppError } from "../../lib/ipc";
import type { AppError, Credentials, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";

// CredentialPrompt, NetworkResult, UseNetworkAction as in Interfaces.

type Attempt = {
  action: (credentials: Credentials | null) => Promise<unknown>;
  credentials: Credentials | null;
};

/** True when a prompt can help: an HTTPS auth failure on a known origin. */
export function needsCredentials(error: AppError): boolean {
  const n = error.network;
  return (
    error.kind === "networkFailed" &&
    n !== undefined &&
    n.https &&
    n.origin !== null &&
    (n.kind === "httpsAuthRequired" || n.kind === "httpsAuthRejected")
  );
}

/**
 * The single gate for every network mutation: runs the action without
 * credentials, asks for them on an HTTPS auth failure, retries until they work
 * or the user cancels. Credentials live in this call only.
 */
export function useNetworkAction(repoId: RepoId): UseNetworkAction {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState<CredentialPrompt | null>(null);
  // Counted here: `isPending` lags a tick, and the prompt wait is not a mutation.
  const [busy, setBusy] = useState(0);
  const elsewhere = useIsMutating({ mutationKey: mutationKeys.network(repoId) }) > 0;
  const { mutateAsync } = useMutation<unknown, AppError, Attempt>({
    mutationKey: mutationKeys.network(repoId),
    mutationFn: ({ action, credentials }) =>
      action(credentials).catch((e: unknown) => {
        throw toAppError(e);
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });

  const ask = (origin: string, rejected: boolean) =>
    new Promise<Credentials | null>((resolve) =>
      setPrompt({
        origin,
        host: origin.replace(/^https?:\/\//, ""),
        rejected,
        submit: (username, token) => {
          setPrompt(null);
          resolve({ origin, username, token });
        },
        cancel: () => {
          setPrompt(null);
          resolve(null);
        },
      }),
    );

  const run = async <T>(
    action: (credentials: Credentials | null) => Promise<T>,
  ): Promise<NetworkResult<T>> => {
    setBusy((n) => n + 1);
    try {
      let credentials: Credentials | null = null;
      for (;;) {
        try {
          return { status: "ok", value: (await mutateAsync({ action, credentials })) as T };
        } catch (e) {
          const error = e as AppError;
          if (!needsCredentials(error)) return { status: "failed", error };
          credentials = await ask(error.network!.origin!, credentials !== null);
          if (credentials === null) return { status: "cancelled" };
        }
      }
    } finally {
      setBusy((n) => n - 1);
    }
  };

  return { run, pending: busy > 0 || elsewhere, prompt };
}
```

(ESLint forbids non-null assertions if `@typescript-eslint/no-non-null-assertion` is on; then read `origin` into a narrowed local first. A component that unmounts while its prompt is open leaves that promise unresolved, which is harmless.)

`useRemotes.ts` / `usePullMode.ts` follow `useBranches` (`useQuery` on `queryKeys.remotes` / `queryKeys.pullMode`, the wrapper's rejection through `toAppError`); `usePullMode` returns `query.data ?? "merge"`.

- [ ] **Step 7: Implement the components and `useSyncActions`**

`useSyncActions(repoId)`: reads `useBranches`, `useRemotes`, `usePullMode`, `useNetworkAction`; derives `tracking` from the `isHead` local branch, `gates = syncGates(head, tracking, remotes?.length, network.pending)`, `upstream`, `upstreamRemote`. Each action returns at once when its gate is non-null; otherwise it clears `message`, sets `running`, and `network.run(…)`s the wrapper (`fetchAll(repoId, c)`, `pull(repoId, mode ?? defaultMode, c)`, `push(repoId, { kind: "upstream" }, false, c)`), then on `failed` sets `message = networkMessage(error)` — except a push failing with `noUpstream`, which opens `setUpstream { remotes: remotes.map(r => r.name), branch: head.name, error: null }` — and clears `running` when the run settles. `publish(remote, branch)` runs `push(repoId, { kind: "setUpstream", remote, branch }, false, c)`: `ok` / `cancelled` close the dialog; `invalidBranchName` / `remoteNotFound` stay in the dialog as its `error`; any other failure closes it and becomes the message. `requestForcePush` (ignored while `gates.forcePush` is set) opens `forcePush { local: head.name, remote: upstreamRemote ?? "", upstream: tracking.upstream }`; `confirmForcePush` runs `push(repoId, { kind: "upstream" }, true, c)` and closes the confirmation when the run settles. A `cancelled` result never sets a message.

`NetworkError.tsx`: `role="alert"` root; `<p>` title, `<p>` hint, `<details><summary>Details</summary><pre>{details}</pre></details>`, then the action button (when `action` and `onAction`) and `Dismiss`. Styles mirror `RepoError.module.css`'s panel variant (height-capped, the `<pre>` scrolls).

`CredentialDialog.tsx`: renders `null` without a prompt, else a body keyed by the prompt object (a rejected retry remounts with empty fields): the `PromptDialog` structure with title `Sign in to {host}`, a `Username` text input (`autoComplete="username"`, focused on mount after `useRestoreFocus(fallbackFocus)`), a `Token or password` input (`type="password"`, `autoComplete="current-password"`), the note `Your git credential helper will store these if one is configured.`, the rejected note (`role="alert"`) when `rejected`, and `Cancel` / `Sign in` (submit; disabled until `username.trim()` and `token` are non-empty). Escape and a backdrop click cancel. Submit calls `prompt.submit(username.trim(), token)`.

`SetUpstreamDialog.tsx`: the same structure, title `Publish {branch}`, a `Remote` `<select>` (initial `remotes.includes("origin") ? "origin" : remotes[0]`), a `Branch name` input (initial `branch`, focused), the inline error (`{name} is not a valid branch name.` for `invalidBranchName`, else `error.message`), `Cancel` / `Publish` (`Working…` while pending).

`SyncToolbar.tsx`: `<div role="toolbar" aria-label="Sync">` holding the upstream text (`<span>` text, then `<span aria-label="{n} ahead">↑{n}</span>` / `<span aria-label="{m} behind">↓{m}</span>` when non-zero), `Fetch`, the `Pull` / `Pull options` pair, the `Push` / `Push options` pair (each `▾` button has `aria-haspopup="menu"` and opens a `ContextMenu` at its `getBoundingClientRect()` left/bottom), and `Remotes…`. Disabled buttons carry `title={gate}`. The running verb's button shows `busyLabel(verb)`. Below the toolbar: `NetworkError` for `sync.message` (actions: `pull` → `sync.pull()`, `fetch` → `sync.fetch()`, `editRemote` → `onOpenRemotes(upstreamRemote ? { mode: "edit", name } : { mode: "list" })`, `addRemote` → `onOpenRemotes({ mode: "add" })`); `CredentialDialog`; `SetUpstreamDialog` while `sync.setUpstream` is set (`pending` = `sync.running === "push"`); `ConfirmDialog` (`danger`, `confirmLabel="Force push"`, copy from `forcePushCopy`, `pending={sync.running === "push"}`) while `sync.forcePush` is set.

`RepoPane.tsx`: `const sync = useSyncActions(tab.id)`; a ref updated in an effect (`useEffect(() => { syncRef.current = sync; })`) so the window handler, registered once, calls the latest actions. The handler keeps its `(ctrl || meta) && shift` and open-dialog checks, then switches on `e.key.toLowerCase()`: `h` → picker (as today), `f` → `fetch()`, `l` → `pull()`, `p` → `push()`, each after `e.preventDefault()`. The header renders `<SyncToolbar sync={sync} onOpenRemotes={…} />` after the branch line; until Task 4, `onOpenRemotes` stores the target in a `remotesTarget` state that nothing renders yet.

Tags: `useTagActions` gets `const network = useNetworkAction(repoId)`; `push` / `deleteRemote` run `network.run((c) => pushTag(repoId, remote, name, c))` (`deleteRemoteTag` likewise): `ok` sets the status, `failed` sets the hook's `error` and resolves it, `cancelled` resolves `null`. `create` / `remove` keep the tag mutation; `error` becomes a state both paths write (`clearError` resets it); `pending` adds `network.pending`; the hook returns `prompt: network.prompt`. `TagFeedback` renders `NetworkError` (`message = networkMessage(error)`, `onDismiss = clearError`) for a `networkFailed` error and `RepoError` as today otherwise; `TagsPanel` renders `<CredentialDialog prompt={actions.prompt} fallbackFocus={rootRef} />`.

Branches: `useBranchActions` drops `deleteRemote`. `BranchesPanel` gets `const network = useNetworkAction(repoId)` and a `networkError` state; `confirmDeleteRemote` runs `network.run((c) => deleteRemoteBranch(repoId, remote, name, c))`, closes the dialog when the run settles, and stores a `failed` error. `pending` adds `network.pending`; the deleteRemote confirm's `pending` is `network.pending`. A `networkFailed` error renders `NetworkError`; any other `failed` error renders through the existing `RepoError` panel; `clearErrors` clears it too. The panel renders `<CredentialDialog prompt={network.prompt} fallbackFocus={rootRef} />`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run lint`. Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "feat(ui): GR-12 sync toolbar, shortcuts, credential prompt and network messages"
```

---

### Task 4: Front-end remotes — `RemotesDialog`, remote heading menu, wiring

**Files:**

- Create: `src/features/remotes/useRemoteActions.ts`, `src/features/remotes/RemotesDialog.tsx` (+ `RemotesDialog.module.css`), `src/features/remotes/remoteCopy.ts`
- Modify: `src/features/branches/BranchGroup.tsx` (optional heading context menu), `src/features/branches/BranchesPanel.tsx` (heading menu, remove confirm, `onOpenRemotes` prop), `src/app/RepoPane.tsx` (renders `RemotesDialog` from `remotesTarget`; passes `onOpenRemotes` to `BranchesPanel`)
- Test: `useRemoteActions.test.tsx`, `RemotesDialog.test.tsx`, `remoteCopy.test.ts` (new); `BranchGroup.test.tsx`, `BranchesPanel.test.tsx`, `src/app/RepoPane.test.tsx`, `src/styles/focusTargets.test.ts` (`"src/features/remotes/RemotesDialog.tsx": 1`)

**Interfaces:**

- Consumes: Task 2's `listRemotes`, `addRemote`, `updateRemote`, `removeRemote`, `fetchAll`; Task 3's `useRemotes`, `useNetworkAction`, `CredentialDialog`, `NetworkError`, `networkMessage`, `RemotesTarget`. `ConfirmDialog`, `ContextMenu`, `useRestoreFocus`, the `PromptDialog` focus rules. `BranchRow`'s keyboard menu rule (Shift+F10 or the ContextMenu key opens at the row's `getBoundingClientRect()` left/bottom).
- Produces:

```ts
// useRemoteActions.ts — each resolves with the AppError or null and never rejects; invalidates queryKeys.repo(id) on settle
export interface UseRemoteActions {
  add(name: string, url: string, pushUrl: string | null): Promise<AppError | null>;
  update(
    name: string,
    newName: string,
    url: string,
    pushUrl: string | null,
  ): Promise<AppError | null>;
  remove(name: string): Promise<AppError | null>;
  pending: boolean;
}
export function useRemoteActions(repoId: RepoId): UseRemoteActions;
// remoteCopy.ts
export function removeRemoteCopy(name: string): { title: string; body: string };
// "Remove remote origin?" / "Its remote-tracking branches are deleted locally. Nothing changes on the server."
export function remoteFieldError(
  error: AppError,
  name: string,
): { field: "name" | "url"; text: string } | null;
// invalidRemoteName → name "‹name› is not a valid remote name."; remoteExists → name "A remote named ‹name› already exists.";
// invalidRemoteUrl → url "Enter a valid URL."; anything else → null (shown as a panel message)
// RemotesDialog.tsx
export interface RemotesDialogProps {
  repoId: RepoId;
  target: RemotesTarget;
  onClose(): void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}
// BranchGroup.tsx: BranchGroupProps gains `onHeadingContextMenu?(x: number, y: number): void`
// BranchesPanel.tsx: BranchesPanelProps gains `onOpenRemotes?(target: RemotesTarget): void`
```

- [ ] **Step 1: Write the failing tests**

`remoteCopy.test.ts`: `removeRemoteCopy` gives the verbatim title and body; `remoteFieldError` maps the three kinds to their field and text, and returns `null` for `remoteNotFound` and `io`.

`useRemoteActions.test.tsx` (mock the three wrappers): `add calls addRemote with name, url and push URL and resolves null`; `update calls updateRemote`; `remove calls removeRemote`; `a rejection resolves with the AppError`; `pending is true while an action runs`; `invalidates the repo queries after success and after failure`.

`RemotesDialog.test.tsx` (mock `listRemotes`, `addRemote`, `updateRemote`, `removeRemote`, `fetchAll`; `target={{ mode: "list" }}` unless stated):

- `titles the dialog Remotes and lists each remote's name and fetch URL`
- `shows the push URL only when it differs from the fetch URL`
- `shows No remotes when there are none`
- `Add remote opens an empty form with Fetch after adding checked and focuses Name`
- `Add is disabled until Name and URL have text`
- `adding calls addRemote with a null push URL, then fetches, then returns to the list` (`addRemote(1, "up", "/srv/up.git", null)`, then `fetchAll(1, null)`)
- `a filled push URL is sent`
- `unchecking Fetch after adding skips the fetch`
- `a fetch after adding that needs sign-in shows the credential dialog and retries`
- `a failed fetch after adding keeps the remote and shows a NetworkError in the dialog`
- `invalidRemoteName and remoteExists show under Name, invalidRemoteUrl under URL, and the form keeps its values`
- `any other add error shows as a message above the list`
- `Edit opens the form prefilled with the remote's name, URL and push URL; Save calls updateRemote`
- `Save with an emptied push URL sends null`
- `an edit target opens the form for that remote directly; Cancel returns to the list`
- `an edit target naming a missing remote shows the list`
- `an add target opens the add form`
- `Remove asks Remove remote origin? with the body; Remove calls removeRemote; Cancel does not`
- `Close and Escape call onClose; Escape inside the form returns to the list`
- `returns focus to the opener when it closes`

`BranchGroup.test.tsx`: `without onHeadingContextMenu the heading is not focusable and has no menu`; `with it, the heading is focusable and a right-click calls it with the pointer position and prevents the browser menu`; `Shift+F10 and the ContextMenu key call it at the heading's bottom-left`.

`BranchesPanel.test.tsx` (the ipc mock gains `removeRemote`):

- `a remote heading's context menu lists Edit remote… and Remove remote…`
- `Edit remote… asks to open the remotes dialog in edit mode for that remote` (`onOpenRemotes({ mode: "edit", name: "origin" })`)
- `Edit remote… is disabled without onOpenRemotes`
- `Remove remote… asks Remove remote origin? and removes it on confirm`
- `a failed remove shows its error in the panel`
- `the Local heading has no context menu`

`RepoPane.test.tsx`: `Remotes… opens the Remotes dialog and Close closes it`; `Edit remote… on a remote heading opens the dialog on that remote's form`; `the Remotes dialog does not follow the user to another tab` (rerender with tab 2: no dialog).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/features/remotes src/features/branches src/app src/styles`. Expected: missing `RemotesDialog` / `useRemoteActions` / `remoteCopy`; no heading menu.

- [ ] **Step 3: Implement**

`useRemoteActions.ts` follows `useBranchActions` (one `useMutation`, `onSettled` invalidates `queryKeys.repo(repoId)`, `run` resolves `null` or the `AppError`).

`RemotesDialog.tsx`: a modal in the `PromptDialog` structure (`role="dialog"`, `aria-modal`, `tabIndex={-1}`, `useRestoreFocus(fallbackFocus)` first). Internal view state `list | { form: "add" } | { form: "edit"; name } | { confirmRemove: name }`, initialised from `target` (an edit target whose remote is not in `useRemotes` once loaded falls back to the list). The list is a `<ul aria-label="Remotes">` of rows: name, fetch URL, the push URL when non-null and different, and `Edit` / `Remove` buttons with `aria-label="Edit {name}"` / `"Remove {name}"`; below it `Add remote` and `Close`. The form has `Name`, `URL`, `Push URL (optional)` inputs (trimmed on submit; an empty push URL is `null`), `Fetch after adding` (add only, default checked), inline field errors from `remoteFieldError` (`aria-describedby`), and `Cancel` / `Add` or `Save` (`Working…` while pending; disabled until name and URL are non-blank). After a successful add with the box checked it runs `network.run((c) => fetchAll(repoId, c))` and shows a `failed` result as a `NetworkError` above the list (the remote stays). Remove opens a `ConfirmDialog` with `removeRemoteCopy(name)`, `confirmLabel="Remove"`, `danger`. Escape in a form returns to the list; Escape in the list closes. Renders `<CredentialDialog prompt={network.prompt} />`.

`BranchGroup.tsx`: with `onHeadingContextMenu`, the `<h2>` gets `tabIndex={0}`, `onContextMenu` (`preventDefault`, call with `clientX` / `clientY`) and an `onKeyDown` for Shift+F10 / `ContextMenu` (`preventDefault`, call with the heading rect's `left` / `bottom`).

`BranchesPanel.tsx`: a `headingMenu` state `{ x, y, remote }` set from each remote group's `onHeadingContextMenu`; a second `ContextMenu` with `Edit remote…` (`disabled: onOpenRemotes === undefined`, calls `onOpenRemotes({ mode: "edit", name })`) and `Remove remote…` (opens a `removeRemote` dialog kind: `ConfirmDialog` with `removeRemoteCopy`, `danger`, `confirmLabel="Remove"`, `pending` from `useRemoteActions`; a failure lands in the panel error). `RepoPane.tsx`: renders `<RemotesDialog key={tab.id} repoId={tab.id} target={remotesTarget} onClose={() => setRemotesTarget(null)} />` while `remotesTarget` is set, and passes `onOpenRemotes={setRemotesTarget}` to `BranchesPanel` and `SyncToolbar`. The state is reset when `tab.id` changes (keyed `RepoPane` content or an effect on `tab.id`).

- [ ] **Step 4: Run the full front-end gate**

Run: `npm run test:coverage && npm run lint && npm run typecheck && npx prettier --check .`. Expected: all green, 100 % on all four metrics for `src/`.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(ui): GR-12 remotes dialog and remote heading menu"
```

---

## Execution: batched agent cycles

Work on a branch `feature/gr-12-remotes-sync` cut from `main`.

| Cycle | Tasks                                                                    | architect + tdd-tester | developer | tdd-tester-coverage + code-reviewer |
| ----- | ------------------------------------------------------------------------ | ---------------------- | --------- | ----------------------------------- |
| 1     | T1 (core, `AppError` mapping, migrated push tests)                       | 1 + 1                  | 1         | 1 + 1                               |
| 2     | T2 (commands, credentials on pushes, IPC, keys)                          | 1 + 1                  | 1         | 1 + 1                               |
| 3     | T3 (gate, messages, dialogs, toolbar, shortcuts, tag / branch migration) | 1 + 1                  | 1         | 1 + 1                               |
| 4     | T4 (remotes dialog, heading menu, wiring)                                | 1 + 1                  | 1         | 1 + 1                               |

- 5 dispatches per cycle × 4 cycles = 20, plus one final `architect` sign-off on the whole branch = **21 dispatches**. A reviewer's BLOCKING issues loop back to `developer` and add dispatches.
- Models: `architect` and `developer` **opus**; `tdd-tester`, `tdd-tester-coverage` and `code-reviewer` **sonnet**. Pass the model explicitly on every dispatch. Name agents with a `gr12-` prefix (for example `gr12-c1-developer`) so `SendMessage` never resumes an older agent of the same name; address follow-ups by agent id.
- The `AppError` mapping sits in cycle 1 (the user's grouping had it in cycle 2) because removing `GitError::PushFailed` breaks the app crate's exhaustive match; keeping it with the core keeps every commit compiling and `cargo test --workspace` green.
- Cycle 2 starts after cycle 1's developer has committed; Task 1's Interfaces fix every Rust name it needs. Cycles 3 and 4 depend only on Task 2's IPC names. Cycle 3's tester writes `src/test/remoteFixtures.ts` before any other test.
- The test role owns every edit to existing test files, fixtures and helpers: the four core push test files, `src-tauri/tests/{error,refs_commands,tag_commands}.rs`, the IPC tests, the `"pushFailed"` literals in feature tests, `RepoPane.test.tsx`, `BranchesPanel.test.tsx`, `BranchGroup.test.tsx`, `useBranchActions.test.tsx`, `useTagActions.test.tsx`, `TagsPanel.test.tsx`, `focusTargets.test.ts`, `src/test/remoteFixtures.ts`, `tests/fixtures/network_stderr/*`. The developer must not touch them.
- The user usually asks for every architect follow-up (BLOCKING or not) to be fixed before merge. Plan a short fix loop after the final architect review rather than listing follow-ups as deferred.

## Verification gate

Work is not done until all three of the following are green:

1. **Green tests and static checks.** From `src-tauri`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`. From the repo root: `npm run test:coverage` (the "All files" row reads 100 for % Stmts, % Branch, % Funcs and % Lines), `npm run lint`, `npm run typecheck`, `npx prettier --check .`.
2. **Full coverage confirmed by `tdd-tester-coverage`** for every cycle.
3. **Final `architect` approval** of file placement, design and conventions across the branch.

Acceptance walk (running app via `npm run tauri dev`, driven through the WebKit remote inspector as in earlier walks; spec §7). Fixtures: a repo whose `origin` is a local bare repo plus a second clone that pushes; a local `git http-backend` behind HTTP Basic auth (a small `python3 http.server` wrapper, as used to verify this plan) added as remote `h`; and one real HTTPS remote the user can sign in to.

1. Header shows `→ origin/main`; push from the second clone, Ctrl+Shift+F → `↓1`.
2. Ctrl+Shift+L (merge default) fast-forwards; no merge commit in the graph.
3. Diverge both sides on README.md, Pull (merge) → the GR-10 conflict banner and editor appear.
4. Commit locally while behind, Push → "The remote has commits you don't have" with **Pull**; Pull then Push succeeds.
5. Force push (with lease)… after another clone pushes unseen work → "The remote branch moved since your last fetch" with **Fetch**.
6. New branch, Push → Publish dialog; publish as `topic-pub` → header shows `→ origin/topic-pub`.
7. Fetch with `h` configured → "Sign in to 127.0.0.1:…"; a wrong token reopens with "Those credentials were rejected"; the right one succeeds, and with `credential.helper=store` the entry appears in the store file; Cancel shows nothing.
8. The real HTTPS remote: Fetch prompts once, then the helper answers silently.
9. Remotes…: add a remote (fetch after adding), rename it (its group heading follows), remove it from the Branches heading menu.
10. Tag push and remote branch delete against `h` prompt and succeed.
11. Detached HEAD and a repo without remotes: buttons disabled with their tooltips; shortcuts do nothing.

## After the last task

- Merge `--no-ff` into `main` and delete the branch. Post a Jira comment on GR-12 and move it to Done. Add `gr12-status.md` to memory with its MEMORY.md line (merge commit, date, follow-ups: cancelling a running operation, fetch/push progress, background fetch, SSH passphrase prompts, a credential prompt for clone).
