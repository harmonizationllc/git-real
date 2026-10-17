mod common;

use git_real_core::{ChangeKind, GitError, RepoSession, StatusEntry, WorkingTreeStatus};

fn status_of(path: &std::path::Path) -> WorkingTreeStatus {
    RepoSession::open(path)
        .expect("open")
        .status()
        .expect("status")
}

fn entry<'a>(status: &'a WorkingTreeStatus, path: &str) -> &'a StatusEntry {
    status
        .entries
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no entry for {path}: {:?}", status.entries))
}

// --- clean and unborn repositories ---

#[test]
fn status_clean_repo_is_empty() {
    let (_dir, path) = common::temp_repo_with_commit();
    assert!(status_of(&path).entries.is_empty());
}

#[test]
fn status_clean_repo_head_is_born() {
    let (_dir, path) = common::temp_repo_with_commit();
    assert!(!status_of(&path).head_unborn);
}

#[test]
fn status_head_unborn() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    assert!(status_of(&path).head_unborn);
}

// --- untracked files ---

#[test]
fn status_untracked_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "hi\n");
    let status = status_of(&path);
    assert_eq!(
        status.entries,
        vec![StatusEntry {
            path: "new.txt".into(),
            old_path: None,
            index: None,
            worktree: Some(ChangeKind::Untracked),
            conflicted: false,
        }]
    );
}

#[test]
fn status_untracked_in_new_dir_is_recursed() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/a.txt", "a\n");
    let paths: Vec<_> = status_of(&path)
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, vec!["dir/a.txt".to_string()]);
}

#[test]
fn status_ignored_files_excluded() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "*.log\n");
    common::write_file(&path, "x.log", "noise\n");
    let paths: Vec<_> = status_of(&path)
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, vec![".gitignore".to_string()]);
}

// --- unstaged changes ---

#[test]
fn status_modified_unstaged() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# changed\n");
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!((e.index, e.worktree), (None, Some(ChangeKind::Modified)));
}

#[test]
fn status_unstaged_deleted() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!((e.index, e.worktree), (None, Some(ChangeKind::Deleted)));
}

// --- staged changes ---

#[test]
fn status_staged_added() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "added.txt", "x\n");
    common::stage(&path, "added.txt");
    let status = status_of(&path);
    let e = entry(&status, "added.txt");
    assert_eq!((e.index, e.worktree), (Some(ChangeKind::Added), None));
}

#[test]
fn status_staged_modified() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!((e.index, e.worktree), (Some(ChangeKind::Modified), None));
}

#[test]
fn status_staged_deleted() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    common::stage(&path, "README.md");
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!((e.index, e.worktree), (Some(ChangeKind::Deleted), None));
}

#[test]
fn status_staged_rename() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("DOC.md")).unwrap();
    common::stage(&path, "README.md");
    common::stage(&path, "DOC.md");
    let status = status_of(&path);
    assert_eq!(status.entries.len(), 1);
    let e = &status.entries[0];
    assert_eq!(
        (e.path.as_str(), e.old_path.as_deref(), e.index),
        ("DOC.md", Some("README.md"), Some(ChangeKind::Renamed))
    );
}

#[test]
fn status_non_rename_entries_have_no_old_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    let status = status_of(&path);
    assert_eq!(entry(&status, "README.md").old_path, None);
}

// --- a file changed in both index and worktree ---

#[test]
fn status_lists_file_changed_in_index_and_worktree() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# staged then edited\n");
    let status = status_of(&path);
    assert_eq!(status.entries.len(), 1);
    let e = &status.entries[0];
    assert_eq!(
        (e.index, e.worktree),
        (Some(ChangeKind::Modified), Some(ChangeKind::Modified))
    );
}

// --- conflicts ---

#[test]
fn status_conflicted() {
    let (_dir, path) = common::temp_repo_with_conflict();
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!(
        (e.conflicted, e.worktree, e.index),
        (true, Some(ChangeKind::Conflicted), None)
    );
}

#[test]
fn status_non_conflicted_entry_has_conflicted_false() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# changed\n");
    let status = status_of(&path);
    assert!(!entry(&status, "README.md").conflicted);
}

// --- ordering ---

#[test]
fn status_entries_sorted_by_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "b.txt", "b\n");
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "c/d.txt", "d\n");
    let paths: Vec<_> = status_of(&path)
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, vec!["a.txt", "b.txt", "c/d.txt"]);
}

// --- serialization contract ---

#[test]
fn status_serializes_camel_case() {
    let e = StatusEntry {
        path: "a.txt".into(),
        old_path: None,
        index: Some(ChangeKind::TypeChange),
        worktree: None,
        conflicted: false,
    };
    let value = serde_json::to_value(&e).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["conflicted", "index", "oldPath", "path", "worktree"]
    );
}

#[test]
fn status_serializes_type_change_kind_camel_case() {
    let value = serde_json::to_value(ChangeKind::TypeChange).unwrap();
    assert_eq!(value, serde_json::json!("typeChange"));
}

#[test]
fn status_serializes_head_unborn_camel_case() {
    let s = WorkingTreeStatus {
        entries: vec![],
        head_unborn: true,
    };
    let value = serde_json::to_value(&s).unwrap();
    assert_eq!(value["headUnborn"], serde_json::json!(true));
}

// --- renames combined with other changes ---

#[test]
fn status_staged_rename_then_edited() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    common::write_file(&path, "DOC.md", "# fixture\n");
    common::stage(&path, "README.md");
    common::stage(&path, "DOC.md");
    common::write_file(&path, "DOC.md", "# fixture\nmore\n");
    let status = status_of(&path);
    assert_eq!(
        status.entries,
        vec![StatusEntry {
            path: "DOC.md".into(),
            old_path: Some("README.md".into()),
            index: Some(ChangeKind::Renamed),
            worktree: Some(ChangeKind::Modified),
            conflicted: false,
        }]
    );
}

