//! GR-33: working-tree operations with `core.autocrlf` on. Each test runs
//! against a repository whose own config sets `core.autocrlf` to `true` or
//! `input`, so it runs the same on every OS (libgit2 honours the setting
//! everywhere). "Correct" is what the git CLI produces: rows with a scriptable
//! git equivalent also run it on a twin repository built by the CLI and compare
//! bytes and `git status`; hunk rows spell the expected bytes out.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    ChangeKind, ConflictSide, HunkAction, HunkSelection, MergeMode, OperationOutcome, RepoSession,
    ResetMode, StashOutcome,
};
use git2::Repository;
use git2::build::CheckoutBuilder;
use tempfile::TempDir;

const F: &str = "f.txt";

/// Twelve lines `l1`..`l12`, LF, with `edits` (1-based line, replacement) applied.
fn text(edits: &[(usize, &str)]) -> String {
    (1..=12)
        .map(|i| {
            let line = edits
                .iter()
                .find(|(n, _)| *n == i)
                .map_or_else(|| format!("l{i}"), |(_, s)| (*s).to_owned());
            format!("{line}\n")
        })
        .collect()
}

fn base() -> String {
    text(&[])
}

/// Lines 2 and 10 edited: far enough apart for two hunks at 3 context lines.
fn edited() -> String {
    text(&[(2, "L2"), (10, "L10")])
}

fn crlf(s: &str) -> Vec<u8> {
    s.replace('\n', "\r\n").into_bytes()
}

fn lf(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

/// A repo with `core.autocrlf=<mode>` that committed `f.txt` = `base()` (an
/// LF blob), then deleted and force-checked-out `f.txt`, so the working file
/// is what git writes for that mode. Identity configured, signing off.
fn crlf_repo(mode: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().to_path_buf();
    common::init_repo(&path);
    common::set_autocrlf(&path, mode);
    common::configure_identity(&path);
    common::commit_file(&path, F, &base(), "base");
    std::fs::remove_file(path.join(F)).expect("delete f.txt");
    Repository::open(&path)
        .expect("open")
        .checkout_head(Some(CheckoutBuilder::new().force()))
        .expect("checkout");
    (dir, path)
}

/// The same repo shape built with the git CLI; `None` when git is skipped.
fn twin(mode: &str) -> Option<(TempDir, PathBuf)> {
    if !common::git_available() {
        return None;
    }
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().to_path_buf();
    common::run_git_ok(&path, &["init", "-q"]);
    common::run_git_ok(&path, &["config", "core.autocrlf", mode]);
    common::configure_identity(&path);
    std::fs::write(path.join(F), base()).expect("write f.txt");
    common::run_git_ok(&path, &["add", F]);
    common::run_git_ok(&path, &["commit", "-q", "-m", "base"]);
    std::fs::remove_file(path.join(F)).expect("delete f.txt");
    common::run_git_ok(&path, &["checkout", "--", F]);
    Some((dir, path))
}

fn session(path: &Path) -> RepoSession {
    RepoSession::open(path).expect("open session")
}

fn write_work(path: &Path, bytes: &[u8]) {
    std::fs::write(path.join(F), bytes).expect("write f.txt");
}

fn work(path: &Path) -> Vec<u8> {
    std::fs::read(path.join(F)).expect("read f.txt")
}

/// The stage-0 index blob of `f.txt`.
fn index_blob(path: &Path) -> Vec<u8> {
    let repo = Repository::open(path).expect("open");
    let index = repo.index().expect("index");
    let entry = index.get_path(Path::new(F), 0).expect("f.txt staged");
    repo.find_blob(entry.id).expect("blob").content().to_vec()
}

/// `(path, index, worktree, conflicted)` of every status entry.
type Row = (String, Option<ChangeKind>, Option<ChangeKind>, bool);

fn entries(path: &Path) -> Vec<Row> {
    session(path)
        .status()
        .expect("status")
        .entries
        .into_iter()
        .map(|e| (e.path, e.index, e.worktree, e.conflicted))
        .collect()
}

fn row(index: Option<ChangeKind>, worktree: Option<ChangeKind>) -> Vec<Row> {
    vec![(F.to_owned(), index, worktree, false)]
}

/// `git status --porcelain` for `path`; `None` when git is skipped.
fn git_status(path: &Path) -> Option<String> {
    if !common::git_available() {
        return None;
    }
    let out = common::run_git_ok(path, &["status", "--porcelain"]);
    Some(String::from_utf8(out.stdout).expect("utf-8 status"))
}

/// Asserts the product's status and, when git runs, git's own porcelain view
/// of the same repository.
fn assert_status(path: &Path, rows: Vec<Row>, porcelain: &str) {
    assert_eq!(entries(path), rows, "product status");
    if let Some(s) = git_status(path) {
        assert_eq!(s, porcelain, "git status of the product's repo");
    }
}

/// Asserts the twin ended in the same bytes, index blob and status.
fn assert_twin(product: &Path, twin: &Path) {
    assert_eq!(work(twin), work(product), "working bytes vs git");
    assert_eq!(index_blob(twin), index_blob(product), "index blob vs git");
    assert_eq!(git_status(twin), git_status(product), "status vs git");
}

fn hunk(index: usize) -> HunkSelection {
    HunkSelection {
        hunk_index: index,
        lines: None,
    }
}

fn lines(index: usize, picked: &[usize]) -> HunkSelection {
    HunkSelection {
        hunk_index: index,
        lines: Some(picked.to_vec()),
    }
}

// --- autocrlf=true: checkout and status ---

#[test]
fn status_clean_after_checkout() {
    let (_d, path) = crlf_repo("true");
    assert_eq!(work(&path), crlf(&base()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, vec![], "");
    if let Some((_t, twin)) = twin("true") {
        assert_twin(&path, &twin);
    }
}

// --- autocrlf=true: hunks and lines ---

#[test]
fn stage_hunk_stores_lf_and_leaves_worktree() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    session(&path)
        .apply_hunk(F, HunkAction::Stage, &hunk(0))
        .expect("stage hunk");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&text(&[(2, "L2")])));
    assert_status(
        &path,
        row(Some(ChangeKind::Modified), Some(ChangeKind::Modified)),
        "MM f.txt\n",
    );
}

