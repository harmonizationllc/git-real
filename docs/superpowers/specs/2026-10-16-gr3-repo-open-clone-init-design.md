# GR-3 — Open, clone, and initialize repositories

- Status: Approved
- Date: 2026-10-16
- Epic: GR-1 / Story: GR-3
- Depends on: ADR 0001 (technology stack), ADR 0002 (project structure)

## 1. Goal

A user can get a repository into Git Real three ways: open an existing local
folder, clone from an HTTPS or SSH URL, or initialize a new repository in a
folder. Recently opened repositories are listed on the start screen. Several
repositories can be open at once, each in its own tab.

This is the first feature on the scaffold, so it also proves the full spine
described in ADR 0002 section 5: pure domain in `git-real-core`, thin Tauri
commands over managed state, and a React UI talking through a single IPC seam.

### Acceptance criteria (from Jira GR-3)

1. Open a local folder; non-Git folders show a clear error with an option to
   initialize.
2. Clone from an HTTPS or SSH URL with a destination folder picker and a
   progress indicator.
3. Initialize a new repository in an empty folder.
4. Recently opened repositories are listed on the start screen and can be
   reopened or removed.
5. Multiple repositories can be open at once in tabs.

### Out of scope

- Branch listing and any repository content beyond a header (GR-7, GR-8).
- File watching and status (GR-4).
- Interactive credential prompts during clone (GR-12). The git CLI inherits the
  user's credential helpers and SSH agent, so non-interactive clones work now.
- Settings, keyboard shortcuts, window chrome beyond the tab bar (GR-14).

## 2. Decisions

- **Hand-written TypeScript IPC wrappers, not tauri-specta.** The command
  surface is small and the team is learning Rust. The seam is structured so
  specta can replace the wrapper bodies later (section 5.4).
- **Open and init use git2; clone uses the git CLI.** Per the hybrid backend
  rule. Clone progress is parsed from the CLI's stderr.
- **Init precondition is "not already a repository".** The ticket's happy
  path is an empty folder, but the "initialize here" offer appears on non-git
  folders that may contain files, and `git init` permits that. Initializing
  inside an existing repository is an error.
- **Recent-repos persistence is a JSON file** in the Tauri app config
  directory, written by the app layer. No `tauri-plugin-store`.
- **One new dependency**, `tauri-plugin-dialog`, for the native folder picker.
  Its JavaScript API is wrapped inside `src/lib/ipc` like everything else.

## 3. Rust domain: `git-real-core`

No Tauri dependency. Everything here is tested with `cargo test -p git-real-core`.

### 3.1 Modules

```
crates/git-real-core/src/
  lib.rs            # pub mod declarations, re-exports of GitError and model types
  error.rs          # GitError
  model/
    mod.rs
    repo.rs         # RepoSummary
    progress.rs     # Progress, ProgressPhase
    recent.rs       # RecentEntry
  repo/
    mod.rs
    session.rs      # RepoSession: open, init, summary
  remote/
    mod.rs
    git_cli.rs      # locate the git executable
    clone.rs        # clone via CLI with progress
    progress_parser.rs  # pure parser for `git clone --progress` stderr
  recent.rs         # RecentRepos list logic
  progress.rs       # ProgressSink trait
```

### 3.2 Types

```rust
// error.rs
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("{0} is not a Git repository")]
    NotARepository(PathBuf),
    #[error("{0} is already a Git repository")]
    AlreadyARepository(PathBuf),
    #[error("{0} does not exist")]
    PathNotFound(PathBuf),
    #[error("the git executable was not found on PATH")]
    GitCliMissing,
    #[error("git clone failed (exit code {code:?}): {stderr}")]
    CloneFailed { code: Option<i32>, stderr: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git2(#[from] git2::Error),
}
```

```rust
// model/repo.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: PathBuf,           // canonical workdir (or gitdir when bare)
    pub name: String,            // final path component
    pub head_branch: Option<String>, // None when HEAD is unborn or detached
    pub is_bare: bool,
}
```

```rust
// model/progress.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressPhase { Counting, Compressing, Receiving, Resolving, CheckingOut, Other }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: ProgressPhase,
    pub percent: Option<u8>,     // None when the line carries no percentage
    pub message: String,         // the raw line, trimmed
}
```

