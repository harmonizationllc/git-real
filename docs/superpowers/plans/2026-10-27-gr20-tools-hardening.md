# GR-20 Tools Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `open_in_editor` cannot leave the repository, settings reads never wait on `git --version`, Windows-style editor commands start on Windows, and a Windows CI job keeps the core crate honest.

**Architecture:** Items 1 and 2 are confined to the Tauri layer (`src-tauri/src/commands/tools.rs`, `src-tauri/src/settings_store.rs`) and reuse core's existing path validator and git verifier. Item 3 lives in `git-real-core::tools`: a `CommandSyntax` parameter on the splitter, a pure `PATHEXT` resolver, and a Windows-only creation flag, all reachable from Linux tests through an `open_in_editor_with` seam. The CI job runs the core crate on `windows-latest`.

**Tech Stack:** Rust 2024 (toolchain 1.99 locally, `stable` in CI), `std::process::Command`, `std::os::windows::process::CommandExt`, GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-10-27-gr20-tools-hardening-design.md` (§3 path guard, §4 settings lock, §5 Windows editor commands, §6 CI job and the rules for pre-existing failures, §9 calls made).

## Global Constraints

- `git-real-core` stays Tauri-free; the only platform switches allowed are `cfg!(windows)` in `CommandSyntax::native()` and `#[cfg(windows)]` around the creation flag (spec §2, §5.3).
- No new crate or npm dependency; no change to the settings file shape, the settings dialog, the front end, or the difftool/mergetool code (spec §1 non-goals, §5.4).
- No new `AppErrorKind`: a rejected path is `GitError::PathNotFound` → `AppErrorKind::PathNotFound`; a spawn failure is `ToolError::Spawn` → `AppErrorKind::ExternalToolFailed` (spec §3.2, §5.2).
- `SettingsStore::update` never holds the settings mutex while `git_cli::verify` runs; the verified path is the one the patch names; an invalid patch returns `SettingsError` before any spawn (spec §4.2).
- The Windows job runs `cargo clippy -p git-real-core --all-targets -- -D warnings` and `cargo test -p git-real-core` with no test filter (spec §6 anti-goal).
- Tests come from the test role first; the developer never edits test files. Commits use explicit paths, no `add -A`, no amend/reset/stash.
- Gate before the final review: `npm run lint`, `npm run typecheck`, `npm test` (coverage 100 %), `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --all --check` (all from `src-tauri` for cargo), and the `core-windows` job green on the pushed branch.

## Review Focus

1. **A quoted Windows path ending in a backslash**, `"C:\Program Files\"` — the `\"` is a literal quote under the Windows rules, so the quote is unterminated; the user must get `UnterminatedQuote`, not a silently mangled argument. Pinned in Task 3.
2. **A second settings patch arriving while a git executable is being verified** (theme change during a slow `git --version`) must complete at once and must not be lost when the verification finishes. Pinned in Task 2's blocking test.
3. **An editor command naming a UNC or drive-rooted program** (`\\server\tools\code.cmd`, `C:\tools\code`) must not be searched on `PATH` and must still get `PATHEXT` extensions tried. Pinned in Task 4.
4. **A repo-relative path with a trailing slash** (`src/`) is a directory the user may want to open in the editor; the validator trims it and it must still open. Pinned in Task 1.
5. **`PATHEXT` in mixed case or unset** on a Windows machine (`.com;.exe;.Bat;.CMD`, or empty): resolution must still find `code.cmd`. Pinned in Task 4.

---

### Task 1: Path guard in `open_in_editor`

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/lib.rs:27` (`mod paths;` → `pub mod paths;`)
- Modify: `src-tauri/crates/git-real-core/src/paths.rs:16` (`pub(crate) fn repo_relative` → `pub fn repo_relative`)
- Modify: `src-tauri/src/commands/tools.rs:18-48` (`open_in_editor_inner`)
- Test: `src-tauri/tests/tools_commands.rs`

**Interfaces:**

- Consumes: `git_real_core::paths::repo_relative(raw: &str) -> Result<String, GitError>` (exists; rules in spec §3.2).
- Produces: `open_in_editor_inner(reg, store, repo_id: Option<RepoId>, path: &str) -> Result<(), AppError>` (unchanged signature). With `Some(id)`, the path passes through `repo_relative` before `workdir.join`; the error converts through the existing `From<GitError> for AppError`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/tests/tools_commands.rs`, reusing `store_with_editor`, `open_repo_in_registry` and the fake-editor script from `open_in_editor_with_a_repo_id_resolves_the_path_against_the_workdir_and_sets_cwd`:

