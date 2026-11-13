//! Auto-stash rollback: when the switch after the stash is refused too, the
//! stash is popped back so the tree is as the user left it. A stand-in `git`
//! first on `PATH` refuses the first `switch` with git's tracked-collision
//! wording and the second with a hook-style message; every other subcommand
//! runs the real git. `PATH` is process-wide, so this test has its own binary
//! and sets it exactly once.

#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::sync::OnceLock;

use git_real_core::{GitError, RepoSession};

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

/// Puts the stand-in first on `PATH`, pointing it at the real git found there now.
fn use_switch_refusing_git() {
    FAKE_DIR.get_or_init(|| {
        let old = std::env::var_os("PATH").unwrap_or_default();
        let real = git_real_core::git_cli::locate_in(&old).expect("real git on PATH");
        let script = format!(
            r#"if [ "$3" = "switch" ]; then
  if [ -f "$2/.git/switched-once" ]; then echo 'hook says no' >&2; exit 1; fi
  touch "$2/.git/switched-once"
  echo 'error: Your local changes to the following files would be overwritten by checkout:' >&2
  exit 1
fi
exec '{}' "$@""#,
            real.display()
        );
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), &script);
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before the test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        dir
    });
}

/// Branch `b` changes README.md; the tree holds a dirty README.md.
fn collision_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    common::branch_with_commit(&path, "b", "README.md", "# changed on b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

#[test]
fn a_refused_second_switch_restores_the_tree() {
    if !common::git_available() {
        return;
    }
    use_switch_refusing_git();
    let (_d, path, session, head) = collision_fixture();
    let err = session.checkout_branch("b").unwrap_err();
    assert!(
        matches!(&err, GitError::CheckoutFailed { stderr, .. } if stderr.contains("hook says no")),
        "{err:?}"
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# dirty edit\n"
    );
    assert!(session.list_stashes().unwrap().is_empty());
}