#[test]
fn status_unstaged_rename() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    common::write_file(&path, "R2.md", "# fixture\n");
    let status = status_of(&path);
    assert_eq!(
        status.entries,
        vec![StatusEntry {
            path: "R2.md".into(),
            old_path: Some("README.md".into()),
            index: None,
            worktree: Some(ChangeKind::Renamed),
            conflicted: false,
        }]
    );
}

// --- type changes ---

#[test]
#[cfg(unix)]
fn status_symlink_typechange() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    std::os::unix::fs::symlink("elsewhere", path.join("README.md")).unwrap();
    let status = status_of(&path);
    assert_eq!(
        entry(&status, "README.md").worktree,
        Some(ChangeKind::TypeChange)
    );
}

// --- unborn HEAD with staged content ---

#[test]
fn status_unborn_head_with_staged_file_reports_unborn() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    assert!(status_of(&path).head_unborn);
}

#[test]
fn status_unborn_head_with_staged_file_is_index_added() {
    let (_dir, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    let status = status_of(&path);
    assert_eq!(entry(&status, "a.txt").index, Some(ChangeKind::Added));
}

// --- bare repositories have no working tree ---

#[test]
fn status_bare_repo_errors() {
    let (_src, src_path) = common::temp_repo_with_commit();
    let (_dir, bare_path) = common::temp_bare_clone(&src_path);
    let err = RepoSession::open(&bare_path)
        .unwrap()
        .status()
        .expect_err("should fail");
    assert!(matches!(err, GitError::Git2(_)), "got {err:?}");
}

// --- index-side type change ---

#[test]
#[cfg(unix)]
fn status_staged_symlink_typechange() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "target.txt", "t\n");
    std::fs::remove_file(path.join("README.md")).unwrap();
    std::os::unix::fs::symlink("target.txt", path.join("README.md")).unwrap();
    common::stage(&path, "README.md");
    let status = status_of(&path);
    let e = entry(&status, "README.md");
    assert_eq!((e.index, e.worktree), (Some(ChangeKind::TypeChange), None));
}

// --- HEAD errors other than unborn are propagated ---

#[test]
fn status_corrupt_head_errors_instead_of_reporting_unborn() {
    let (_dir, path) = common::temp_repo_with_commit();
    std::fs::write(path.join(".git").join("HEAD"), "garbage\n").unwrap();
    let err = RepoSession::open(&path)
        .expect("open succeeds with a corrupt HEAD")
        .status()
        .expect_err("corrupt HEAD must not look like an unborn branch");
    assert!(matches!(err, GitError::Git2(_)), "got {err:?}");
}

// --- ordering: byte-wise, case-sensitive, nested ---

#[test]
fn status_entries_sorted_bytewise_with_mixed_case_and_nesting() {
    let (_dir, path) = common::temp_repo_with_commit();
    for p in ["b.txt", "B.txt", "a/b.txt", "a.txt", "a-b.txt", "A/z.txt"] {
        common::write_file(&path, p, "x\n");
    }
    let paths: Vec<_> = status_of(&path)
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(
        paths,
        vec!["A/z.txt", "B.txt", "a-b.txt", "a.txt", "a/b.txt", "b.txt"]
    );
}

// --- serialization round-trips ---

#[test]
fn change_kind_serde_names_round_trip_for_every_variant() {
    let cases = [
        (ChangeKind::Added, "added"),
        (ChangeKind::Modified, "modified"),
        (ChangeKind::Deleted, "deleted"),
        (ChangeKind::Renamed, "renamed"),
        (ChangeKind::TypeChange, "typeChange"),
        (ChangeKind::Untracked, "untracked"),
        (ChangeKind::Conflicted, "conflicted"),
    ];
    for (kind, name) in cases {
        let value = serde_json::to_value(kind).unwrap();
        assert_eq!(value, serde_json::json!(name));
        let back: ChangeKind = serde_json::from_value(value).unwrap();
        assert_eq!(back, kind);
    }
}

#[test]
fn change_kind_rejects_snake_case_name() {
    assert!(serde_json::from_str::<ChangeKind>("\"type_change\"").is_err());
}

#[test]
fn working_tree_status_deserializes_from_camel_case_json() {
    let json = r#"{
        "entries": [
            {"path":"new.md","oldPath":"old.md","index":"renamed","worktree":"typeChange","conflicted":false},
            {"path":"c.txt","oldPath":null,"index":null,"worktree":"conflicted","conflicted":true}
        ],
        "headUnborn": true
    }"#;
    let status: WorkingTreeStatus = serde_json::from_str(json).unwrap();
    assert_eq!(
        status,
        WorkingTreeStatus {
            entries: vec![
                StatusEntry {
                    path: "new.md".into(),
                    old_path: Some("old.md".into()),
                    index: Some(ChangeKind::Renamed),
                    worktree: Some(ChangeKind::TypeChange),
                    conflicted: false,
                },
                StatusEntry {
                    path: "c.txt".into(),
                    old_path: None,
                    index: None,
                    worktree: Some(ChangeKind::Conflicted),
                    conflicted: true,
                },
            ],
            head_unborn: true,
        }
    );
}

#[test]
fn working_tree_status_round_trips_through_json() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "u.txt", "u\n");
    let status = status_of(&path);
    let json = serde_json::to_string(&status).unwrap();
    let back: WorkingTreeStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(back, status);
}
