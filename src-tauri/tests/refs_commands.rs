//! Integration tests for the branch command `*_inner` functions (GR-7).

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{HeadState, RepoSession};
use git_real_lib::commands::refs::{
    checkout_branch_inner, checkout_remote_branch_inner, create_branch_inner, delete_branch_inner,
    delete_remote_branch_inner, list_branches_inner, rename_branch_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{BranchType, Repository};
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;

/// Registered repo with one commit, local identity, signing off.
fn open_fixture() -> (TempDir, PathBuf, RepoRegistry, RepoId, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, path, reg, id, head)
}

/// Registered repo with a fetched local bare remote `origin` holding `feature`.
fn remote_fixture() -> (TempDir, TempDir, PathBuf, PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
    }
    common::push_branch(&path, "feature");
    common::fetch_origin(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, bare_dir, path, bare, reg, id)
}

fn local_exists(path: &Path, name: &str) -> bool {
    Repository::open(path)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .is_ok()
}

// --- list_branches_inner ---

#[test]
fn list_branches_inner_returns_head_and_local_branches() {
    let (_d, _p, reg, id, head) = open_fixture();
    let list = list_branches_inner(&reg, id).unwrap();
    assert_eq!(list.head, HeadState::Branch { name: head.clone() });
    assert_eq!(list.local.len(), 1);
    assert_eq!(list.local[0].name, head);
}

#[test]
fn list_branches_inner_includes_remote_groups() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let list = list_branches_inner(&reg, id).unwrap();
    assert_eq!(list.remotes[0].remote, "origin");
    assert!(list.remotes[0].branches.iter().any(|b| b.name == "feature"));
}

// --- create_branch_inner ---

#[test]
fn create_branch_inner_without_checkout_keeps_head() {
    let (_d, path, reg, id, head) = open_fixture();
    let branch = create_branch_inner(&reg, id, "topic", None, false).unwrap();
    assert_eq!(branch.name, "topic");
    assert_eq!(common::head_branch_name(&path), head);
    assert!(local_exists(&path, "topic"));
}

#[test]
fn create_branch_inner_with_checkout_moves_head() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _head) = open_fixture();
    create_branch_inner(&reg, id, "topic", None, true).unwrap();
    assert_eq!(common::head_branch_name(&path), "topic");
}

#[test]
fn create_branch_inner_with_checkout_returns_the_branch_marked_as_head() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, _head) = open_fixture();
    let branch = create_branch_inner(&reg, id, "topic", None, true).unwrap();
    assert!(branch.is_head);
}

#[test]
fn create_branch_inner_with_checkout_removes_the_branch_when_git_refuses() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, head) = open_fixture();
    common::branch_with_commit(&path, "b2", "README.md", "# on b2\n");
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let err = create_branch_inner(&reg, id, "new", Some("b2"), true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CheckoutFailed);
    assert!(!local_exists(&path, "new"));
    assert_eq!(common::head_branch_name(&path), head);
}

#[test]
fn create_branch_inner_honours_the_start_point() {
    let (_d, path, reg, id, _head) = open_fixture();
    let first = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::commit_file(&path, "more.txt", "m\n", "second");
    let branch =
        create_branch_inner(&reg, id, "topic", Some(&first.to_string()[..7]), false).unwrap();
    assert_eq!(branch.oid, first.to_string());
}

#[test]
fn create_branch_inner_maps_invalid_name() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = create_branch_inner(&reg, id, "-x", None, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
}

#[test]
fn create_branch_inner_maps_taken_name() {
    let (_d, _p, reg, id, head) = open_fixture();
    let err = create_branch_inner(&reg, id, &head, None, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchExists);
}

#[test]
fn create_branch_inner_maps_unknown_revision() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = create_branch_inner(&reg, id, "topic", Some("nope"), false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RevisionNotFound);
}

#[test]
fn create_branch_inner_maps_unborn_head() {
    let dir = tempfile::tempdir().unwrap();
    Repository::init(dir.path()).unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(dir.path()).unwrap());
    let err = create_branch_inner(&reg, id, "topic", None, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnbornHead);
}

