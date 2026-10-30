//! Checkout through `git switch` (GR-7). Tests that reach the git CLI return
//! early when it is not on PATH, like `commit.rs`; pre-check failures do not
//! need it and always run.

mod common;

use common::git_available;

use std::path::{Path, PathBuf};

use git_real_core::{GitError, RepoSession};
use git2::{BranchType, Repository};

/// Repo with one commit, local identity, signing off.
fn fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

/// Fixture plus a fetched local bare remote `origin` holding a `feature`
/// branch. The local `feature` branch is deleted again unless `keep_local`.
fn remote_fixture(
    keep_local: bool,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    PathBuf,
    PathBuf,
    String,
) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
    }
    common::push_branch(&path, "feature");
    common::fetch_remote(&path, "origin");
    if !keep_local {
        let repo = Repository::open(&path).unwrap();
        repo.find_branch("feature", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
    }
    (dir, bare_dir, path, bare, head)
}

fn head_ref(path: &Path) -> String {
    common::head_branch_name(path)
}

fn config_string(path: &Path, key: &str) -> Option<String> {
    Repository::open(path)
        .unwrap()
        .config()
        .unwrap()
        .get_string(key)
        .ok()
}

// --- checkout_branch: local switch ---

#[test]
fn checkout_local_moves_head_to_the_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    session.create_branch("b", None).unwrap();
    session.checkout_branch("b").unwrap();
    assert_eq!(head_ref(&path), "b");
}

#[test]
fn checkout_the_current_branch_is_ok() {
    if !git_available() {
        return;
    }
    let (_d, path, session, head) = fixture();
    session.checkout_branch(&head).unwrap();
    assert_eq!(head_ref(&path), head);
}

#[test]
fn checkout_updates_the_working_tree() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    common::branch_with_commit(&path, "b", "only-on-b.txt", "b\n");
    assert!(!path.join("only-on-b.txt").exists());
    session.checkout_branch("b").unwrap();
    assert!(path.join("only-on-b.txt").exists());
}

#[test]
fn checkout_a_missing_branch_fails_with_branch_not_found() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("ghost").unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "ghost"));
}

#[test]
fn checkout_rejects_a_leading_dash_name() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-x"));
}

#[test]
fn checkout_rejects_an_invalid_name() {
    let (_d, _p, session, _head) = fixture();
    let err = session.checkout_branch("a..b").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(_)));
}

// --- checkout_branch: git's own refusal and hooks ---

fn dirty_conflict_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::branch_with_commit(&path, "b", "README.md", "# changed on b\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    (d, path, session, head)
}

#[test]
fn checkout_with_a_conflicting_dirty_file_fails_with_gits_stderr() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, _head) = dirty_conflict_fixture();
    let err = session.checkout_branch("b").unwrap_err();
    match err {
        GitError::CheckoutFailed { code, stderr, .. } => {
            assert_ne!(code, Some(0));
            assert!(stderr.contains("overwritten"), "stderr was: {stderr}");
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

#[test]
fn checkout_with_a_conflicting_dirty_file_keeps_head_unchanged() {
    if !git_available() {
        return;
    }
    let (_d, path, session, head) = dirty_conflict_fixture();
    let _ = session.checkout_branch("b");
    assert_eq!(head_ref(&path), head);
}

#[test]
fn checkout_with_a_conflicting_dirty_file_keeps_the_local_edit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = dirty_conflict_fixture();
    let _ = session.checkout_branch("b");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# dirty edit\n"
    );
}

#[cfg(unix)]
#[test]
fn checkout_runs_the_post_checkout_hook() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    // Repo-local hooksPath so a developer's global hooksPath cannot hide the hook.
    let hooks = path.join(".git").join("hooks");
    Repository::open(&path)
        .unwrap()
        .config()
        .unwrap()
        .set_str("core.hooksPath", hooks.to_str().unwrap())
        .unwrap();
    common::install_hook(&path, "post-checkout", "touch hook-ran");
    session.create_branch("b", None).unwrap();
    session.checkout_branch("b").unwrap();
    assert!(path.join("hook-ran").exists());
}

// --- checkout_remote_branch ---

