mod common;

use git_real_core::{ChangeKind, GitError, RepoSession, StatusEntry, WorkingTreeStatus};

fn session(path: &std::path::Path) -> RepoSession {
    RepoSession::open(path).expect("open")
}

fn status_of(path: &std::path::Path) -> WorkingTreeStatus {
    session(path).status().expect("status")
}

fn entry(path: &std::path::Path, rel: &str) -> StatusEntry {
    let status = status_of(path);
    status
        .entries
        .iter()
        .find(|e| e.path == rel)
        .cloned()
        .unwrap_or_else(|| panic!("no entry for {rel}: {:?}", status.entries))
}

fn sides(path: &std::path::Path, rel: &str) -> (Option<ChangeKind>, Option<ChangeKind>) {
    let e = entry(path, rel);
    (e.index, e.worktree)
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// --- stage_paths: adds working tree changes to the index ---

#[test]
fn stage_paths_stages_untracked() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "hi\n");
    session(&path)
        .stage_paths(&paths(&["new.txt"]))
        .expect("stage");
    assert_eq!(sides(&path, "new.txt"), (Some(ChangeKind::Added), None));
}

#[test]
fn stage_paths_stages_modified() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# changed\n");
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    assert_eq!(
        sides(&path, "README.md"),
        (Some(ChangeKind::Modified), None)
    );
}

#[test]
fn stage_paths_stages_deletion() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    assert_eq!(sides(&path, "README.md"), (Some(ChangeKind::Deleted), None));
}

#[test]
fn stage_paths_merges_worktree_change_into_index() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# one\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# two\n");
    assert_eq!(
        sides(&path, "README.md"),
        (Some(ChangeKind::Modified), Some(ChangeKind::Modified))
    );
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    assert_eq!(
        sides(&path, "README.md"),
        (Some(ChangeKind::Modified), None)
    );
}

#[test]
fn stage_paths_multiple() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    session(&path)
        .stage_paths(&paths(&["a.txt", "b.txt"]))
        .expect("stage");
    assert_eq!(
        (sides(&path, "a.txt"), sides(&path, "b.txt")),
        (
            (Some(ChangeKind::Added), None),
            (Some(ChangeKind::Added), None)
        )
    );
}

#[test]
fn stage_paths_leaves_other_paths_untouched() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    session(&path)
        .stage_paths(&paths(&["a.txt"]))
        .expect("stage");
    assert_eq!(sides(&path, "b.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn stage_paths_empty_list_changes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    session(&path).stage_paths(&[]).expect("stage");
    assert_eq!(sides(&path, "a.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn stage_paths_marks_conflict_resolved() {
    let (_dir, path) = common::temp_repo_with_conflict();
    common::write_file(&path, "README.md", "# resolved\n");
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    assert!(!entry(&path, "README.md").conflicted);
}

#[test]
fn stage_paths_unknown_path_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .stage_paths(&paths(&["missing.txt"]))
        .expect_err("unknown path");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

// --- stage_all: stages additions, modifications and deletions ---

#[test]
fn stage_all_stages_everything_including_deletions() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "keep.txt", "k\n");
    common::commit_all(&path, "add keep");
    std::fs::remove_file(path.join("README.md")).unwrap();
    common::write_file(&path, "keep.txt", "changed\n");
    common::write_file(&path, "new.txt", "n\n");
    session(&path).stage_all().expect("stage all");
    assert_eq!(
        (
            sides(&path, "README.md"),
            sides(&path, "keep.txt"),
            sides(&path, "new.txt")
        ),
        (
            (Some(ChangeKind::Deleted), None),
            (Some(ChangeKind::Modified), None),
            (Some(ChangeKind::Added), None)
        )
    );
}

#[test]
fn stage_all_on_clean_repo_changes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    session(&path).stage_all().expect("stage all");
    assert!(status_of(&path).entries.is_empty());
}

// --- unstage_paths / unstage_all: reset the index to HEAD ---

#[test]
fn unstage_paths_restores_index_to_head() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    session(&path)
        .unstage_paths(&paths(&["README.md"]))
        .expect("unstage");
    assert_eq!(
        sides(&path, "README.md"),
        (None, Some(ChangeKind::Modified))
    );
}

#[test]
fn unstage_paths_turns_staged_addition_back_into_untracked() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "n\n");
    common::stage(&path, "new.txt");
    session(&path)
        .unstage_paths(&paths(&["new.txt"]))
        .expect("unstage");
    assert_eq!(sides(&path, "new.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn unstage_paths_leaves_other_staged_paths_staged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    common::stage(&path, "a.txt");
    common::stage(&path, "b.txt");
    session(&path)
        .unstage_paths(&paths(&["a.txt"]))
        .expect("unstage");
    assert_eq!(sides(&path, "b.txt"), (Some(ChangeKind::Added), None));
}

#[test]
fn unstage_paths_unborn_removes_from_index() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    session(&path)
        .unstage_paths(&paths(&["a.txt"]))
        .expect("unstage");
    assert_eq!(sides(&path, "a.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn unstage_all_clears_staged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::write_file(&path, "new.txt", "n\n");
    common::stage(&path, "README.md");
    common::stage(&path, "new.txt");
    session(&path).unstage_all().expect("unstage all");
    assert_eq!(
        (sides(&path, "README.md"), sides(&path, "new.txt")),
        (
            (None, Some(ChangeKind::Modified)),
            (None, Some(ChangeKind::Untracked))
        )
    );
}

#[test]
fn unstage_all_unborn_clears_index() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    common::stage(&path, "a.txt");
    common::stage(&path, "b.txt");
    session(&path).unstage_all().expect("unstage all");
    assert!(
        status_of(&path)
            .entries
            .iter()
            .all(|e| e.index.is_none() && e.worktree == Some(ChangeKind::Untracked))
    );
}

#[test]
fn unstage_all_on_clean_repo_changes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    session(&path).unstage_all().expect("unstage all");
    assert!(status_of(&path).entries.is_empty());
}