```rust
// model/recent.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: PathBuf,
    pub name: String,
    pub last_opened: u64,        // unix seconds
}
```

```rust
// progress.rs
pub trait ProgressSink: Send {
    fn report(&mut self, progress: Progress);
}
```

### 3.3 Behaviour

**`RepoSession::open(path) -> Result<RepoSession, GitError>`**

- Nonexistent path: `PathNotFound`.
- Existing directory that is not a repository (no `.git`, not bare):
  `NotARepository`. Discovery does not walk up to a parent repository; opening
  a subfolder of a repo is `NotARepository`, matching the user's intent of
  pointing at the repository root.
- Otherwise returns a session owning the `git2::Repository`.

**`RepoSession::init(path) -> Result<RepoSession, GitError>`**

- Nonexistent path: creates the directory, then initializes.
- Path that is already a repository: `AlreadyARepository`.
- Otherwise `git2::Repository::init` and returns the session.

**`RepoSession::summary(&self) -> RepoSummary`**

- `path` is the canonicalized workdir, or the gitdir for a bare repo.
- `name` is the last path component.
- `head_branch` is the short branch name when HEAD is a symbolic ref to a
  branch (including an unborn branch right after init), `None` when detached.

**`git_cli::locate() -> Result<PathBuf, GitError>`**

- Searches each entry of `PATH` for `git` (and `git.exe` on Windows). Returns
  `GitCliMissing` when none exists. Accepts an explicit PATH string in an
  inner function so tests can pass a fake.

**`clone::clone(url, dest, sink: &mut dyn ProgressSink) -> Result<PathBuf, GitError>`**

- Locates git, runs `git clone --progress <url> <dest>` with stderr piped.
- Reads stderr line by line (lines end in `\r` or `\n`), feeds each through
  `progress_parser::parse_line`, and reports every `Some(Progress)` to the sink.
- Non-zero exit: `CloneFailed` with the exit code and the collected stderr.
- Success: returns the canonical path of `dest`.

**`progress_parser::parse_line(&str) -> Option<Progress>`**

- Recognizes `Counting objects`, `Compressing objects`, `Receiving objects`,
  `Resolving deltas`, `Updating files` (mapped to `CheckingOut`) and extracts
  the percentage when present. Any other non-empty line maps to `Other` with
  no percentage. Empty lines yield `None`.

**`RecentRepos`**

- `touch(path, name, now)` inserts at the front, removing any earlier entry
  with the same path, then truncates to `MAX_ENTRIES = 20`.
- `remove(path)` removes a matching entry if present; no error if absent.
- `entries()` returns the list most-recent-first.
- Derives `Serialize`/`Deserialize` and `Default` so the app layer can load
  and save it as JSON. A missing or unparsable file yields `Default`.

### 3.4 Tests

- Fixtures use `tempfile::tempdir()` and `git2` to build repositories. A
  helper creates a repo with one commit so `head_branch` is populated, and a
  bare clone of it to use as a local clone URL.
- `open`: positive on a real repo; negative for missing path, plain folder,
  and a subfolder of a repo.
- `init`: positive on empty folder, on non-empty non-git folder, and on a
  missing folder; negative on an existing repo.
- `summary`: head branch for a repo with a commit, `None` for detached HEAD,
  branch name for a fresh init (unborn), bare flag for a bare repo.
- `progress_parser`: one case per phase, a line with no percentage, an
  unrelated line, an empty line.
- `clone`: integration test against the local bare fixture, asserting the
  sink received at least one `Receiving` or `CheckingOut` report and the
  destination opens as a repo; negative on a nonexistent URL (`CloneFailed`);
  `locate` negative with an empty PATH. The integration tests skip when `git`
  is not on PATH so a bare CI image does not fail for the wrong reason.
- `RecentRepos`: touch inserts at front, touch dedupes and moves to front,
  cap at 20, remove present, remove absent, round-trips through serde.

## 4. Tauri app layer: `src-tauri/src`

### 4.1 Modules

```
src-tauri/src/
  main.rs
  lib.rs             # run(): plugins, managed state, generate_handler!
  error.rs           # AppError
  state.rs           # RepoId, RepoRegistry, RecentStore
  events.rs          # event names and payload types
  commands/
    mod.rs
    repo.rs          # the GR-3 commands
```

