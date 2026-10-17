mod common;

use std::path::Path;

use git_real_core::{DiffScope, DiffSide, GitError, RepoSession};

const BIG: u64 = 1 << 20;

fn content(path: &Path, file: &str, scope: DiffScope, side: DiffSide) -> Result<Vec<u8>, GitError> {
    content_with(path, file, scope, side, BIG)
}

fn content_with(
    path: &Path,
    file: &str,
    scope: DiffScope,
    side: DiffSide,
    max: u64,
) -> Result<Vec<u8>, GitError> {
    RepoSession::open(path)
        .expect("open")
        .file_content(file, scope, side, max)
}

fn assert_not_found(result: Result<Vec<u8>, GitError>) {
    assert!(
        matches!(result, Err(GitError::PathNotFound(_))),
        "{result:?}"
    );
}

/// Adds a gitlink (submodule) index entry at `rel`. Its commit lives in the
/// submodule's own store, so it is absent from this repo's object database.
fn add_gitlink(path: &Path, rel: &str) {
    let repo = git2::Repository::open(path).expect("open repo");
    let id = git2::Oid::from_str("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
    assert!(repo.odb().unwrap().read_header(id).is_err());
    let mut index = repo.index().unwrap();
    index
        .add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o160000,
            uid: 0,
            gid: 0,
            file_size: 0,
            id,
            flags: 0,
            flags_extended: 0,
            path: rel.as_bytes().to_vec(),
        })
        .expect("add gitlink");
    index.write().expect("write index");
}

/// README.md: HEAD = "# fixture\n", index = "# staged\n", workdir = "# work\n".
fn three_versions() -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "README.md", "# staged\n");
    common::stage(&path, "README.md");
    common::write_file(&path, "README.md", "# work\n");
    (dir, path)
}

#[test]
fn resolves_each_scope_and_side() {
    let (_d, path) = three_versions();
    let cases = [
        (DiffScope::Staged, DiffSide::Old, "# fixture\n"),
        (DiffScope::Staged, DiffSide::New, "# staged\n"),
        (DiffScope::Unstaged, DiffSide::Old, "# staged\n"),
        (DiffScope::Unstaged, DiffSide::New, "# work\n"),
    ];
    for (scope, side, want) in cases {
        assert_eq!(
            content(&path, "README.md", scope, side).unwrap(),
            want.as_bytes(),
            "{scope:?}/{side:?}"
        );
    }
}

#[test]
fn added_file_has_no_old_side() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "new.txt", "x");
    common::stage(&path, "new.txt");
    assert_not_found(content(&path, "new.txt", DiffScope::Staged, DiffSide::Old));
    assert_eq!(
        content(&path, "new.txt", DiffScope::Staged, DiffSide::New).unwrap(),
        b"x"
    );
}

#[test]
fn deleted_file_has_no_new_side() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::remove_file(path.join("README.md")).unwrap();
    assert_not_found(content(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::New,
    ));
    assert_eq!(
        content(&path, "README.md", DiffScope::Unstaged, DiffSide::Old).unwrap(),
        b"# fixture\n"
    );
}

#[test]
fn rename_old_side_is_read_by_old_path() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::rename(path.join("README.md"), path.join("RENAMED.md")).unwrap();
    common::stage(&path, "README.md");
    common::stage(&path, "RENAMED.md");
    assert_eq!(
        content(&path, "README.md", DiffScope::Staged, DiffSide::Old).unwrap(),
        b"# fixture\n"
    );
    assert_not_found(content(
        &path,
        "RENAMED.md",
        DiffScope::Staged,
        DiffSide::Old,
    ));
}

#[test]
fn unborn_head_has_no_old_staged_side() {
    let (_d, path) = common::temp_repo_unborn();
    common::write_file(&path, "a.txt", "a");
    common::stage(&path, "a.txt");
    assert_not_found(content(&path, "a.txt", DiffScope::Staged, DiffSide::Old));
}

#[cfg(unix)]
#[test]
fn symlink_returns_its_target_string() {
    let (_d, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("/etc/hostname", path.join("link")).unwrap();
    assert_eq!(
        content(&path, "link", DiffScope::Unstaged, DiffSide::New).unwrap(),
        b"/etc/hostname"
    );
}

#[test]
fn directory_and_escapes_are_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::create_dir(path.join("dir")).unwrap();
    assert_not_found(content(&path, "dir", DiffScope::Unstaged, DiffSide::New));
    assert_not_found(content(&path, "../x", DiffScope::Unstaged, DiffSide::New));
    assert_not_found(content(
        &path,
        ".git/config",
        DiffScope::Unstaged,
        DiffSide::New,
    ));
    assert_not_found(content(
        &path,
        "missing.txt",
        DiffScope::Staged,
        DiffSide::New,
    ));
}

