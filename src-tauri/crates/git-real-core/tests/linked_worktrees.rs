//! Linked worktrees (GR-39): listing with git2 and the admin `HEAD` fallback,
//! add/remove/prune through the real git CLI, and the branch guards that
//! refuse to check out or delete a branch another worktree has checked out.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    GitError, HeadState, LinkedWorktree, PrunedWorktrees, RepoSession, WorktreeBranch,
};
use git2::{BranchType, Repository};
use tempfile::TempDir;

/// Main repo with one commit plus a second temp dir for linked worktrees.
fn fixture() -> (TempDir, PathBuf, TempDir, PathBuf, String) {
    let (main_dir, main) = common::temp_repo_with_commit();
    common::configure_identity(&main);
    let main = main.canonicalize().unwrap();
    let head = common::head_branch_name(&main);
    let wt_dir = tempfile::tempdir().unwrap();
    let wt_root = wt_dir.path().canonicalize().unwrap();
    (main_dir, main, wt_dir, wt_root, head)
}

/// `git -C main worktree add -b <branch> <wt_root>/<name>`; returns the canonical path.
fn add_worktree(main: &Path, wt_root: &Path, name: &str, branch: &str) -> PathBuf {
    let path = wt_root.join(name);
    common::run_git_ok(
        main,
        &["worktree", "add", "-b", branch, path.to_str().unwrap()],
    );
    path.canonicalize().unwrap()
}

fn session(path: &Path) -> RepoSession {
    RepoSession::open(path).unwrap()
}

fn entry<'a>(list: &'a [LinkedWorktree], path: &Path) -> &'a LinkedWorktree {
    list.iter()
        .find(|w| w.path == path)
        .unwrap_or_else(|| panic!("no worktree at {} in {list:?}", path.display()))
}

fn paths(list: &[LinkedWorktree]) -> Vec<PathBuf> {
    list.iter().map(|w| w.path.clone()).collect()
}

fn head_oid(path: &Path) -> String {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string()
}

fn head_shorthand(path: &Path) -> String {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .shorthand()
        .unwrap()
        .to_owned()
}

fn branch_exists(path: &Path, name: &str) -> bool {
    Repository::open(path)
        .unwrap()
        .find_branch(name, BranchType::Local)
        .is_ok()
}

fn existing(name: &str) -> WorktreeBranch {
    WorktreeBranch::Existing {
        name: name.to_owned(),
    }
}

fn new_branch(name: &str, start: Option<&str>) -> WorktreeBranch {
    WorktreeBranch::New {
        name: name.to_owned(),
        start: start.map(str::to_owned),
    }
}

// --- list ---

#[test]
fn list_from_main_has_main_first_then_linked_sorted_by_path() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let b = add_worktree(&main, &root, "b", "feat/b");
    let a = add_worktree(&main, &root, "a", "feat/a");
    let list = session(&main).list_linked_worktrees().unwrap();
    assert_eq!(list.len(), 3, "{list:?}");
    assert_eq!(
        list[0],
        LinkedWorktree {
            name: None,
            path: main.clone(),
            head: Some(HeadState::Branch { name: head }),
            is_main: true,
            is_current: true,
            missing: false,
            locked: None,
        }
    );
    assert_eq!(paths(&list[1..]), vec![a.clone(), b]);
    assert_eq!(
        list[1],
        LinkedWorktree {
            name: Some("a".into()),
            path: a,
            head: Some(HeadState::Branch {
                name: "feat/a".into()
            }),
            is_main: false,
            is_current: false,
            missing: false,
            locked: None,
        }
    );
}

#[test]
fn list_from_linked_worktree_marks_it_current_and_same_set() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let b = add_worktree(&main, &root, "b", "feat/b");
    let a = add_worktree(&main, &root, "a", "feat/a");
    let list = session(&a).list_linked_worktrees().unwrap();
    assert_eq!(paths(&list), vec![main.clone(), a.clone(), b]);
    let current: Vec<&Path> = list
        .iter()
        .filter(|w| w.is_current)
        .map(|w| w.path.as_path())
        .collect();
    assert_eq!(current, vec![a.as_path()]);
    assert!(entry(&list, &main).is_main);
}