// --- discard_paths: throws away working tree changes ---

#[test]
fn discard_paths_restores_tracked_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# fixture\n"
    );
}

#[test]
fn discard_paths_restores_tracked_file_status_to_clean() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert!(status_of(&path).entries.is_empty());
}

#[test]
fn discard_paths_restores_index_version_not_head() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# unstaged\n");
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# staged\n"
    );
}

#[test]
fn discard_paths_keeps_staged_change_in_index() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# unstaged\n");
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert_eq!(
        sides(&path, "README.md"),
        (Some(ChangeKind::Modified), None)
    );
}

#[test]
fn discard_paths_deletes_untracked_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "junk.txt", "j\n");
    session(&path)
        .discard_paths(&paths(&["junk.txt"]))
        .expect("discard");
    assert!(!path.join("junk.txt").exists());
}

#[test]
fn discard_paths_removes_untracked_dir() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/a.txt", "a\n");
    common::write_file(&path, "dir/sub/b.txt", "b\n");
    session(&path)
        .discard_paths(&paths(&["dir"]))
        .expect("discard");
    assert!(!path.join("dir").exists());
}

#[test]
fn discard_paths_restores_deleted_tracked_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# fixture\n"
    );
}

#[test]
fn discard_paths_leaves_other_files_untouched() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    common::write_file(&path, "keep.txt", "keep\n");
    session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("keep.txt")).unwrap(),
        "keep\n"
    );
}

#[test]
fn discard_paths_unknown_path_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&["missing.txt"]))
        .expect_err("unknown path");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

// --- stage_paths: edge rulings ---

#[test]
fn stage_paths_writes_working_tree_content_into_index_blob() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "v2\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "v3\n");
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    let repo = git2::Repository::open(&path).unwrap();
    let index = repo.index().unwrap();
    let id = index
        .get_path(std::path::Path::new("README.md"), 0)
        .unwrap()
        .id;
    assert_eq!(repo.find_blob(id).unwrap().content(), b"v3\n");
}

#[test]
fn stage_paths_directory_is_git2_error() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/a.txt", "a\n");
    let err = session(&path)
        .stage_paths(&paths(&["dir"]))
        .expect_err("directory");
    assert!(matches!(err, GitError::Git2(_)), "got {err:?}");
}

#[test]
fn stage_paths_fails_fast_and_writes_nothing_when_a_path_is_unknown() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    let _ = session(&path).stage_paths(&paths(&["a.txt", "nope.txt"]));
    assert_eq!(sides(&path, "a.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn stage_paths_rejects_paths_outside_repo() {
    let (_dir, path) = common::temp_repo_with_commit();
    for bad in ["../x", ".git/config", "/etc/passwd"] {
        let err = session(&path)
            .stage_paths(&paths(&[bad]))
            .expect_err("outside repo");
        assert!(matches!(err, GitError::PathNotFound(_)), "{bad}: {err:?}");
    }
}

#[test]
fn stage_paths_strips_trailing_slash() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    session(&path)
        .stage_paths(&paths(&["a.txt/"]))
        .expect("stage");
    assert_eq!(sides(&path, "a.txt"), (Some(ChangeKind::Added), None));
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn stage_paths_treats_glob_characters_literally() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "*.txt", "star\n");
    common::write_file(&path, "a.txt", "a\n");
    session(&path)
        .stage_paths(&paths(&["*.txt"]))
        .expect("stage");
    assert_eq!(sides(&path, "a.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn stage_paths_sees_index_changed_through_another_handle() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "ext.txt", "e\n");
    common::write_file(&path, "README.md", "# changed\n");
    let s = session(&path);
    s.status().expect("status");
    common::stage(&path, "ext.txt");
    s.stage_paths(&paths(&["README.md"])).expect("stage");
    assert_eq!(sides(&path, "ext.txt"), (Some(ChangeKind::Added), None));
}

#[test]
fn unstage_paths_sees_index_changed_through_another_handle() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "ext.txt", "e\n");
    common::write_file(&path, "README.md", "# changed\n");
    common::stage(&path, "README.md");
    let s = session(&path);
    s.status().expect("status");
    common::stage(&path, "ext.txt");
    s.unstage_paths(&paths(&["README.md"])).expect("unstage");
    assert_eq!(sides(&path, "ext.txt"), (Some(ChangeKind::Added), None));
}

// --- unstage: edge rulings ---

#[test]
fn unstage_paths_unknown_path_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .unstage_paths(&paths(&["nope.txt"]))
        .expect_err("unknown path");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn unstage_paths_head_directory_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "sub/c.txt", "c\n");
    common::commit_all(&path, "add sub");
    let err = session(&path)
        .unstage_paths(&paths(&["sub"]))
        .expect_err("directory");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn unstage_paths_rejects_paths_outside_repo() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .unstage_paths(&paths(&["../x"]))
        .expect_err("outside repo");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn unstage_paths_empty_list_changes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    session(&path).unstage_paths(&[]).expect("unstage");
    assert_eq!(sides(&path, "a.txt"), (Some(ChangeKind::Added), None));
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_treats_glob_characters_literally() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "*.txt", "star\n");
    common::write_file(&path, "b.txt", "b\n");
    common::commit_all(&path, "add txt");
    common::write_file(&path, "*.txt", "star2\n");
    common::write_file(&path, "b.txt", "b2\n");
    common::stage(&path, "*.txt");
    common::stage(&path, "b.txt");
    session(&path)
        .unstage_paths(&paths(&["*.txt"]))
        .expect("unstage");
    assert_eq!(sides(&path, "b.txt"), (Some(ChangeKind::Modified), None));
}

