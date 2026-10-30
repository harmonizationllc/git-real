//! Commit detail, file history and blame (GR-9): `commit_files`, `file_history`,
//! `blame` and `tracked_files`. Git2 fixtures only; no git CLI is needed.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::history::BLAME_MAX_BYTES;
use git_real_core::{
    Blame, BlameHunk, ChangeKind, CommitFile, FileHistoryEntry, GitError, RepoSession,
    Signature as CoreSignature,
};
use git2::{Oid, Repository, Signature};

const ABSENT_OID: &str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

fn open(path: &Path) -> RepoSession {
    RepoSession::open(path).expect("open session")
}

fn head_oid(path: &Path) -> Oid {
    Repository::open(path)
        .expect("open repo")
        .head()
        .expect("head")
        .target()
        .expect("direct head")
}

fn at(name: &str, offset: i64) -> Signature<'static> {
    Signature::new(
        name,
        &format!("{}@example.com", name.to_lowercase()),
        &git2::Time::new(common::FIXTURE_TIME + offset, 0),
    )
    .expect("signature")
}

/// Commits `files` on HEAD with `name` as author and committer, `offset` seconds after the fixture base.
fn commit_as(
    path: &Path,
    files: &[(&str, &str)],
    message: &str,
    parents: &[Oid],
    name: &str,
    offset: i64,
) -> Oid {
    common::commit_tree_at(
        path,
        Some("HEAD"),
        files,
        message,
        parents,
        &at(name, offset),
        &at(name, offset),
    )
}

fn cf(path: &str, old_path: Option<&str>, change: ChangeKind) -> CommitFile {
    CommitFile {
        path: path.into(),
        old_path: old_path.map(str::to_owned),
        change,
    }
}

/// (change, path, old_path) of each history entry, newest first.
fn shape(entries: &[FileHistoryEntry]) -> Vec<(ChangeKind, String, Option<String>)> {
    entries
        .iter()
        .map(|e| (e.change, e.path.clone(), e.old_path.clone()))
        .collect()
}

fn history(path: &Path, file: &str) -> Result<Vec<FileHistoryEntry>, GitError> {
    let mut s = open(path);
    let generation = s.log_summary().expect("summary").generation;
    s.file_history(generation, file)
}

/// R <- A (HEAD branch) ; R <- B (`feature`) ; M = merge(A, B) on the HEAD branch.
/// `f.txt` is "base\n" in R, "base\nA\n" in A, "B\nbase\n" in B and the resolved
/// "B\nbase\nA\n" in M, so the merge changed the file against its first parent.
fn merge_changing_file() -> (tempfile::TempDir, PathBuf, Oid, Oid, Oid, Oid) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let r = common::commit_tree_at(
        &path,
        Some("HEAD"),
        &[("f.txt", "base\n")],
        "root",
        &[],
        &common::signature_at(0),
        &common::signature_at(0),
    );
    let a = common::commit_tree_at(
        &path,
        Some("HEAD"),
        &[("f.txt", "base\nA\n")],
        "on main",
        &[r],
        &common::signature_at(10),
        &common::signature_at(10),
    );
    let b = common::commit_tree_at(
        &path,
        Some("refs/heads/feature"),
        &[("f.txt", "B\nbase\n")],
        "on feature",
        &[r],
        &common::signature_at(20),
        &common::signature_at(20),
    );
    let m = common::commit_tree_at(
        &path,
        Some("HEAD"),
        &[("f.txt", "B\nbase\nA\n")],
        "merge",
        &[a, b],
        &common::signature_at(30),
        &common::signature_at(30),
    );
    (dir, path, r, a, b, m)
}

/// Commits the current index on HEAD without touching the working tree.
fn commit_index(path: &Path, message: &str) -> Oid {
    let repo = Repository::open(path).expect("open repo");
    let mut index = repo.index().expect("index");
    let tree = repo
        .find_tree(index.write_tree().expect("write tree"))
        .expect("find tree");
    let sig = Signature::now("Test User", "test@example.com").expect("signature");
    let parent = repo.head().expect("head").peel_to_commit().expect("commit");
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
        .expect("commit")
}

/// Adds a gitlink (submodule) index entry at `rel`; the commit lives outside this repo's object database.
/// Uses `Index::add` with a mode 0o160000 entry, which compiles against git2 0.20.
fn add_gitlink(path: &Path, rel: &str) {
    let repo = Repository::open(path).expect("open repo");
    let mut index = repo.index().expect("index");
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
            id: Oid::from_str(ABSENT_OID).unwrap(),
            flags: 0,
            flags_extended: 0,
            path: rel.as_bytes().to_vec(),
        })
        .expect("add gitlink");
    index.write().expect("write index");
}