### 4.2 Types

```rust
// error.rs
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError { pub kind: String, pub message: String }
```

`From<GitError>` maps each variant to a stable kind string:
`notARepository`, `alreadyARepository`, `pathNotFound`, `gitCliMissing`,
`cloneFailed`, `io`, `git`. Unknown repo ids map to kind `unknownRepo`.
Commands return `Result<T, AppError>`, so the front end receives a rejected
promise whose reason is `{ kind, message }`.

```rust
// state.rs
pub type RepoId = u64;

pub struct RepoRegistry {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<RepoId, Arc<Mutex<RepoSession>>>>,
}
```

`register(session) -> RepoId`, `get(id) -> Option<Arc<Mutex<RepoSession>>>`,
`remove(id) -> bool`. `std::sync::Mutex` throughout.

```rust
pub struct RecentStore { path: PathBuf, inner: Mutex<RecentRepos> }
```

`load(path)` reads the JSON file or starts from `Default`; `touch` and
`remove` mutate and save immediately; `entries()` returns a clone. The file
path is `<app_config_dir>/recent-repos.json`, resolved in `run()` via
`tauri::Manager::path()`.

```rust
// events.rs
pub const CLONE_PROGRESS: &str = "clone-progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressPayload { pub clone_id: u64, pub progress: Progress }
```

`EventProgressSink { app: AppHandle, clone_id }` implements the core's
`ProgressSink` by emitting `CLONE_PROGRESS`.

```rust
// commands/repo.rs — app-layer DTOs (they carry app concepts, so not in core)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepo { pub id: RepoId, pub summary: RepoSummary }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCliInfo { pub available: bool, pub path: Option<String> }
```

### 4.3 Commands

All commands follow the same pattern: a `#[tauri::command] async fn` that
extracts managed state and calls an inner function taking plain references.
Blocking git2 and process work runs inside
`tauri::async_runtime::spawn_blocking`.

| Command         | Args                                       | Returns                                                | Notes                                           |
| --------------- | ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------- |
| `open_repo`     | `path: String`                             | `OpenedRepo { id, summary }`                           | Registers session, touches recents              |
| `init_repo`     | `path: String`                             | `OpenedRepo`                                           | Same, via `RepoSession::init`                   |
| `clone_repo`    | `url: String, dest: String, clone_id: u64` | `OpenedRepo`                                           | Emits `clone-progress`; opens result on success |
| `close_repo`    | `id: RepoId`                               | `()`                                                   | Removes from registry; `unknownRepo` if absent  |
| `list_recent`   | —                                          | `Vec<RecentEntry>`                                     |                                                 |
| `remove_recent` | `path: String`                             | `Vec<RecentEntry>`                                     | Returns the updated list                        |
| `check_git_cli` | —                                          | `GitCliInfo { available: bool, path: Option<String> }` | Never errors                                    |

`clone_id` is chosen by the front end so it can filter progress events for
the dialog that started the clone.

### 4.4 Tests

Inner functions are tested with a `RepoRegistry` and a `RecentStore` pointed
at a temp file, using the same fixtures as core:

- `open_repo` registers and returns an id that `get` resolves; touches recents.
- `close_repo` removes; a second close is `unknownRepo`.
- `AppError` from each `GitError` variant serializes to the expected `kind`.
- `RecentStore` persists across a reload from the same path, and tolerates a
  missing or corrupt file.
- `clone_repo` inner with a recording sink (not the Tauri event sink) against
  the local bare fixture.

The `#[tauri::command]` wrappers and `run()` are not unit tested; they are
one-line adapters exercised by `npm run tauri dev`.

## 5. Front end: `src/`

### 5.1 Layout