#[test]
fn stage_lines_stores_lf() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    // Hunk 1 is [l7, l8, l9, -l10, +L10, l11, l12].
    session(&path)
        .apply_hunk(F, HunkAction::Stage, &lines(1, &[3, 4]))
        .expect("stage lines");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&text(&[(10, "L10")])));
    assert_status(
        &path,
        row(Some(ChangeKind::Modified), Some(ChangeKind::Modified)),
        "MM f.txt\n",
    );
}

#[test]
fn unstage_hunk_keeps_worktree() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    let s = session(&path);
    s.stage_paths(&[F.to_owned()]).expect("stage file");
    assert_eq!(index_blob(&path), lf(&edited()));
    s.apply_hunk(F, HunkAction::Unstage, &hunk(0))
        .expect("unstage hunk");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&text(&[(10, "L10")])));
    assert_status(
        &path,
        row(Some(ChangeKind::Modified), Some(ChangeKind::Modified)),
        "MM f.txt\n",
    );
}

#[test]
fn discard_hunk_keeps_crlf_and_other_hunk() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    session(&path)
        .apply_hunk(F, HunkAction::Discard, &hunk(0))
        .expect("discard hunk");
    assert_eq!(work(&path), crlf(&text(&[(10, "L10")])));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, row(None, Some(ChangeKind::Modified)), " M f.txt\n");
}

#[test]
fn discard_lines_keeps_crlf() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    // Hunk 0 is [l1, -l2, +L2, l3, l4, l5].
    session(&path)
        .apply_hunk(F, HunkAction::Discard, &lines(0, &[1, 2]))
        .expect("discard lines");
    assert_eq!(work(&path), crlf(&text(&[(10, "L10")])));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, row(None, Some(ChangeKind::Modified)), " M f.txt\n");
}

// --- autocrlf=true: whole files ---

#[test]
fn discard_paths_writes_crlf_checkout() {
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    session(&path)
        .discard_paths(&[F.to_owned()])
        .expect("discard file");
    assert_eq!(work(&path), crlf(&base()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, vec![], "");
    if let Some((_t, twin)) = twin("true") {
        write_work(&twin, &crlf(&edited()));
        common::run_git_ok(&twin, &["checkout", "--", F]);
        assert_twin(&path, &twin);
    }
}

#[test]
fn stage_and_unstage_whole_file() {
    let (_d, path) = crlf_repo("true");
    let twin = twin("true");
    write_work(&path, &crlf(&edited()));
    let s = session(&path);
    s.stage_paths(&[F.to_owned()]).expect("stage file");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&edited()));
    assert_status(&path, row(Some(ChangeKind::Modified), None), "M  f.txt\n");
    if let Some((_t, twin)) = &twin {
        write_work(twin, &crlf(&edited()));
        common::run_git_ok(twin, &["add", F]);
        assert_twin(&path, twin);
    }

    s.unstage_paths(&[F.to_owned()]).expect("unstage file");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, row(None, Some(ChangeKind::Modified)), " M f.txt\n");
    if let Some((_t, twin)) = &twin {
        common::run_git_ok(twin, &["reset", "-q", "--", F]);
        assert_twin(&path, twin);
    }
}