// --- commit_files: one entry per path a commit changed against its first parent ---

#[test]
fn commit_files_on_root_lists_every_path_as_added() {
    let (_d, path) = common::temp_repo_with_commit();

    let files = open(&path)
        .commit_files(&head_oid(&path).to_string())
        .unwrap();

    assert_eq!(files, [cf("README.md", None, ChangeKind::Added)]);
}

#[test]
fn commit_files_lists_modified_deleted_and_renamed() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let long = "a distinctive line of text\n".repeat(20);
    let c1 = commit_as(
        &path,
        &[("a.txt", "a\n"), ("b.txt", "b\n"), ("c.txt", &long)],
        "first",
        &[],
        "Alice",
        0,
    );
    let c2 = commit_as(
        &path,
        &[("a.txt", "a2\n"), ("d.txt", &long)],
        "second",
        &[c1],
        "Alice",
        10,
    );

    let files = open(&path).commit_files(&c2.to_string()).unwrap();

    assert_eq!(
        files,
        [
            cf("a.txt", None, ChangeKind::Modified),
            cf("b.txt", None, ChangeKind::Deleted),
            cf("d.txt", Some("c.txt"), ChangeKind::Renamed),
        ]
    );
}

#[test]
fn commit_files_reports_a_pure_rename_with_its_old_path() {
    let (_d, path, oids) = common::rename_fixture();

    let files = open(&path).commit_files(&oids[2].to_string()).unwrap();

    assert_eq!(files, [cf("b.txt", Some("a.txt"), ChangeKind::Renamed)]);
}

#[test]
fn commit_files_on_merge_compares_first_parent() {
    let (_d, path, _r, _a, _b, m) = common::merge_fixture();

    let files = open(&path).commit_files(&m.to_string()).unwrap();

    assert_eq!(files, [cf("b.txt", None, ChangeKind::Added)]);
}

#[test]
fn commit_files_bad_oid_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path).commit_files(ABSENT_OID).unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn commit_files_non_hex_oid_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path).commit_files("not-a-hash").unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn commit_files_order_is_by_path() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "c.txt", "c\n");
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, "b/x.txt", "x\n");
    let c = common::commit_all(&path, "three files");

    let files = open(&path).commit_files(&c.to_string()).unwrap();

    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b/x.txt", "c.txt"]);
}

#[test]
fn commit_files_of_an_empty_commit_is_empty() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = head_oid(&path);
    let repo = Repository::open(&path).unwrap();
    let parent = repo.find_commit(head).unwrap();
    let same_tree = parent.tree().unwrap();
    let sig = Signature::now("Test User", "test@example.com").unwrap();
    let empty = repo
        .commit(Some("HEAD"), &sig, &sig, "empty", &same_tree, &[&parent])
        .unwrap();

    let files = open(&path).commit_files(&empty.to_string()).unwrap();

    assert_eq!(files, Vec::<CommitFile>::new());
}

// --- file_history: commits that touched a file, newest first, following renames ---

#[test]
fn file_history_lists_add_then_modify_newest_first() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_file(&path, "README.md", "# fixture\ntwo\n", "modify");

    let entries = history(&path, "README.md").unwrap();

    assert_eq!(
        shape(&entries)
            .into_iter()
            .map(|(c, _, _)| c)
            .collect::<Vec<_>>(),
        [ChangeKind::Modified, ChangeKind::Added]
    );
}

#[test]
fn file_history_copies_commit_metadata_from_the_log_row() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let c1 = commit_as(
        &path,
        &[("f.txt", "one\n")],
        "add f\n\nbody",
        &[],
        "Alice",
        5,
    );

    let entries = history(&path, "f.txt").unwrap();

    assert_eq!(
        entries,
        [FileHistoryEntry {
            oid: c1.to_string(),
            subject: "add f".into(),
            author_name: "Alice".into(),
            author_email: "alice@example.com".into(),
            author_time: common::FIXTURE_TIME + 5,
            change: ChangeKind::Added,
            path: "f.txt".into(),
            old_path: None,
        }]
    );
}