```rust
/// GR-20 §3: with a repo id, only repo-relative paths reach the editor.
#[test]
fn open_in_editor_with_a_repo_id_rejects_paths_that_leave_the_repository() {
    // fake editor records argv into <tmp>/argv.txt (as in the absolute-path test)
    for bad in ["/etc/hosts", "../outside.txt", "src/../../x", "", ".git/config", ".GIT/config", "a//b"] {
        let err = open_in_editor_inner(&reg, &store, Some(id), bad).unwrap_err();
        assert_eq!(err.kind, AppErrorKind::PathNotFound, "path {bad:?}");
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(!argv_file.exists(), "no editor may have been spawned");
}

/// Review Focus 4: a trailing slash is trimmed and the directory opens.
#[test]
fn open_in_editor_with_a_repo_id_opens_a_directory_given_with_a_trailing_slash() {
    // create <repo>/src/, call with "src/", wait for argv file,
    // assert argv contains repo_path.join("src") and not "src/"
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test tools_commands rejects_paths -- --nocapture`
Expected: FAIL — `/etc/hosts` spawns the editor (argv file appears) and `unwrap_err` panics on `Ok`.

- [ ] **Step 3: Expose the validator and use it.** Make `paths` a `pub mod` and `repo_relative` `pub` (keep the doc comment). In `open_in_editor_inner`, `Some(id)` branch: `let rel = git_real_core::paths::repo_relative(path)?;` before taking the session lock, then `workdir.join(&rel)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test tools_commands`
Expected: all PASS, including the existing `..._resolves_the_path_against_the_workdir_and_sets_cwd` and `..._passes_the_absolute_path_unchanged`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/tools_commands.rs
git commit -m "test(GR-20): open_in_editor with a repo id rejects paths outside the repository"
git add src-tauri/crates/git-real-core/src/lib.rs src-tauri/crates/git-real-core/src/paths.rs src-tauri/src/commands/tools.rs
git commit -m "feat(GR-20): open_in_editor validates repo-relative paths before joining"
```

---

### Task 2: Settings mutex released during git verification

**Files:**

- Modify: `src-tauri/src/settings_store.rs:52-69` (`update`)
- Test: `src-tauri/tests/settings_store.rs`

**Interfaces:**

- Consumes: `Settings::apply(&self, &SettingsPatch) -> Result<Settings, SettingsError>`, `git_cli::verify(&Path) -> Result<String, GitError>`, `git_cli::set_configured_path(Option<PathBuf>)` (all exist).
- Produces: `SettingsStore::update(&self, patch: &SettingsPatch) -> Result<Settings, AppError>` (unchanged signature) with the three-step choreography of spec §4.2: dry-run apply on a snapshot (errors first), unlocked verify of `patch.git.executable` when it is `Some(Some(p))` and `p` differs from the snapshot's value, then lock → apply to current → save → swap → override update when the executable changed versus the value stored at that moment.

- [ ] **Step 1: Write the failing test** in `src-tauri/tests/settings_store.rs`. A fake git whose `--version` blocks until `<dir>/go` exists (pattern: `external_merge_does_not_hold_the_session_lock_while_the_tool_runs` in `tests/tools_commands.rs`, but it must print a plausible `git version 2.0.0` line and exit 0 after unblocking, so `verify` accepts it):

```rust
/// GR-20 §4 and Review Focus 2: reads and other patches proceed while a new
/// git executable is being verified, and nothing is lost.
#[test]
fn update_does_not_hold_the_lock_while_verifying_the_git_executable() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;
    // blocking fake git in `dir`; store on a temp settings.json
    let store = Arc::new(SettingsStore::load(path));
    let handle = std::thread::spawn({ let store = Arc::clone(&store); move || store.update(&git_patch) });
    // wait until <dir>/started exists (the fake git touches it before blocking)
    let t = std::time::Instant::now();
    let snapshot = store.get();                       // must not block
    assert!(t.elapsed() < std::time::Duration::from_millis(500));
    assert!(snapshot.git.executable.is_none());
    store.update(&theme_patch).unwrap();              // a second patch lands now
    assert_eq!(store.get().appearance.theme, Theme::Dark);
    std::fs::write(dir.join("go"), "").unwrap();
    let saved = handle.join().unwrap().unwrap();
    assert_eq!(saved.git.executable.as_deref(), Some(fake_git.as_path()));
    assert_eq!(saved.appearance.theme, Theme::Dark);  // the theme patch survived
    assert_eq!(configured_path(), Some(fake_git));
}