#[test]
fn unstage_paths_unborn_unknown_path_is_path_not_found() {
    let (_dir, path) = common::temp_repo_unborn();
    let err = session(&path)
        .unstage_paths(&paths(&["nope.txt"]))
        .expect_err("unknown path");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

// --- discard_paths: edge rulings ---

#[test]
fn discard_paths_rejects_parent_dir_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&["../x"]))
        .expect_err("outside repo");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn discard_paths_rejects_dot_git() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&[".git"]))
        .expect_err("dot git");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn discard_paths_rejects_path_inside_dot_git() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&[".git/config"]))
        .expect_err("inside dot git");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn discard_paths_rejects_absolute_path_and_deletes_nothing() {
    let (dir, path) = common::temp_repo_with_commit();
    let outside = tempfile::tempdir().expect("outside dir");
    let victim = outside.path().join("victim.txt");
    std::fs::write(&victim, "keep\n").unwrap();
    let err = session(&path)
        .discard_paths(&paths(&[victim.to_str().unwrap()]))
        .expect_err("absolute");
    assert!(
        matches!(err, GitError::PathNotFound(_)) && victim.exists(),
        "got {err:?}"
    );
    drop(dir);
}

#[test]
fn discard_paths_keeps_repository_intact_after_dot_git_rejection() {
    let (_dir, path) = common::temp_repo_with_commit();
    let _ = session(&path).discard_paths(&paths(&[".git"]));
    assert!(path.join(".git").exists() && RepoSession::open(&path).is_ok());
}

#[test]
fn discard_paths_fails_fast_on_unknown_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    let err = session(&path)
        .discard_paths(&paths(&["README.md", "nope"]))
        .expect_err("unknown path");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[test]
fn discard_paths_fail_fast_leaves_earlier_paths_modified() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    let _ = session(&path).discard_paths(&paths(&["README.md", "nope"]));
    assert_eq!(
        sides(&path, "README.md"),
        (None, Some(ChangeKind::Modified))
    );
}

#[test]
fn discard_paths_conflicted_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_conflict();
    common::write_file(&path, "README.md", "edited\n");
    let err = session(&path)
        .discard_paths(&paths(&["README.md"]))
        .expect_err("conflicted");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn discard_paths_conflicted_leaves_worktree_untouched() {
    let (_dir, path) = common::temp_repo_with_conflict();
    common::write_file(&path, "README.md", "edited\n");
    let _ = session(&path).discard_paths(&paths(&["README.md"]));
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "edited\n"
    );
}

#[test]
fn discard_paths_directory_with_tracked_files_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "sub/c.txt", "c\n");
    common::commit_all(&path, "add sub");
    common::write_file(&path, "sub/c.txt", "changed\n");
    let err = session(&path)
        .discard_paths(&paths(&["sub"]))
        .expect_err("tracked dir");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn discard_paths_removes_untracked_dir_with_trailing_slash() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "tmp/a.txt", "a\n");
    common::write_file(&path, "tmp/deep/b.txt", "b\n");
    session(&path)
        .discard_paths(&paths(&["tmp/"]))
        .expect("discard");
    assert!(!path.join("tmp").exists());
}

#[test]
fn discard_paths_restores_staged_added_file_to_index_content() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "staged\n");
    common::stage(&path, "new.txt");
    common::write_file(&path, "new.txt", "later\n");
    session(&path)
        .discard_paths(&paths(&["new.txt"]))
        .expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("new.txt")).unwrap(),
        "staged\n"
    );
}

#[test]
fn discard_paths_empty_list_leaves_unstaged_changes() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    session(&path).discard_paths(&[]).expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# scribble\n"
    );
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn discard_paths_treats_glob_characters_literally() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "*.txt", "star\n");
    common::write_file(&path, "b.txt", "b\n");
    common::commit_all(&path, "add txt");
    common::write_file(&path, "*.txt", "star2\n");
    common::write_file(&path, "b.txt", "b2\n");
    session(&path)
        .discard_paths(&paths(&["*.txt"]))
        .expect("discard");
    assert_eq!(sides(&path, "b.txt"), (None, Some(ChangeKind::Modified)));
}

#[test]
fn discard_paths_sees_index_changed_through_another_handle() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    let s = session(&path);
    s.status().expect("status");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# later\n");
    s.discard_paths(&paths(&["README.md"])).expect("discard");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# staged\n"
    );
}

// --- stage_all / unstage_all: stale index guard ---

#[test]
fn stage_all_sees_index_changed_through_another_handle() {
    let (_dir, path) = common::temp_repo_with_commit();
    let s = session(&path);
    s.status().expect("status");
    common::write_file(&path, "ext.txt", "e\n");
    common::stage(&path, "ext.txt");
    common::write_file(&path, "other.txt", "o\n");
    s.stage_all().expect("stage all");
    assert_eq!(sides(&path, "ext.txt"), (Some(ChangeKind::Added), None));
}