#[test]
fn file_history_follows_a_rename() {
    let (_d, path, _oids) = common::rename_fixture();

    let entries = history(&path, "b.txt").unwrap();

    assert_eq!(
        shape(&entries),
        [
            (ChangeKind::Modified, "b.txt".into(), None),
            (ChangeKind::Renamed, "b.txt".into(), Some("a.txt".into())),
            (ChangeKind::Modified, "a.txt".into(), None),
            (ChangeKind::Added, "a.txt".into(), None),
        ]
    );
}

#[test]
fn file_history_of_the_old_name_stops_at_the_rename() {
    let (_d, path, oids) = common::rename_fixture();

    let entries = history(&path, "a.txt").unwrap();

    let listed: Vec<String> = entries.iter().map(|e| e.oid.clone()).collect();
    assert_eq!(
        (listed, entries[0].change),
        (
            vec![
                oids[2].to_string(),
                oids[1].to_string(),
                oids[0].to_string()
            ],
            ChangeKind::Deleted
        )
    );
}

#[test]
fn file_history_lists_a_file_deleted_then_re_added() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let c1 = commit_as(
        &path,
        &[("f.txt", "1\n"), ("other.txt", "x\n")],
        "add",
        &[],
        "Alice",
        0,
    );
    let c2 = commit_as(
        &path,
        &[("f.txt", "2\n"), ("other.txt", "x\n")],
        "modify",
        &[c1],
        "Alice",
        10,
    );
    let c3 = commit_as(&path, &[("other.txt", "x\n")], "delete", &[c2], "Alice", 20);
    commit_as(
        &path,
        &[("f.txt", "4\n"), ("other.txt", "x\n")],
        "re-add",
        &[c3],
        "Alice",
        30,
    );

    let entries = history(&path, "f.txt").unwrap();

    let changes: Vec<ChangeKind> = entries.iter().map(|e| e.change).collect();
    assert_eq!(
        changes,
        [
            ChangeKind::Added,
            ChangeKind::Deleted,
            ChangeKind::Modified,
            ChangeKind::Added
        ]
    );
}

#[test]
fn file_history_skips_a_merge_equal_to_first_parent() {
    let (_d, path, _r, a, _b, _m) = common::merge_fixture();

    let entries = history(&path, "a.txt").unwrap();

    let oids: Vec<&str> = entries.iter().map(|e| e.oid.as_str()).collect();
    assert_eq!(oids, [a.to_string()]);
}

#[test]
fn file_history_lists_a_merge_that_changed_the_file() {
    let (_d, path, _r, _a, _b, m) = merge_changing_file();

    let entries = history(&path, "f.txt").unwrap();

    let merge_entry = entries.iter().find(|e| e.oid == m.to_string());
    assert_eq!(merge_entry.map(|e| e.change), Some(ChangeKind::Modified));
}

#[test]
fn file_history_unknown_path_is_empty() {
    let (_d, path) = common::temp_repo_with_commit();

    let entries = history(&path, "never-committed.txt").unwrap();

    assert_eq!(entries, Vec::<FileHistoryEntry>::new());
}

#[test]
fn file_history_stale_generation_is_log_stale() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let generation = s.log_summary().unwrap().generation;

    let err = s.file_history(generation + 1, "README.md").unwrap_err();

    assert!(matches!(err, GitError::LogStale), "{err:?}");
}

#[test]
fn file_history_before_any_summary_is_log_stale() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path).file_history(1, "README.md").unwrap_err();

    assert!(matches!(err, GitError::LogStale), "{err:?}");
}

#[test]
fn file_history_order_matches_graph() {
    let (_d, path, _r, _a, _b, _m) = merge_changing_file();
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 100).unwrap().rows;
    let entries = s.file_history(summary.generation, "f.txt").unwrap();

    let indices: Vec<usize> = entries
        .iter()
        .map(|e| rows.iter().position(|r| r.oid == e.oid).expect("in graph"))
        .collect();

    assert!(indices.windows(2).all(|w| w[0] < w[1]), "{indices:?}");
}

// --- blame: the commit that last changed each line ---

/// f.txt is "one\n" by Alice at +0, then "one\ntwo\n" by Bob at +10.
fn blame_fixture() -> (tempfile::TempDir, PathBuf, Oid, Oid) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let c1 = commit_as(&path, &[("f.txt", "one\n")], "first", &[], "Alice", 0);
    let c2 = commit_as(
        &path,
        &[("f.txt", "one\ntwo\n")],
        "second",
        &[c1],
        "Bob",
        10,
    );
    (dir, path, c1, c2)
}