#[test]
fn create_branch_inner_with_checkout_and_taken_name_does_not_move_head() {
    let (_d, path, reg, id, head) = open_fixture();
    let _ = create_branch_inner(&reg, id, &head, None, true);
    assert_eq!(common::head_branch_name(&path), head);
}

// --- rename_branch_inner ---

#[test]
fn rename_branch_inner_renames_the_branch() {
    let (_d, path, reg, id, _head) = open_fixture();
    create_branch_inner(&reg, id, "old", None, false).unwrap();
    rename_branch_inner(&reg, id, "old", "new").unwrap();
    assert!(local_exists(&path, "new"));
    assert!(!local_exists(&path, "old"));
}

#[test]
fn rename_branch_inner_maps_missing_branch() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = rename_branch_inner(&reg, id, "ghost", "new").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn rename_branch_inner_maps_taken_name() {
    let (_d, _p, reg, id, head) = open_fixture();
    create_branch_inner(&reg, id, "old", None, false).unwrap();
    let err = rename_branch_inner(&reg, id, "old", &head).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchExists);
}

// --- delete_branch_inner ---

#[test]
fn delete_branch_inner_deletes_a_merged_branch() {
    let (_d, path, reg, id, _head) = open_fixture();
    create_branch_inner(&reg, id, "topic", None, false).unwrap();
    delete_branch_inner(&reg, id, "topic", false).unwrap();
    assert!(!local_exists(&path, "topic"));
}

#[test]
fn delete_branch_inner_maps_not_merged() {
    let (_d, path, reg, id, _head) = open_fixture();
    common::branch_with_commit(&path, "wip", "wip.txt", "w\n");
    let err = delete_branch_inner(&reg, id, "wip", false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotMerged);
    assert!(local_exists(&path, "wip"));
}

#[test]
fn delete_branch_inner_force_deletes_an_unmerged_branch() {
    let (_d, path, reg, id, _head) = open_fixture();
    common::branch_with_commit(&path, "wip", "wip.txt", "w\n");
    delete_branch_inner(&reg, id, "wip", true).unwrap();
    assert!(!local_exists(&path, "wip"));
}

#[test]
fn delete_branch_inner_maps_current_branch() {
    let (_d, _p, reg, id, head) = open_fixture();
    let err = delete_branch_inner(&reg, id, &head, true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CannotDeleteCurrent);
}

#[test]
fn delete_branch_inner_maps_missing_branch() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = delete_branch_inner(&reg, id, "ghost", false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

// --- checkout_branch_inner / checkout_remote_branch_inner ---

#[test]
fn checkout_branch_inner_moves_head() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _head) = open_fixture();
    create_branch_inner(&reg, id, "topic", None, false).unwrap();
    checkout_branch_inner(&reg, id, "topic").unwrap();
    assert_eq!(common::head_branch_name(&path), "topic");
}

#[test]
fn checkout_branch_inner_maps_missing_branch() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = checkout_branch_inner(&reg, id, "ghost").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn checkout_branch_inner_maps_git_refusal_to_checkout_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, _head) = open_fixture();
    common::branch_with_commit(&path, "b", "README.md", "# on b\n");
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let err = checkout_branch_inner(&reg, id, "b").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CheckoutFailed);
    assert!(err.message.contains("overwritten"), "{}", err.message);
}

#[test]
fn checkout_remote_branch_inner_creates_a_tracking_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, reg, id) = remote_fixture();
    Repository::open(&path)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    checkout_remote_branch_inner(&reg, id, "origin", "feature").unwrap();
    assert_eq!(common::head_branch_name(&path), "feature");
}

#[test]
fn checkout_remote_branch_inner_maps_unknown_remote() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let err = checkout_remote_branch_inner(&reg, id, "nope", "feature").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
}

// --- delete_remote_branch_inner ---

#[test]
fn delete_remote_branch_inner_deletes_on_the_bare_remote() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, _p, bare, reg, id) = remote_fixture();
    delete_remote_branch_inner(&reg, id, "origin", "feature", None).unwrap();
    let still_there = Repository::open_bare(&bare)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .is_ok();
    assert!(!still_there);
}

