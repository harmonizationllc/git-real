//! Branch listing and git2-backed branch operations (GR-7): list, validate,
//! create, rename, delete. No git CLI is needed here.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::refs::validate_branch_name;
use git_real_core::{BranchList, GitError, HeadState, RepoSession};
use git2::{BranchType, Repository};

/// Repo with one commit on the libgit2 default branch (never assumed to be `main`).
fn fixture() -> (tempfile::TempDir, PathBuf, RepoSession, String) {
    let (dir, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session, head)
}

/// Fixture plus a local bare remote `origin` that has been fetched and tracked.
fn remote_fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    PathBuf,
    PathBuf,
    String,
) {
    let (dir, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    (dir, bare_dir, path, bare, head)
}

fn head_oid(path: &Path) -> git2::Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

fn local_names(list: &BranchList) -> Vec<String> {
    list.local.iter().map(|b| b.name.clone()).collect()
}

fn branch_exists(path: &Path, name: &str) -> bool {
    Repository::open(path)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .is_ok()
}

// --- list: local branches and HEAD state ---

#[test]
fn list_fresh_repo_has_one_local_branch_marked_as_head() {
    let (_d, _p, session, head) = fixture();
    let list = session.list_branches().unwrap();
    assert_eq!(list.head, HeadState::Branch { name: head.clone() });
    assert_eq!(local_names(&list), vec![head]);
    assert!(list.local[0].is_head);
}

#[test]
fn list_fresh_repo_has_no_remotes_and_no_tracking() {
    let (_d, _p, session, _head) = fixture();
    let list = session.list_branches().unwrap();
    assert!(list.remotes.is_empty());
    assert_eq!(list.local[0].tracking, None);
}

#[test]
fn list_reports_full_hex_oid_of_the_branch_tip() {
    let (_d, path, session, _head) = fixture();
    let list = session.list_branches().unwrap();
    assert_eq!(list.local[0].oid, head_oid(&path).to_string());
}

#[test]
fn list_sorts_local_branches_by_name_in_byte_order() {
    let (_d, _p, session, head) = fixture();
    session.create_branch("zeta", None).unwrap();
    session.create_branch("Alpha", None).unwrap();
    session.create_branch("alpha", None).unwrap();
    let mut expected = vec![
        head,
        "zeta".to_string(),
        "Alpha".to_string(),
        "alpha".to_string(),
    ];
    expected.sort();
    assert_eq!(local_names(&session.list_branches().unwrap()), expected);
}

#[test]
fn list_marks_exactly_one_branch_as_head() {
    let (_d, _p, session, _head) = fixture();
    session.create_branch("other", None).unwrap();
    let list = session.list_branches().unwrap();
    assert_eq!(list.local.iter().filter(|b| b.is_head).count(), 1);
}

#[test]
fn list_reports_detached_head_with_full_oid() {
    let (_d, path, session, _head) = fixture();
    let oid = head_oid(&path);
    Repository::open(&path)
        .unwrap()
        .set_head_detached(oid)
        .unwrap();
    assert_eq!(
        session.list_branches().unwrap().head,
        HeadState::Detached {
            oid: oid.to_string()
        }
    );
}

#[test]
fn list_marks_no_local_branch_as_head_when_detached() {
    let (_d, path, session, _head) = fixture();
    Repository::open(&path)
        .unwrap()
        .set_head_detached(head_oid(&path))
        .unwrap();
    assert!(
        session
            .list_branches()
            .unwrap()
            .local
            .iter()
            .all(|b| !b.is_head)
    );
}

#[test]
fn list_reports_unborn_head_with_the_branch_it_will_create() {
    let (_d, path) = common::temp_repo_unborn();
    let expected = common::head_branch_name(&path);
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(
        session.list_branches().unwrap().head,
        HeadState::Unborn { name: expected }
    );
}

#[test]
fn list_has_no_local_branches_when_head_is_unborn() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    assert!(session.list_branches().unwrap().local.is_empty());
}

#[cfg(unix)]
#[test]
fn list_tolerates_a_non_utf8_branch_name() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let (_d, path, session, _head) = fixture();
    let oid = head_oid(&path);
    let refs = path.join(".git").join("refs").join("heads");
    std::fs::write(
        refs.join(OsStr::from_bytes(b"bad-\xff-name")),
        format!("{oid}\n"),
    )
    .unwrap();
    let list = session.list_branches().expect("listing must not fail");
    assert!(list.local.iter().any(|b| b.name.starts_with("bad-")));
}

// --- list: remote branches ---