#[test]
fn unstage_all_sees_index_changed_through_another_handle() {
    let (_dir, path) = common::temp_repo_with_commit();
    let s = session(&path);
    s.status().expect("status");
    common::write_file(&path, "ext.txt", "e\n");
    common::stage(&path, "ext.txt");
    s.unstage_all().expect("unstage all");
    assert_eq!(sides(&path, "ext.txt"), (None, Some(ChangeKind::Untracked)));
}

// --- coverage audit: path guard edge cases (repo_relative is private, so tested through the API) ---

/// Spellings `repo_relative` must reject even though the file they hint at exists.
const MALFORMED_PATHS: [&str; 9] = [
    "a//b",
    "./a",
    "a/./b",
    "a/../b",
    ".GIT",
    ".Git/config",
    ".git/",
    "",
    "/",
];

fn repo_with_lookalike_files() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a/b", "b\n");
    common::write_file(&path, "b", "b\n");
    (dir, path)
}

#[test]
fn stage_paths_rejects_malformed_paths_and_stages_nothing() {
    let (_dir, path) = repo_with_lookalike_files();
    for bad in MALFORMED_PATHS {
        let err = session(&path).stage_paths(&paths(&[bad])).expect_err(bad);
        assert!(matches!(err, GitError::PathNotFound(_)), "{bad:?}: {err:?}");
    }
    assert_eq!(sides(&path, "a/b"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn unstage_paths_rejects_malformed_paths() {
    let (_dir, path) = repo_with_lookalike_files();
    for bad in MALFORMED_PATHS {
        let err = session(&path).unstage_paths(&paths(&[bad])).expect_err(bad);
        assert!(matches!(err, GitError::PathNotFound(_)), "{bad:?}: {err:?}");
    }
}

#[test]
fn discard_paths_rejects_malformed_paths_and_deletes_nothing() {
    let (_dir, path) = repo_with_lookalike_files();
    for bad in MALFORMED_PATHS {
        let err = session(&path).discard_paths(&paths(&[bad])).expect_err(bad);
        assert!(matches!(err, GitError::PathNotFound(_)), "{bad:?}: {err:?}");
    }
    assert!(path.join("a/b").exists() && path.join("b").exists());
    assert!(path.join(".git").exists());
}

#[test]
fn path_guard_error_carries_the_raw_input() {
    let (_dir, path) = repo_with_lookalike_files();
    let err = session(&path)
        .stage_paths(&paths(&["./a"]))
        .expect_err("dot component");
    assert!(
        matches!(&err, GitError::PathNotFound(p) if p == std::path::Path::new("./a")),
        "got {err:?}"
    );
}

#[test]
fn stage_paths_allows_dot_git_lookalike_names() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "target\n");
    common::write_file(&path, ".github/ci.yml", "on: push\n");
    session(&path)
        .stage_paths(&paths(&[".gitignore", ".github/ci.yml"]))
        .expect("lookalikes are not .git");
    assert_eq!(
        (sides(&path, ".gitignore"), sides(&path, ".github/ci.yml")),
        (
            (Some(ChangeKind::Added), None),
            (Some(ChangeKind::Added), None)
        )
    );
}

#[test]
fn discard_paths_allows_dot_git_lookalike_names() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "target\n");
    session(&path)
        .discard_paths(&paths(&[".gitignore"]))
        .expect("untracked .gitignore is discardable");
    assert!(!path.join(".gitignore").exists());
}

#[test]
fn stage_paths_strips_repeated_trailing_slashes() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    session(&path)
        .stage_paths(&paths(&["a.txt///"]))
        .expect("stage");
    assert_eq!(sides(&path, "a.txt"), (Some(ChangeKind::Added), None));
}

// --- coverage audit: symlinks ---

#[cfg(unix)]
#[test]
fn discard_paths_untracked_symlink_to_outside_dir_removes_only_the_link() {
    let (_dir, path) = common::temp_repo_with_commit();
    let outside = tempfile::tempdir().expect("outside dir");
    std::fs::write(outside.path().join("precious.txt"), "keep\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), path.join("link")).unwrap();
    session(&path)
        .discard_paths(&paths(&["link"]))
        .expect("discard link");
    assert!(path.join("link").symlink_metadata().is_err());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("precious.txt")).unwrap(),
        "keep\n"
    );
}

#[cfg(unix)]
#[test]
fn discard_paths_dangling_untracked_symlink_is_removed() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("nowhere", path.join("dangling")).unwrap();
    session(&path)
        .discard_paths(&paths(&["dangling"]))
        .expect("discard dangling");
    assert!(path.join("dangling").symlink_metadata().is_err());
}

#[cfg(unix)]
#[test]
fn stage_paths_stages_dangling_symlink() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("nowhere", path.join("dangling")).unwrap();
    session(&path)
        .stage_paths(&paths(&["dangling"]))
        .expect("stage dangling");
    assert_eq!(sides(&path, "dangling"), (Some(ChangeKind::Added), None));
}

// --- coverage audit: conflicts ---

#[test]
fn stage_paths_resolves_conflict_to_a_modified_index_entry() {
    let (_dir, path) = common::temp_repo_with_conflict();
    common::write_file(&path, "README.md", "# resolved\n");
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage");
    let e = entry(&path, "README.md");
    assert_eq!((e.conflicted, e.index), (false, Some(ChangeKind::Modified)));
}

#[test]
fn stage_paths_resolves_conflict_by_deletion() {
    let (_dir, path) = common::temp_repo_with_conflict();
    std::fs::remove_file(path.join("README.md")).unwrap();
    session(&path)
        .stage_paths(&paths(&["README.md"]))
        .expect("stage deletion");
    let e = entry(&path, "README.md");
    assert_eq!((e.conflicted, e.index), (false, Some(ChangeKind::Deleted)));
}