#[test]
fn checkout_remote_creates_a_local_branch_and_moves_head_to_it() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(head_ref(&path), "feature");
}

#[test]
fn checkout_remote_sets_the_tracking_remote() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        config_string(&path, "branch.feature.remote").as_deref(),
        Some("origin")
    );
}

#[test]
fn checkout_remote_sets_the_tracking_merge_ref() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(
        config_string(&path, "branch.feature.merge").as_deref(),
        Some("refs/heads/feature")
    );
}

#[test]
fn checkout_remote_switches_to_an_existing_local_branch_of_that_name() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(true);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(head_ref(&path), "feature");
}

#[test]
fn checkout_remote_with_an_existing_local_branch_does_not_add_tracking() {
    if !git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = remote_fixture(true);
    let session = RepoSession::open(&path).unwrap();
    session.checkout_remote_branch("origin", "feature").unwrap();
    assert_eq!(config_string(&path, "branch.feature.remote"), None);
}

#[test]
fn checkout_remote_case_variant_of_local_branch_is_case_collision() {
    if !git_available() {
        return;
    }
    // Remote branch `alpha`; local branch `Alpha`.
    let (_d, _b, path, _bare, head) = remote_fixture(false);
    common::run_git_ok(&path, &["branch", "alpha", "origin/feature"]);
    common::push_branch(&path, "alpha");
    common::fetch_remote(&path, "origin");
    {
        let repo = Repository::open(&path).unwrap();
        repo.find_branch("alpha", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("Alpha", &commit, false).unwrap();
    }
    common::set_ignorecase(&path, true);
    let session = RepoSession::open(&path).unwrap();

    let err = session
        .checkout_remote_branch("origin", "alpha")
        .unwrap_err();

    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing } if requested == "alpha" && existing == "Alpha"),
        "{err:?}"
    );
    assert_eq!(head_ref(&path), head);
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_reference("refs/heads/Alpha").is_ok());
    assert!(repo.find_reference("refs/heads/alpha").is_err());
}

#[test]
fn checkout_remote_with_an_unknown_remote_fails() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .checkout_remote_branch("nope", "feature")
        .unwrap_err();
    assert!(matches!(err, GitError::RemoteNotFound(n) if n == "nope"));
}

#[test]
fn checkout_remote_with_an_unknown_branch_fails() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .checkout_remote_branch("origin", "nope")
        .unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "origin/nope"));
}

#[test]
fn checkout_remote_rejects_an_invalid_branch_name() {
    let (_d, _b, path, _bare, _head) = remote_fixture(false);
    let session = RepoSession::open(&path).unwrap();
    let err = session.checkout_remote_branch("origin", "-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-x"));
}

#[test]
fn checkout_remote_blocked_by_a_dirty_file_fails_with_checkout_failed() {
    if !git_available() {
        return;
    }
    let (_d, _path, session) = blocked_remote_fixture();
    let err = session
        .checkout_remote_branch("origin", "remote-only")
        .unwrap_err();
    assert!(matches!(err, GitError::CheckoutFailed { .. }));
}

#[test]
fn checkout_remote_blocked_by_a_dirty_file_creates_no_local_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = blocked_remote_fixture();
    let _ = session.checkout_remote_branch("origin", "remote-only");
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_branch("remote-only", BranchType::Local).is_err());
}

/// `origin/remote-only` changes README.md while the working tree has an
/// uncommitted edit to it, so git must refuse the switch.
fn blocked_remote_fixture() -> ((tempfile::TempDir, tempfile::TempDir), PathBuf, RepoSession) {
    let (d, b, path, _bare, _head) = remote_fixture(false);
    common::branch_with_commit(&path, "remote-only", "README.md", "# remote\n");
    common::push_branch(&path, "remote-only");
    common::fetch_remote(&path, "origin");
    Repository::open(&path)
        .unwrap()
        .find_branch("remote-only", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let session = RepoSession::open(&path).unwrap();
    ((d, b), path, session)
}

// --- create_and_checkout_branch: create then switch, rolled back on refusal ---

#[test]
fn create_and_checkout_moves_head_to_the_new_branch() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    session.create_and_checkout_branch("topic", None).unwrap();
    assert_eq!(head_ref(&path), "topic");
}

