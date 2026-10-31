//! Integration tests for the commit graph command `*_inner` functions (GR-8).

mod common;

use std::path::PathBuf;
use std::time::Duration;

use git_real_core::{LogSummary, RepoSession, ResetMode};
use git_real_lib::commands::log::{
    checkout_commit_inner, get_commit_inner, get_log_page_inner, get_log_summary_inner,
    reset_to_commit_inner, search_log_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{Oid, Repository};
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;

/// Registered repo with one commit, local identity, signing off.
fn open_fixture() -> (TempDir, PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, path, reg, id)
}

/// Polls the summary command until the graph is complete and not refreshing.
fn complete_summary(reg: &RepoRegistry, id: RepoId) -> LogSummary {
    loop {
        let summary = get_log_summary_inner(reg, id).unwrap();
        if summary.complete && !summary.refreshing {
            return summary;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn head_oid(path: &std::path::Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

// --- get_log_summary_inner and get_log_page_inner ---

#[test]
fn get_log_summary_inner_reports_generation_one_and_one_row() {
    let (_d, _p, reg, id) = open_fixture();
    let summary = get_log_summary_inner(&reg, id).unwrap();
    assert_eq!(
        (summary.generation, summary.total, summary.max_lanes),
        (1, 1, 1)
    );
}

#[test]
fn get_log_page_inner_returns_the_row_the_summary_counted() {
    let (_d, path, reg, id) = open_fixture();
    let summary = complete_summary(&reg, id);
    let page = get_log_page_inner(&reg, id, summary.generation, 0, 10).unwrap();
    assert_eq!(
        (page.start, page.rows.len(), page.rows[0].oid.clone()),
        (0, 1, head_oid(&path).to_string())
    );
}

#[test]
fn get_log_page_inner_maps_a_wrong_generation_to_log_stale() {
    let (_d, _p, reg, id) = open_fixture();
    complete_summary(&reg, id);
    let err = get_log_page_inner(&reg, id, 99, 0, 10).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::LogStale);
}

#[test]
fn get_log_page_inner_maps_a_page_before_any_summary_to_log_stale() {
    let (_d, _p, reg, id) = open_fixture();
    let err = get_log_page_inner(&reg, id, 1, 0, 10).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::LogStale);
}

#[test]
fn get_log_summary_inner_bumps_the_generation_after_a_commit() {
    let (_d, path, reg, id) = open_fixture();
    let first = complete_summary(&reg, id).generation;
    common::commit_file(&path, "b.txt", "b\n", "second");
    let summary = complete_summary(&reg, id);
    assert_eq!((summary.generation > first, summary.total), (true, 2));
}

#[test]
fn get_log_page_inner_rejects_the_previous_generation_after_a_commit() {
    let (_d, path, reg, id) = open_fixture();
    let old = complete_summary(&reg, id).generation;
    common::commit_file(&path, "b.txt", "b\n", "second");
    complete_summary(&reg, id);
    let err = get_log_page_inner(&reg, id, old, 0, 10).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::LogStale);
}

// --- search_log_inner ---

#[test]
fn search_log_inner_finds_the_subject() {
    let (_d, _p, reg, id) = open_fixture();
    let g = complete_summary(&reg, id).generation;
    assert_eq!(search_log_inner(&reg, id, g, "initial").unwrap(), vec![0]);
}

#[test]
fn search_log_inner_returns_nothing_when_no_row_matches() {
    let (_d, _p, reg, id) = open_fixture();
    let g = complete_summary(&reg, id).generation;
    assert!(search_log_inner(&reg, id, g, "zzz").unwrap().is_empty());
}

#[test]
fn search_log_inner_maps_a_wrong_generation_to_log_stale() {
    let (_d, _p, reg, id) = open_fixture();
    complete_summary(&reg, id);
    let err = search_log_inner(&reg, id, 99, "initial").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::LogStale);
}

// --- get_commit_inner ---

#[test]
fn get_commit_inner_returns_the_subject_and_no_parents_for_the_root() {
    let (_d, path, reg, id) = open_fixture();
    let detail = get_commit_inner(&reg, id, &head_oid(&path).to_string()).unwrap();
    assert_eq!(
        (detail.message.subject.as_str(), detail.parents.len()),
        ("initial commit", 0)
    );
}

#[test]
fn get_commit_inner_maps_an_unknown_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();
    let err = get_commit_inner(&reg, id, &"0".repeat(40)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn get_commit_inner_maps_malformed_text_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();
    let err = get_commit_inner(&reg, id, "nothex").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn get_commit_inner_names_the_oid_in_the_error_message() {
    let (_d, _p, reg, id) = open_fixture();
    let err = get_commit_inner(&reg, id, "nothex").unwrap_err();
    assert!(err.message.contains("nothex"));
}

// --- reset_to_commit_inner ---

#[test]
fn reset_to_commit_inner_moves_head_back_with_a_mixed_reset() {
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    reset_to_commit_inner(&reg, id, &first.to_string(), ResetMode::Mixed).unwrap();
    assert_eq!(head_oid(&path), first);
}

#[test]
fn reset_to_commit_inner_hard_restores_the_working_tree() {
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    reset_to_commit_inner(&reg, id, &first.to_string(), ResetMode::Hard).unwrap();
    assert!(!path.join("b.txt").exists());
}

#[test]
fn reset_to_commit_inner_soft_keeps_the_working_tree() {
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    reset_to_commit_inner(&reg, id, &first.to_string(), ResetMode::Soft).unwrap();
    assert!(path.join("b.txt").exists());
}

#[test]
fn reset_to_commit_inner_maps_an_unknown_oid_to_commit_not_found() {
    let (_d, path, reg, id) = open_fixture();
    let before = head_oid(&path);
    let err = reset_to_commit_inner(&reg, id, &"0".repeat(40), ResetMode::Hard).unwrap_err();
    assert_eq!(
        (err.kind, head_oid(&path)),
        (AppErrorKind::CommitNotFound, before)
    );
}

// --- checkout_commit_inner ---

#[test]
fn checkout_commit_inner_detaches_head_at_the_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    checkout_commit_inner(&reg, id, &first.to_string()).unwrap();
    let repo = Repository::open(&path).unwrap();
    assert_eq!(
        (repo.head_detached().unwrap(), repo.head().unwrap().target()),
        (true, Some(first))
    );
}

