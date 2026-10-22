# GR-12 — Remotes: fetch, pull, push with authentication

- Jira: GR-12 "Remotes: fetch, pull, push with authentication". One spec
  for the whole story (user choice: no slices).
- Depends on: GR-3 (`git_cli` wrapper, `GIT_TERMINAL_PROMPT=0`), GR-7
  (`BranchesPanel` remote groups, `ContextMenu`, `ConfirmDialog`,
  `PromptDialog`, the prepare-then-run pattern of `remote/push_delete.rs`,
  `BranchSummary.upstream`/`ahead`/`behind`), GR-10a (`merge_branch`,
  `rebase_onto`, `OperationOutcome`, `OperationBanner`, the conflict flow),
  GR-11b (`remote/push_tag.rs`, `RepoError variant="panel"`).
- Follows: ADR 0001 / CLAUDE.md hybrid rule (network and credentials → git
  CLI; local config and ref writes → git2 with `default-features = false`),
  ADR 0002, the IPC seam rule, the `spawn_blocking` rule, the 100 % coverage
  gate.
- Date: 2026-10-22. Design approved in chat.

## 1. Goal

From a toolbar in the repository header, or with a keyboard shortcut, the
user can fetch, pull (merge or rebase), and push the current branch. A push
of a branch with no upstream asks where to publish it and sets the upstream.
Force push uses `--force-with-lease` behind a confirmation. The header shows
the current branch's upstream with ahead/behind counts. A Remotes dialog adds,
edits and removes remotes. SSH uses whatever the system `ssh` uses (agent,
`~/.ssh` keys and config). HTTPS uses the user's git credential helper; when
it has nothing stored, the app asks for a username and token, retries, and
hands the working credentials to the helper to store. Every network or auth
failure shows a message that says what to do next.

### Out of scope (follow-ups)