#[test]
fn size_limit_is_inclusive() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "ten.txt", "0123456789");
    assert_eq!(
        content_with(&path, "ten.txt", DiffScope::Unstaged, DiffSide::New, 10)
            .unwrap()
            .len(),
        10
    );
    match content_with(&path, "ten.txt", DiffScope::Unstaged, DiffSide::New, 9) {
        Err(GitError::TooLarge {
            path: p,
            size,
            limit,
        }) => {
            assert_eq!((p.as_str(), size, limit), ("ten.txt", 10, 9));
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
    // Blob sides are checked by object size too.
    assert!(matches!(
        content_with(&path, "README.md", DiffScope::Staged, DiffSide::Old, 3),
        Err(GitError::TooLarge {
            size: 10,
            limit: 3,
            ..
        })
    ));
}

#[test]
fn binary_bytes_round_trip() {
    let (_d, path) = common::temp_repo_with_commit();
    let bytes = [0u8, 255, 0x89, b'P', b'N', b'G', 0, 1, 2];
    std::fs::write(path.join("blob.bin"), bytes).unwrap();
    common::stage(&path, "blob.bin");
    assert_eq!(
        content(&path, "blob.bin", DiffScope::Unstaged, DiffSide::Old).unwrap(),
        bytes
    );
    assert_eq!(
        content(&path, "blob.bin", DiffScope::Unstaged, DiffSide::New).unwrap(),
        bytes
    );
}

#[test]
fn too_large_display() {
    let e = GitError::TooLarge {
        path: "a.png".into(),
        size: 30,
        limit: 20,
    };
    assert_eq!(
        e.to_string(),
        "a.png is 30 bytes, above the 20 byte preview limit"
    );
}

#[test]
fn gitlink_in_index_is_not_found_on_both_index_sides() {
    let (_d, path) = common::temp_repo_with_commit();
    add_gitlink(&path, "sub");
    assert_not_found(content(&path, "sub", DiffScope::Unstaged, DiffSide::Old));
    assert_not_found(content(&path, "sub", DiffScope::Staged, DiffSide::New));
}

#[test]
fn gitlink_in_head_is_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    add_gitlink(&path, "sub");
    let repo = git2::Repository::open(&path).unwrap();
    let mut index = repo.index().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "add gitlink", &tree, &[&parent])
        .unwrap();
    assert_not_found(content(&path, "sub", DiffScope::Staged, DiffSide::Old));
}

#[test]
fn tree_in_head_is_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "dir/inner.txt", "x");
    common::commit_all(&path, "add dir");
    assert_not_found(content(&path, "dir", DiffScope::Staged, DiffSide::Old));
    assert_eq!(
        content(&path, "dir/inner.txt", DiffScope::Staged, DiffSide::Old).unwrap(),
        b"x"
    );
}

#[test]
fn unmerged_path_has_no_stage_zero_index_side() {
    let (_d, path) = common::temp_repo_with_conflict();
    assert_not_found(content(
        &path,
        "README.md",
        DiffScope::Unstaged,
        DiffSide::Old,
    ));
}

#[test]
fn blob_paths_are_validated_like_workdir_paths() {
    let (_d, path) = common::temp_repo_with_commit();
    for bad in ["", "/README.md", "a/../README.md", ".git/config", "a//b"] {
        assert_not_found(content(&path, bad, DiffScope::Staged, DiffSide::Old));
        assert_not_found(content(&path, bad, DiffScope::Unstaged, DiffSide::Old));
    }
}

#[test]
fn workdir_file_far_above_limit_is_too_large_without_full_read() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("big.bin"), vec![b'x'; 1000]).unwrap();
    match content_with(&path, "big.bin", DiffScope::Unstaged, DiffSide::New, 9) {
        Err(GitError::TooLarge {
            path: p,
            size,
            limit,
        }) => {
            assert_eq!((p.as_str(), limit), ("big.bin", 9));
            assert!(size > limit, "reported size {size} must exceed the limit");
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

#[test]
fn zero_limit_admits_only_empty_files() {
    let (_d, path) = common::temp_repo_with_commit();
    std::fs::write(path.join("empty.txt"), b"").unwrap();
    assert_eq!(
        content_with(&path, "empty.txt", DiffScope::Unstaged, DiffSide::New, 0).unwrap(),
        b""
    );
    std::fs::write(path.join("one.txt"), b"x").unwrap();
    assert!(matches!(
        content_with(&path, "one.txt", DiffScope::Unstaged, DiffSide::New, 0),
        Err(GitError::TooLarge { .. })
    ));
}

#[test]
fn maximum_limit_does_not_overflow() {
    let (_d, path) = common::temp_repo_with_commit();
    assert_eq!(
        content_with(
            &path,
            "README.md",
            DiffScope::Unstaged,
            DiffSide::New,
            u64::MAX
        )
        .unwrap(),
        b"# fixture\n"
    );
}

#[test]
fn blob_at_exact_limit_is_returned_and_one_below_is_too_large() {
    let (_d, path) = common::temp_repo_with_commit(); // README.md is 10 bytes in HEAD
    assert_eq!(
        content_with(&path, "README.md", DiffScope::Staged, DiffSide::Old, 10)
            .unwrap()
            .len(),
        10
    );
    assert!(matches!(
        content_with(&path, "README.md", DiffScope::Staged, DiffSide::Old, 9),
        Err(GitError::TooLarge {
            size: 10,
            limit: 9,
            ..
        })
    ));
}

#[cfg(unix)]
#[test]
fn dangling_symlink_returns_its_target_string() {
    let (_d, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("nowhere/at/all", path.join("dangling")).unwrap();
    assert_eq!(
        content(&path, "dangling", DiffScope::Unstaged, DiffSide::New).unwrap(),
        b"nowhere/at/all"
    );
}

#[cfg(unix)]
#[test]
fn unreadable_workdir_file_is_an_io_error_not_not_found() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, path) = common::temp_repo_with_commit();
    let file = path.join("secret.txt");
    std::fs::write(&file, "s").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&file).is_ok() {
        return; // running as root: permissions are not enforced
    }
    let result = content(&path, "secret.txt", DiffScope::Unstaged, DiffSide::New);
    assert!(matches!(result, Err(GitError::Io(_))), "{result:?}");
}

#[test]
fn too_large_workdir_file_reports_its_real_length() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "ten.txt", "0123456789");
    match content_with(&path, "ten.txt", DiffScope::Unstaged, DiffSide::New, 3) {
        Err(GitError::TooLarge {
            path: p,
            size,
            limit,
        }) => assert_eq!((p.as_str(), size, limit), ("ten.txt", 10, 3)),
        other => panic!("expected TooLarge with the real size, got {other:?}"),
    }
}
