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