fn hunk(start: u32, oid: Oid, name: &str, offset: i64, summary: &str) -> BlameHunk {
    BlameHunk {
        start,
        lines: 1,
        oid: oid.to_string(),
        author: CoreSignature {
            name: name.into(),
            email: format!("{}@example.com", name.to_lowercase()),
            time: common::FIXTURE_TIME + offset,
        },
        summary: summary.into(),
    }
}

#[test]
fn blame_two_commits_two_hunks() {
    let (_d, path, c1, c2) = blame_fixture();

    let blame = open(&path).blame("f.txt", None).unwrap();

    assert_eq!(
        blame,
        Blame {
            oid: c2.to_string(),
            path: "f.txt".into(),
            hunks: vec![
                hunk(1, c1, "Alice", 0, "first"),
                hunk(2, c2, "Bob", 10, "second")
            ],
            lines: vec!["one".into(), "two".into()],
        }
    );
}

#[test]
fn blame_at_older_commit() {
    let (_d, path, c1, _c2) = blame_fixture();

    let blame = open(&path).blame("f.txt", Some(&c1.to_string())).unwrap();

    assert_eq!(
        (blame.hunks, blame.lines),
        (
            vec![hunk(1, c1, "Alice", 0, "first")],
            vec!["one".to_owned()]
        )
    );
}

#[test]
fn blame_defaults_to_head() {
    let (_d, path, _c1, c2) = blame_fixture();

    let blame = open(&path).blame("f.txt", None).unwrap();

    assert_eq!(blame.oid, c2.to_string());
}

#[test]
fn blame_echoes_the_requested_oid() {
    let (_d, path, c1, _c2) = blame_fixture();

    let blame = open(&path).blame("f.txt", Some(&c1.to_string())).unwrap();

    assert_eq!(blame.oid, c1.to_string());
}

#[test]
fn blame_strips_cr_and_hunks_cover_every_line() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_crlf(&path, "crlf.txt", "a\nb\nc\n", "add crlf file");
    let repo = Repository::open(&path).unwrap();
    let blob = repo
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .get_name("crlf.txt")
        .unwrap()
        .to_object(&repo)
        .unwrap()
        .peel_to_blob()
        .unwrap();
    assert_eq!(blob.content(), b"a\r\nb\r\nc\r\n", "fixture must hold CRLF");

    let blame = open(&path).blame("crlf.txt", None).unwrap();

    let covered: u32 = blame.hunks.iter().map(|h| h.lines).sum();
    assert_eq!(
        (blame.lines, covered),
        (vec!["a".to_owned(), "b".into(), "c".into()], 3)
    );
}

#[test]
fn blame_keeps_a_final_line_without_a_newline() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_file(&path, "tail.txt", "a\nb", "no trailing newline");

    let blame = open(&path).blame("tail.txt", None).unwrap();

    assert_eq!(blame.lines, ["a", "b"]);
}

#[test]
fn blame_hunks_are_in_line_order_without_gaps() {
    let (_d, path, _c1, _c2) = blame_fixture();

    let blame = open(&path).blame("f.txt", None).unwrap();

    let mut next = 1;
    for h in &blame.hunks {
        assert_eq!(h.start, next);
        next += h.lines;
    }
}

#[test]
fn blame_missing_path_is_path_not_found() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path).blame("nope.txt", None).unwrap_err();

    assert!(matches!(err, GitError::PathNotFound(_)), "{err:?}");
}

#[test]
fn blame_of_a_directory_is_path_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_file(&path, "dir/x.txt", "x\n", "nested");

    let err = open(&path).blame("dir", None).unwrap_err();

    assert!(matches!(err, GitError::PathNotFound(_)), "{err:?}");
}

#[test]
fn blame_path_missing_at_the_requested_commit_is_path_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let root = head_oid(&path);
    common::commit_file(&path, "later.txt", "x\n", "later");

    let err = open(&path)
        .blame("later.txt", Some(&root.to_string()))
        .unwrap_err();

    assert!(matches!(err, GitError::PathNotFound(_)), "{err:?}");
}

#[test]
fn blame_binary_blob_is_binary_file() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_binary(&path, "img.bin", b"PNG\0\x01\x02", "add binary");

    let err = open(&path).blame("img.bin", None).unwrap_err();

    assert!(
        matches!(&err, GitError::BinaryFile(p) if p == "img.bin"),
        "{err:?}"
    );
}