#[test]
fn list_reports_detached_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let d = root.join("d");
    common::run_git_ok(&main, &["worktree", "add", "--detach", d.to_str().unwrap()]);
    let list = session(&main).list_linked_worktrees().unwrap();
    assert_eq!(
        entry(&list, &d).head,
        Some(HeadState::Detached {
            oid: head_oid(&main)
        })
    );
}

#[test]
fn list_missing_folder_reads_branch_from_admin_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    let list = session(&main).list_linked_worktrees().unwrap();
    let row = entry(&list, &a);
    assert!(row.missing);
    assert_eq!(row.path, a);
    assert_eq!(
        row.head,
        Some(HeadState::Branch {
            name: "feat/a".into()
        })
    );
}

#[test]
fn list_missing_detached_reads_oid_from_admin_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let d = root.join("d");
    common::run_git_ok(&main, &["worktree", "add", "--detach", d.to_str().unwrap()]);
    std::fs::remove_dir_all(&d).unwrap();
    let list = session(&main).list_linked_worktrees().unwrap();
    let row = entry(&list, &d);
    assert!(row.missing);
    assert_eq!(
        row.head,
        Some(HeadState::Detached {
            oid: head_oid(&main)
        })
    );
}

#[test]
fn list_missing_detached_reads_a_64_hex_admin_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let d = root.join("d");
    common::run_git_ok(&main, &["worktree", "add", "--detach", d.to_str().unwrap()]);
    std::fs::remove_dir_all(&d).unwrap();
    let oid = "ab".repeat(32);
    std::fs::write(main.join(".git/worktrees/d/HEAD"), format!("{oid}\n")).unwrap();
    let list = session(&main).list_linked_worktrees().unwrap();
    assert_eq!(entry(&list, &d).head, Some(HeadState::Detached { oid }));
}

#[test]
fn list_corrupt_admin_head_has_no_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    std::fs::write(main.join(".git/worktrees/a/HEAD"), "garbage\n").unwrap();
    let list = session(&main).list_linked_worktrees().unwrap();
    let row = entry(&list, &a);
    assert!(row.missing);
    assert_eq!(row.head, None);
}

#[test]
fn list_locked_with_reason_and_without() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let b = add_worktree(&main, &root, "b", "feat/b");
    common::run_git_ok(
        &main,
        &["worktree", "lock", "--reason", "demo", a.to_str().unwrap()],
    );
    common::run_git_ok(&main, &["worktree", "lock", b.to_str().unwrap()]);
    let list = session(&main).list_linked_worktrees().unwrap();
    assert_eq!(entry(&list, &a).locked.as_deref(), Some("demo"));
    assert_eq!(entry(&list, &b).locked.as_deref(), Some(""));
}

#[test]
fn list_bare_session_is_empty() {
    let (_md, main, _wd, _root, _head) = fixture();
    let (_bd, bare) = common::temp_bare_clone(&main);
    assert_eq!(session(&bare).list_linked_worktrees().unwrap(), vec![]);
}

#[test]
fn list_linked_worktree_of_bare_repo_has_no_main_row() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let (_bd, bare) = common::temp_bare_clone(&main);
    let w = root.join("w");
    common::run_git_ok(&bare, &["worktree", "add", w.to_str().unwrap(), &head]);
    let w = w.canonicalize().unwrap();
    let list = session(&w).list_linked_worktrees().unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0].path, w);
    assert!(!list[0].is_main);
    assert!(list[0].is_current);
}