#[test]
fn unstage_paths_on_conflicted_path_resets_it_to_head() {
    let (_dir, path) = common::temp_repo_with_conflict();
    session(&path)
        .unstage_paths(&paths(&["README.md"]))
        .expect("unstage conflicted");
    assert!(
        !status_of(&path)
            .entries
            .iter()
            .any(|e| e.path == "README.md" && e.conflicted)
    );
}

// --- coverage audit: renames ---

fn repo_with_staged_rename() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("MOVED.md")).unwrap();
    common::stage(&path, "README.md");
    common::stage(&path, "MOVED.md");
    (dir, path)
}

#[test]
fn unstage_paths_of_both_sides_of_a_staged_rename_undoes_it() {
    let (_dir, path) = repo_with_staged_rename();
    let staged = entry(&path, "MOVED.md");
    assert_eq!(
        (staged.index, staged.old_path.as_deref()),
        (Some(ChangeKind::Renamed), Some("README.md"))
    );
    session(&path)
        .unstage_paths(&paths(&["README.md", "MOVED.md"]))
        .expect("unstage rename");
    // Nothing is staged any more; the move is now an unstaged rename.
    let status = status_of(&path);
    assert!(
        status.entries.iter().all(|e| e.index.is_none()),
        "{status:?}"
    );
    let moved = entry(&path, "MOVED.md");
    assert_eq!(
        (moved.worktree, moved.old_path.as_deref()),
        (Some(ChangeKind::Renamed), Some("README.md"))
    );
}

#[test]
fn unstage_paths_of_only_the_new_side_leaves_the_deletion_staged() {
    let (_dir, path) = repo_with_staged_rename();
    session(&path)
        .unstage_paths(&paths(&["MOVED.md"]))
        .expect("unstage new side");
    assert_eq!(
        (sides(&path, "README.md"), sides(&path, "MOVED.md")),
        (
            (Some(ChangeKind::Deleted), None),
            (None, Some(ChangeKind::Untracked))
        )
    );
}

// --- coverage audit: stage_all / unstage_all ---

#[test]
fn stage_all_stages_nested_untracked_directory_and_deletion_together() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "deep/er/leaf.txt", "leaf\n");
    common::write_file(&path, "deep/top.txt", "top\n");
    std::fs::remove_file(path.join("README.md")).unwrap();
    session(&path).stage_all().expect("stage all");
    assert_eq!(
        (
            sides(&path, "deep/er/leaf.txt"),
            sides(&path, "deep/top.txt"),
            sides(&path, "README.md")
        ),
        (
            (Some(ChangeKind::Added), None),
            (Some(ChangeKind::Added), None),
            (Some(ChangeKind::Deleted), None)
        )
    );
}

#[test]
fn stage_all_skips_ignored_files() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "*.log\n");
    common::write_file(&path, "debug.log", "noise\n");
    session(&path).stage_all().expect("stage all");
    let listed: Vec<_> = status_of(&path)
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert!(!listed.contains(&"debug.log".to_string()), "{listed:?}");
}

#[test]
fn unstage_all_unborn_with_nested_staged_files_leaves_them_untracked() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "d/a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    session(&path).stage_all().expect("stage all");
    session(&path).unstage_all().expect("unstage all");
    assert_eq!(
        (sides(&path, "d/a.txt"), sides(&path, "b.txt")),
        (
            (None, Some(ChangeKind::Untracked)),
            (None, Some(ChangeKind::Untracked))
        )
    );
}

// --- RED: a failed call must not leave dirty state in the session's cached index ---

#[test]
fn stage_paths_failed_call_leaves_same_session_status_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    let s = session(&path);
    let _ = s.stage_paths(&paths(&["a.txt", "nope.txt"]));
    let status = s.status().expect("status");
    let e = status.entries.iter().find(|e| e.path == "a.txt").unwrap();
    assert_eq!((e.index, e.worktree), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn stage_paths_failed_call_does_not_leak_into_next_successful_write() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b.txt", "b\n");
    let s = session(&path);
    let _ = s.stage_paths(&paths(&["a.txt", "nope.txt"]));
    s.stage_paths(&paths(&["b.txt"])).expect("stage b");
    assert_eq!(sides(&path, "a.txt"), (None, Some(ChangeKind::Untracked)));
}

#[test]
fn unstage_paths_failed_call_leaves_same_session_status_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    let s = session(&path);
    let _ = s.unstage_paths(&paths(&["a.txt", "nope.txt"]));
    let status = s.status().expect("status");
    let e = status.entries.iter().find(|e| e.path == "a.txt").unwrap();
    assert_eq!((e.index, e.worktree), (Some(ChangeKind::Added), None));
}

#[test]
fn discard_paths_failed_call_leaves_same_session_status_unchanged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# scribble\n");
    let s = session(&path);
    let _ = s.discard_paths(&paths(&["README.md", "nope.txt"]));
    let status = s.status().expect("status");
    let e = status
        .entries
        .iter()
        .find(|e| e.path == "README.md")
        .unwrap();
    assert_eq!((e.index, e.worktree), (None, Some(ChangeKind::Modified)));
}

// --- RED: a symlinked ancestor must never be followed out of the repository ---

#[cfg(unix)]
fn outside_dir_with_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let outside = tempfile::tempdir().expect("outside dir");
    let file = outside.path().join("f");
    std::fs::write(&file, "keep\n").unwrap();
    (outside, file)
}

