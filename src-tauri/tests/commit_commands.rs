//! Integration tests for the commit command `*_inner` functions.

mod common;

use git_real_core::{CommitMessage, RepoSession, SigningFormat};
use git_real_lib::commands::commit::{
    commit_inner, get_commit_config_inner, get_head_message_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use tempfile::TempDir;

fn open_fixture() -> (TempDir, std::path::PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, path, reg, id)
}

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.into(),
        body: body.into(),
    }
}

#[test]
fn get_commit_config_inner_reads_identity() {
    let (_d, _p, reg, id) = open_fixture();
    let cfg = get_commit_config_inner(&reg, id).unwrap();
    assert_eq!(cfg.name.as_deref(), Some("Test User"));
    assert_eq!(cfg.email.as_deref(), Some("test@example.com"));
    assert_eq!(cfg.signing, None);
}

#[test]
fn get_commit_config_inner_reports_signing() {
    let (_d, path, reg, id) = open_fixture();
    let repo = git2::Repository::open(&path).unwrap();
    let mut c = repo.config().unwrap();
    c.set_bool("commit.gpgsign", true).unwrap();
    c.set_str("gpg.format", "ssh").unwrap();
    assert_eq!(
        get_commit_config_inner(&reg, id).unwrap().signing,
        Some(SigningFormat::Ssh)
    );
}

#[test]
fn get_head_message_inner_returns_split_message() {
    let (_d, _p, reg, id) = open_fixture();
    assert_eq!(
        get_head_message_inner(&reg, id).unwrap(),
        Some(msg("initial commit", ""))
    );
}

#[test]
fn get_head_message_inner_is_none_for_unborn() {
    let dir = tempfile::tempdir().unwrap();
    common::init_repo(dir.path());
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(dir.path()).unwrap());
    assert_eq!(get_head_message_inner(&reg, id).unwrap(), None);
}

#[test]
fn commit_inner_nothing_staged_maps_to_nothing_to_commit() {
    let (_d, _p, reg, id) = open_fixture();
    let err = commit_inner(&reg, id, &msg("S", ""), false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NothingToCommit);
    assert_eq!(err.message, "nothing is staged to commit");
}

#[test]
fn commit_inner_blank_subject_maps_to_empty_message() {
    let (_d, _p, reg, id) = open_fixture();
    let err = commit_inner(&reg, id, &msg(" ", "b"), true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::EmptyMessage);
}

#[test]
fn commit_inner_commits_and_returns_outcome() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = open_fixture();
    std::fs::write(path.join("n.txt"), "n\n").unwrap();
    let repo = git2::Repository::open(&path).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("n.txt")).unwrap();
    index.write().unwrap();

    let out = commit_inner(&reg, id, &msg("Add n", "body"), false).unwrap();

    assert_eq!(out.summary, "Add n");
    assert_eq!(out.oid, repo.head().unwrap().target().unwrap().to_string());
}

#[test]
fn commit_inner_amend_rewords_head() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = open_fixture();
    let out = commit_inner(&reg, id, &msg("Reworded", ""), true).unwrap();
    assert_eq!(out.summary, "Reworded");
    assert_eq!(
        get_head_message_inner(&reg, id).unwrap(),
        Some(msg("Reworded", ""))
    );
}

#[test]
fn commit_commands_unknown_repo() {
    let reg = RepoRegistry::default();
    assert_eq!(
        get_commit_config_inner(&reg, 99).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        get_head_message_inner(&reg, 99).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        commit_inner(&reg, 99, &msg("S", ""), false)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
}