#[test]
fn create_and_checkout_returns_the_branch_marked_as_head() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, _head) = fixture();
    let branch = session.create_and_checkout_branch("topic", None).unwrap();
    assert_eq!(branch.name, "topic");
    assert!(branch.is_head);
}

#[test]
fn create_and_checkout_honours_the_start_point() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = fixture();
    let tip = common::branch_with_commit(&path, "b2", "other.txt", "o\n");
    let branch = session
        .create_and_checkout_branch("topic", Some("b2"))
        .unwrap();
    assert_eq!(branch.oid, tip.to_string());
}

fn refused_switch_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (d, path, session, head) = fixture();
    common::branch_with_commit(&path, "b2", "README.md", "# changed on b2\n");
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    (d, path, session, head)
}

#[test]
fn create_and_checkout_fails_with_checkout_failed_when_git_refuses() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, _head) = refused_switch_fixture();
    let err = session
        .create_and_checkout_branch("new", Some("b2"))
        .unwrap_err();
    assert!(matches!(err, GitError::CheckoutFailed { .. }));
}

#[test]
fn create_and_checkout_removes_the_new_branch_when_git_refuses() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _head) = refused_switch_fixture();
    let _ = session.create_and_checkout_branch("new", Some("b2"));
    let repo = Repository::open(&path).unwrap();
    assert!(repo.find_branch("new", BranchType::Local).is_err());
}

#[test]
fn create_and_checkout_keeps_head_when_git_refuses() {
    if !git_available() {
        return;
    }
    let (_d, path, session, head) = refused_switch_fixture();
    let _ = session.create_and_checkout_branch("new", Some("b2"));
    assert_eq!(head_ref(&path), head);
}

#[test]
fn create_and_checkout_rejects_a_taken_name_and_keeps_head() {
    let (_d, path, session, head) = fixture();
    let err = session.create_and_checkout_branch(&head, None).unwrap_err();
    assert!(matches!(err, GitError::BranchExists(n) if n == head));
    assert_eq!(head_ref(&path), head);
}

#[test]
fn create_and_checkout_rejects_a_leading_dash_name() {
    let (_d, path, session, _head) = fixture();
    let err = session.create_and_checkout_branch("-x", None).unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(_)));
    assert!(
        Repository::open(&path)
            .unwrap()
            .find_branch("-x", BranchType::Local)
            .is_err()
    );
}

#[test]
fn create_and_checkout_with_an_unknown_revision_fails() {
    let (_d, _p, session, _head) = fixture();
    let err = session
        .create_and_checkout_branch("topic", Some("nope"))
        .unwrap_err();
    assert!(matches!(err, GitError::RevisionNotFound(n) if n == "nope"));
}

// --- a remote named like a flag must never reach argv ---

#[test]
fn checkout_remote_rejects_a_remote_whose_name_starts_with_a_dash() {
    let (_d, _b, path, _bare, head) = remote_fixture(false);
    let url = config_string(&path, "remote.origin.url").unwrap();
    Repository::open(&path).unwrap().remote("-x", &url).unwrap();
    common::fetch_remote(&path, "-x");
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(
        session.checkout_remote_branch("-x", &head).unwrap_err(),
        GitError::RemoteNotFound(name) if name == "-x"
    ));
}

// --- checkout_commit: detached checkout of a commit (GR-8) ---

/// Two commits (README `# fixture` then `# two`); returns (dir, path, session, first, second).
fn two_commit_fixture() -> (
    tempfile::TempDir,
    PathBuf,
    RepoSession,
    git2::Oid,
    git2::Oid,
) {
    let (d, path, _session, _head) = fixture();
    let first = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let second = common::commit_file(&path, "README.md", "# two\n", "second");
    let session = RepoSession::open(&path).unwrap();
    (d, path, session, first, second)
}

#[test]
fn should_detach_head_at_the_commit_when_checking_out_a_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, first, _second) = two_commit_fixture();
    session.checkout_commit(&first.to_string()).unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(repo.head_detached().unwrap());
}

