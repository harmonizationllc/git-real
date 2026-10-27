# GR-20: External-tool hardening and Windows tool commands — design

**Ticket:** GR-20 "GR-14 hardening: open_in_editor path guard, settings lock
during git verify, non-Linux tool commands" (Task, relates to GR-14).
**Builds on:** GR-14 §2 (external tools, settings store) and GR-29 (one
settings file).
**Status:** implemented on branch `feature/gr-20-tools-hardening`; Windows probe results in §6.1

## 1. Intent

Three follow-ups from the GR-14 reviews. The first two are hardening of
code that works today; the third is the first real step toward Windows,
which the owner confirmed on 2026-10-27 is "on the horizon" (macOS is not).
The owner also agreed to a Windows CI job so the Windows behaviour is
exercised by a real Windows toolchain rather than only by Linux tests with
the platform forced.

### Goals

1. `open_in_editor` with a `repoId` only opens paths that are, textually,
   inside that repository's working tree, by the same rule every other
   path-taking command already applies. A symlink inside the repository
   that points outside it is the repository's own content and is opened,
   as every other command would read it; the guard is lexical, not
   canonicalising.
2. Reading settings never waits on `git --version` while another caller is
   saving a new git executable.
3. An editor command typed on Windows the way a Windows user would type it
   (`code --wait`, `"C:\Program Files\Microsoft VS Code\Code.exe" --wait`,
   `notepad`) starts the editor on Windows, with no console window flashing.
4. The core crate compiles, passes clippy and passes its tests on a Windows
   runner in CI, and keeps doing so.

### Non-goals

- macOS tool commands (owner: not on the horizon).
- Building or packaging the Tauri application on Windows; a Windows job
  for the `git-real` (Tauri) crate or `npm run tauri build`. That is the
  future Windows packaging ticket.
- Changes to the difftool and mergetool mechanics. Both run through
  `git difftool`/`git mergetool`, and git runs the configured command
  through its own `sh` on every platform including Git for Windows, so the
  user's command is a POSIX shell line everywhere and the settings hints
  (`meld "$LOCAL" "$REMOTE"`) stay correct.
- Console-based editors (vim, nano). The editor is spawned with its
  standard streams closed on Linux already, so a terminal editor has never
  been usable from the app; Windows gets the same assumption (§4.3).
- Any settings UI change. The editor hint "Command line; the file or
  folder path is appended, e.g. code --wait" is true on both platforms.
- Front-end changes. `FileHeader` and the command palette already send
  repo-relative paths (with a repo id) or absolute paths (without one).

### Anti-goals

- A Windows job that runs a thinned-down test list so it goes green. If
  existing core tests fail on Windows for reasons unrelated to this ticket,
  the plan says what happens (§6); the job must run the whole core crate.
- Re-enabling git2 network features or adding a `tokio` dependency.

## 2. Constraints