```
src/
  main.tsx
  app/
    App.tsx              # shell: providers, TabBar, active pane or StartScreen
    TabBar.tsx
    RepoPane.tsx         # header only: name and head branch
  features/repo/
    StartScreen.tsx      # Open / Clone / Init actions + RecentList
    RecentList.tsx
    CloneDialog.tsx      # url, destination picker, progress, errors
    RepoError.tsx        # renders AppError; offers "Initialize here" on notARepository
    useOpenRepo.ts       # mutations: open, init, clone; on success -> tabs store
    useRecentRepos.ts    # query + remove mutation
  lib/
    ipc/
      index.ts           # the only module features import from
      types.ts           # DTOs mirroring Rust: RepoSummary, OpenedRepo, RecentEntry, Progress, AppError, GitCliInfo
      commands.ts        # one async function per command, wrapping invoke
      events.ts          # onCloneProgress(cloneId, handler) -> unlisten
      dialog.ts          # pickFolder() -> string | null, wrapping @tauri-apps/plugin-dialog
    query/
      client.ts          # QueryClient
      keys.ts            # queryKeys.recent
    store/
      repoTabs.ts        # zustand: tabs[], activeId, openTab, closeTab, activate
  components/            # shared presentational pieces as they emerge
  styles/
```

### 5.2 Behaviour

- **Start screen** shows three actions and the recent list. Open and Init
  call `pickFolder()`, then the command. Clone opens `CloneDialog`.
- **Open on a non-git folder** rejects with kind `notARepository`. `RepoError`
  shows the message and an "Initialize repository here" button that calls
  `initRepo` with the same path.
- **Clone dialog**: URL text field, destination folder picker, Clone button
  disabled until both are set. On submit it generates a `cloneId`, subscribes
  to progress, calls `cloneRepo`, shows the latest phase and percentage in a
  progress bar, and on success opens a tab and closes. On failure the dialog
  stays open with the error. If `checkGitCli` reports unavailable, the dialog
  shows that message instead of the form.
- **Recent list**: each row shows name and path, click reopens, a remove
  control calls `removeRecent` and updates the list. Reopening a path that no
  longer exists shows the `pathNotFound` error and leaves the entry in place
  so the user can remove it deliberately.
- **Tabs**: opening a repo already open activates its tab instead of
  duplicating it (matched by `summary.path`). Closing a tab calls `closeRepo`
  and activates the nearest remaining tab. With no tabs, the start screen
  shows; a "+" tab also shows the start screen.
- **ESLint** already forbids `@tauri-apps/api/core` outside `src/lib/ipc`.
  Extend the restricted list with `@tauri-apps/plugin-dialog` and
  `@tauri-apps/api/event`.

### 5.3 Tests

All IPC is mocked at the seam with `mockIPC` / `clearMocks` from
`@tauri-apps/api/mocks`. The dialog wrapper is mocked with `vi.mock` on
`src/lib/ipc/dialog`.

- `commands.test.ts`: each wrapper invokes the exact command name with the
  expected argument object and returns the parsed payload; rejections surface
  the `AppError` unchanged.
- `events.test.ts`: `onCloneProgress` filters by `cloneId` and returns an
  unlisten function.
- `repoTabs.test.ts`: open, dedupe by path, close activates neighbour, close
  last leaves no active tab.
- `StartScreen.test.tsx`: renders recents, Open flows through picker to
  `openRepo`, picker cancel does nothing, error path renders `RepoError`,
  "Initialize here" calls `initRepo` with the failed path.
- `CloneDialog.test.tsx`: button disabled until valid, progress updates from
  events, success opens a tab, failure keeps the dialog with the error,
  missing git CLI shows the notice.
- `RecentList.test.tsx`: reopen and remove.
- `App.test.tsx`: no tabs shows start screen, tab switching, close tab.

### 5.4 Migration path to tauri-specta

If specta is adopted later:

1. Add `specta` and `tauri-specta` to the app crate and annotate the existing
   command fns and DTOs. The DTOs already use one struct per type with
   `serde(rename_all = "camelCase")`, which is what specta expects.
2. Generate `src/lib/ipc/bindings.ts` from the build.
3. Replace the bodies of `commands.ts` and `types.ts` with re-exports from
   `bindings.ts`. `index.ts` and every feature import stay unchanged.
4. Delete the hand-written contract tests that pinned command names; the
   compiler now enforces them.

## 6. Definition of done

- All five acceptance criteria demonstrated in `npm run tauri dev` on Linux.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` green.
- `cargo fmt --check`, `cargo clippy --workspace -D warnings`,
  `cargo test --workspace` green from `src-tauri`.
- Coverage audit and architect sign-off per the team workflow in CLAUDE.md.
- Jira GR-3 moved to Done.