#[test]
fn blame_oversize_blob_is_too_large() {
    let (_d, path) = common::temp_repo_with_commit();
    // "a\n" repeated plus one byte is 4 MiB + 1.
    let text = format!("{}a", "a\n".repeat(BLAME_MAX_BYTES as usize / 2));
    assert_eq!(text.len() as u64, BLAME_MAX_BYTES + 1);
    common::commit_file(&path, "big.txt", &text, "add big file");

    let err = open(&path).blame("big.txt", None).unwrap_err();

    let GitError::TooLarge { size, limit, .. } = err else {
        panic!("expected TooLarge");
    };
    assert_eq!((size, limit), (BLAME_MAX_BYTES + 1, BLAME_MAX_BYTES));
}

#[test]
fn blame_accepts_a_blob_of_exactly_the_limit() {
    let (_d, path) = common::temp_repo_with_commit();
    let text = "a\n".repeat(BLAME_MAX_BYTES as usize / 2);
    assert_eq!(text.len() as u64, BLAME_MAX_BYTES);
    common::commit_file(&path, "edge.txt", &text, "add edge file");

    let blame = open(&path).blame("edge.txt", None).unwrap();

    assert_eq!(blame.lines.len(), BLAME_MAX_BYTES as usize / 2);
}

#[test]
fn blame_bad_oid_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path)
        .blame("README.md", Some(ABSENT_OID))
        .unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn blame_non_hex_oid_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();

    let err = open(&path)
        .blame("README.md", Some("not-a-hash"))
        .unwrap_err();

    assert!(matches!(err, GitError::CommitNotFound(_)), "{err:?}");
}

#[test]
fn blame_unborn_head_is_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();

    let err = open(&path).blame("README.md", None).unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

// --- tracked_files: blob paths in the HEAD tree, sorted ---

#[test]
fn tracked_files_sorted_and_nested() {
    let (_d, path) = common::temp_repo_unborn();
    common::commit_file(&path, "b/c.txt", "c\n", "nested");
    common::commit_file(&path, "a.txt", "a\n", "top level");

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["a.txt", "b/c.txt"]);
}

#[test]
fn tracked_files_reads_head_not_the_index() {
    let (_d, path) = common::temp_repo_with_commit();
    common::write_file(&path, "staged.txt", "s\n");
    common::stage(&path, "staged.txt");

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["README.md"]);
}

#[test]
fn tracked_files_skips_gitlink() {
    let (_d, path) = common::temp_repo_with_commit();
    add_gitlink(&path, "sub");
    commit_index(&path, "add submodule entry");

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["README.md"]);
}

#[test]
fn tracked_files_unborn_is_empty() {
    let (_d, path) = common::temp_repo_unborn();

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, Vec::<String>::new());
}

// --- GR-9 architect changes: type changes, lossy paths, malformed paths, non-blob entries ---

#[cfg(unix)]
#[test]
fn commit_files_reports_a_type_change() {
    let (_d, path) = common::temp_repo_unborn();
    common::commit_file(&path, "f", "target\n", "file");
    std::fs::remove_file(path.join("f")).unwrap();
    std::os::unix::fs::symlink("elsewhere", path.join("f")).unwrap();
    let c = common::commit_all(&path, "now a symlink");

    let files = open(&path).commit_files(&c.to_string()).unwrap();

    assert_eq!(files, [cf("f", None, ChangeKind::TypeChange)]);
}

#[cfg(unix)]
#[test]
fn tracked_files_lists_a_non_utf8_directory_lossily() {
    use std::os::unix::ffi::OsStrExt;
    let (_d, path) = common::temp_repo_unborn();
    let repo = Repository::open(&path).unwrap();
    let blob = repo.blob(b"x\n").unwrap();
    let mut inner = repo.treebuilder(None).unwrap();
    inner.insert("f.txt", blob, 0o100644).unwrap();
    let inner = inner.write().unwrap();
    let mut outer = repo.treebuilder(None).unwrap();
    let dir_name = std::ffi::OsStr::from_bytes(b"d\xff");
    outer.insert(dir_name.as_bytes(), inner, 0o040000).unwrap();
    let tree = repo.find_tree(outer.write().unwrap()).unwrap();
    let sig = Signature::now("Test User", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "non-utf8 dir", &tree, &[])
        .unwrap();

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["d\u{fffd}/f.txt"]);
}

#[test]
fn blame_malformed_path_is_path_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let s = open(&path);

    let results = [s.blame("../x", None), s.blame("", None)];

    assert!(
        results
            .iter()
            .all(|r| matches!(r, Err(GitError::PathNotFound(_)))),
        "{results:?}"
    );
}