- `git-real-core` has no Tauri dependency and keeps platform-specific
  assumptions out (CLAUDE.md). The crate already carries two small
  platform switches (`git_cli::CANDIDATES` for `git.exe`,
  `paths::repo_relative` for `\` and `:`), so a platform-chosen default is
  acceptable when the behaviour itself is a pure function the tests can
  drive on any platform.
- Tests come first and are written by the test role; the developer writes
  the minimum that makes them pass.
- Existing error kinds are reused where one fits. A new `AppErrorKind` is
  a wire-shape change and needs a reason.
- The Windows runner has no COSMIC, no Tauri system libraries and no
  display; only the core crate runs there.

## 3. Item 1: path guard in `open_in_editor`

### 3.1 Today

`open_in_editor_inner` (`src-tauri/src/commands/tools.rs`) does
`workdir.join(path)` when a repo id is given. `Path::join` replaces the
base when the argument is absolute, so `/etc/hosts` (or `C:\...` on
Windows) opens outside the repository, and `../../x` walks out of it.

### 3.2 Decision

When a repo id is given, the path is validated as a repository-relative
path with the same rules every other command uses:
`git_real_core::paths::repo_relative` (non-empty, no leading `/`, no
empty, `.` or `..` components, no leading `.git` component, and on Windows
no `\` or `:`). A rejected path is reported as `GitError::PathNotFound`,
which already maps to `AppErrorKind::PathNotFound`; the front end's
existing error toast shows it. `.git` is rejected on purpose: nothing in
the UI offers to open `.git/config` in the editor, and a path that
reaches into `.git` from a diff header is a bug elsewhere.

Without a repo id the path is used unchanged, as today (the command palette
opens whatever absolute path the user picked).

Where the validation lives is the builder's call: either `repo_relative`
becomes `pub` (it is `pub(crate)` today), or core gains a small
`tools::open_repo_file_in_editor(cmd, workdir, raw_path)` that validates
and joins. The command handler must not duplicate the rules.

### 3.3 Tests

In `src-tauri/tests/tools_commands.rs`, with a repo id: an absolute path, a
`..` path, an empty path and a `.git/config` path each fail with
`PathNotFound` and spawn nothing (the fake editor records argv; no record
appears). A plain relative path still opens, resolved against the workdir,
with the cwd set, as the existing test asserts.

## 4. Item 2: settings lock during git verification

### 4.1 Today

`SettingsStore::update` (`src-tauri/src/settings_store.rs`) takes the
mutex, applies the patch, runs `git_cli::verify` (spawns `git --version`)
if the executable changed, saves, and swaps. `get` waits the whole time.
`get` is called by `get_settings` and by the tool commands, so a slow or
hung `git --version` (a network drive, an antivirus scan on Windows)
freezes every settings read.

### 4.2 Decision

Verification runs with no lock held. The executable verified is the one
the **patch** names, not one read from the store:

1. Take the lock just long enough to clone the current settings; drop it.
   Apply the patch to that snapshot as a dry run: a `SettingsError` is
   returned here, so an invalid patch never spawns git (today's order of
   errors, which the existing tests pin, is kept).
2. If `patch.git.executable` is `Some(Some(path))` and `path` differs from
   the snapshot's executable, call `git_cli::verify(&path)` unlocked; a
   failure returns the error and nothing was touched.
3. Take the lock. Apply the patch to the **current** settings (not to the
   snapshot from step 1), save, swap, and update the process-wide git
   override if the executable changed versus the value that was stored at
   this moment. Release.

Re-applying under the lock means two overlapping updates each land on top
of the other's result instead of one overwriting the other, and the value
being saved is always exactly the value that was verified, because the
patch supplies it. Two overlapping updates of the executable may verify
twice; that is fine.

A patch that sets the executable to the value already stored skips
verification, as today. A patch that clears it (`Some(None)`) never
verifies, as today.

### 4.3 Tests

In `src-tauri/tests/settings_store.rs`: the existing update tests keep
passing unchanged. One new test uses a fake git whose `--version` blocks
until a file appears; `update` runs on a thread, the test calls
`store.get()` from the main thread with a bounded wait and asserts it
returns while the fake git is still blocked, then releases the fake git and
asserts the update finishes with the new executable stored and the
override set. `tests/tools_commands.rs` has a precedent for this shape
(`external_merge_does_not_hold_the_session_lock_while_the_tool_runs`).

## 5. Item 3: Windows editor commands

Only the editor path (`tools::open_in_editor`) parses and spawns the
user's command itself. Three things break on Windows today.

### 5.1 Command splitting

`split_command` treats `\` as an escape outside single quotes, so
`C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe` loses
every separator. It also honours single quotes, which Windows command
lines do not.

**Decision.** The splitter gains a syntax parameter:

```rust
pub enum CommandSyntax { Posix, Windows }
impl CommandSyntax { pub fn native() -> Self { /* cfg!(windows) */ } }
pub fn split_command(cmd: &str) -> Result<Vec<String>, ToolError>      // native()
pub fn split_command_with(syntax: CommandSyntax, cmd: &str) -> Result<Vec<String>, ToolError>
```

`Posix` is today's behaviour, unchanged, with its existing tests.
`Windows` follows the MSVCRT / `CommandLineToArgvW` rules:

- Arguments are separated by runs of spaces and tabs.
- A double quote starts or ends a quoted span; the quotes themselves are
  dropped; a quoted span may sit inside an argument (`a"b c"d` is `ab cd`).
- Backslashes are literal **unless** they are followed by a double quote:
  `2n` backslashes then `"` give `n` backslashes and the quote toggles
  quoting; `2n+1` backslashes then `"` give `n` backslashes and a literal
  `"`.
- Single quotes are ordinary characters.
- An unterminated quote is `ToolError::UnterminatedQuote` (the Windows
  rule of silently closing it at end of input is not followed, so the two
  syntaxes report the same mistake the same way); a blank command is
  `ToolError::EmptyCommand`; an explicit `""` argument is kept.
- `""` inside a quoted span (the post-2008 "literal quote" rule) is the
  builder's call; a test pins whichever it is.

Table-driven tests run **both** syntaxes on Linux by passing the syntax
explicitly. The `native()` choice is pinned by a test under `cfg(windows)`
and one under `cfg(not(windows))`.

### 5.2 Program resolution

`Command::new("code")` on Windows finds only `code.exe` on `PATH`; VS
Code's launcher is `code.cmd`, so the most common editor command fails
with "file not found". Rust's standard library runs a `.bat`/`.cmd`
program through `cmd.exe /c` itself (with the BatBadBut-safe quoting since
Rust 1.77) **when the program name it is given already ends in that
extension**, so the fix is to resolve the name before spawning.

**Decision.** A pure resolver in core:

```rust
pub struct ToolEnv { pub path: OsString, pub pathext: OsString }   // from_process() reads PATH/PATHEXT
pub fn resolve_program(program: &str, env: &ToolEnv,
                       is_file: impl Fn(&Path) -> bool) -> Option<PathBuf>
```

The resolver splits `PATH` on `;` and recognises Windows-rooted entries
(`X:\`, `X:/`, `\\`) itself, and builds candidates as strings joined with
`\`, so it behaves identically on a Linux host.

Rules, used only under the Windows syntax:

- The candidate names for a program are: the name **as given, only when
  its last component already has an extension** (a `.` after the last
  separator that is not its first character), then the name with each
  `PATHEXT` extension appended, in `PATHEXT` order. A bare name is never
  probed as given: a standard VS Code install puts an extensionless `sh`
  script named `code` next to `code.cmd`, and `CreateProcess` cannot run
  it, so `code` must resolve to `code.cmd` the way `cmd.exe` would
  (amended 2026-10-27 after the Cycle B review).
- If `program` contains a path separator (`\` or `/`) or a drive prefix,
  it is not searched on `PATH`: its candidates are probed where it points;
  return the first that `is_file`.
- Otherwise, for each absolute entry of `PATH` in order (empty and relative
  entries skipped, as `git_cli::locate_in` does), probe `dir\<candidate>`
  for each candidate; return the first file found. Extensions are probed
  exactly as `PATHEXT` spells them (the filesystem is case-insensitive);
  `Code.exe` is probed as given and only then as `Code.exe.COM` and so on.
- `PATHEXT` falls back to `.COM;.EXE;.BAT;.CMD` when unset or empty.
- `None` means "not found"; the spawn then reports
  `ToolError::Spawn { program, cause }` with the cause "not found on PATH"
  rather than letting `CreateProcess` produce a less specific message.

Under the POSIX syntax nothing changes: `Command::new` searches `PATH`
itself and there is no `PATHEXT`.

Resolution can hand the standard library a `.cmd`/`.bat` program, and
since Rust 1.77 `Command` refuses (with `InvalidInput`) an argument it
cannot escape safely for `cmd.exe`, such as a path containing `"`. That
error takes the existing route: `ToolError::Spawn` with the OS message as
the cause. No special wording.

Tests build a temporary directory tree, pass synthetic `PATH` and
`PATHEXT` strings and a closure over `Path::is_file`, and run on every
platform, since nothing in the resolver depends on the host OS.

**Seam for the full editor path.** `open_in_editor(cmd, path, cwd)` keeps
its signature and uses `CommandSyntax::native()` and the real `PATH` and
`PATHEXT`. A sibling, `open_in_editor_with(syntax, env, cmd, path, cwd)`,
takes the syntax and a small struct carrying `PATH` and `PATHEXT`
(`ToolEnv { path, pathext }` or equivalent), and is what the tests call,
so the Windows splitting-and-resolving route is exercised end to end on
Linux with a fake `code.cmd` on a synthetic `PATH`. The native function is
a one-line wrapper over the sibling.

### 5.3 Spawning

A console program (and `cmd.exe /c code.cmd` is one) started from a GUI
process on Windows opens a console window, which flashes and may stay
open. **Decision:** on Windows the editor is spawned with the
`CREATE_NO_WINDOW` creation flag
(`std::os::windows::process::CommandExt::creation_flags`), behind
`#[cfg(windows)]`, with stdin/stdout/stderr null as today. This is the same
"the editor is a GUI program" assumption Linux already makes (§1
non-goals). This is the one piece that Linux cannot execute; the Windows
CI job compiles it, and a Windows test asserts a spawn of a trivial
console program (`cmd /c exit 0`) returns `Ok` and does not block.

### 5.4 What is unchanged

- `open_external_diff` and `open_external_merge` pass the user's command to
  git verbatim via `-c difftool.gitreal.cmd=…`; git's `sh` splits it.
- The editor's cwd rules, detached spawn (child not waited on), and the
  path appended as the final argument.
- The settings file shape and the settings dialog.

## 6. Windows CI job

A new job in `.github/workflows/ci.yml`:

```yaml
core-windows:
  name: Core crate (Windows)
  runs-on: windows-latest
  steps: checkout; dtolnay/rust-toolchain@stable with clippy;
         Swatinem/rust-cache (workspaces: src-tauri);
         cargo clippy -p git-real-core --all-targets -- -D warnings;
         cargo test -p git-real-core --no-fail-fast
```

working-directory `src-tauri` for the cargo steps. Only the core crate:
the Tauri crate needs WebView2 and the front-end bundle and belongs to the
packaging ticket. `git2` with `default-features = false` builds libgit2
from source through the `cc` crate, which the MSVC toolchain on the runner
supports; `ureq` is rustls-only. Git for Windows is preinstalled on the
runner for the tests that run a real `git`.

**Pre-existing failures.** Nobody has compiled the core crate on Windows.
Test files that need a shell are already gated (`#![cfg(unix)]` on
`tools.rs` and `rebase_todo_io.rs`, per-test gates elsewhere), but some may
not be. The plan's first Windows task is a probe: the job is committed on
the feature branch and the branch is pushed to `origin` so GitHub runs it
(there is no other way to run a Windows toolchain here; the branch is
deleted after merge as usual). Each failure found is handled one of three
ways, and the ruling goes in the plan:

- A test, test helper or clippy warning (`--all-targets -D warnings`
  reports unused imports and dead code in modules that are `cfg(unix)` on
  one side) that only needs a `#[cfg(unix)]` gate or a narrowly scoped
  `#[allow]` with a comment: do it, in this ticket. There is no cap on
  these; each is a line.
- A compile error in core `src/` on Windows: it blocks the whole job, so
  it is fixed in this ticket when the fix changes nothing on Linux
  (typically a `cfg` split or an `OsStr` conversion). A fix that would
  change Linux behaviour or needs design stops the work and comes back to
  the owner with the error.
- A test that fails for a real portability reason (core behaves
  differently on Windows): the main session files a linked Jira ticket
  with the failure output, the test is gated with a `// GR-nn` comment,
  and the job keeps running the whole crate. The builder does not file
  tickets. The job must be green at merge with the whole crate selected;
  the anti-goal is a narrowed filter, not a gated test with a ticket.

The job is a required part of the gate for this ticket. Whether it becomes
a required status check for `main` is the owner's call at merge time; the
recommendation is yes, since it costs nothing to keep and a red Windows
job is the whole point.

### 6.1 Probe results

Six CI rounds on `feature/gr-20-tools-hardening`. The job ended green at
run 40511357273 with the whole crate selected: clippy clean and every core
test binary run on Windows, 0 failed. Two job changes were made by
controller ruling during the probe. The test step runs with
`--no-fail-fast`, so one run reports every failing binary. A step before it
runs `git config --system core.autocrlf false`, because Git for Windows sets
autocrlf system-wide and libgit2 reads that file (GR-33).

Rule 1, gated or allowed in this ticket:

- `tests/common/mod.rs`: `fake_git` and `install_hook` import
  `std::os::unix`. They were already `#[cfg(unix)]` before the probe; no
  edit.
- `tests/commit_error_paths.rs`: clippy unused imports (`git_commit`,
  `clone`, `Progress`, `ProgressSink`) and dead `NullSink`, `ROLE`, `OUT`,
  all used only by the unix GIT_DIR probe. Gated `#[cfg(unix)]`.
- `tests/clone.rs`: clippy unused imports `Credentials`, `HELPER`, used only
  by unix fake-git tests. Gated `#[cfg(unix)]`.
- `tests/tools_windows.rs`: clippy `collapsible_if` in the poll loop of
  `a_bare_name_resolves_to_a_cmd_file_on_path_and_runs_through_cmd_exe`.
  Function-scoped `#[allow(clippy::collapsible_if)]` with a comment.
- `tests/tags_coverage.rs`: compile error, ungated
  `std::os::unix::ffi::OsStrExt` for
  `list_tags_skips_a_tag_whose_ref_is_not_utf8`. Test and its two imports
  gated `#[cfg(unix)]`, matching its twin in `branches.rs`.
- 22 tests whose fixture cannot create its file name on Windows, failing in
  `common::write_file` or `common::stage` before core runs. Gated
  `#[cfg(unix)]` with a one-line comment, plus the helper
  `repo_with_trailing_space_files`.
  - Control or glob characters (os error 123): `diff.rs`
    `diff_pathspec_glob_characters_match_literally`; four `ignore.rs`
    `add_to_gitignore_*` tests (carriage return, literal glob, line break,
    newline); ten `index_ops.rs` tests (`*_treats_glob_characters_literally`
    for discard, stage and unstage; leading newline, carriage return,
    newline, tab and vertical-tab/form-feed names).
  - Trailing spaces, which Windows strips: seven `index_ops.rs` tests on
    `pad ` and `two  `.

Rule 2: no compile error in core `src/` on Windows.

Rule 3, ticketed by the main session:

- GR-32: NTFS loose refs and file names are case-insensitive.
  `branches.rs` `list_sorts_local_branches_by_name_in_byte_order`
  (`BranchExists("alpha")`) and `status.rs`
  `status_entries_sorted_bytewise_with_mixed_case_and_nesting`. Gated.
- GR-33: Git for Windows sets `core.autocrlf=true` system-wide, so 30 tests
  in `index_ops`, `log`, `merge`, `patch_apply`, `stash` and `switch` saw
  CRLF conversion. Not gated: the job disables autocrlf before the tests,
  and all 30 pass.
- GR-34 (bug): libgit2 on Windows does not honour the backslash pathspec
  escape, so `unstage_paths` of a `!` or `#` name is a silent no-op.
  `index_ops.rs` `unstage_paths_unstages_file_with_leading_bang` and
  `unstage_paths_hash_prefixed_name_unstages_only_that_file`. Gated.
- GR-35 (bug): renaming a remote whose URL is a local `C:\` path leaves an
  unescaped URL in `.git/config` ("invalid escape").
  `remote_sync.rs`
  `update_remote_rename_moves_tracking_refs_and_upstream_config`. Gated.
- GR-36: `/definitely/missing` is not absolute on Windows; the test data is
  Unix-shaped. `settings.rs`
  `apply_rejects_a_missing_clone_dir_and_a_relative_git_path`,
  `apply_does_not_recheck_an_unpatched_missing_clone_dir`,
  `lenient_relative_paths_never_panic`, and their now-unix-only imports.
  Gated.

## 7. Verification

- Rust: the new tests in §3.3, §4.3, §5.1–5.3; `cargo test --workspace`,
  `cargo clippy --workspace -- -D warnings`, `cargo fmt --check` on Linux;
  the `core-windows` job green on the branch.
- Front end: no change; `npm test`, `npm run lint`, `npm run typecheck`
  stay green and coverage stays at 100 %.
- Owner walk on Linux (unchanged behaviour): open a file in the editor
  from a diff header and from the palette; change the git executable in
  settings to a wrong path (rejected, old value kept) and to a right one
  (accepted). Nothing else is user-visible on Linux.
- Owner walk on Windows: none in this ticket (no Windows build exists);
  the packaging ticket inherits "type `code --wait` as the editor, open a
  file, no console window flashes" as its first editor check.

## 8. Left to the builder

- Where the path validation is exposed from core (§3.2).
- The exact lock choreography in `update` as long as §4.2 holds (no lock
  held across `verify`; the patch's value is what gets verified; apply is
  re-run under the lock).
- The `""`-inside-quotes rule in the Windows splitter (§5.1).
- Internal module layout (`tools.rs` may split into `tools/{split,
resolve, spawn}.rs`).
- The test for the Windows-only creation flag (§5.3) and how `fake_git`
  helpers are gated.

## 9. Calls made without the owner

- Item 1 rejects `..`, empty and `.git` paths as well as absolute ones,
  by reusing the existing validator (the ticket named only absolute
  paths).
- The Windows splitter reports an unterminated quote as an error instead
  of silently closing it.
- Program resolution reports "not found on PATH" itself instead of
  deferring to the OS message.
- `CREATE_NO_WINDOW` over `DETACHED_PROCESS`: both hide the console; the
  former is what a GUI host conventionally uses for a helper process.
- The Windows CI job covers the core crate only and runs clippy as well
  as tests.
- The path guard is lexical (Goal 1); symlinks are not canonicalised,
  matching every other command.
- An invalid patch is rejected before git is spawned (§4.2 step 1).
- The feature branch is pushed to `origin` during the work so the Windows
  job can run; nothing is merged or released by that push.
- Windows-side errors from Rust's `.cmd` argument escaping keep the OS
  message (§5.2).