/// Spec §4.2 step 1: an invalid patch is rejected before git is spawned.
#[test]
fn update_rejects_an_invalid_patch_before_spawning_git() {
    // patch with the blocking fake git AND an invalid field (e.g. appearance.fontSize 0,
    // whichever field `Settings::apply` validates today); expect Err of the
    // SettingsError kind within 500 ms and no `started` marker file.
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --test settings_store does_not_hold_the_lock`
Expected: FAIL — `store.get()` blocks until the test's own timeout assertion, or the second `update` deadlocks the test (use a `#[test]` with the wait bounded as above so it fails instead of hanging).

- [ ] **Step 3: Rewrite `update`** per spec §4.2 (three steps; the lock is taken twice, never across `verify`). Keep `apply_git_override`, `set_window`, `ensure_file_exists` untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test settings_store`
Expected: all PASS, including the existing `update_rejects_invalid_settings_without_saving`, `update_verifies_a_changed_git_executable_and_pushes_the_override`, `update_rejects_a_non_git_executable_and_keeps_the_old_value`, `update_clearing_the_git_executable_resets_the_override`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/settings_store.rs
git commit -m "test(GR-20): settings update verifies git without holding the lock"
git add src-tauri/src/settings_store.rs
git commit -m "fix(GR-20): verify a new git executable outside the settings mutex"
```

---

### Task 3: `CommandSyntax` and the Windows splitter

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/tools.rs:77-150` (`split_command`)
- Modify: `src-tauri/crates/git-real-core/src/lib.rs:49-52` (re-exports)
- Test (new, **not** `cfg(unix)`, no `mod common`): `src-tauri/crates/git-real-core/tests/tools_syntax.rs`

**Interfaces:**

- Produces, in `git_real_core::tools` and re-exported from the crate root:
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum CommandSyntax { Posix, Windows }`
  - `impl CommandSyntax { pub fn native() -> Self }` — `Windows` when `cfg!(windows)`, else `Posix`.
  - `pub fn split_command_with(syntax: CommandSyntax, cmd: &str) -> Result<Vec<String>, ToolError>`
  - `pub fn split_command(cmd: &str) -> Result<Vec<String>, ToolError>` = `split_command_with(CommandSyntax::native(), cmd)` (existing name, existing behaviour on Linux).
- The `Posix` arm is today's code moved, byte for byte. The `Windows` arm follows spec §5.1. `""` inside a quoted span is one literal `"` (the builder's call, now made: it is what every Windows CRT since 2008 does).

- [ ] **Step 1: Write the failing tests** in `tests/tools_syntax.rs`:

```rust
use git_real_core::{CommandSyntax, ToolError, split_command, split_command_with};

#[test]
fn windows_syntax_table() {
    let cases: &[(&str, &[&str])] = &[
        ("code --wait", &["code", "--wait"]),
        (r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe --wait",
         &[r"C:\Users\me\AppData\Local\Programs\Microsoft", "VS", "Code\Code.exe", "--wait"]),
        (r#""C:\Program Files\Microsoft VS Code\Code.exe" --wait"#,
         &[r"C:\Program Files\Microsoft VS Code\Code.exe", "--wait"]),
        (r#"a"b c"d"#, &["ab cd"]),
        (r#"\\"x""#, &[r#"\x"#]),           // 2 backslashes + quote → 1 backslash, quote toggles
        (r#""a\\\"b""#, &[r#"a\"b"#]),       // 3 backslashes + quote → 1 backslash + literal quote
        (r#""a""b""#, &[r#"a"b"#]),          // "" inside quotes is a literal quote
        ("'a b'", &["'a", "b'"]),            // single quotes are ordinary
        ("a\tb", &["a", "b"]),
        (r#""""#, &[""]),
    ];
    for (input, expected) in cases {
        assert_eq!(split_command_with(CommandSyntax::Windows, input).unwrap(),
                   expected.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "input {input:?}");
    }
}

#[test]
fn windows_syntax_errors() {
    assert_eq!(split_command_with(CommandSyntax::Windows, "  \t ").unwrap_err(), ToolError::EmptyCommand);
    assert_eq!(split_command_with(CommandSyntax::Windows, r#""abc"#).unwrap_err(), ToolError::UnterminatedQuote);
    // Review Focus 1: a trailing backslash inside quotes escapes the closing quote.
    assert_eq!(split_command_with(CommandSyntax::Windows, r#""C:\Program Files\""#).unwrap_err(),
               ToolError::UnterminatedQuote);
}

#[test]
fn posix_syntax_is_unchanged() {
    // the same eight rows as `split_command_table` in tests/tools.rs, through
    // split_command_with(CommandSyntax::Posix, _)
}

#[cfg(not(windows))]
#[test]
fn native_syntax_is_posix_off_windows() {
    assert_eq!(CommandSyntax::native(), CommandSyntax::Posix);
    assert_eq!(split_command("'a b'").unwrap(), vec!["a b".to_string()]);
}

#[cfg(windows)]
#[test]
fn native_syntax_is_windows_on_windows() {
    assert_eq!(CommandSyntax::native(), CommandSyntax::Windows);
    assert_eq!(split_command(r"C:\x\y.exe").unwrap(), vec![r"C:\x\y.exe".to_string()]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test tools_syntax`
Expected: FAIL to compile — `CommandSyntax` and `split_command_with` do not exist.

- [ ] **Step 3: Implement** `CommandSyntax`, `split_command_with` (move the existing loop into a private `split_posix`, add `split_windows` with the backslash-run counting rule of spec §5.1), and make `split_command` the native wrapper. Re-export both from `lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test -p git-real-core --test tools_syntax --test tools`
Expected: all PASS; `split_command_table` in `tests/tools.rs` unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/git-real-core/tests/tools_syntax.rs
git commit -m "test(GR-20): Windows command-line splitting rules"
git add src-tauri/crates/git-real-core/src/tools.rs src-tauri/crates/git-real-core/src/lib.rs
git commit -m "feat(GR-20): CommandSyntax with a Windows splitter beside the POSIX one"
```

---

### Task 4: Program resolution, the editor seam and the Windows spawn flag

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/tools.rs` (`open_in_editor`, new items below)
- Modify: `src-tauri/crates/git-real-core/src/lib.rs:49-52` (re-exports)
- Test: `src-tauri/crates/git-real-core/tests/tools_syntax.rs` (resolver, host-independent)
- Test: `src-tauri/crates/git-real-core/tests/tools.rs` (Linux end-to-end through the seam; file is `cfg(unix)`)
- Test (new): `src-tauri/crates/git-real-core/tests/tools_windows.rs` with `#![cfg(windows)]`

**Interfaces:**