#[test]
fn list_groups_remote_branches_under_their_remote() {
    let (_d, _b, path, _bare, head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    let remotes = session.list_branches().unwrap().remotes;
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].remote, "origin");
    assert_eq!(
        remotes[0]
            .branches
            .iter()
            .map(|b| b.name.as_str())
            .collect::<Vec<_>>(),
        vec![head.as_str()]
    );
}

#[test]
fn list_remote_branch_carries_remote_name_and_tip_oid() {
    let (_d, _b, path, _bare, head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    let branch = session.list_branches().unwrap().remotes[0].branches[0].clone();
    assert_eq!(branch.remote, "origin");
    assert_eq!(branch.name, head);
    assert_eq!(branch.oid, head_oid(&path).to_string());
}

#[test]
fn list_skips_the_symbolic_origin_head() {
    let (_d, _b, path, _bare, head) = remote_fixture();
    Repository::open(&path)
        .unwrap()
        .reference_symbolic(
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{head}"),
            true,
            "test",
        )
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    let names: Vec<String> = session.list_branches().unwrap().remotes[0]
        .branches
        .iter()
        .map(|b| b.name.clone())
        .collect();
    assert_eq!(names, vec![head]);
}

#[test]
fn remote_branch_with_slash_in_name_keeps_remote_and_name() {
    let (_d, _b, path, _bare, _head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    session.create_branch("feature/x", None).unwrap();
    common::push_branch(&path, "feature/x");
    common::fetch_remote(&path, "origin");
    let remotes = session.list_branches().unwrap().remotes;
    assert!(
        remotes[0]
            .branches
            .iter()
            .any(|b| b.remote == "origin" && b.name == "feature/x")
    );
}

#[test]
fn remote_with_slash_in_its_own_name_is_split_correctly() {
    let (_d, _b, path, bare, head) = remote_fixture();
    Repository::open(&path)
        .unwrap()
        .remote("up/stream", bare.to_str().unwrap())
        .unwrap();
    common::fetch_remote(&path, "up/stream");
    let session = RepoSession::open(&path).unwrap();
    let group = session
        .list_branches()
        .unwrap()
        .remotes
        .into_iter()
        .find(|g| g.remote == "up/stream")
        .expect("group for remote up/stream");
    assert_eq!(group.branches[0].name, head);
}

#[test]
fn list_sorts_remote_groups_by_remote_then_branch_name() {
    let (_d, _b, path, bare, _head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    session.create_branch("b-branch", None).unwrap();
    session.create_branch("a-branch", None).unwrap();
    common::push_branch(&path, "b-branch");
    common::push_branch(&path, "a-branch");
    Repository::open(&path)
        .unwrap()
        .remote("aaa", bare.to_str().unwrap())
        .unwrap();
    common::fetch_remote(&path, "aaa");
    common::fetch_remote(&path, "origin");
    let remotes = session.list_branches().unwrap().remotes;
    let order: Vec<&str> = remotes.iter().map(|g| g.remote.as_str()).collect();
    assert_eq!(order, vec!["aaa", "origin"]);
    let names: Vec<&str> = remotes[1]
        .branches
        .iter()
        .map(|b| b.name.as_str())
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
}

// --- list: tracking information ---

#[test]
fn list_reports_upstream_with_zero_ahead_and_behind_when_in_sync() {
    let (_d, _b, path, _bare, head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    let tracking = session.list_branches().unwrap().local[0]
        .tracking
        .clone()
        .unwrap();
    assert_eq!(tracking.upstream, format!("origin/{head}"));
    assert_eq!((tracking.ahead, tracking.behind), (Some(0), Some(0)));
}

#[test]
fn list_reports_ahead_count_after_a_local_commit() {
    let (_d, _b, path, _bare, _head) = remote_fixture();
    common::commit_file(&path, "local.txt", "l\n", "local commit");
    let session = RepoSession::open(&path).unwrap();
    let tracking = session.list_branches().unwrap().local[0]
        .tracking
        .clone()
        .unwrap();
    assert_eq!((tracking.ahead, tracking.behind), (Some(1), Some(0)));
}

/// Commits once in a second clone of `bare` and pushes it, then fetches in `path`.
fn advance_remote(path: &Path, bare: &Path, head: &str) {
    let other = tempfile::tempdir().unwrap();
    let clone_path = other.path().join("clone");
    git2::build::RepoBuilder::new()
        .clone(bare.to_str().unwrap(), &clone_path)
        .expect("clone bare");
    common::commit_file(&clone_path, "remote.txt", "r\n", "remote commit");
    common::push_branch(&clone_path, head);
    common::fetch_remote(path, "origin");
}

#[test]
fn list_reports_behind_count_after_the_remote_advances() {
    let (_d, _b, path, bare, head) = remote_fixture();
    advance_remote(&path, &bare, &head);
    let session = RepoSession::open(&path).unwrap();
    let tracking = session.list_branches().unwrap().local[0]
        .tracking
        .clone()
        .unwrap();
    assert_eq!((tracking.ahead, tracking.behind), (Some(0), Some(1)));
}

#[test]
fn list_reports_both_counts_when_histories_diverge() {
    let (_d, _b, path, bare, head) = remote_fixture();
    common::commit_file(&path, "local.txt", "l\n", "local commit");
    advance_remote(&path, &bare, &head);
    let session = RepoSession::open(&path).unwrap();
    let tracking = session.list_branches().unwrap().local[0]
        .tracking
        .clone()
        .unwrap();
    assert_eq!((tracking.ahead, tracking.behind), (Some(1), Some(1)));
}

#[test]
fn list_reports_gone_upstream_with_unknown_counts() {
    let (_d, _b, path, _bare, head) = remote_fixture();
    Repository::open(&path)
        .unwrap()
        .config()
        .unwrap()
        .set_str(&format!("branch.{head}.merge"), "refs/heads/nope")
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    let tracking = session.list_branches().unwrap().local[0]
        .tracking
        .clone()
        .unwrap();
    assert_eq!(tracking.upstream, "origin/nope");
    assert_eq!((tracking.ahead, tracking.behind), (None, None));
}

#[test]
fn list_reports_no_tracking_for_a_branch_without_upstream() {
    let (_d, _b, path, _bare, _head) = remote_fixture();
    let session = RepoSession::open(&path).unwrap();
    session.create_branch("plain", None).unwrap();
    let list = session.list_branches().unwrap();
    let plain = list.local.iter().find(|b| b.name == "plain").unwrap();
    assert_eq!(plain.tracking, None);
}

// --- validate_branch_name ---

fn assert_invalid(name: &str) {
    assert!(
        matches!(validate_branch_name(name), Err(GitError::InvalidBranchName(n)) if n == name),
        "{name:?} should be rejected"
    );
}

#[test]
fn validate_accepts_a_plain_name() {
    assert!(validate_branch_name("feature").is_ok());
}

#[test]
fn validate_accepts_a_name_with_slashes() {
    assert!(validate_branch_name("feature/login-form").is_ok());
}

#[test]
fn validate_rejects_an_empty_name() {
    assert_invalid("");
}

#[test]
fn validate_rejects_a_leading_dash() {
    assert_invalid("-x");
}

#[test]
fn validate_rejects_a_double_dash_option_lookalike() {
    assert_invalid("--track");
}

#[test]
fn validate_rejects_whitespace() {
    assert_invalid("a b");
}

#[test]
fn validate_rejects_consecutive_dots() {
    assert_invalid("a..b");
}

#[test]
fn validate_rejects_a_lock_suffix() {
    assert_invalid("a.lock");
}

#[test]
fn validate_rejects_a_trailing_slash() {
    assert_invalid("a/");
}

#[test]
fn validate_rejects_reflog_syntax() {
    assert_invalid("@{x}");
}

// --- create_branch ---

#[test]
fn create_from_head_points_at_the_head_commit() {
    let (_d, path, session, _head) = fixture();
    let branch = session.create_branch("topic", None).unwrap();
    assert_eq!(branch.oid, head_oid(&path).to_string());
}

#[test]
fn create_returns_the_new_branch_without_head_or_tracking() {
    let (_d, _p, session, _head) = fixture();
    let branch = session.create_branch("topic", None).unwrap();
    assert_eq!(branch.name, "topic");
    assert!(!branch.is_head);
    assert_eq!(branch.tracking, None);
}

#[test]
fn create_makes_the_branch_visible_in_the_repository() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("topic", None).unwrap();
    assert!(branch_exists(&path, "topic"));
}

#[test]
fn create_does_not_move_head() {
    let (_d, _p, session, head) = fixture();
    session.create_branch("topic", None).unwrap();
    assert_eq!(
        session.list_branches().unwrap().head,
        HeadState::Branch { name: head }
    );
}

#[test]
fn create_from_a_branch_name_starts_at_that_branch_tip() {
    let (_d, path, session, _head) = fixture();
    let base_oid = head_oid(&path);
    session.create_branch("base", None).unwrap();
    common::commit_file(&path, "more.txt", "m\n", "move head forward");
    let branch = session.create_branch("topic", Some("base")).unwrap();
    assert_eq!(branch.oid, base_oid.to_string());
}

#[test]
fn create_from_a_short_oid_starts_at_that_commit() {
    let (_d, path, session, _head) = fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "more.txt", "m\n", "second");
    let short = &first.to_string()[..7];
    let branch = session.create_branch("topic", Some(short)).unwrap();
    assert_eq!(branch.oid, first.to_string());
}

#[test]
fn create_from_a_full_oid_starts_at_that_commit() {
    let (_d, path, session, _head) = fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "more.txt", "m\n", "second");
    let branch = session
        .create_branch("topic", Some(&first.to_string()))
        .unwrap();
    assert_eq!(branch.oid, first.to_string());
}

#[test]
fn create_accepts_a_name_with_slashes() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("feature/x", None).unwrap();
    assert!(branch_exists(&path, "feature/x"));
}