#[test]
fn should_point_head_at_the_requested_commit_when_checking_out_a_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, first, _second) = two_commit_fixture();
    session.checkout_commit(&first.to_string()).unwrap();
    let repo = Repository::open(&path).unwrap();
    assert_eq!(repo.head().unwrap().target().unwrap(), first);
}

#[test]
fn should_update_the_working_tree_when_checking_out_a_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, first, _second) = two_commit_fixture();
    session.checkout_commit(&first.to_string()).unwrap();
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# fixture\n"
    );
}

#[test]
fn should_keep_the_branch_where_it_was_when_checking_out_an_older_commit() {
    if !git_available() {
        return;
    }
    let (_d, path, session, first, second) = two_commit_fixture();
    let branch = common::head_branch_name(&path);
    session.checkout_commit(&first.to_string()).unwrap();
    let repo = Repository::open(&path).unwrap();
    let tip = repo
        .find_branch(&branch, BranchType::Local)
        .unwrap()
        .get()
        .target()
        .unwrap();
    assert_eq!(tip, second);
}

#[test]
fn should_accept_checking_out_the_commit_head_is_already_on() {
    if !git_available() {
        return;
    }
    let (_d, path, session, _first, second) = two_commit_fixture();
    session.checkout_commit(&second.to_string()).unwrap();
    let repo = Repository::open(&path).unwrap();
    assert_eq!(repo.head().unwrap().target().unwrap(), second);
}

fn dirty_commit_fixture() -> (
    tempfile::TempDir,
    PathBuf,
    RepoSession,
    git2::Oid,
    git2::Oid,
) {
    let (d, path, session, first, second) = two_commit_fixture();
    std::fs::write(path.join("README.md"), "# dirty edit\n").unwrap();
    (d, path, session, first, second)
}

#[test]
fn should_fail_with_gits_stderr_when_a_dirty_file_blocks_a_commit_checkout() {
    if !git_available() {
        return;
    }
    let (_d, _p, session, first, _second) = dirty_commit_fixture();
    match session.checkout_commit(&first.to_string()).unwrap_err() {
        GitError::CheckoutFailed { code, stderr, .. } => {
            assert_ne!(code, Some(0));
            assert!(stderr.contains("overwritten"), "stderr was: {stderr}");
        }
        other => panic!("expected CheckoutFailed, got {other:?}"),
    }
}

#[test]
fn should_keep_head_unchanged_when_a_dirty_file_blocks_a_commit_checkout() {
    if !git_available() {
        return;
    }
    let (_d, path, session, first, second) = dirty_commit_fixture();
    let _ = session.checkout_commit(&first.to_string());
    let repo = Repository::open(&path).unwrap();
    assert_eq!(
        (repo.head_detached().unwrap(), repo.head().unwrap().target()),
        (false, Some(second))
    );
}

// Pre-checks need no git CLI, so these always run.

#[test]
fn should_reject_a_checkout_of_a_well_formed_oid_that_does_not_exist() {
    let (_d, _p, session, _head) = fixture();
    let input = "0".repeat(40);
    assert!(matches!(
        session.checkout_commit(&input).unwrap_err(),
        GitError::CommitNotFound(s) if s == input
    ));
}

#[test]
fn should_reject_a_checkout_of_text_that_is_not_hex() {
    let (_d, _p, session, _head) = fixture();
    assert!(matches!(
        session.checkout_commit("zz").unwrap_err(),
        GitError::CommitNotFound(s) if s == "zz"
    ));
}

#[test]
fn should_reject_a_checkout_target_that_looks_like_a_flag() {
    let (_d, _p, session, _head) = fixture();
    assert!(matches!(
        session.checkout_commit("--orphan").unwrap_err(),
        GitError::CommitNotFound(_)
    ));
}

#[test]
fn should_reject_a_checkout_of_the_oid_of_a_tree() {
    let (_d, path, session, _head) = fixture();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .tree_id();
    assert!(matches!(
        session.checkout_commit(&tree.to_string()).unwrap_err(),
        GitError::CommitNotFound(_)
    ));
}

#[test]
fn should_leave_head_on_its_branch_when_the_checkout_target_is_unknown() {
    let (_d, path, session, head) = fixture();
    let _ = session.checkout_commit(&"0".repeat(40));
    assert_eq!(head_ref(&path), head);
}