#[test]
fn file_history_malformed_path_is_path_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let generation = s.log_summary().unwrap().generation;

    let results = [
        s.file_history(generation, "../x"),
        s.file_history(generation, ""),
    ];

    assert!(
        results
            .iter()
            .all(|r| matches!(r, Err(GitError::PathNotFound(_)))),
        "{results:?}"
    );
}

#[test]
fn file_history_treats_a_file_replaced_by_a_directory_as_deleted() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    common::commit_file(&path, "x", "file\n", "x is a file");
    std::fs::remove_file(path.join("x")).unwrap();
    common::write_file(&path, "x/inner.txt", "inner\n");
    common::commit_all(&path, "x becomes a directory");

    let entries = history(&path, "x").unwrap();

    let changes: Vec<ChangeKind> = entries.iter().map(|e| e.change).collect();
    assert_eq!(changes, [ChangeKind::Deleted, ChangeKind::Added]);
}

// --- GR-9 coverage audit: oid kinds, merges, rename chains, blame shapes, tree shapes ---

/// Object ids that exist but are not commits: the root tree and an annotated tag.
fn non_commit_oids(path: &Path) -> Vec<(&'static str, String)> {
    let head = head_oid(path);
    common::tag_annotated(path, "v1", head);
    let repo = Repository::open(path).unwrap();
    let tag = repo
        .find_reference("refs/tags/v1")
        .unwrap()
        .target()
        .unwrap();
    let tree = repo.find_commit(head).unwrap().tree_id();
    vec![("tree", tree.to_string()), ("tag", tag.to_string())]
}

#[test]
fn commit_files_of_a_tree_or_tag_object_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let s = open(&path);

    for (kind, oid) in non_commit_oids(&path) {
        let err = s.commit_files(&oid).unwrap_err();
        assert!(
            matches!(err, GitError::CommitNotFound(_)),
            "{kind}: {err:?}"
        );
    }
}

#[test]
fn commit_files_requires_exactly_forty_hex_characters() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = head_oid(&path).to_string();
    let s = open(&path);

    let short = s.commit_files(&head[..39]);
    let long = s.commit_files(&format!("{head}0"));

    assert!(
        matches!(short, Err(GitError::CommitNotFound(_))),
        "{short:?}"
    );
    assert!(matches!(long, Err(GitError::CommitNotFound(_))), "{long:?}");
}

#[test]
fn commit_files_lists_a_file_replaced_by_a_directory_as_delete_plus_add() {
    let (_d, path) = common::temp_repo_unborn();
    common::commit_file(&path, "x", "file\n", "x is a file");
    std::fs::remove_file(path.join("x")).unwrap();
    common::write_file(&path, "x/inner.txt", "inner\n");
    let c = common::commit_all(&path, "x becomes a directory");

    let files = open(&path).commit_files(&c.to_string()).unwrap();

    assert_eq!(
        files,
        [
            cf("x", None, ChangeKind::Deleted),
            cf("x/inner.txt", None, ChangeKind::Added)
        ]
    );
}

#[test]
fn commit_files_lists_an_added_gitlink() {
    let (_d, path) = common::temp_repo_with_commit();
    add_gitlink(&path, "sub");
    let c = commit_index(&path, "add submodule entry");

    let files = open(&path).commit_files(&c.to_string()).unwrap();

    assert_eq!(files, [cf("sub", None, ChangeKind::Added)]);
}

#[test]
fn file_history_lists_a_merge_that_brought_the_file_in_from_its_second_parent() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let r = commit_as(&path, &[("base.txt", "base\n")], "root", &[], "Ann", 0);
    let a = commit_as(&path, &[("base.txt", "base\n")], "main", &[r], "Ann", 10);
    let b = common::commit_tree_at(
        &path,
        Some("refs/heads/feature"),
        &[("base.txt", "base\n"), ("g.txt", "g\n")],
        "feature adds g",
        &[r],
        &at("Ann", 20),
        &at("Ann", 20),
    );
    let m = commit_as(
        &path,
        &[("base.txt", "base\n"), ("g.txt", "g\n")],
        "merge",
        &[a, b],
        "Ann",
        30,
    );

    let entries = history(&path, "g.txt").unwrap();

    // Against its first parent the merge added g.txt, and no rename explains it.
    let seen: Vec<(String, ChangeKind, Option<String>)> = entries
        .iter()
        .map(|e| (e.oid.clone(), e.change, e.old_path.clone()))
        .collect();
    assert_eq!(
        seen,
        [
            (m.to_string(), ChangeKind::Added, None),
            (b.to_string(), ChangeKind::Added, None)
        ]
    );
}