#[cfg(unix)]
#[test]
fn discard_paths_through_symlinked_ancestor_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    let (outside, _file) = outside_dir_with_file();
    std::os::unix::fs::symlink(outside.path(), path.join("link")).unwrap();
    let err = session(&path)
        .discard_paths(&paths(&["link/f"]))
        .expect_err("symlink ancestor");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[cfg(unix)]
#[test]
fn discard_paths_through_symlinked_ancestor_keeps_outside_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    let (outside, file) = outside_dir_with_file();
    std::os::unix::fs::symlink(outside.path(), path.join("link")).unwrap();
    let _ = session(&path).discard_paths(&paths(&["link/f"]));
    assert!(file.exists());
}

#[cfg(unix)]
#[test]
fn stage_paths_through_symlinked_ancestor_is_rejected() {
    let (_dir, path) = common::temp_repo_with_commit();
    let (outside, _file) = outside_dir_with_file();
    std::os::unix::fs::symlink(outside.path(), path.join("link")).unwrap();
    let err = session(&path)
        .stage_paths(&paths(&["link/f"]))
        .expect_err("symlink ancestor");
    assert!(
        matches!(err, GitError::PathNotFound(_) | GitError::Git2(_)),
        "got {err:?}"
    );
}

#[cfg(unix)]
#[test]
fn stage_paths_through_symlinked_ancestor_stages_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    let (outside, _file) = outside_dir_with_file();
    std::os::unix::fs::symlink(outside.path(), path.join("link")).unwrap();
    let _ = session(&path).stage_paths(&paths(&["link/f"]));
    assert!(!status_of(&path).entries.iter().any(|e| e.path == "link/f"));
}

// --- path separators and special characters ---

#[cfg(windows)]
#[test]
fn discard_paths_rejects_backslash_parent_path_on_windows() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&["..\\x"]))
        .expect_err("outside repo");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[cfg(windows)]
#[test]
fn discard_paths_rejects_drive_relative_path_on_windows() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .discard_paths(&paths(&["C:x"]))
        .expect_err("drive relative");
    assert!(matches!(err, GitError::PathNotFound(_)), "got {err:?}");
}

#[cfg(unix)]
#[test]
fn stage_paths_stages_file_named_with_backslash_on_unix() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "back\\slash.txt", "b\n");
    session(&path)
        .stage_paths(&paths(&["back\\slash.txt"]))
        .expect("stage");
    assert_eq!(
        sides(&path, "back\\slash.txt"),
        (Some(ChangeKind::Added), None)
    );
}

#[cfg(unix)]
#[test]
fn discard_paths_tracked_file_named_with_backslash_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "back\\slash.txt", "b\n");
    common::commit_all(&path, "add backslash file");
    common::write_file(&path, "back\\slash.txt", "changed\n");
    let err = session(&path)
        .discard_paths(&paths(&["back\\slash.txt"]))
        .expect_err("backslash");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[cfg(unix)]
#[test]
fn discard_paths_backslash_rejection_leaves_file_modified() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "back\\slash.txt", "b\n");
    common::commit_all(&path, "add backslash file");
    common::write_file(&path, "back\\slash.txt", "changed\n");
    let _ = session(&path).discard_paths(&paths(&["back\\slash.txt"]));
    assert_eq!(
        std::fs::read_to_string(path.join("back\\slash.txt")).unwrap(),
        "changed\n"
    );
}

#[cfg(unix)]
#[test]
fn unstage_paths_unstages_file_named_with_backslash_on_unix() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "back\\slash.txt", "b\n");
    common::stage(&path, "back\\slash.txt");
    session(&path)
        .unstage_paths(&paths(&["back\\slash.txt"]))
        .expect("unstage");
    assert_eq!(
        sides(&path, "back\\slash.txt"),
        (None, Some(ChangeKind::Untracked))
    );
}

// GR-34: libgit2 on Windows does not honour the backslash pathspec escape, so unstaging a !/# name is a silent no-op.
#[cfg(unix)]
#[test]
fn unstage_paths_unstages_file_with_leading_bang() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "!foo", "f\n");
    common::stage(&path, "!foo");
    session(&path)
        .unstage_paths(&paths(&["!foo"]))
        .expect("unstage");
    assert_eq!(sides(&path, "!foo"), (None, Some(ChangeKind::Untracked)));
}

// --- unstage_all: staged deletion and modification together ---

#[test]
fn unstage_all_restores_staged_deletion_and_modification_to_worktree_only() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "keep.txt", "k\n");
    common::commit_all(&path, "add keep");
    std::fs::remove_file(path.join("README.md")).unwrap();
    common::write_file(&path, "keep.txt", "changed\n");
    common::stage(&path, "README.md");
    common::stage(&path, "keep.txt");
    session(&path).unstage_all().expect("unstage all");
    assert_eq!(
        (sides(&path, "README.md"), sides(&path, "keep.txt")),
        (
            (None, Some(ChangeKind::Deleted)),
            (None, Some(ChangeKind::Modified))
        )
    );
}

// --- filenames ending in spaces must be matched exactly ---

/// Commits `pad `, `two  ` and a sibling `pad`, then modifies all three.
#[cfg(unix)] // only the trailing-space tests use it, and they are unix-only
fn repo_with_trailing_space_files() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "pad ", "1\n");
    common::write_file(&path, "two  ", "2\n");
    common::write_file(&path, "pad", "3\n");
    common::commit_all(&path, "add padded files");
    common::write_file(&path, "pad ", "1x\n");
    common::write_file(&path, "two  ", "2x\n");
    common::write_file(&path, "pad", "3x\n");
    (dir, path)
}