#[test]
fn create_rejects_a_leading_dash() {
    let (_d, _p, session, _head) = fixture();
    let err = session.create_branch("-flag", None).unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "-flag"));
}

#[test]
fn create_rejects_an_invalid_name() {
    let (_d, _p, session, _head) = fixture();
    let err = session.create_branch("a..b", None).unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "a..b"));
}

#[test]
fn create_rejects_a_taken_name() {
    let (_d, _p, session, head) = fixture();
    let err = session.create_branch(&head, None).unwrap_err();
    assert!(matches!(err, GitError::BranchExists(n) if n == head));
}

#[test]
fn create_with_a_taken_name_leaves_the_existing_branch_untouched() {
    let (_d, path, session, _head) = fixture();
    let first = head_oid(&path);
    session.create_branch("topic", None).unwrap();
    common::commit_file(&path, "more.txt", "m\n", "second");
    let _ = session.create_branch("topic", None);
    let repo = Repository::open(&path).unwrap();
    let tip = repo
        .find_branch("topic", BranchType::Local)
        .unwrap()
        .get()
        .target();
    assert_eq!(tip, Some(first));
}

#[test]
fn create_on_unborn_head_fails_with_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    let err = session.create_branch("topic", None).unwrap_err();
    assert!(matches!(err, GitError::UnbornHead));
}