#[test]
fn file_history_only_reports_a_rename_of_the_followed_path() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let body = "one\ntwo\nthree\nfour\n";
    let c1 = commit_as(&path, &[("x.txt", body)], "add x", &[], "Ann", 0);
    // The same commit renames x to y and adds an unrelated z.
    commit_as(
        &path,
        &[("y.txt", body), ("z.txt", "z\n")],
        "rename x, add z",
        &[c1],
        "Ann",
        10,
    );

    let z = history(&path, "z.txt").unwrap();
    let y = history(&path, "y.txt").unwrap();

    assert_eq!(shape(&z), [(ChangeKind::Added, "z.txt".to_owned(), None)]);
    assert_eq!(
        shape(&y),
        [
            (
                ChangeKind::Renamed,
                "y.txt".to_owned(),
                Some("x.txt".to_owned())
            ),
            (ChangeKind::Added, "x.txt".to_owned(), None)
        ]
    );
}

#[test]
fn file_history_follows_a_rename_that_also_edits_the_file() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let c1 = commit_as(
        &path,
        &[("old.txt", "1\n2\n3\n4\n5\n6\n7\n8\n")],
        "add old",
        &[],
        "Ann",
        0,
    );
    commit_as(
        &path,
        &[("new.txt", "1\n2\n3\n4\n5\n6\n7\n8 changed\n")],
        "rename and edit",
        &[c1],
        "Ann",
        10,
    );

    let entries = history(&path, "new.txt").unwrap();

    assert_eq!(
        shape(&entries),
        [
            (
                ChangeKind::Renamed,
                "new.txt".to_owned(),
                Some("old.txt".to_owned())
            ),
            (ChangeKind::Added, "old.txt".to_owned(), None)
        ]
    );
}

#[test]
fn file_history_follows_a_chain_of_two_renames() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let body = "alpha\nbeta\ngamma\ndelta\n";
    let c1 = commit_as(&path, &[("a.txt", body)], "add a", &[], "Ann", 0);
    let c2 = commit_as(&path, &[("b.txt", body)], "a to b", &[c1], "Ann", 10);
    commit_as(&path, &[("c.txt", body)], "b to c", &[c2], "Ann", 20);

    let entries = history(&path, "c.txt").unwrap();

    assert_eq!(
        shape(&entries),
        [
            (
                ChangeKind::Renamed,
                "c.txt".to_owned(),
                Some("b.txt".to_owned())
            ),
            (
                ChangeKind::Renamed,
                "b.txt".to_owned(),
                Some("a.txt".to_owned())
            ),
            (ChangeKind::Added, "a.txt".to_owned(), None)
        ]
    );
}

#[test]
fn file_history_of_a_directory_path_is_empty() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_file(&path, "dir/x.txt", "x\n", "nested");

    let entries = history(&path, "dir").unwrap();

    assert!(entries.is_empty(), "{entries:?}");
}

#[test]
fn file_history_ignores_a_gitlink_at_the_path() {
    let (_d, path) = common::temp_repo_with_commit();
    add_gitlink(&path, "sub");
    commit_index(&path, "add submodule entry");

    let entries = history(&path, "sub").unwrap();

    assert!(entries.is_empty(), "{entries:?}");
}

// --- blame shapes ---

#[test]
fn blame_attributes_interleaved_edits_to_three_hunks_that_cover_every_line() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    let c1 = commit_as(&path, &[("f.txt", "a\nb\nc\n")], "one", &[], "Ann", 0);
    let c2 = commit_as(&path, &[("f.txt", "a\nB\nc\n")], "two", &[c1], "Bob", 10);
    let c3 = commit_as(
        &path,
        &[("f.txt", "a\nB\nc\nd\n")],
        "three",
        &[c2],
        "Cy",
        20,
    );

    let blame = open(&path).blame("f.txt", None).unwrap();

    let spans: Vec<(u32, u32, String)> = blame
        .hunks
        .iter()
        .map(|h| (h.start, h.lines, h.oid.clone()))
        .collect();
    assert_eq!(
        spans,
        [
            (1, 1, c1.to_string()),
            (2, 1, c2.to_string()),
            (3, 1, c1.to_string()),
            (4, 1, c3.to_string())
        ]
    );
    let covered: u32 = blame.hunks.iter().map(|h| h.lines).sum();
    assert_eq!(covered as usize, blame.lines.len());
}