#[test]
fn list_separate_git_dir_main_row_is_the_workdir() {
    if !common::git_available() {
        return;
    }
    let (_md, _main, _wd, root, _head) = fixture();
    let gitdir = root.join("gitdir");
    let work = root.join("work");
    common::run_git_ok(
        &root,
        &[
            "init",
            &format!("--separate-git-dir={}", gitdir.display()),
            work.to_str().unwrap(),
        ],
    );
    common::configure_identity(&work);
    common::commit_file(&work, "a.txt", "a\n", "first");
    let work = work.canonicalize().unwrap();
    let wt = add_worktree(&work, &root, "linked", "feat/linked");
    // From the main worktree itself, the main row is its own workdir.
    let list = session(&work).list_linked_worktrees().unwrap();
    assert_eq!(paths(&list), vec![work.clone(), wt.clone()]);
    assert!(list[0].is_main && list[0].is_current);
    // From the linked worktree nothing records where `work` is (git's own
    // `worktree list` prints the gitdir), so there is no main row rather
    // than the gitdir's parent.
    let list = session(&wt).list_linked_worktrees().unwrap();
    assert_eq!(paths(&list), vec![wt]);
}

// --- add ---

#[test]
fn add_existing_branch_creates_worktree_on_it() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    common::run_git_ok(&main, &["branch", "feat"]);
    let p = root.join("feat");
    session(&main)
        .add_linked_worktree(&p, &existing("feat"))
        .unwrap();
    assert!(p.exists());
    assert_eq!(head_shorthand(&p), "feat");
}

#[test]
fn add_new_branch_at_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("feat");
    session(&main)
        .add_linked_worktree(&p, &new_branch("feat", None))
        .unwrap();
    assert_eq!(head_shorthand(&p), "feat");
    assert_eq!(head_oid(&p), head_oid(&main));
}

#[test]
fn add_new_branch_at_commit() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let first = common::commit_file(&main, "one.txt", "1\n", "one");
    common::commit_file(&main, "two.txt", "2\n", "two");
    let p = root.join("old");
    session(&main)
        .add_linked_worktree(&p, &new_branch("old", Some(&first.to_string())))
        .unwrap();
    assert_eq!(head_oid(&p), first.to_string());
}

#[test]
fn add_invalid_name_is_invalid_branch_name() {
    let (_md, main, _wd, root, _head) = fixture();
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &new_branch("-x", None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::InvalidBranchName(ref n) if n == "-x"),
        "{err:?}"
    );
}

#[test]
fn add_taken_name_is_branch_exists() {
    let (_md, main, _wd, root, head) = fixture();
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &new_branch(&head, None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::BranchExists(ref n) if *n == head),
        "{err:?}"
    );
}

#[test]
fn add_unknown_existing_branch_is_branch_not_found() {
    let (_md, main, _wd, root, _head) = fixture();
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &existing("nope"))
        .unwrap_err();
    assert!(
        matches!(err, GitError::BranchNotFound(ref n) if n == "nope"),
        "{err:?}"
    );
}

#[test]
fn add_unknown_start_is_revision_not_found() {
    let (_md, main, _wd, root, _head) = fixture();
    let s = session(&main);
    for start in ["nope", "-x"] {
        let err = s
            .add_linked_worktree(&root.join("x"), &new_branch("feat", Some(start)))
            .unwrap_err();
        assert!(
            matches!(err, GitError::RevisionNotFound(ref r) if r == start),
            "{start}: {err:?}"
        );
    }
    assert!(!root.join("x").exists());
}