- Consumes: `CommandSyntax`, `split_command_with` (Task 3).
- Produces, in `git_real_core::tools`, re-exported from the crate root:
  - `#[derive(Debug, Clone, Default, PartialEq, Eq)] pub struct ToolEnv { pub path: OsString, pub pathext: OsString }` with `impl ToolEnv { pub fn from_process() -> Self }` reading `PATH` and `PATHEXT` (empty when unset).
  - `pub const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";`
  - `pub fn resolve_program(program: &str, env: &ToolEnv, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf>` — Windows rules of spec §5.2. It splits `env.path` on `;` itself and recognises Windows-absolute entries itself (`X:\`, `X:/`, `\\`), so it behaves identically on a Linux host; candidates are built as strings joined with `\`. A `program` containing `\` or `/` or a drive prefix is never searched on `PATH`. `PATHEXT` entries are used as given, after trimming; an empty `pathext` means `DEFAULT_PATHEXT`.
  - `pub fn open_in_editor_with(syntax: CommandSyntax, env: &ToolEnv, cmd: &str, path: &Path, cwd: Option<&Path>) -> Result<(), ToolError>` — splits with `syntax`; under `Windows` resolves `argv[0]` with `resolve_program(.., Path::is_file)` and returns `ToolError::Spawn { program, cause: "not found on PATH".into() }` on `None`; spawns detached as today; under `#[cfg(windows)]` adds `.creation_flags(CREATE_NO_WINDOW)` where `const CREATE_NO_WINDOW: u32 = 0x0800_0000;`.
  - `pub fn open_in_editor(cmd, path, cwd)` (existing) = `open_in_editor_with(CommandSyntax::native(), &ToolEnv::from_process(), cmd, path, cwd)`.

- [ ] **Step 1: Write the failing resolver tests** in `tests/tools_syntax.rs`, with `is_file` a closure over a `HashSet<String>` of backslash paths (no real files):

```rust
fn env(path: &str, pathext: &str) -> ToolEnv { ToolEnv { path: path.into(), pathext: pathext.into() } }
fn files(list: &[&str]) -> impl Fn(&Path) -> bool { /* set contains path.to_string_lossy() */ }

#[test]
fn resolve_program_finds_a_cmd_launcher_through_pathext() {
    let f = files(&[r"C:\VSCode\bin\code.cmd"]);
    assert_eq!(resolve_program("code", &env(r"C:\Windows;C:\VSCode\bin", ".COM;.EXE;.BAT;.CMD"), &f),
               Some(PathBuf::from(r"C:\VSCode\bin\code.cmd")));
}
#[test]
fn resolve_program_prefers_the_name_as_given_then_pathext_order() {
    let f = files(&[r"C:\a\x", r"C:\a\x.cmd", r"C:\a\x.exe"]);
    assert_eq!(resolve_program("x", &env(r"C:\a", ".CMD;.EXE"), &f), Some(PathBuf::from(r"C:\a\x")));
    assert_eq!(resolve_program("x.exe", &env(r"C:\a", ".CMD;.EXE"), &f), Some(PathBuf::from(r"C:\a\x.exe")));
    let f = files(&[r"C:\a\x.cmd", r"C:\a\x.exe"]);
    assert_eq!(resolve_program("x", &env(r"C:\a", ".CMD;.EXE"), &f), Some(PathBuf::from(r"C:\a\x.cmd")));
}
#[test]
fn resolve_program_skips_empty_and_relative_path_entries() {
    let f = files(&[r"bin\x.exe", r"C:\b\x.exe"]);
    assert_eq!(resolve_program("x", &env(r";bin;C:\b", ".EXE"), &f), Some(PathBuf::from(r"C:\b\x.exe")));
}
// Review Focus 3
#[test]
fn resolve_program_does_not_search_path_for_rooted_programs() {
    let f = files(&[r"\\srv\tools\code.cmd", r"C:\t\code.exe", r"C:\on\path\code.exe"]);
    let e = env(r"C:\on\path", ".EXE;.CMD");
    assert_eq!(resolve_program(r"\\srv\tools\code", &e, &f), Some(PathBuf::from(r"\\srv\tools\code.cmd")));
    assert_eq!(resolve_program(r"C:\t\code", &e, &f), Some(PathBuf::from(r"C:\t\code.exe")));
    assert_eq!(resolve_program(r"C:/t/code", &e, &f), Some(PathBuf::from(r"C:/t/code.exe")));
    assert_eq!(resolve_program(r"C:\missing\code", &e, &f), None);
}
// Review Focus 5: extensions are probed as given (the real filesystem is
// case-insensitive; the closure records what was asked), and an empty
// PATHEXT means DEFAULT_PATHEXT.
#[test]
fn resolve_program_probes_pathext_as_given_and_defaults_it_when_empty() {
    let seen = std::cell::RefCell::new(Vec::<String>::new());
    let probe = |p: &Path| { seen.borrow_mut().push(p.to_string_lossy().into_owned()); false };
    resolve_program("code", &env(r"C:\a", " .com; .exe;.Bat;.CMD "), probe);
    assert_eq!(seen.borrow().as_slice(),
               [r"C:\a\code", r"C:\a\code.com", r"C:\a\code.exe", r"C:\a\code.Bat", r"C:\a\code.CMD"]);
    let f = files(&[r"C:\a\code.CMD"]);
    assert_eq!(resolve_program("code", &env(r"C:\a", ""), &f), Some(PathBuf::from(r"C:\a\code.CMD")));
    assert_eq!(DEFAULT_PATHEXT, ".COM;.EXE;.BAT;.CMD");
}
#[test]
fn resolve_program_returns_none_when_nothing_matches() {
    assert_eq!(resolve_program("code", &env(r"C:\a", ".EXE"), |_| false), None);
}
```

- [ ] **Step 2: Write the failing seam tests** in `tests/tools.rs` (Linux). The resolver joins `PATH` entries with `\`, so a bare name can never hit a Linux file; the Linux end-to-end tests therefore use the "not found" error and a rooted program (one containing `/`, which spec §5.2 treats as rooted and probes as given). The fake launcher is a shebang script named `code.cmd`; probe it as `common::fake_git` does to avoid ETXTBSY.

```rust
#[test]
fn open_in_editor_with_windows_syntax_reports_a_program_missing_from_path() {
    let env = ToolEnv { path: r"C:\nowhere".into(), pathext: ".CMD".into() };
    let err = open_in_editor_with(CommandSyntax::Windows, &env, "code --wait", Path::new("/f"), None).unwrap_err();
    assert_eq!(err, ToolError::Spawn { program: "code".into(), cause: "not found on PATH".into() });
}

#[test]
fn open_in_editor_with_windows_syntax_spawns_a_rooted_program_with_the_path_appended() {
    // "<dir>/code.cmd --wait" under Windows syntax, ToolEnv::default()
    // → Ok; argv.txt (written by the script) ends with "--wait", "/some/file"
}

#[test]
fn open_in_editor_with_posix_syntax_ignores_the_tool_env() {
    // ToolEnv { path: "C:\\nowhere".into(), pathext: ".CMD".into() } with
    // "sh <script> --wait" under Posix → spawned as today
}
```

- [ ] **Step 3: Write the Windows-only tests** in `tests/tools_windows.rs` (`#![cfg(windows)]`; they run only in the CI job of Task 5):

```rust
#[test]
fn a_bare_name_resolves_to_a_cmd_file_on_path_and_runs_through_cmd_exe() {
    // <dir>\code.cmd containing "@echo %* > \"<dir>\\argv.txt\"\r\n"
    // env: path = dir, pathext = ".COM;.EXE;.BAT;.CMD"
    // open_in_editor_with(Windows, &env, "code --wait", Path::new(r"C:\f.txt"), None) → Ok
    // wait ≤ 2 s for argv.txt; assert it contains "--wait C:\f.txt"
}

#[test]
fn a_console_program_spawns_without_blocking() {
    let env = ToolEnv::from_process();
    open_in_editor_with(CommandSyntax::Windows, &env, "cmd /c exit", Path::new("0"), None).unwrap();
}

#[test]
fn from_process_reads_pathext() {
    assert!(!ToolEnv::from_process().pathext.is_empty());
}
```

- [ ] **Step 4: Run the Linux tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test tools_syntax --test tools`
Expected: FAIL to compile — `ToolEnv`, `resolve_program`, `open_in_editor_with` missing.

- [ ] **Step 5: Implement** the items in the Interfaces block. `open_in_editor` becomes the one-line native wrapper. The creation flag goes in a `#[cfg(windows)]` block inside `open_in_editor_with` (`use std::os::windows::process::CommandExt;` scoped there).

- [ ] **Step 6: Run the Linux tests to verify they pass, and that Windows-only code still builds for the host**

Run: `cd src-tauri && cargo test -p git-real-core && cargo clippy -p git-real-core --all-targets -- -D warnings`
Expected: all PASS, clippy clean (`tools_windows.rs` compiles to an empty test binary on Linux).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/git-real-core/tests/tools_syntax.rs src-tauri/crates/git-real-core/tests/tools.rs src-tauri/crates/git-real-core/tests/tools_windows.rs
git commit -m "test(GR-20): PATHEXT resolution, the editor seam and Windows-only spawn checks"
git add src-tauri/crates/git-real-core/src/tools.rs src-tauri/crates/git-real-core/src/lib.rs
git commit -m "feat(GR-20): resolve Windows editor programs through PATHEXT and spawn without a console"
```

---

### Task 5: Windows CI job, probe run, and gating of pre-existing failures

**Files:**

- Modify: `.github/workflows/ci.yml` (new job after `build-and-test`)
- Modify: `src-tauri/crates/git-real-core/tests/common/mod.rs:72-90` and `:253-258` (`#[cfg(unix)]` on the two helpers that import `std::os::unix`)
- Modify, as the probe dictates: other files under `src-tauri/crates/git-real-core/{src,tests}`
- Modify: `docs/superpowers/specs/2026-10-27-gr20-tools-hardening-design.md` (status line; a §6.1 "Probe results" list)

**Interfaces:**

- Produces: job `core-windows` ("Core crate (Windows)"), `runs-on: windows-latest`, steps: `actions/checkout@v4`; `dtolnay/rust-toolchain@stable` with `components: clippy`; `Swatinem/rust-cache@v2` with `workspaces: src-tauri`; `cargo clippy -p git-real-core --all-targets -- -D warnings`; `cargo test -p git-real-core` — both with `working-directory: src-tauri`. No `if:`, no test filter.

- [ ] **Step 1: Gate the known-unportable helpers.** Add `#[cfg(unix)]` to `common::fake_git` and to the hook-writing helper at `common/mod.rs:253` (both `use std::os::unix::...` inside the body, which fails to compile on Windows in every test binary that declares `mod common;` without a crate-level `cfg(unix)`). Run `cargo test -p git-real-core` on Linux: still green.

- [ ] **Step 2: Add the job** to `.github/workflows/ci.yml` exactly as in Interfaces.

- [ ] **Step 3: Commit and push the branch to run the probe**

```bash
git add .github/workflows/ci.yml src-tauri/crates/git-real-core/tests/common/mod.rs
git commit -m "ci(GR-20): run the core crate's clippy and tests on windows-latest"
git push -u origin feature/gr-20-tools-hardening
gh run watch --exit-status   # or: gh run list --branch feature/gr-20-tools-hardening
```

Expected: the run appears; the Linux jobs stay green; `core-windows` reports either green or a list of failures.

- [ ] **Step 4: Rule on each failure** by spec §6, in this order: (a) `cfg(unix)` gate or a scoped `#[allow(dead_code)]`/`#[allow(unused_imports)]` with a one-line comment; (b) a core `src/` compile error fixed only if the fix changes nothing on Linux, else stop and report to the main session; (c) a genuine portability test failure: report it to the main session with the failure output and gate the test with `// GR-nn: <one line>` once the ticket number comes back. Record every ruling as a bullet in spec §6.1 "Probe results" (file, failure, ruling).

Run after each round: `cd src-tauri && cargo test -p git-real-core && cargo clippy -p git-real-core --all-targets -- -D warnings` on Linux, then commit with explicit paths (`fix(GR-20): gate <what> for Windows`) and push; repeat until `core-windows` is green.

- [ ] **Step 5: Verify the job is green with the whole crate selected**

Run: `gh run view --json jobs --jq '.jobs[] | select(.name=="Core crate (Windows)") | .conclusion'`
Expected: `success`; and `grep -n "cargo test -p git-real-core$" .github/workflows/ci.yml` shows no filter.

- [ ] **Step 6: Update the spec status line** to "implemented on branch `feature/gr-20-tools-hardening`; probe results in §6.1" and commit:

```bash
git add docs/superpowers/specs/2026-10-27-gr20-tools-hardening-design.md
git commit -m "docs(GR-20): Windows probe results and status"
git push
```

---

## Execution notes

- Suggested batching (owner is cost-sensitive): **Cycle A** = Tasks 1 + 2 (Tauri layer; tester → developer → reviewer), **Cycle B** = Tasks 3 + 4 (core; tester → developer → reviewer), **Cycle C** = Task 5 (one agent, iterating with CI; its rulings reviewed by the main session). Then the whole-branch review on the most capable model. Three implementation cycles plus reviews.
- Models: tester `sonnet`, developer `opus`, per-cycle reviewer `sonnet`, final review `fable`, passed explicitly on every dispatch.
- Task 5 needs network access (`git push`, `gh run`) and may take several CI round-trips (a Windows cold build of libgit2 is roughly 10–15 minutes). The agent must not end its turn while waiting on a run; it watches with `gh run watch`.
- Branch: `feature/gr-20-tools-hardening` in a worktree under `.claude/worktrees/`, from local `main` (535677a). The spec and this plan are committed first on that branch.
- Jira: new tickets for portability failures are filed by the main session (spec §6); a summary comment goes on GR-20 after the final review; the transition is the owner's call. Merge/PR/keep via superpowers:finishing-a-development-branch.