fn read(path: &std::path::Path, rel: &str) -> String {
    std::fs::read_to_string(path.join(rel)).unwrap()
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn discard_paths_restores_file_with_one_trailing_space() {
    let (_dir, path) = repo_with_trailing_space_files();
    session(&path)
        .discard_paths(&paths(&["pad "]))
        .expect("discard");
    assert_eq!(read(&path, "pad "), "1\n");
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn discard_paths_restores_file_with_two_trailing_spaces() {
    let (_dir, path) = repo_with_trailing_space_files();
    session(&path)
        .discard_paths(&paths(&["two  "]))
        .expect("discard");
    assert_eq!(read(&path, "two  "), "2\n");
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn discard_paths_trailing_space_leaves_unspaced_sibling_modified() {
    let (_dir, path) = repo_with_trailing_space_files();
    session(&path)
        .discard_paths(&paths(&["pad "]))
        .expect("discard");
    assert_eq!(read(&path, "pad"), "3x\n");
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn unstage_paths_unstages_file_with_one_trailing_space() {
    let (_dir, path) = repo_with_trailing_space_files();
    common::stage(&path, "pad ");
    session(&path)
        .unstage_paths(&paths(&["pad "]))
        .expect("unstage");
    assert_eq!(sides(&path, "pad "), (None, Some(ChangeKind::Modified)));
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn unstage_paths_unstages_file_with_two_trailing_spaces() {
    let (_dir, path) = repo_with_trailing_space_files();
    common::stage(&path, "two  ");
    session(&path)
        .unstage_paths(&paths(&["two  "]))
        .expect("unstage");
    assert_eq!(sides(&path, "two  "), (None, Some(ChangeKind::Modified)));
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn unstage_paths_trailing_space_leaves_unspaced_sibling_staged() {
    let (_dir, path) = repo_with_trailing_space_files();
    common::stage(&path, "pad ");
    common::stage(&path, "pad");
    session(&path)
        .unstage_paths(&paths(&["pad "]))
        .expect("unstage");
    assert_eq!(sides(&path, "pad"), (Some(ChangeKind::Modified), None));
}

// Windows strips trailing spaces from file names, so this fixture cannot exist.
#[cfg(unix)]
#[test]
fn stage_paths_trailing_space_stages_only_that_file() {
    let (_dir, path) = repo_with_trailing_space_files();
    session(&path)
        .stage_paths(&paths(&["pad "]))
        .expect("stage");
    assert_eq!(
        (sides(&path, "pad "), sides(&path, "pad")),
        (
            (Some(ChangeKind::Modified), None),
            (None, Some(ChangeKind::Modified))
        )
    );
}

// --- names that look like pathspec syntax must be matched literally ---

fn repo_with_hash_files() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "#notes.txt", "n\n");
    common::write_file(&path, "other.txt", "o\n");
    common::commit_all(&path, "add hash file");
    common::write_file(&path, "#notes.txt", "n2\n");
    common::write_file(&path, "other.txt", "o2\n");
    (dir, path)
}

#[test]
fn discard_paths_hash_prefixed_name_restores_that_file() {
    let (_dir, path) = repo_with_hash_files();
    session(&path)
        .discard_paths(&paths(&["#notes.txt"]))
        .expect("discard");
    assert_eq!(read(&path, "#notes.txt"), "n\n");
}

#[test]
fn discard_paths_hash_prefixed_name_leaves_other_files_modified() {
    let (_dir, path) = repo_with_hash_files();
    session(&path)
        .discard_paths(&paths(&["#notes.txt"]))
        .expect("discard");
    assert_eq!(
        sides(&path, "other.txt"),
        (None, Some(ChangeKind::Modified))
    );
}

// GR-34: libgit2 on Windows does not honour the backslash pathspec escape, so unstaging a !/# name is a silent no-op.
#[cfg(unix)]
#[test]
fn unstage_paths_hash_prefixed_name_unstages_only_that_file() {
    let (_dir, path) = repo_with_hash_files();
    common::stage(&path, "#notes.txt");
    common::stage(&path, "other.txt");
    session(&path)
        .unstage_paths(&paths(&["#notes.txt"]))
        .expect("unstage");
    assert_eq!(
        (sides(&path, "#notes.txt"), sides(&path, "other.txt")),
        (
            (None, Some(ChangeKind::Modified)),
            (Some(ChangeKind::Modified), None)
        )
    );
}

#[test]
fn stage_paths_hash_prefixed_name_stages_only_that_file() {
    let (_dir, path) = repo_with_hash_files();
    session(&path)
        .stage_paths(&paths(&["#notes.txt"]))
        .expect("stage");
    assert_eq!(
        sides(&path, "other.txt"),
        (None, Some(ChangeKind::Modified))
    );
}

// --- unstage_paths: control whitespace truncates libgit2 pathspecs ---

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_newline_leading_name_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "\nx", "x\n");
    common::write_file(&path, "other.txt", "o\n");
    common::stage(&path, "\nx");
    common::stage(&path, "other.txt");
    let err = session(&path)
        .unstage_paths(&paths(&["\nx"]))
        .expect_err("newline name");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_newline_name_leaves_other_staged_files_staged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "\nx", "x\n");
    common::write_file(&path, "other.txt", "o\n");
    common::stage(&path, "\nx");
    common::stage(&path, "other.txt");
    let _ = session(&path).unstage_paths(&paths(&["\nx"]));
    assert_eq!(sides(&path, "other.txt"), (Some(ChangeKind::Added), None));
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_tab_name_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a\tb", "t\n");
    common::stage(&path, "a\tb");
    let err = session(&path)
        .unstage_paths(&paths(&["a\tb"]))
        .expect_err("tab name");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_tab_name_leaves_staged_sibling_untouched() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a\tb", "t\n");
    common::write_file(&path, "a/c.txt", "c\n");
    common::stage(&path, "a\tb");
    common::stage(&path, "a/c.txt");
    let _ = session(&path).unstage_paths(&paths(&["a\tb"]));
    assert_eq!(sides(&path, "a/c.txt"), (Some(ChangeKind::Added), None));
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_carriage_return_name_is_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a\rb", "r\n");
    common::stage(&path, "a\rb");
    let err = session(&path)
        .unstage_paths(&paths(&["a\rb"]))
        .expect_err("cr name");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn unstage_paths_vertical_tab_and_form_feed_names_are_bad_selection() {
    let (_dir, path) = common::temp_repo_with_commit();
    for name in ["a\x0bb", "a\x0cb"] {
        common::write_file(&path, name, "v\n");
        common::stage(&path, name);
        let err = session(&path)
            .unstage_paths(&paths(&[name]))
            .expect_err("control name");
        assert!(matches!(err, GitError::BadSelection), "{name:?}: {err:?}");
    }
}

// Windows cannot create this file name (control or glob character).
#[cfg(unix)]
#[test]
fn discard_paths_deletes_only_untracked_file_with_leading_newline() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "\nx", "x\n");
    common::write_file(&path, "other.txt", "o\n");
    session(&path)
        .discard_paths(&paths(&["\nx"]))
        .expect("discard");
    assert!(!path.join("\nx").exists() && path.join("other.txt").exists());
}