#[test]
fn stash_save_pop_restores_crlf() {
    let Some((_t, twin)) = twin("true") else {
        return;
    };
    let (_d, path) = crlf_repo("true");
    write_work(&path, &crlf(&edited()));
    write_work(&twin, &crlf(&edited()));
    let s = session(&path);

    s.stash_push(Some("wip"), false).expect("stash push");
    common::run_git_ok(&twin, &["stash", "push", "-q", "-m", "wip"]);
    assert_eq!(work(&path), crlf(&base()));
    assert_status(&path, vec![], "");
    assert_twin(&path, &twin);

    let entry = s.list_stashes().expect("list")[0].clone();
    assert_eq!(
        s.stash_pop(entry.index, &entry.oid).expect("stash pop"),
        StashOutcome::Applied
    );
    common::run_git_ok(&twin, &["stash", "pop", "-q"]);
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, row(None, Some(ChangeKind::Modified)), " M f.txt\n");
    assert_twin(&path, &twin);
}

/// Commits `content` (written CRLF, as a Windows editor saves) with the CLI.
fn cli_commit(path: &Path, content: &str, message: &str) {
    write_work(path, &crlf(content));
    common::run_git_ok(path, &["add", F]);
    common::run_git_ok(path, &["commit", "-q", "-m", message]);
}

fn head_oid(path: &Path) -> String {
    let out = common::run_git_ok(path, &["rev-parse", "HEAD"]);
    String::from_utf8(out.stdout)
        .expect("utf-8")
        .trim()
        .to_owned()
}

#[test]
fn reset_hard_writes_crlf() {
    let Some((_t, twin)) = twin("true") else {
        return;
    };
    let (_d, path) = crlf_repo("true");
    let first = head_oid(&path);
    let twin_first = head_oid(&twin);
    for p in [&path, &twin] {
        cli_commit(p, &edited(), "second");
        write_work(p, &crlf(&text(&[(5, "dirty")])));
    }

    session(&path)
        .reset_to_commit(&first, ResetMode::Hard)
        .expect("reset hard");
    common::run_git_ok(&twin, &["reset", "-q", "--hard", &twin_first]);
    assert_eq!(work(&path), crlf(&base()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, vec![], "");
    assert_twin(&path, &twin);
}

#[test]
fn switch_branch_writes_crlf_status_clean() {
    let Some((_t, twin)) = twin("true") else {
        return;
    };
    let (_d, path) = crlf_repo("true");
    for p in [&path, &twin] {
        let head = common::head_branch_name(p);
        common::run_git_ok(p, &["checkout", "-q", "-b", "b"]);
        cli_commit(p, &edited(), "on b");
        common::run_git_ok(p, &["checkout", "-q", &head]);
    }
    assert_eq!(work(&path), crlf(&base()));

    session(&path).checkout_branch("b").expect("switch");
    common::run_git_ok(&twin, &["switch", "-q", "b"]);
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&edited()));
    assert_status(&path, vec![], "");
    assert_twin(&path, &twin);
}

/// Branch `other` commits `theirs`, the base branch commits `ours`; HEAD on base.
fn diverge(path: &Path, ours: &str, theirs: &str) {
    let head = common::head_branch_name(path);
    common::run_git_ok(path, &["checkout", "-q", "-b", "other"]);
    cli_commit(path, theirs, "on other");
    common::run_git_ok(path, &["checkout", "-q", &head]);
    cli_commit(path, ours, "on base");
}

#[test]
fn merge_clean_writes_crlf() {
    let Some((_t, twin)) = twin("true") else {
        return;
    };
    let (_d, path) = crlf_repo("true");
    for p in [&path, &twin] {
        diverge(p, &text(&[(2, "L2")]), &text(&[(10, "L10")]));
    }

    let outcome = session(&path)
        .merge_branch("other", MergeMode::Merge)
        .expect("merge");
    assert_eq!(outcome, OperationOutcome::Completed);
    common::run_git_ok(&twin, &["merge", "-q", "--no-ff", "--no-edit", "other"]);
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&edited()));
    assert_status(&path, vec![], "");
    assert_twin(&path, &twin);
}