- Cancelling a running network operation.
- Progress percentages for fetch/push (busy state only).
- Automatic background fetch.
- SSH key passphrase prompts (keys must be in `ssh-agent` or unencrypted).
- The credential prompt for clone (GR-3's clone keeps its current error).
- A configurable shortcut system (GR-14).
- Fetching a single remote from the toolbar; pushing branches other than the
  current one; pushing to a remote other than the upstream's.

## 2. Decisions

- **One spec, no slices** (user choice).
- **HTTPS credentials: fail → prompt → retry** (user choice A). The first
  run uses the configured helper with prompts disabled. On an HTTPS auth
  failure the UI asks; the retry passes the credentials through environment
  variables to a one-shot inline helper (never on the command line). After a
  successful retry, `git credential approve` stores them in the user's
  helper. No askpass bridge, no socket, no second binary entry point.
- **Toolbar in the repo header** (user choice): `Fetch`, split `Pull ▾`,
  split `Push ▾`, `Remotes…`, beside the branch line with `↑n ↓m`.
  Shortcuts **Ctrl+Shift+F** fetch, **Ctrl+Shift+L** pull (default mode),
  **Ctrl+Shift+P** push (Cmd on macOS, as Ctrl+Shift+H already does).
- **Remote management in a dialog** (user choice), opened from `Remotes…`
  and from new `Edit remote…` / `Remove remote…` items on remote group
  headings in the Branches panel. The refs column (GR-17) is unchanged.
- **Pull = fetch + existing merge/rebase.** Pull fetches the upstream's
  remote, then calls `merge_branch` or `rebase_onto` with the upstream ref,
  so conflicts and in-progress state reuse the GR-10 banner and editor
  unchanged. Default mode follows `pull.rebase` (`true`, `merges`,
  `interactive` → rebase; anything else or unset → merge); the menu offers
  both explicitly.
- **Fetch = `git fetch --all`.** Pruning follows the user's `fetch.prune`
  config; the app passes no `--prune`.
- **Force push = `--force-with-lease=refs/heads/<branch>:<oid>`**, where
  `<oid>` is the remote-tracking ref's value read when the push is prepared,
  so an unseen remote update is never overwritten.
- **One network operation per repository at a time.** The front end
  disables the toolbar while a remote mutation is pending; the backend does
  not add a lock (git's own ref locks protect the repository).

## 3. Core (`git-real-core`)

All new files live in `src/remote/`. Every runnable type follows the
`push_tag.rs` pattern: `RepoSession::prepare_*` validates under the session
lock and returns an owned value; `run()` executes after the lock is released.

### 3.1 `src/remote/auth.rs`

```rust
pub struct Credentials { pub username: String, pub token: String }
```

- `Debug` is implemented by hand and prints `token: "***"`.
- `pub(crate) fn apply(cmd: &mut Command, creds: Option<&Credentials>)`:
  with `Some`, adds `-c credential.helper=` (clears configured helpers for
  this run) and `-c credential.helper=!f() { echo "username=$GR_USERNAME";
echo "password=$GR_TOKEN"; }; f`, and sets the two env vars. These `-c`
  args go before the subcommand.
- `pub(crate) fn approve(git, workdir, url, creds)`: runs
  `git credential approve` with `protocol`, `host`, `path` (parsed from the
  remote URL), `username` and `password` on stdin through
  `git_cli::capture_with_input`. Failure is ignored (no helper configured
  is not an error).
- `run_push` (in `remote/mod.rs`) gains a `creds: Option<&Credentials>`
  parameter; `TagPush::run`, `TagPushDelete::run` and the GR-7 remote branch
  delete pass theirs through, so those operations get the prompt too.

### 3.2 `src/remote/classify.rs`

```rust
pub enum NetworkErrorKind {
    HttpsAuthRequired,          // "could not read Username", "terminal prompts disabled"
    HttpsAuthRejected,          // "Authentication failed for", HTTP 401/403
    SshAuthFailed,              // "Permission denied (publickey"
    HostKeyUnverified,          // "Host key verification failed"
    HostUnreachable,            // "Could not resolve host", "Connection refused",
                                // "Connection timed out", "Network is unreachable"
    RepoNotFound,               // "Repository not found", "does not appear to be a git repository"
    PushRejectedNonFastForward, // "[rejected]" + "(fetch first)" or "(non-fast-forward)"
    LeaseStale,                 // "[rejected]" + "(stale info)"
    Other,
}
pub fn classify(stderr: &str) -> NetworkErrorKind
```

Pure, first match wins in the order listed. Fixture stderr samples from
real git (HTTPS and SSH variants) live in `tests/fixtures/network_stderr/`.

### 3.3 Errors

A new variant replaces direct use of `PushFailed` for these operations:

```rust
NetworkFailed { verb: &'static str, kind: NetworkErrorKind, https: bool, stderr: String }
```

`verb` is `"fetch"`, `"pull"` or `"push"`. `https` is true when the remote's
URL scheme is `http`/`https` (so the UI knows a credential prompt can help).
`PushFailed` callers (tag push/delete, remote branch delete) move to
`NetworkFailed` too; the `pushFailed` front-end kind is removed with its
uses migrated.

### 3.4 `src/remote/fetch.rs`

`RepoSession::prepare_fetch() -> Result<Fetch, GitError>`: errors with
`NoRemotes` when the repository has none. `Fetch::run(creds)` runs
`git -C <workdir> fetch --all`. `https` is true when any remote is HTTPS.
After a successful run with credentials, `approve` runs for each HTTPS
remote's URL.

### 3.5 `src/remote/pull.rs`

```rust
pub enum PullMode { Merge, Rebase }
```

- `RepoSession::pull_default_mode() -> PullMode` reads `pull.rebase` via
  git2 config.
- `RepoSession::prepare_pull()`: requires a local HEAD branch
  (`DetachedHead` otherwise) with an upstream (`NoUpstream` otherwise);
  captures the upstream's remote name and full upstream ref.
- `Pull::fetch(creds)` runs `git fetch <remote>`.
- The app layer then calls the existing `merge_branch(upstream)` or
  `rebase_onto(upstream)` on the session and returns its `OperationOutcome`
  (fast-forward, merged, conflicts, …). Pull itself adds no merge logic.

### 3.6 `src/remote/push.rs`

```rust
pub enum PushTarget { Upstream, SetUpstream { remote: String, branch: String } }
```

- `RepoSession::prepare_push(target, force) -> Result<Push, GitError>`:
  - Requires a HEAD branch (`DetachedHead`).
  - `Upstream` with no upstream → `NoUpstream` (the UI then opens the
    set-upstream dialog). The upstream must be a branch on a remote.
  - `SetUpstream`: the remote must exist (`RemoteNotFound`), the branch name
    passes `validate_branch_name`.
  - `force`: reads the remote-tracking ref's oid for the lease; when the
    tracking ref is missing the lease is `refs/heads/<branch>:` (expect
    absent).
- `Push::run(creds)`: `git push [-u] [--force-with-lease=<lease>] <remote>
HEAD:refs/heads/<branch>`.

### 3.7 `src/remote/remotes.rs` (git2, no network)

```rust
pub struct RemoteInfo { pub name: String, pub fetch_url: String, pub push_url: Option<String> }
```

`impl RepoSession`:

- `list_remotes() -> Vec<RemoteInfo>` sorted by name.
- `add_remote(name, url)`: `InvalidRemoteName` unless
  `git2::Remote::is_valid_name`; `RemoteExists` on duplicates; empty URL →
  `InvalidRemoteUrl`.
- `update_remote(name, new_name, url, push_url: Option<String>)`: rename
  (git2 `remote_rename`, which moves tracking refs and branch upstream
  config) when the name changed, then `remote_set_url` and
  `remote_set_pushurl` (`None` clears it). Missing → `RemoteNotFound`.
- `remove_remote(name)`: git2 `remote_delete` (removes tracking refs and
  upstream config for its branches).

New `GitError` variants: `NoRemotes`, `NoUpstream`, `DetachedHead`, `InvalidRemoteName`, `InvalidRemoteUrl`, `RemoteExists`,
`NetworkFailed`.

## 4. App layer (`src-tauri`)

New `src/commands/remote.rs`. Every command runs its git work in
`tauri::async_runtime::spawn_blocking` and emits `REPO_CHANGED` after any
success that changed refs or config.

| Command             | Args                                      | Returns               |
| ------------------- | ----------------------------------------- | --------------------- |
| `fetch`             | `repo_id, credentials?`                   | `()`                  |
| `pull_default_mode` | `repo_id`                                 | `"merge" \| "rebase"` |
| `pull`              | `repo_id, mode, credentials?`             | `OperationOutcome`    |
| `push`              | `repo_id, target, force, credentials?`    | `()`                  |
| `list_remotes`      | `repo_id`                                 | `RemoteInfo[]`        |
| `add_remote`        | `repo_id, name, url`                      | `()`                  |
| `update_remote`     | `repo_id, name, new_name, url, push_url?` | `()`                  |
| `remove_remote`     | `repo_id, name`                           | `()`                  |

`credentials` is `{ username, token } | null`. It lives only in memory for
the command; it is never logged, stored, or put into an error message.
Existing `push_tag`, `delete_remote_tag` and remote-branch delete commands
gain the same optional `credentials` argument.

`AppError` gains kinds `networkFailed` (with a `network: { verb, kind,
https }` payload; `stderr` stays in `message` for a "Details" disclosure),
`noRemotes`, `noUpstream`, `detachedHead`, `invalidRemoteName`,
`invalidRemoteUrl`, `remoteExists`.

## 5. Front end

### 5.1 IPC (`src/lib/ipc`)

Typed wrappers for each command above plus the new error kinds and
`NetworkErrorKind` union; nothing else imports `invoke`. Query key
`queryKeys.remotes(repoId)`; the pull default mode is fetched with the
remotes query's sibling key `queryKeys.pullMode(repoId)`.

### 5.2 `features/remotes/`

- **`useNetworkAction.ts`** — the single gate for every network mutation
  (fetch, pull, push, tag push/delete, remote branch delete). It takes an
  action `(credentials | null) => Promise<T>` and:
  1. Runs it with `null`.
  2. On `networkFailed` with `https` and kind `HttpsAuthRequired` or
     `HttpsAuthRejected`, opens `CredentialDialog`; on submit, reruns with
     the entered credentials; a further rejection reopens the dialog with
     "Those credentials were rejected". Cancel ends with no error shown.
  3. Any other failure becomes a `{ title, hint, action? }` message from
     `networkMessage.ts`.
  4. On success invalidates branches, log, tags and status queries.
     Credentials are held in component state only until the retry settles.
- **`networkMessage.ts`** — pure mapping, kind → text:
  - `SshAuthFailed`: "SSH key was refused" / "Add your key to the agent
    with `ssh-add`, and check it is registered with the host."
  - `HostKeyUnverified`: "Host key not trusted" / "Connect once from a
    terminal (`ssh -T <host>`) to verify and save the host key."
  - `HostUnreachable`: "Could not reach the remote" / "Check your network
    connection and the remote URL."
  - `RepoNotFound`: "Repository not found" / "Check the remote URL, and
    that your account can access it." with action "Edit remote…".
  - `PushRejectedNonFastForward`: "The remote has commits you don't have" /
    "Pull, then push again." with action "Pull".
  - `LeaseStale`: "The remote branch moved since your last fetch" / "Fetch
    and review the new commits before forcing again." with action "Fetch".
  - `HttpsAuth*` without `https` cannot occur; `Other`: "git <verb>
    failed" with the stderr under "Details".
  - `noRemotes`: "No remotes configured" with action "Add remote…";
    `detachedHead`: "Check out a branch to pull or push."
- **`SyncToolbar.tsx`** — rendered in the `RepoPane` header after the
  branch line:
  - Upstream text `main → origin/main` with `↑2 ↓3` (hidden when zero;
    "upstream gone" when `ahead`/`behind` are `null`; "no upstream" when
    absent). Data comes from the existing branches query's `head`.
  - `Fetch`; `Pull ▾` (main click = default mode; menu: "Pull (merge)",
    "Pull (rebase)"); `Push ▾` (main click = push; menu: "Force push (with
    lease)…"); `Remotes…`.
  - Disabled states with `title` tooltips: no remotes (Fetch/Pull/Push),
    detached HEAD (Pull/Push), no upstream (Pull), any network mutation
    pending for this repo (all three; label becomes "Fetching…",
    "Pulling…", "Pushing…").
  - Errors render in a `RepoError variant="panel"` under the toolbar, with
    the message's action button.
- **Shortcuts** — `RepoPane`'s existing window keydown handler gains
  Ctrl/Cmd+Shift+F/L/P, each calling the toolbar's actions through a shared
  `useSyncActions(repoId)` hook (ignored while disabled or while a dialog
  is open).
- **`CredentialDialog.tsx`** — modal: host shown in the title ("Sign in to
  github.com"), Username, Token (password input, labelled "Token or
  password"), note "Your git credential helper will store these if one is
  configured.", Cancel / Sign in. Focus starts in Username; restores focus
  with `useRestoreFocus`.
- **`SetUpstreamDialog.tsx`** — opened when push fails with `noUpstream`:
  remote `<select>` (default `origin` if present, else first), branch name
  (default the local name), "Publish". Submits `SetUpstream`.
- **Force push** — `ConfirmDialog`: "Force push main to origin?" / "This
  replaces origin/main with your local branch. It fails safely if someone
  else pushed since your last fetch." / "Force push".
- **`RemotesDialog.tsx`** — list of remotes (name, fetch URL, push URL if
  different) with Edit and Remove per row and Add at the bottom. Add/Edit
  use an inline form (name, URL, optional push URL); Add has "Fetch after
  adding" checked by default (runs through `useNetworkAction`). Remove asks
  via `ConfirmDialog`: "Remove remote origin?" / "Its remote-tracking
  branches are deleted locally. Nothing changes on the server."
  Validation errors (`invalidRemoteName`, `invalidRemoteUrl`,
  `remoteExists`) show inline under the field.
- **Branches panel** — each remote group heading gets a context menu
  (right-click, Shift+F10, ContextMenu key) with "Edit remote…" (opens
  `RemotesDialog` in edit mode for that remote) and "Remove remote…".
  Existing tag push/delete and remote branch delete switch to
  `useNetworkAction`.

## 6. Error handling summary

| Situation                          | Result                                           |
| ---------------------------------- | ------------------------------------------------ |
| HTTPS, nothing stored              | Credential dialog → retry → `credential approve` |
| HTTPS, wrong token                 | Dialog reopens with "rejected" note              |
| SSH key refused / host key unknown | Panel message with `ssh-add` / `ssh -T` hint     |
| Offline, DNS, refused              | "Could not reach the remote"                     |
| Push behind remote                 | Message with **Pull** action                     |
| Lease stale                        | Message with **Fetch** action                    |
| Push, no upstream                  | Set-upstream dialog                              |
| Pull conflicts                     | Existing GR-10 banner and conflict editor        |
| Detached HEAD / no remotes         | Buttons disabled with tooltip                    |
| Unknown git failure                | "git push failed" + stderr under Details         |

## 7. Testing

- **Core unit:** `classify` against every fixture; `Credentials` `Debug`
  redacts; `pull_default_mode` for each `pull.rebase` value; remote CRUD
  including invalid names, duplicates, rename moving upstream config, and
  remove deleting tracking refs.
- **Core integration** (`tests/`, local bare repos over `file://`, no real
  network): fetch updates tracking refs; pull merge, pull rebase,
  pull fast-forward, pull with conflicts reports `Conflicts`; push; push
  without upstream → `NoUpstream`; set-upstream push writes
  `branch.<name>.remote/merge`; non-fast-forward push classifies correctly;
  force push succeeds when the lease holds and fails as `LeaseStale` when
  the remote moved after the last fetch; `NoRemotes`, `DetachedHead`.
- **Credentials:** a fake `git` script (as `cli_unavailable.rs` does) that
  records its argv and env and runs the inline helper; asserts the token
  appears only in env, never in argv, and that `approve` writes the
  expected stdin.
- **App layer:** command tests in `src-tauri/tests/remote_commands.rs` for
  error-kind mapping and that `credentials` never appears in an error.
- **Front end (Vitest, IPC mocked at `src/lib/ipc`):** `useNetworkAction`
  (success, auth required → dialog → retry success, rejected → reopen,
  cancel, non-auth error), `networkMessage` for every kind, `SyncToolbar`
  (all disabled states, labels while pending, ahead/behind text variants,
  menus, error action buttons), shortcuts in `RepoPane`, each dialog
  (validation, focus, submit, cancel), Branches heading menu, migrated tag
  and remote-branch actions.
- **Gate:** `npm test`, `npm run lint`, `npm run typecheck`,
  `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, 100 %
  coverage, architect sign-off, then a live acceptance walk in the running
  app against a local bare remote plus one real HTTPS remote.
