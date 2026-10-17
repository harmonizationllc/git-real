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