#[test]
fn create_with_an_unknown_revision_fails() {
    let (_d, _p, session, _head) = fixture();
    let err = session.create_branch("topic", Some("nope")).unwrap_err();
    assert!(matches!(err, GitError::RevisionNotFound(s) if s == "nope"));
}

#[test]
fn create_with_an_unknown_revision_creates_nothing() {
    let (_d, path, session, _head) = fixture();
    let _ = session.create_branch("topic", Some("nope"));
    assert!(!branch_exists(&path, "topic"));
}

// --- rename_branch ---

#[test]
fn rename_moves_the_branch_to_the_new_name() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("old", None).unwrap();
    session.rename_branch("old", "new").unwrap();
    assert!(branch_exists(&path, "new"));
    assert!(!branch_exists(&path, "old"));
}

#[test]
fn rename_keeps_the_branch_tip() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("old", None).unwrap();
    session.rename_branch("old", "new").unwrap();
    let repo = Repository::open(&path).unwrap();
    let tip = repo
        .find_branch("new", BranchType::Local)
        .unwrap()
        .get()
        .target();
    assert_eq!(tip, Some(head_oid(&path)));
}

#[test]
fn rename_the_current_branch_keeps_head_symbolic_on_the_new_name() {
    let (_d, path, session, head) = fixture();
    session.rename_branch(&head, "renamed").unwrap();
    assert_eq!(common::head_branch_name(&path), "renamed");
}

#[test]
fn rename_the_current_branch_is_reflected_in_the_listing() {
    let (_d, _p, session, head) = fixture();
    session.rename_branch(&head, "renamed").unwrap();
    assert_eq!(
        session.list_branches().unwrap().head,
        HeadState::Branch {
            name: "renamed".into()
        }
    );
}

#[test]
fn rename_to_a_taken_name_fails_and_keeps_both_branches() {
    let (_d, path, session, head) = fixture();
    session.create_branch("old", None).unwrap();
    let err = session.rename_branch("old", &head).unwrap_err();
    assert!(matches!(err, GitError::BranchExists(n) if n == head));
    assert!(branch_exists(&path, "old"));
}

#[test]
fn rename_to_an_invalid_name_fails() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("old", None).unwrap();
    let err = session.rename_branch("old", "a b").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(n) if n == "a b"));
    assert!(branch_exists(&path, "old"));
}