#[test]
fn merge_conflict_markers_and_resolve() {
    let Some((_t, twin)) = twin("true") else {
        return;
    };
    let (_d, path) = crlf_repo("true");
    for p in [&path, &twin] {
        diverge(p, &text(&[(2, "ours")]), &text(&[(2, "theirs")]));
    }

    let s = session(&path);
    let outcome = s.merge_branch("other", MergeMode::Merge).expect("merge");
    assert_eq!(outcome, OperationOutcome::Conflicts);
    let conflicted = common::run_git(&twin, &["merge", "--no-ff", "--no-edit", "other"]);
    assert!(!conflicted.status.success(), "the twin merge must conflict");
    let markers = work(&path);
    assert!(
        markers
            .windows(b"<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> other\r\n".len())
            .any(|w| w == b"<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> other\r\n"),
        "CRLF conflict markers: {:?}",
        String::from_utf8_lossy(&markers)
    );
    assert_eq!(markers, work(&twin), "conflict file vs git");
    assert_status(
        &path,
        vec![(F.to_owned(), None, Some(ChangeKind::Conflicted), true)],
        "UU f.txt\n",
    );

    s.resolve_conflicts(&[F.to_owned()], ConflictSide::Ours)
        .expect("keep ours");
    common::run_git_ok(&twin, &["checkout", "--ours", "--", F]);
    common::run_git_ok(&twin, &["add", F]);
    assert_eq!(work(&path), crlf(&text(&[(2, "ours")])));
    assert_eq!(index_blob(&path), lf(&text(&[(2, "ours")])));
    assert_twin(&path, &twin);
    let leftovers: Vec<_> = std::fs::read_dir(path.join(".git"))
        .expect("read .git")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("git-real-"))
        .collect();
    assert!(leftovers.is_empty(), "scratch left in .git: {leftovers:?}");
}

#[test]
fn resolve_theirs_writes_crlf() {
    if !common::git_available() {
        return;
    }
    let (_d, path) = crlf_repo("true");
    diverge(&path, &text(&[(2, "ours")]), &text(&[(2, "theirs")]));
    let s = session(&path);
    assert_eq!(
        s.merge_branch("other", MergeMode::Merge).expect("merge"),
        OperationOutcome::Conflicts
    );
    s.resolve_conflicts(&[F.to_owned()], ConflictSide::Theirs)
        .expect("keep theirs");
    assert_eq!(work(&path), crlf(&text(&[(2, "theirs")])));
    assert_eq!(index_blob(&path), lf(&text(&[(2, "theirs")])));
    assert_status(&path, row(Some(ChangeKind::Modified), None), "M  f.txt\n");
}

#[test]
fn write_resolution_stages_lf() {
    if !common::git_available() {
        return;
    }
    let (_d, path) = crlf_repo("true");
    diverge(&path, &text(&[(2, "ours")]), &text(&[(2, "theirs")]));
    let s = session(&path);
    assert_eq!(
        s.merge_branch("other", MergeMode::Merge).expect("merge"),
        OperationOutcome::Conflicts
    );
    let resolved = String::from_utf8(crlf(&text(&[(2, "both")]))).expect("utf-8");
    s.write_resolution(F, &resolved, true)
        .expect("write resolution");
    assert_eq!(work(&path), crlf(&text(&[(2, "both")])));
    assert_eq!(index_blob(&path), lf(&text(&[(2, "both")])));
    assert_status(&path, row(Some(ChangeKind::Modified), None), "M  f.txt\n");
}

// --- autocrlf=input ---

#[test]
fn input_status_clean() {
    let (_d, path) = crlf_repo("input");
    assert_eq!(work(&path), lf(&base()));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, vec![], "");
    if let Some((_t, twin)) = twin("input") {
        assert_twin(&path, &twin);
    }
}

#[test]
fn input_stage_hunk_lf() {
    let (_d, path) = crlf_repo("input");
    // An editor that saves CRLF: staging must still store LF.
    write_work(&path, &crlf(&edited()));
    session(&path)
        .apply_hunk(F, HunkAction::Stage, &hunk(0))
        .expect("stage hunk");
    assert_eq!(work(&path), crlf(&edited()));
    assert_eq!(index_blob(&path), lf(&text(&[(2, "L2")])));
    assert_status(
        &path,
        row(Some(ChangeKind::Modified), Some(ChangeKind::Modified)),
        "MM f.txt\n",
    );
}

#[test]
fn input_discard_hunk_keeps_lf() {
    let (_d, path) = crlf_repo("input");
    write_work(&path, &lf(&edited()));
    session(&path)
        .apply_hunk(F, HunkAction::Discard, &hunk(0))
        .expect("discard hunk");
    assert_eq!(work(&path), lf(&text(&[(10, "L10")])));
    assert_eq!(index_blob(&path), lf(&base()));
    assert_status(&path, row(None, Some(ChangeKind::Modified)), " M f.txt\n");
}

#[test]
fn input_discard_paths() {
    let (_d, path) = crlf_repo("input");
    write_work(&path, &crlf(&edited()));
    session(&path)
        .discard_paths(&[F.to_owned()])
        .expect("discard file");
    assert_eq!(work(&path), lf(&base()));
    assert_status(&path, vec![], "");
    if let Some((_t, twin)) = twin("input") {
        write_work(&twin, &crlf(&edited()));
        common::run_git_ok(&twin, &["checkout", "--", F]);
        assert_twin(&path, &twin);
    }
}