#[test]
fn add_new_on_unborn_head_is_unborn_head() {
    let (_ud, unborn) = common::temp_repo_unborn();
    let wt = tempfile::tempdir().unwrap();
    let err = session(&unborn)
        .add_linked_worktree(&wt.path().join("x"), &new_branch("feat", None))
        .unwrap_err();
    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

#[test]
fn add_existing_branch_checked_out_here_is_branch_checked_out() {
    let (_md, main, _wd, root, head) = fixture();
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &existing(&head))
        .unwrap_err();
    match err {
        GitError::BranchCheckedOut { name, worktree } => {
            assert_eq!(name, head);
            assert_eq!(worktree, main);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn add_existing_branch_checked_out_elsewhere_is_branch_checked_out() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let err = session(&main)
        .add_linked_worktree(&root.join("x"), &existing("feat/a"))
        .unwrap_err();
    match err {
        GitError::BranchCheckedOut { name, worktree } => {
            assert_eq!(name, "feat/a");
            assert_eq!(worktree, a);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn add_into_non_empty_folder_is_path_exists() {
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("full");
    std::fs::create_dir(&p).unwrap();
    std::fs::write(p.join("keep.txt"), "keep\n").unwrap();
    let err = session(&main)
        .add_linked_worktree(&p, &new_branch("feat", None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::PathExists(ref e) if *e == p),
        "{err:?}"
    );
    let names: Vec<_> = std::fs::read_dir(&p)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("keep.txt")]);
    assert!(!branch_exists(&main, "feat"));
}

#[test]
fn add_relative_path_is_path_not_absolute() {
    let (_md, main, _wd, _root, _head) = fixture();
    common::run_git_ok(&main, &["branch", "side"]);
    // Unique per fixture, so a stray folder from another test cannot mask one made here.
    let sibling = format!("{}-rel", main.file_name().unwrap().to_string_lossy());
    let dotdot = PathBuf::from("..").join(&sibling);
    let tilde = PathBuf::from("~").join(&sibling);
    for p in [&dotdot, &tilde] {
        for branch in [new_branch("feat", None), existing("side")] {
            let err = session(&main).add_linked_worktree(p, &branch).unwrap_err();
            assert!(
                matches!(err, GitError::PathNotAbsolute(ref e) if e == p),
                "{p:?} {branch:?}: {err:?}"
            );
        }
    }
    assert!(!main.parent().unwrap().join(&sibling).exists());
    assert!(!main.join("~").exists());
    assert!(!Path::new(&sibling).exists());
    assert!(!Path::new("~").exists());
    assert!(!branch_exists(&main, "feat"));
}

#[test]
fn add_into_a_file_path_is_path_exists() {
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("file.txt");
    std::fs::write(&p, "x").unwrap();
    let err = session(&main)
        .add_linked_worktree(&p, &new_branch("feat", None))
        .unwrap_err();
    assert!(
        matches!(err, GitError::PathExists(ref e) if *e == p),
        "{err:?}"
    );
}

#[test]
fn add_into_empty_folder_succeeds() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("empty");
    std::fs::create_dir(&p).unwrap();
    session(&main)
        .add_linked_worktree(&p, &new_branch("feat", None))
        .unwrap();
    assert_eq!(head_shorthand(&p), "feat");
}

// --- remove ---

#[test]
fn remove_clean_worktree_deletes_folder_and_keeps_branch() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    add_worktree(&main, &root, "b", "feat/b");
    let s = session(&main);
    s.remove_linked_worktree(&a, false).unwrap();
    assert!(!a.exists());
    assert_eq!(s.list_linked_worktrees().unwrap().len(), 2);
    let out = common::run_git_ok(&main, &["branch", "--list", "feat/a"]);
    assert!(!String::from_utf8_lossy(&out.stdout).trim().is_empty());
}

#[test]
fn remove_dirty_without_force_is_worktree_dirty_and_keeps_everything() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::write_file(&a, "README.md", "changed\n");
    let s = session(&main);
    let err = s.remove_linked_worktree(&a, false).unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeDirty(ref p) if *p == a),
        "{err:?}"
    );
    assert!(a.join("README.md").exists());
    entry(&s.list_linked_worktrees().unwrap(), &a);
}

#[test]
fn remove_untracked_only_without_force_is_worktree_dirty() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::write_file(&a, "new/deep.txt", "new\n");
    let err = session(&main)
        .remove_linked_worktree(&a, false)
        .unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeDirty(ref p) if *p == a),
        "{err:?}"
    );
}

#[test]
fn remove_dirty_with_force_removes() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::write_file(&a, "README.md", "changed\n");
    let s = session(&main);
    s.remove_linked_worktree(&a, true).unwrap();
    assert!(!a.exists());
    assert_eq!(paths(&s.list_linked_worktrees().unwrap()), vec![main]);
}

#[test]
fn remove_missing_folder_without_force_drops_entry() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    let s = session(&main);
    s.remove_linked_worktree(&a, false).unwrap();
    assert!(!paths(&s.list_linked_worktrees().unwrap()).contains(&a));
}