#[test]
fn rename_to_a_leading_dash_name_fails() {
    let (_d, _p, session, _head) = fixture();
    session.create_branch("old", None).unwrap();
    let err = session.rename_branch("old", "-x").unwrap_err();
    assert!(matches!(err, GitError::InvalidBranchName(_)));
}

#[test]
fn rename_a_missing_branch_fails() {
    let (_d, _p, session, _head) = fixture();
    let err = session.rename_branch("ghost", "new").unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "ghost"));
}

// --- delete_branch ---

#[test]
fn delete_a_branch_at_the_head_commit_without_force() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("topic", None).unwrap();
    session.delete_branch("topic", false).unwrap();
    assert!(!branch_exists(&path, "topic"));
}

#[test]
fn delete_an_ancestor_of_head_without_force() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("old", None).unwrap();
    common::commit_file(&path, "more.txt", "m\n", "head moves on");
    session.delete_branch("old", false).unwrap();
    assert!(!branch_exists(&path, "old"));
}

#[test]
fn delete_an_unmerged_branch_without_force_fails() {
    let (_d, path, session, _head) = fixture();
    common::branch_with_commit(&path, "wip", "wip.txt", "w\n");
    let err = session.delete_branch("wip", false).unwrap_err();
    assert!(matches!(err, GitError::BranchNotMerged(n) if n == "wip"));
}

#[test]
fn delete_an_unmerged_branch_without_force_keeps_the_branch() {
    let (_d, path, session, _head) = fixture();
    common::branch_with_commit(&path, "wip", "wip.txt", "w\n");
    let _ = session.delete_branch("wip", false);
    assert!(branch_exists(&path, "wip"));
}

#[test]
fn delete_an_unmerged_branch_with_force_succeeds() {
    let (_d, path, session, _head) = fixture();
    common::branch_with_commit(&path, "wip", "wip.txt", "w\n");
    session.delete_branch("wip", true).unwrap();
    assert!(!branch_exists(&path, "wip"));
}

#[test]
fn delete_the_current_branch_fails() {
    let (_d, path, session, head) = fixture();
    let err = session.delete_branch(&head, false).unwrap_err();
    assert!(matches!(err, GitError::CannotDeleteCurrent(n) if n == head));
    assert!(branch_exists(&path, &head));
}

#[test]
fn delete_the_current_branch_fails_even_with_force() {
    let (_d, _p, session, head) = fixture();
    let err = session.delete_branch(&head, true).unwrap_err();
    assert!(matches!(err, GitError::CannotDeleteCurrent(_)));
}

#[test]
fn delete_a_missing_branch_fails() {
    let (_d, _p, session, _head) = fixture();
    let err = session.delete_branch("ghost", false).unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(n) if n == "ghost"));
}

#[test]
fn delete_with_force_on_a_missing_branch_still_fails() {
    let (_d, _p, session, _head) = fixture();
    let err = session.delete_branch("ghost", true).unwrap_err();
    assert!(matches!(err, GitError::BranchNotFound(_)));
}

#[test]
fn delete_with_an_unborn_head_counts_the_branch_as_unmerged() {
    let (_d, path, _session, _head) = fixture();
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("b", &commit, false).unwrap();
        repo.set_head("refs/heads/newborn").unwrap();
    }
    let session = RepoSession::open(&path).unwrap();
    let err = session.delete_branch("b", false).unwrap_err();
    assert!(matches!(err, GitError::BranchNotMerged(n) if n == "b"));
}

#[test]
fn delete_with_an_unborn_head_succeeds_with_force() {
    let (_d, path, _session, _head) = fixture();
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("b", &commit, false).unwrap();
        repo.set_head("refs/heads/newborn").unwrap();
    }
    let session = RepoSession::open(&path).unwrap();
    session.delete_branch("b", true).unwrap();
    assert!(!branch_exists(&path, "b"));
}

#[test]
fn delete_judges_merged_against_a_detached_head() {
    let (_d, path, session, _head) = fixture();
    session.create_branch("b", None).unwrap();
    Repository::open(&path)
        .unwrap()
        .set_head_detached(head_oid(&path))
        .unwrap();
    session.delete_branch("b", false).unwrap();
    assert!(!branch_exists(&path, "b"));
}

#[test]
fn delete_a_branch_with_slashes_removes_it_from_the_listing() {
    let (_d, _p, session, _head) = fixture();
    session.create_branch("feature/x", None).unwrap();
    assert!(local_names(&session.list_branches().unwrap()).contains(&"feature/x".to_string()));
    session.delete_branch("feature/x", false).unwrap();
    assert!(!local_names(&session.list_branches().unwrap()).contains(&"feature/x".to_string()));
}