#[test]
fn checkout_commit_inner_maps_an_unknown_oid_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();
    let err = checkout_commit_inner(&reg, id, &"0".repeat(40)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn checkout_commit_inner_maps_a_blocked_switch_to_checkout_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "README.md", "# two\n", "second");
    std::fs::write(path.join("README.md"), "# dirty\n").unwrap();
    let err = checkout_commit_inner(&reg, id, &first.to_string()).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CheckoutFailed);
}

// --- unknown repo id: every command maps to unknownRepo ---

#[test]
fn get_log_summary_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_log_summary_inner(&reg, MISSING_ID).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_log_page_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_log_page_inner(&reg, MISSING_ID, 1, 0, 10).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn search_log_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = search_log_inner(&reg, MISSING_ID, 1, "x").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn get_commit_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = get_commit_inner(&reg, MISSING_ID, &"0".repeat(40)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn checkout_commit_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err = checkout_commit_inner(&reg, MISSING_ID, &"0".repeat(40)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

#[test]
fn reset_to_commit_inner_maps_unknown_repo() {
    let reg = RepoRegistry::default();
    let err =
        reset_to_commit_inner(&reg, MISSING_ID, &"0".repeat(40), ResetMode::Soft).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- coverage audit: staleness across commands, blank queries, bad input ---

#[test]
fn search_log_inner_rejects_the_previous_generation_after_a_commit() {
    let (_d, path, reg, id) = open_fixture();
    let old = complete_summary(&reg, id).generation;
    common::commit_file(&path, "b.txt", "b\n", "second");
    complete_summary(&reg, id);
    let err = search_log_inner(&reg, id, old, "second").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::LogStale);
}

#[test]
fn search_log_inner_returns_nothing_for_a_blank_query() {
    let (_d, _p, reg, id) = open_fixture();
    let g = complete_summary(&reg, id).generation;
    assert_eq!(
        search_log_inner(&reg, id, g, "   ").unwrap(),
        Vec::<u32>::new()
    );
}

#[test]
fn search_log_inner_finds_a_commit_by_a_hash_prefix() {
    let (_d, path, reg, id) = open_fixture();
    let g = complete_summary(&reg, id).generation;
    let prefix = head_oid(&path).to_string()[..7].to_owned();
    assert_eq!(search_log_inner(&reg, id, g, &prefix).unwrap(), vec![0]);
}

#[test]
fn get_log_page_inner_returns_an_empty_page_past_the_end() {
    let (_d, _p, reg, id) = open_fixture();
    let g = complete_summary(&reg, id).generation;
    let page = get_log_page_inner(&reg, id, g, 50, 10).unwrap();
    assert_eq!((page.start, page.rows.len()), (50, 0));
}

#[test]
fn get_log_summary_inner_keeps_the_generation_when_nothing_changed() {
    let (_d, _p, reg, id) = open_fixture();
    let first = complete_summary(&reg, id).generation;
    assert_eq!(complete_summary(&reg, id).generation, first);
}

#[test]
fn reset_to_commit_inner_makes_the_next_summary_a_new_generation() {
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    let before = complete_summary(&reg, id);
    reset_to_commit_inner(&reg, id, &first.to_string(), ResetMode::Hard).unwrap();
    let after = complete_summary(&reg, id);
    assert_eq!(
        (
            before.total,
            after.total,
            after.generation > before.generation
        ),
        (2, 1, true)
    );
}

#[test]
fn get_commit_inner_maps_an_abbreviated_hash_to_commit_not_found() {
    let (_d, path, reg, id) = open_fixture();
    let short = head_oid(&path).to_string()[..7].to_owned();
    let err = get_commit_inner(&reg, id, &short).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn checkout_commit_inner_maps_flag_like_text_to_commit_not_found_without_running_git() {
    let (_d, path, reg, id) = open_fixture();
    let before = head_oid(&path);
    let err = checkout_commit_inner(&reg, id, "--detach").unwrap_err();
    assert_eq!(
        (err.kind, head_oid(&path)),
        (AppErrorKind::CommitNotFound, before)
    );
}

#[test]
fn reset_to_commit_inner_maps_malformed_text_to_commit_not_found() {
    let (_d, _p, reg, id) = open_fixture();
    let err = reset_to_commit_inner(&reg, id, "not-a-hash", ResetMode::Soft).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::CommitNotFound);
}

#[test]
fn checkout_commit_inner_makes_the_next_summary_a_new_generation_with_a_head_label() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = open_fixture();
    let first = head_oid(&path);
    common::commit_file(&path, "b.txt", "b\n", "second");
    let before = complete_summary(&reg, id);
    checkout_commit_inner(&reg, id, &first.to_string()).unwrap();
    let after = complete_summary(&reg, id);
    let page = get_log_page_inner(&reg, id, after.generation, 0, 10).unwrap();
    let detached = page
        .rows
        .iter()
        .find(|r| r.oid == first.to_string())
        .unwrap()
        .refs
        .iter()
        .any(|l| l.name == "HEAD" && l.is_head);
    assert_eq!(
        (after.generation > before.generation, detached),
        (true, true)
    );
}