#[test]
fn delete_remote_branch_inner_removes_the_branch_from_the_listing() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    delete_remote_branch_inner(&reg, id, "origin", "feature", None).unwrap();
    let list = list_branches_inner(&reg, id).unwrap();
    assert!(
        list.remotes
            .iter()
            .flat_map(|g| &g.branches)
            .all(|b| b.name != "feature")
    );
}

#[test]
fn delete_remote_branch_inner_maps_unknown_remote() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let err = delete_remote_branch_inner(&reg, id, "nope", "feature", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
}

#[test]
fn delete_remote_branch_inner_maps_unknown_remote_branch() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let err = delete_remote_branch_inner(&reg, id, "origin", "nope", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn delete_remote_branch_inner_maps_push_rejection_to_network_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, _p, bare, reg, id) = remote_fixture();
    Repository::open_bare(&bare)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    let err = delete_remote_branch_inner(&reg, id, "origin", "feature", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(err.network.unwrap().verb, "push");
    assert!(!err.message.is_empty());
}

/// The session lock must not be held while the push runs: a `pre-receive`
/// hook in the bare remote blocks until the test has listed branches on the
/// same repo. If the lock were held the listing would wait for the push, the
/// hook would hit its own timeout and reject the push, and the result below
/// would be an error instead of `Ok`.
#[cfg(unix)]
#[test]
fn delete_remote_branch_inner_does_not_hold_the_session_lock_during_the_push() {
    use std::time::{Duration, Instant};

    if !common::git_available() {
        return;
    }
    let (_d, _b, _p, bare, reg, id) = remote_fixture();
    let markers = tempfile::tempdir().unwrap();
    let started = markers.path().join("started");
    let release = markers.path().join("release");

    let hooks = bare.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    Repository::open_bare(&bare)
        .unwrap()
        .config()
        .unwrap()
        .set_str("core.hooksPath", hooks.to_str().unwrap())
        .unwrap();
    let script = format!(
        "#!/bin/sh\ntouch '{}'\ni=0\nwhile [ ! -f '{}' ]; do\n  i=$((i+1))\n  [ $i -gt 200 ] && exit 1\n  sleep 0.05\ndone\nexit 0\n",
        started.display(),
        release.display()
    );
    let hook = hooks.join("pre-receive");
    std::fs::write(&hook, script).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let result = std::thread::scope(|scope| {
        let push = scope.spawn(|| delete_remote_branch_inner(&reg, id, "origin", "feature", None));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !started.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        // Blocks forever-ish (until the hook times out) if the lock is held.
        let _ = list_branches_inner(&reg, id);
        std::fs::write(&release, "go").unwrap();
        push.join().unwrap()
    });
    assert!(result.is_ok(), "push result: {result:?}");
}

// --- unknown repo id: every command maps to unknownRepo ---

