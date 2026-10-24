//! The pull request draft: commits ahead of `origin/<target>`, the title and body prefill,
//! and branch-name humanizing (GR-13 spec §5.3). Real git against a local bare repository
//! as `origin` (no network).

mod common;

use std::path::PathBuf;

use git_real_core::remote::pr_draft::humanize_branch;
use git_real_core::{GitError, PullRequestDraft, RepoSession};
use git2::{Repository, Signature};
use tempfile::TempDir;

/// A repo with an identity whose `origin` is a local bare clone, fetched.
/// Returns (dirs, repo path, head branch name).
fn fx() -> (TempDir, TempDir, PathBuf, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    (dir, bare_dir, path, head)
}

/// Switches to a new branch `name` at the current HEAD.
fn on_branch(path: &std::path::Path, name: &str) {
    common::run_git_ok(path, &["switch", "-q", "-c", name]);
}

fn draft(path: &std::path::Path, target: &str) -> Result<PullRequestDraft, GitError> {
    RepoSession::open(path).unwrap().pull_request_draft(target)
}

// Branch names read as sentences: last path segment, separators to spaces, first letter up.
#[test]
fn humanizes_branch_names() {
    for (name, want) in [
        ("feature/add-login", "Add login"),
        ("fix_typo", "Fix typo"),
        ("GR-13-hosting", "GR 13 hosting"),
        ("main", "Main"),
        ("a/b/c--d__e", "C d e"),
        ("x", "X"),
    ] {
        assert_eq!(humanize_branch(name), want, "{name}");
    }
}

// Exactly one commit ahead: its subject is the title and the rest of its message the body.
#[test]
fn one_commit_ahead_uses_its_subject_and_body() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/login");
    common::commit_file(&path, "login.txt", "l\n", "Add login\n\nWhy\n\nDetails\n");

    assert_eq!(
        draft(&path, &head).unwrap(),
        PullRequestDraft {
            title: "Add login".into(),
            body: "Why\n\nDetails".into(),
            ahead: 1
        }
    );
}

#[test]
fn a_subject_only_commit_has_an_empty_body() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/login");
    common::commit_file(&path, "login.txt", "l\n", "Just a subject");

    let got = draft(&path, &head).unwrap();

    assert_eq!(
        (got.title.as_str(), got.body.as_str(), got.ahead),
        ("Just a subject", "", 1)
    );
}

// Several commits: no single message speaks for the branch, so the name does.
#[test]
fn several_commits_ahead_humanize_the_branch_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/add-login");
    common::commit_file(&path, "a.txt", "a\n", "first");
    common::commit_file(&path, "b.txt", "b\n", "second");

    assert_eq!(
        draft(&path, &head).unwrap(),
        PullRequestDraft {
            title: "Add login".into(),
            body: String::new(),
            ahead: 2
        }
    );
}

// One commit whose message is empty has no subject to use, so the branch name speaks.
#[test]
fn a_single_commit_with_an_empty_message_uses_the_humanized_branch_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/add-login");
    {
        let repo = Repository::open(&path).unwrap();
        let sig = Signature::now("Test User", "test@example.com").unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "", &tree, &[&parent])
            .unwrap();
    }

    assert_eq!(
        draft(&path, &head).unwrap(),
        PullRequestDraft {
            title: "Add login".into(),
            body: String::new(),
            ahead: 1
        }
    );
}

#[test]
fn no_commits_ahead_is_ahead_zero_with_the_humanized_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/no-work-yet");

    assert_eq!(
        draft(&path, &head).unwrap(),
        PullRequestDraft {
            title: humanize_branch("feature/no-work-yet"),
            body: String::new(),
            ahead: 0
        }
    );
}

// The count stops at 1000 so a huge branch does not walk its whole history.
#[test]
fn ahead_saturates_at_one_thousand() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/add-login");
    {
        // In-process commits on the same tree: the CLI would take seconds for 1001.
        let repo = Repository::open(&path).unwrap();
        let sig = Signature::now("Test User", "test@example.com").unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        for i in 0..1001 {
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("c{i}"),
                &tree,
                &[&parent],
            )
            .unwrap();
        }
    }

    assert_eq!(
        draft(&path, &head).unwrap(),
        PullRequestDraft {
            title: "Add login".into(),
            body: String::new(),
            ahead: 1000
        }
    );
}

// Errors: unknown target, invalid target, detached and unborn HEAD.
#[test]
fn a_missing_target_is_revision_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _head) = fx();
    on_branch(&path, "feature/login");

    let err = draft(&path, "nope").unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "origin/nope"),
        "{err:?}"
    );
}

#[test]
fn an_invalid_target_name_is_invalid_branch_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _head) = fx();
    on_branch(&path, "feature/login");

    let dash = draft(&path, "-x").unwrap_err();
    let space = draft(&path, "a b").unwrap_err();

    assert!(
        matches!(dash, GitError::InvalidBranchName(ref s) if s == "-x"),
        "{dash:?}"
    );
    assert!(matches!(space, GitError::InvalidBranchName(_)), "{space:?}");
}

#[test]
fn a_detached_head_is_detached_head() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    common::run_git_ok(&path, &["checkout", "-q", "--detach"]);

    let err = draft(&path, &head).unwrap_err();

    assert!(matches!(err, GitError::DetachedHead), "{err:?}");
}

#[test]
fn an_unborn_head_is_unborn_head() {
    // `git init` only, no origin: HEAD is checked before the target lookup.
    let (_d, path) = common::temp_repo_unborn();

    let err = draft(&path, "main").unwrap_err();

    assert!(matches!(err, GitError::UnbornHead), "{err:?}");
}

#[test]
fn draft_serializes_camel_case() {
    let value = serde_json::to_value(PullRequestDraft {
        title: "t".into(),
        body: "b".into(),
        ahead: 1,
    })
    .unwrap();

    assert_eq!(value, serde_json::json!({"title":"t","body":"b","ahead":1}));
}