#[test]
fn remove_main_is_cannot_remove_main() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let err = session(&a).remove_linked_worktree(&main, true).unwrap_err();
    assert!(matches!(err, GitError::CannotRemoveMain), "{err:?}");
    assert!(main.exists());
}

#[test]
fn remove_current_is_cannot_remove_current() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let err = session(&a).remove_linked_worktree(&a, true).unwrap_err();
    assert!(matches!(err, GitError::CannotRemoveCurrent), "{err:?}");
    assert!(a.exists());
}

#[test]
fn remove_locked_is_worktree_locked() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::run_git_ok(
        &main,
        &["worktree", "lock", "--reason", "demo", a.to_str().unwrap()],
    );
    let err = session(&main).remove_linked_worktree(&a, true).unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeLocked(ref r) if r == "demo"),
        "{err:?}"
    );
    assert!(a.exists());
}

#[test]
fn remove_unknown_path_is_worktree_not_found() {
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("nowhere");
    let err = session(&main)
        .remove_linked_worktree(&p, false)
        .unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeNotFound(ref e) if *e == p),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn remove_accepts_the_canonical_path_of_a_symlinked_worktree() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("link");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    let through_link = link.join("s");
    common::run_git_ok(
        &main,
        &[
            "worktree",
            "add",
            "-b",
            "feat",
            through_link.to_str().unwrap(),
        ],
    );
    let s = session(&main);
    s.remove_linked_worktree(&root.join("s"), false).unwrap();
    assert_eq!(paths(&s.list_linked_worktrees().unwrap()), vec![main]);
}

#[test]
fn linked_worktree_dirty_is_false_for_a_clean_worktree() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    assert!(!session(&main).linked_worktree_dirty(&a).unwrap());
}

#[test]
fn linked_worktree_dirty_is_true_for_a_modified_tracked_file() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::write_file(&a, "README.md", "changed\n");
    assert!(session(&main).linked_worktree_dirty(&a).unwrap());
}

#[test]
fn linked_worktree_dirty_is_true_for_untracked_only() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::write_file(&a, "new/deep.txt", "new\n");
    assert!(session(&main).linked_worktree_dirty(&a).unwrap());
}

#[test]
fn linked_worktree_dirty_is_false_for_a_missing_folder() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    assert!(!session(&main).linked_worktree_dirty(&a).unwrap());
}

#[test]
fn linked_worktree_dirty_unknown_path_is_worktree_not_found() {
    let (_md, main, _wd, root, _head) = fixture();
    let p = root.join("nowhere");
    let err = session(&main).linked_worktree_dirty(&p).unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeNotFound(ref e) if *e == p),
        "{err:?}"
    );
}

#[test]
fn remove_unopenable_folder_without_force_is_worktree_dirty() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::write(a.join(".git"), "gitdir: /nonexistent\n").unwrap();
    let s = session(&main);
    let err = s.remove_linked_worktree(&a, false).unwrap_err();
    assert!(
        matches!(err, GitError::WorktreeDirty(ref p) if *p == a),
        "{err:?}"
    );
    assert!(s.linked_worktree_dirty(&a).unwrap());
    // git refuses even `--force` here: "validation failed, cannot remove
    // working tree: '<a>/.git' is not a .git file".
    let err = s.remove_linked_worktree(&a, true).unwrap_err();
    assert!(
        matches!(err, GitError::OperationFailed { ref verb, .. } if verb == "worktree remove"),
        "{err:?}"
    );
    assert!(a.exists());
}

// --- prune ---

#[test]
fn prune_with_nothing_stale_returns_no_paths() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    add_worktree(&main, &root, "a", "feat/a");
    let s = session(&main);
    let before = s.list_linked_worktrees().unwrap();
    assert_eq!(
        s.prune_linked_worktrees().unwrap(),
        PrunedWorktrees { paths: vec![] }
    );
    assert_eq!(s.list_linked_worktrees().unwrap(), before);
}