#[test]
fn list_branches_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = list_branches_inner(&reg, MISSING_ID).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn create_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = create_branch_inner(&reg, MISSING_ID, "x", None, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn rename_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = rename_branch_inner(&reg, MISSING_ID, "a", "b").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn delete_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = delete_branch_inner(&reg, MISSING_ID, "a", false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn checkout_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = checkout_branch_inner(&reg, MISSING_ID, "a").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn checkout_remote_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = checkout_remote_branch_inner(&reg, MISSING_ID, "origin", "a").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn delete_remote_branch_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = delete_remote_branch_inner(&reg, MISSING_ID, "origin", "a", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- GR-7 cycle 1 coverage ---

#[test]
fn create_branch_inner_maps_an_unexpected_libgit2_error_to_git() {
    let (_d, path, reg, id, _head) = open_fixture();
    let err = create_branch_inner(&reg, id, "topic", Some("HEAD^{tree}"), false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::Git);
    assert!(!local_exists(&path, "topic"));
}

#[test]
fn create_branch_inner_without_checkout_does_not_need_the_git_cli() {
    // Plain creation stays on git2: it must work with no git on PATH at all.
    let (_d, path, reg, id, head) = open_fixture();
    let branch = create_branch_inner(&reg, id, "topic", None, false).unwrap();
    assert!(!branch.is_head);
    assert_eq!(common::head_branch_name(&path), head);
}

#[test]
fn create_branch_inner_with_checkout_maps_unborn_head() {
    let dir = tempfile::tempdir().unwrap();
    Repository::init(dir.path()).unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(dir.path()).expect("open"));
    let err = create_branch_inner(&reg, id, "topic", None, true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnbornHead);
}

#[test]
fn delete_branch_inner_force_still_maps_current_branch() {
    let (_d, _p, reg, id, head) = open_fixture();
    let err = delete_branch_inner(&reg, id, &head, true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CannotDeleteCurrent);
}

#[test]
fn rename_branch_inner_renames_the_current_branch_and_head_follows() {
    let (_d, path, reg, id, head) = open_fixture();
    rename_branch_inner(&reg, id, &head, "renamed").unwrap();
    assert_eq!(common::head_branch_name(&path), "renamed");
    assert!(!local_exists(&path, &head));
}

#[test]
fn rename_branch_inner_maps_an_invalid_new_name() {
    let (_d, path, reg, id, head) = open_fixture();
    let err = rename_branch_inner(&reg, id, &head, "bad name").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
    assert!(local_exists(&path, &head));
}

#[test]
fn checkout_branch_inner_maps_a_leading_dash_name_to_invalid_branch_name() {
    let (_d, _p, reg, id, _head) = open_fixture();
    let err = checkout_branch_inner(&reg, id, "--detach").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
}

#[test]
fn checkout_remote_branch_inner_maps_unknown_remote_branch() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let err = checkout_remote_branch_inner(&reg, id, "origin", "ghost").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::BranchNotFound);
}

#[test]
fn checkout_remote_branch_inner_switches_to_an_existing_local_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, reg, id) = remote_fixture();
    // `feature` still exists locally from the fixture.
    checkout_remote_branch_inner(&reg, id, "origin", "feature").unwrap();
    assert_eq!(common::head_branch_name(&path), "feature");
}

#[test]
fn checkout_remote_branch_inner_maps_git_refusal_to_checkout_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, reg, id) = remote_fixture();
    Repository::open(&path)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    // HEAD moves on, so switching to `feature` must rewrite README.md, which
    // has an uncommitted edit.
    common::commit_file(&path, "README.md", "# v2\n", "v2");
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let err = checkout_remote_branch_inner(&reg, id, "origin", "feature").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CheckoutFailed);
    assert!(!local_exists(&path, "feature"));
}

#[test]
fn delete_remote_branch_inner_maps_an_invalid_name() {
    let (_d, _b, _p, _bare, reg, id) = remote_fixture();
    let err = delete_remote_branch_inner(&reg, id, "origin", "--all", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
}

#[test]
fn delete_remote_branch_inner_keeps_the_local_branch_of_the_same_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, reg, id) = remote_fixture();
    delete_remote_branch_inner(&reg, id, "origin", "feature", None).unwrap();
    assert!(local_exists(&path, "feature"));
    assert!(
        Repository::open_bare(&bare)
            .unwrap()
            .find_branch("feature", BranchType::Local)
            .is_err()
    );
}

#[test]
fn remote_branch_commands_reject_a_remote_whose_name_starts_with_a_dash() {
    let (_d, _b, path, bare, reg, id) = remote_fixture();
    let head = common::head_branch_name(&path);
    Repository::open(&path)
        .unwrap()
        .remote("-x", bare.to_str().unwrap())
        .unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let mut remote = repo.find_remote("-x").unwrap();
        remote
            .fetch(&["+refs/heads/*:refs/remotes/-x/*"], None, None)
            .unwrap();
    }
    let err = delete_remote_branch_inner(&reg, id, "-x", &head, None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
    let err = checkout_remote_branch_inner(&reg, id, "-x", &head).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
}