// --- discard_paths: refuses untracked directories holding a nested repository (C1) ---

/// Initialises a nested repository at `rel` under `root` with one commit of
/// `inner.txt`, and returns that commit's id.
fn nested_repo_with_commit(root: &std::path::Path, rel: &str) -> git2::Oid {
    let nested = root.join(rel);
    std::fs::create_dir_all(&nested).expect("create nested dir");
    let repo = common::init_repo(&nested);
    std::fs::write(nested.join("inner.txt"), "inner\n").expect("write inner");
    let mut index = repo.index().expect("nested index");
    index
        .add_path(std::path::Path::new("inner.txt"))
        .expect("stage inner");
    index.write().expect("write nested index");
    let tree_id = index.write_tree().expect("write nested tree");
    let tree = repo.find_tree(tree_id).expect("find nested tree");
    let sig = git2::Signature::now("Test User", "test@example.com").expect("signature");
    repo.commit(Some("HEAD"), &sig, &sig, "nested commit", &tree, &[])
        .expect("nested commit")
}

fn nested_head(root: &std::path::Path, rel: &str) -> Option<git2::Oid> {
    let repo = git2::Repository::open(root.join(rel)).ok()?;
    let head = repo.head().ok()?;
    head.target()
}

#[test]
fn discard_paths_nested_repo_fixture_is_reported_as_untracked_dir() {
    let (_dir, path) = common::temp_repo_with_commit();
    nested_repo_with_commit(&path, "vendor/lib");
    assert_eq!(
        status_of(&path).entries,
        vec![StatusEntry {
            path: "vendor/lib/".into(),
            old_path: None,
            index: None,
            worktree: Some(ChangeKind::Untracked),
            conflicted: false,
        }]
    );
}

#[test]
fn discard_paths_refuses_untracked_dir_containing_nested_repo() {
    let (_dir, path) = common::temp_repo_with_commit();
    nested_repo_with_commit(&path, "vendor/lib");
    let err = session(&path)
        .discard_paths(&paths(&["vendor/lib/"]))
        .expect_err("nested repo must not be discarded");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn discard_paths_nested_repo_refusal_keeps_its_dot_git() {
    let (_dir, path) = common::temp_repo_with_commit();
    nested_repo_with_commit(&path, "vendor/lib");
    let _ = session(&path).discard_paths(&paths(&["vendor/lib/"]));
    assert!(path.join("vendor/lib/.git").exists());
}

#[test]
fn discard_paths_nested_repo_refusal_keeps_its_commit() {
    let (_dir, path) = common::temp_repo_with_commit();
    let oid = nested_repo_with_commit(&path, "vendor/lib");
    let _ = session(&path).discard_paths(&paths(&["vendor/lib/"]));
    assert_eq!(nested_head(&path, "vendor/lib"), Some(oid));
}

#[test]
fn discard_paths_refuses_nested_repo_at_depth() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "scratch/notes.txt", "n\n");
    nested_repo_with_commit(&path, "scratch/a/b");
    let err = session(&path)
        .discard_paths(&paths(&["scratch/"]))
        .expect_err("dir holding a nested repo must not be discarded");
    assert!(matches!(err, GitError::BadSelection), "got {err:?}");
}

#[test]
fn discard_paths_nested_repo_at_depth_refusal_deletes_nothing() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "scratch/notes.txt", "n\n");
    let oid = nested_repo_with_commit(&path, "scratch/a/b");
    let _ = session(&path).discard_paths(&paths(&["scratch/"]));
    assert!(
        path.join("scratch/notes.txt").exists() && nested_head(&path, "scratch/a/b") == Some(oid)
    );
}

#[test]
fn discard_paths_nested_repo_refusal_happens_before_other_deletions() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "junk.txt", "j\n");
    nested_repo_with_commit(&path, "vendor/lib");
    let _ = session(&path).discard_paths(&paths(&["junk.txt", "vendor/lib/"]));
    assert!(path.join("junk.txt").exists());
}