#[test]
fn prune_returns_missing_paths_and_skips_locked() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let b = add_worktree(&main, &root, "b", "feat/b");
    common::run_git_ok(&main, &["worktree", "lock", b.to_str().unwrap()]);
    std::fs::remove_dir_all(&a).unwrap();
    std::fs::remove_dir_all(&b).unwrap();
    let s = session(&main);
    assert_eq!(
        s.prune_linked_worktrees().unwrap(),
        PrunedWorktrees {
            paths: vec![a.clone()]
        }
    );
    let list = s.list_linked_worktrees().unwrap();
    assert!(!paths(&list).contains(&a));
    let row = entry(&list, &b);
    assert!(row.missing);
    assert!(row.locked.is_some());
}

/// libgit2 skips an entry whose admin files it cannot read; `gitdir` itself
/// must stay readable for the path to be known, so `commondir` is the file
/// made unreadable. Skipped when the chmod has no effect, as for root.
#[cfg(unix)]
#[test]
fn prune_reports_an_entry_whose_gitdir_is_broken() {
    use std::os::unix::fs::PermissionsExt;
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    let commondir = main.join(".git/worktrees/a/commondir");
    std::fs::set_permissions(&commondir, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&commondir).is_ok() {
        return;
    }
    let s = session(&main);
    assert!(!paths(&s.list_linked_worktrees().unwrap()).contains(&a));
    assert_eq!(
        s.prune_linked_worktrees().unwrap(),
        PrunedWorktrees {
            paths: vec![a.clone()]
        }
    );
    assert!(!main.join(".git/worktrees/a").exists());
}

// --- branch listing and guards ---

#[test]
fn list_branches_marks_branch_checked_out_in_linked_worktree() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let list = session(&main).list_branches().unwrap();
    let by_name = |n: &str| list.local.iter().find(|b| b.name == n).unwrap().clone();
    assert_eq!(by_name("feat/a").worktree, Some(a));
    assert_eq!(by_name(&head).worktree, None);
}

#[test]
fn list_branches_marks_branch_of_missing_worktree() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    let list = session(&main).list_branches().unwrap();
    let feat = list.local.iter().find(|b| b.name == "feat/a").unwrap();
    assert_eq!(feat.worktree, Some(a));
}

#[test]
fn list_branches_from_linked_marks_main_branch() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let list = session(&a).list_branches().unwrap();
    let by_name = |n: &str| list.local.iter().find(|b| b.name == n).unwrap().clone();
    assert_eq!(by_name(&head).worktree, Some(main));
    assert_eq!(by_name("feat/a").worktree, None);
}

/// An unreadable `.git/worktrees` makes `repo.worktrees()` fail (a regular
/// file there reads as "no worktrees"). Skipped when the chmod has no effect,
/// as for root.
#[cfg(unix)]
#[test]
fn list_branches_survives_a_corrupt_worktree_registry() {
    use std::os::unix::fs::PermissionsExt;
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    add_worktree(&main, &root, "a", "feat/a");
    let registry = main.join(".git/worktrees");
    let set_mode =
        |mode| std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(mode)).unwrap();
    set_mode(0o000);
    if std::fs::read_dir(&registry).is_ok() {
        set_mode(0o755);
        return;
    }
    let s = session(&main);
    let listed = s.list_branches();
    let checkout = s.checkout_branch("feat/a");
    set_mode(0o755);
    let list = listed.unwrap();
    assert!(list.local.iter().any(|b| b.name == "feat/a"), "{list:?}");
    assert!(list.local.iter().all(|b| b.worktree.is_none()), "{list:?}");
    assert!(checkout.is_err(), "{checkout:?}");
}

#[test]
fn checkout_branch_checked_out_elsewhere_is_refused() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    let err = session(&main).checkout_branch("feat/a").unwrap_err();
    match err {
        GitError::BranchCheckedOut { name, worktree } => {
            assert_eq!(name, "feat/a");
            assert_eq!(worktree, a);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(head_shorthand(&main), head);
}

#[test]
fn delete_branch_checked_out_elsewhere_is_refused() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    add_worktree(&main, &root, "a", "feat/a");
    let s = session(&main);
    for force in [false, true] {
        let err = s.delete_branch("feat/a", force).unwrap_err();
        assert!(
            matches!(err, GitError::BranchCheckedOut { ref name, .. } if name == "feat/a"),
            "force {force}: {err:?}"
        );
    }
    assert!(branch_exists(&main, "feat/a"));
}

