//! Task 4: Failing tests for the tools command layer — open_in_editor_inner,
//! open_external_diff_inner, open_external_merge_inner.
//! Pins Review Focus 1 (merge tool lock release).
//! Expected to fail to compile until the implementation exists.

#![cfg(unix)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git_real_core::ExternalDiffScope;
use git_real_core::git_cli::set_configured_path;
use git_real_lib::commands::tools::{
    open_external_diff_inner, open_external_merge_inner, open_in_editor_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::settings_store::SettingsStore;
use git_real_lib::state::{RepoId, RepoRegistry};

/// Serialises tests that touch the process-wide `CONFIGURED` static.
static TEST_LOCK: Mutex<()> = Mutex::new(());

struct ResetConfigured;
impl Drop for ResetConfigured {
    fn drop(&mut self) {
        set_configured_path(None);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// The body of a fake git (see `common::fake_git_script`) that records argv
/// in `$PWD/argv.txt`, plus optional behaviour via `$PWD/behaviour`.
const ARGV_SCRIPT: &str = "printf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\n[ -f \"$PWD/behaviour\" ] && . \"$PWD/behaviour\"\nexit 0";

/// A `SettingsStore` backed by a temp file, with an external editor pre-set.
fn store_with_editor(path: PathBuf, editor: &str) -> SettingsStore {
    let store = SettingsStore::load(path);
    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(&format!(r#"{{"tools":{{"editor":"{editor}"}}}}"#)).unwrap();
    store.update(&patch).unwrap();
    store
}

fn store_with_diff_tool(path: PathBuf, cmd: &str) -> SettingsStore {
    let store = SettingsStore::load(path);
    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(&format!(r#"{{"tools":{{"diffTool":"{cmd}"}}}}"#)).unwrap();
    store.update(&patch).unwrap();
    store
}

fn store_with_merge_tool(path: PathBuf, cmd: &str) -> SettingsStore {
    let store = SettingsStore::load(path);
    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(&format!(r#"{{"tools":{{"mergeTool":"{cmd}"}}}}"#)).unwrap();
    store.update(&patch).unwrap();
    store
}

fn open_repo_in_registry(reg: &RepoRegistry, path: &Path) -> RepoId {
    use git_real_lib::commands::repo::open_repo_inner;
    use git_real_lib::recent_store::RecentStore;
    let (_tdir, rpath) = common::temp_file_path("recent-repos.json");
    let recent = RecentStore::load(rpath);
    let opened = open_repo_inner(reg, &recent, path.to_str().unwrap()).unwrap();
    opened.id
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn open_in_editor_without_a_configured_editor_is_no_external_tool() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path);
    let reg = RepoRegistry::default();
    // No editor configured
    let err = open_in_editor_inner(&reg, &store, None, "/some/file").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoExternalTool);
    assert!(
        err.to_string().contains("no external editor is configured"),
        "unexpected message: {}",
        err
    );
}

#[test]
fn open_external_diff_runs_difftool_for_the_selected_scope() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let git_dir = tempfile::tempdir().unwrap();
    let git = common::fake_git_script(git_dir.path(), ARGV_SCRIPT);
    set_configured_path(Some(git.clone()));

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_diff_tool(spath, "meld");

    let scope = ExternalDiffScope::Unstaged;
    open_external_diff_inner(&reg, &store, id, "README.md", &scope).unwrap();

    let argv_path = repo_path.join("argv.txt");
    assert!(
        argv_path.exists(),
        "argv.txt must be written by the fake git"
    );
    let argv = fs::read_to_string(&argv_path).unwrap();
    assert!(
        argv.contains("difftool"),
        "expected difftool in argv: {argv}"
    );
}

#[test]
fn open_external_diff_for_a_root_commit_uses_the_empty_tree() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let git_dir = tempfile::tempdir().unwrap();
    let git = common::fake_git_script(git_dir.path(), ARGV_SCRIPT);
    set_configured_path(Some(git.clone()));

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);

    let repo = git2::Repository::open(&repo_path).unwrap();
    let root_oid = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();
    drop(repo);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_diff_tool(spath, "meld");

    let scope = ExternalDiffScope::Commit { oid: root_oid };
    open_external_diff_inner(&reg, &store, id, "README.md", &scope).unwrap();

    let argv = fs::read_to_string(repo_path.join("argv.txt")).unwrap();
    assert!(
        argv.contains(git_real_core::EMPTY_TREE),
        "empty-tree hash must appear for a root commit: {argv}"
    );
}

#[test]
fn open_external_merge_without_a_tool_is_no_external_tool() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(spath);

    let err = open_external_merge_inner(&reg, &store, id, "conflict.txt").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoExternalTool);
    assert!(
        err.to_string()
            .contains("no external merge tool is configured"),
        "unexpected message: {}",
        err
    );
}

#[test]
fn a_failing_tool_is_external_tool_failed_with_the_last_stderr_line() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let git_dir = tempfile::tempdir().unwrap();
    // A git that always fails with a known stderr message.
    let failing_git = {
        let script =
            "printf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\necho 'fatal: tool failed' >&2; exit 1";
        let path = git_dir.path().join("git");
        let body = format!("#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\n{script}\n");
        fs::write(&path, &body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    set_configured_path(Some(failing_git));

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_merge_tool(spath, "meld");

    let err = open_external_merge_inner(&reg, &store, id, "f.txt").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::ExternalToolFailed);
    assert!(
        err.to_string().contains("fatal: tool failed"),
        "expected stderr line in error: {}",
        err
    );
}

#[test]
fn an_unknown_repo_is_unknown_repo() {
    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_merge_tool(spath, "meld");
    let reg = RepoRegistry::default();

    let err = open_external_merge_inner(&reg, &store, 9999, "f.txt").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

/// Review Focus 1: the session lock must NOT be held while the merge tool runs.
///
/// Strategy: a fake git that blocks until `$PWD/.git/go` exists; we run
/// `open_external_merge_inner` on a separate thread and confirm that
/// `reg.get(id).unwrap().try_lock()` succeeds within 2 s (i.e. the lock was
/// released before the tool exited).
#[test]
fn external_merge_does_not_hold_the_session_lock_while_the_tool_runs() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let git_dir = tempfile::tempdir().unwrap();
    let blocking_git = {
        // Block until $PWD/.git/go appears, then exit 0.
        let script = "printf '%s\\n' \"$@\" > \"$PWD/argv.txt\"\nwhile [ ! -f \"$PWD/.git/go\" ]; do sleep 0.05; done\nexit 0";
        let path = git_dir.path().join("git");
        let body = format!("#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\n{script}\n");
        fs::write(&path, &body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    set_configured_path(Some(blocking_git));

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = Arc::new(RepoRegistry::default());
    let id = open_repo_in_registry(&reg, &repo_path);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = Arc::new(store_with_merge_tool(spath, "meld"));

    let reg_clone = Arc::clone(&reg);
    let store_clone = Arc::clone(&store);
    let repo_path_clone = repo_path.clone();

    // Spawn the merge tool invocation on a background thread.
    let handle = std::thread::spawn(move || {
        open_external_merge_inner(&reg_clone, &store_clone, id, "conflict.txt")
    });

    // Poll for the argv.txt file to confirm the tool has started.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !repo_path.join("argv.txt").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "fake git never started (argv.txt not created)"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // Now verify that the session lock is NOT held (i.e. the handler dropped it
    // before spawning the blocking git).
    let deadline2 = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        // try_lock on the session — if this succeeds, the lock is free.
        if reg
            .get(id)
            .expect("repo still registered")
            .try_lock()
            .is_ok()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline2,
            "session lock was held for more than 2 s while the merge tool ran"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // Unblock the fake git.
    fs::write(repo_path_clone.join(".git").join("go"), "").unwrap();
    handle.join().unwrap().unwrap();
}

/// Coverage gap: `open_in_editor_inner` with an editor configured returns Ok.
/// (The core test `open_in_editor_appends_the_path_and_returns_before_the_tool_exits`
/// covers the spawned-process side; this test pins the app-layer plumbing.)
#[test]
fn open_in_editor_with_a_configured_editor_returns_ok() {
    let git_dir = tempfile::tempdir().unwrap();
    // A fake editor that records its args and exits quickly.
    let editor_path = {
        let p = git_dir.path().join("fake_editor");
        let body = "#!/bin/sh\nprintf '%s\\n' \"$@\" > /dev/null\nexit 0\n";
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    };

    let (_sdir, spath) = common::temp_file_path("settings.json");
    // Invoke via "sh <path>" so the kernel execs /bin/sh rather than the freshly-written
    // script file, preventing ETXTBSY when a parallel test's fork inherits the write fd.
    let editor_cmd = format!("sh {}", editor_path.display());
    let store = store_with_editor(spath, &editor_cmd);
    let reg = RepoRegistry::default();

    open_in_editor_inner(&reg, &store, None, "/some/file.rs").unwrap();
}

// ─── R18: open_in_editor gains repoId to resolve relative paths ───────────────

/// R18: when a repo id is given, the handler resolves the relative path against
/// the session's working directory and sets the editor's cwd to that directory.
#[test]
fn open_in_editor_with_a_repo_id_resolves_the_path_against_the_workdir_and_sets_cwd() {
    let git_dir = tempfile::tempdir().unwrap();
    // Fake editor: records argv and $PWD into the directory it runs in.
    let editor_path = {
        let p = git_dir.path().join("fake_editor");
        let body = "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PWD/editor-argv.txt\"\necho \"$PWD\" > \"$PWD/editor-pwd.txt\"\n";
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    };
    // Use "sh <path>" to avoid ETXTBSY on freshly-written scripts.
    let editor_cmd = format!("sh {}", editor_path.display());

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_editor(spath, &editor_cmd);

    open_in_editor_inner(&reg, &store, Some(id), "README.md").unwrap();

    // Wait for the editor to record its info.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !repo_path.join("editor-argv.txt").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "editor argv file never appeared"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let argv = fs::read_to_string(repo_path.join("editor-argv.txt")).unwrap();
    let expected_path = repo_path.join("README.md");
    assert!(
        argv.contains(expected_path.to_str().unwrap()),
        "expected absolute joined path in argv: {argv}"
    );

    let pwd = fs::read_to_string(repo_path.join("editor-pwd.txt")).unwrap();
    assert_eq!(
        pwd.trim(),
        repo_path.to_str().unwrap(),
        "editor cwd must equal the repository working directory"
    );
}

/// R18: an unknown repo id returns a repo-not-found error.
#[test]
fn open_in_editor_with_an_unknown_repo_id_fails() {
    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_editor(spath, "code --wait");
    let reg = RepoRegistry::default();

    let err = open_in_editor_inner(&reg, &store, Some(9999), "README.md").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

/// R18: when repoId is null (None), the path must already be absolute and is passed
/// unchanged to the editor.
#[test]
fn open_in_editor_without_a_repo_id_passes_the_absolute_path_unchanged() {
    let git_dir = tempfile::tempdir().unwrap();
    let argv_file = git_dir.path().join("argv.txt");
    let argv_file_str = argv_file.to_str().unwrap();
    let editor_path = {
        let p = git_dir.path().join("fake_editor");
        let body = format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{argv_file_str}'\n");
        fs::write(&p, &body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    };
    let editor_cmd = format!("sh {}", editor_path.display());

    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_editor(spath, &editor_cmd);
    let reg = RepoRegistry::default();

    open_in_editor_inner(&reg, &store, None, "/absolute/path/to/file.rs").unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !argv_file.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "editor argv file never appeared"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let argv = fs::read_to_string(&argv_file).unwrap();
    assert!(
        argv.contains("/absolute/path/to/file.rs"),
        "expected absolute path unchanged in argv: {argv}"
    );
}

/// GR-20 §3: with a repo id, only repo-relative paths reach the editor.
#[test]
fn open_in_editor_with_a_repo_id_rejects_paths_that_leave_the_repository() {
    let git_dir = tempfile::tempdir().unwrap();
    let argv_file = git_dir.path().join("argv.txt");
    let argv_file_str = argv_file.to_str().unwrap();
    let editor_path = {
        let p = git_dir.path().join("fake_editor");
        let body = format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{argv_file_str}'\n");
        fs::write(&p, &body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    };
    let editor_cmd = format!("sh {}", editor_path.display());

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);
    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_editor(spath, &editor_cmd);

    for bad in [
        "/etc/hosts",
        "../outside.txt",
        "src/../../x",
        "",
        ".git/config",
        ".GIT/config",
        "a//b",
    ] {
        let err = open_in_editor_inner(&reg, &store, Some(id), bad)
            .expect_err(&format!("path {bad:?} must be rejected"));
        assert_eq!(err.kind, AppErrorKind::PathNotFound, "path {bad:?}");
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(!argv_file.exists(), "no editor may have been spawned");
}

/// Review Focus 4: a trailing slash is trimmed and the directory opens.
#[test]
fn open_in_editor_with_a_repo_id_opens_a_directory_given_with_a_trailing_slash() {
    let git_dir = tempfile::tempdir().unwrap();
    let argv_file = git_dir.path().join("argv.txt");
    let argv_file_str = argv_file.to_str().unwrap();
    let editor_path = {
        let p = git_dir.path().join("fake_editor");
        let body = format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{argv_file_str}'\n");
        fs::write(&p, &body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    };
    let editor_cmd = format!("sh {}", editor_path.display());

    let (_repo_dir, repo_path) = common::temp_repo_with_commit();
    fs::create_dir(repo_path.join("src")).unwrap();
    let reg = RepoRegistry::default();
    let id = open_repo_in_registry(&reg, &repo_path);
    let (_sdir, spath) = common::temp_file_path("settings.json");
    let store = store_with_editor(spath, &editor_cmd);

    open_in_editor_inner(&reg, &store, Some(id), "src/").unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !argv_file.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "editor argv file never appeared"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // The editor may still be writing; give it a moment to finish.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let argv = fs::read_to_string(&argv_file).unwrap();
    let expected = repo_path.join("src");
    assert!(
        argv.lines().any(|l| l == expected.to_str().unwrap()),
        "expected the directory without a trailing slash in argv: {argv}"
    );
}