#[test]
fn blame_of_a_merge_attributes_lines_to_the_commits_that_wrote_them() {
    let (_d, path, r, a, b, m) = merge_changing_file();

    let blame = open(&path).blame("f.txt", Some(&m.to_string())).unwrap();

    assert_eq!(blame.lines, ["B", "base", "A"]);
    let owners: Vec<(u32, String)> = blame
        .hunks
        .iter()
        .map(|h| (h.start, h.oid.clone()))
        .collect();
    assert_eq!(
        owners,
        [(1, b.to_string()), (2, r.to_string()), (3, a.to_string())]
    );
}

#[test]
fn blame_follows_a_file_across_a_rename() {
    let (_d, path, oids) = common::rename_fixture();

    let blame = open(&path).blame("b.txt", None).unwrap();

    let owners: Vec<(u32, String)> = blame
        .hunks
        .iter()
        .map(|h| (h.start, h.oid.clone()))
        .collect();
    assert_eq!(
        owners,
        [
            (1, oids[0].to_string()),
            (2, oids[1].to_string()),
            (3, oids[3].to_string())
        ]
    );
}

#[test]
fn blame_of_an_empty_file_has_no_lines_and_no_covered_lines() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_file(&path, "empty.txt", "", "add empty file");

    let blame = open(&path).blame("empty.txt", None).unwrap();

    // libgit2 may report one zero-line hunk for an empty file; it must cover nothing.
    let covered: u32 = blame.hunks.iter().map(|h| h.lines).sum();
    assert_eq!((blame.lines, covered), (Vec::<String>::new(), 0));
}

#[test]
fn blame_keeps_blank_lines_and_decodes_invalid_utf8_lossily() {
    let (_d, path) = common::temp_repo_with_commit();
    common::commit_binary(&path, "mixed.txt", b"a\n\ncaf\xe9\n", "latin-1 text");

    let blame = open(&path).blame("mixed.txt", None).unwrap();

    assert_eq!(blame.lines, ["a", "", "caf\u{fffd}"]);
    let covered: u32 = blame.hunks.iter().map(|h| h.lines).sum();
    assert_eq!(covered, 3);
}

#[test]
fn blame_of_a_tree_or_tag_object_id_is_commit_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let s = open(&path);

    for (kind, oid) in non_commit_oids(&path) {
        let err = s.blame("README.md", Some(&oid)).unwrap_err();
        assert!(
            matches!(err, GitError::CommitNotFound(_)),
            "{kind}: {err:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn blame_of_a_symlink_blames_its_target_text() {
    let (_d, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("README.md", path.join("link")).unwrap();
    let c = common::commit_all(&path, "add symlink");

    let blame = open(&path).blame("link", None).unwrap();

    assert_eq!(blame.lines, ["README.md"]);
    let oids: Vec<&str> = blame.hunks.iter().map(|h| h.oid.as_str()).collect();
    assert_eq!(oids, [c.to_string()]);
}

// --- tracked_files: tree shapes ---

#[cfg(unix)]
#[test]
fn tracked_files_lists_a_symlink_entry() {
    let (_d, path) = common::temp_repo_with_commit();
    std::os::unix::fs::symlink("README.md", path.join("link")).unwrap();
    common::commit_all(&path, "add symlink");

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["README.md", "link"]);
}

#[test]
fn tracked_files_skips_an_empty_subtree_and_descends_into_deep_ones() {
    let (_d, path) = common::temp_repo_unborn();
    let repo = Repository::open(&path).unwrap();
    let blob = repo.blob(b"x\n").unwrap();
    let empty = repo.treebuilder(None).unwrap().write().unwrap();
    let mut leaf = repo.treebuilder(None).unwrap();
    leaf.insert("deep.txt", blob, 0o100644).unwrap();
    let leaf = leaf.write().unwrap();
    let mut mid = repo.treebuilder(None).unwrap();
    mid.insert("c", leaf, 0o040000).unwrap();
    let mid = mid.write().unwrap();
    let mut top = repo.treebuilder(None).unwrap();
    top.insert("a", mid, 0o040000).unwrap();
    top.insert("hollow", empty, 0o040000).unwrap();
    top.insert("a-b.txt", blob, 0o100644).unwrap();
    top.insert("a.txt", blob, 0o100644).unwrap();
    let tree = repo.find_tree(top.write().unwrap()).unwrap();
    let sig = Signature::now("Test User", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "shapes", &tree, &[])
        .unwrap();

    let files = open(&path).tracked_files().unwrap();

    assert_eq!(files, ["a-b.txt", "a.txt", "a/c/deep.txt"]);
}