#[test]
fn rename_branch_updates_a_live_linked_worktree_head() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    session(&main)
        .rename_branch("feat/a", "feat/renamed")
        .unwrap();
    assert_eq!(head_shorthand(&a), "feat/renamed");
    assert!(!branch_exists(&main, "feat/a"));
}

#[test]
fn rename_branch_held_by_a_missing_worktree_is_refused() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    std::fs::remove_dir_all(&a).unwrap();
    let admin_head = main.join(".git/worktrees/a/HEAD");
    let before = std::fs::read_to_string(&admin_head).unwrap();
    let err = session(&main)
        .rename_branch("feat/a", "feat/renamed")
        .unwrap_err();
    match err {
        GitError::BranchCheckedOut { name, worktree } => {
            assert_eq!(name, "feat/a");
            assert_eq!(worktree, a);
        }
        other => panic!("{other:?}"),
    }
    assert!(branch_exists(&main, "feat/a"));
    assert!(!branch_exists(&main, "feat/renamed"));
    assert_eq!(std::fs::read_to_string(&admin_head).unwrap(), before);
}

#[test]
fn checkout_remote_branch_with_local_checked_out_elsewhere_is_refused() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, head) = fixture();
    let (_bd, bare) = common::temp_bare_clone(&main);
    common::add_remote_and_fetch(&main, &bare, &head);
    let a = add_worktree(&main, &root, "a", "feat/a");
    common::push_branch(&main, "feat/a");
    common::fetch_remote(&main, "origin");
    let err = session(&main)
        .checkout_remote_branch("origin", "feat/a")
        .unwrap_err();
    match err {
        GitError::BranchCheckedOut { name, worktree } => {
            assert_eq!(name, "feat/a");
            assert_eq!(worktree, a);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(head_shorthand(&main), head);
}

// --- common dir and messages ---

#[test]
fn common_dir_outside_workdir_is_none_for_main_and_some_for_linked() {
    if !common::git_available() {
        return;
    }
    let (_md, main, _wd, root, _head) = fixture();
    let a = add_worktree(&main, &root, "a", "feat/a");
    assert_eq!(session(&main).common_dir_outside_workdir(), None);
    assert_eq!(
        session(&a).common_dir_outside_workdir(),
        Some(main.join(".git").canonicalize().unwrap())
    );
}

#[test]
fn error_messages() {
    assert_eq!(
        GitError::BranchCheckedOut {
            name: "x".into(),
            worktree: "/w/sub".into()
        }
        .to_string(),
        "x is checked out in worktree sub"
    );
    assert_eq!(
        GitError::BranchCheckedOut {
            name: "x".into(),
            worktree: "/".into()
        }
        .to_string(),
        "x is checked out in worktree /"
    );
    assert_eq!(
        GitError::WorktreeLocked(String::new()).to_string(),
        "the worktree is locked"
    );
    assert_eq!(
        GitError::WorktreeLocked("demo".into()).to_string(),
        "the worktree is locked: demo"
    );
    assert_eq!(
        GitError::WorktreeNotFound("/w".into()).to_string(),
        "/w is not a worktree of this repository"
    );
    assert_eq!(
        GitError::WorktreeDirty("/w".into()).to_string(),
        "/w has uncommitted changes"
    );
    assert_eq!(
        GitError::CannotRemoveMain.to_string(),
        "the main worktree cannot be removed"
    );
    assert_eq!(
        GitError::CannotRemoveCurrent.to_string(),
        "the worktree open in this tab cannot be removed from here"
    );
    assert_eq!(
        GitError::PathExists("/w".into()).to_string(),
        "/w already exists and is not empty"
    );
    assert_eq!(
        GitError::PathNotAbsolute("~/w".into()).to_string(),
        "~/w is not an absolute path"
    );
}
