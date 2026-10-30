//! The git side of PR checkout (GR-13a): `prepare_ref_fetch` validation, fetching a PR head
//! into `FETCH_HEAD`, and `checkout_fetch_head` creating, fast-forwarding or resetting
//! `pr/<n>`. Real git against a local bare repository as `origin` (no network).

mod common;

use std::path::{Path, PathBuf};

use git_real_core::hosting::CheckoutPrOutcome;
use git_real_core::remote::pr_checkout::RefFetch;
use git_real_core::{GitError, RepoSession};
use git2::Repository;
use tempfile::TempDir;

/// A repo with an identity whose `origin` is a local bare clone.
/// Returns (dirs, repo path, bare path, head branch name).
fn fx() -> (TempDir, TempDir, PathBuf, PathBuf, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    (dir, bare_dir, path, bare, head)
}

/// Makes one commit adding `file` on a side clone of `bare` and force-pushes it to
/// `refs/pull/<n>/head`. With `extend` the commit sits on top of the current PR head,
/// otherwise on top of the bare repository's default branch. Returns the new oid.
fn pr_head(bare: &Path, n: u64, file: &str, content: &str, extend: bool) -> String {
    let side_dir = tempfile::tempdir().expect("side dir");
    let side = side_dir.path().join("side");
    let out = std::process::Command::new("git")
        .arg("clone")
        .args(["-c", "core.autocrlf=false"])
        .arg(bare)
        .arg(&side)
        .output()
        .expect("spawn git");
    assert!(out.status.success(), "clone failed");
    common::configure_identity(&side);
    let pull_ref = format!("refs/pull/{n}/head");
    if extend {
        common::run_git_ok(&side, &["fetch", "origin", &pull_ref]);
        common::run_git_ok(&side, &["checkout", "-q", "--detach", "FETCH_HEAD"]);
    }
    let oid = common::commit_file(&side, file, content, &format!("pr {n} {file}"));
    common::run_git_ok(
        &side,
        &["push", "-q", "origin", &format!("+HEAD:{pull_ref}")],
    );
    oid.to_string()
}

fn ref_oid(path: &Path, name: &str) -> Option<String> {
    Repository::open(path)
        .unwrap()
        .find_reference(name)
        .ok()
        .and_then(|r| r.target())
        .map(|o| o.to_string())
}

fn fetch_pr(session: &RepoSession, n: u64) -> RefFetch {
    let fetch = session
        .prepare_ref_fetch("origin", &format!("refs/pull/{n}/head"))
        .unwrap();
    fetch.run(None).unwrap();
    fetch
}

fn checked_out(branch: &str) -> CheckoutPrOutcome {
    CheckoutPrOutcome::CheckedOut {
        branch: branch.to_owned(),
    }
}

// A fork PR is fetched from refs/pull/<n>/head and lands on pr/<n>; the user's same-named
// local branch (a fork branch is often called `main`) is never written.
#[test]
fn fork_pr_lands_on_pr_n_and_never_touches_a_same_named_local_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    let head_before = ref_oid(&path, &format!("refs/heads/{head}"));
    let pr = pr_head(&bare, 7, "pr.txt", "pr\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);

    let outcome = session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(outcome, checked_out("pr/7"));
    assert_eq!(common::head_branch_name(&path), "pr/7");
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(pr));
    assert_eq!(ref_oid(&path, &format!("refs/heads/{head}")), head_before);
    let config = Repository::open(&path).unwrap().config().unwrap();
    assert!(config.get_string("branch.pr/7.remote").is_err());
}

// Re-checking out a PR whose branch is behind the new head fast-forwards it.
#[test]
fn an_existing_pr_branch_fast_forwards() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    session.checkout_fetch_head(&fetch, 7, false).unwrap();
    common::run_git_ok(&path, &["switch", &head]);
    let b = pr_head(&bare, 7, "b.txt", "b\n", true);
    let fetch = fetch_pr(&session, 7);

    let outcome = session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(outcome, checked_out("pr/7"));
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(b));
}

// A pr/<n> that already contains the fetched head (the user added commits) is only switched to.
#[test]
fn a_pr_branch_that_already_contains_the_head_is_only_switched_to() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    session.checkout_fetch_head(&fetch, 7, false).unwrap();
    let local = common::commit_file(&path, "l.txt", "local\n", "local commit");
    common::run_git_ok(&path, &["switch", &head]);
    let fetch = fetch_pr(&session, 7);

    let outcome = session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(outcome, checked_out("pr/7"));
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(local.to_string()));
    assert_eq!(common::head_branch_name(&path), "pr/7");
}

// A pr/<n> with local commits that the PR head (force-pushed) does not contain needs a reset;
// nothing changes until the caller asks for it.
#[test]
fn a_diverged_pr_branch_needs_a_reset_and_reset_moves_it() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    session.checkout_fetch_head(&fetch, 7, false).unwrap();
    let local = common::commit_file(&path, "l.txt", "local\n", "local commit");
    common::run_git_ok(&path, &["switch", &head]);
    let b = pr_head(&bare, 7, "b.txt", "b\n", false);
    let fetch = fetch_pr(&session, 7);

    let outcome = session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(
        outcome,
        CheckoutPrOutcome::NeedsReset {
            branch: "pr/7".to_owned()
        }
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(local.to_string()));
    assert_eq!(common::head_branch_name(&path), head);

    let reset = session.checkout_fetch_head(&fetch, 7, true).unwrap();

    assert_eq!(reset, checked_out("pr/7"));
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(b));
}

// Uncommitted local edits that the PR head would overwrite block the switch like any other.
#[test]
fn a_conflicting_dirty_tree_blocks_checkout_with_checkout_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "README.md", "changed by the pr\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    common::write_file(&path, "README.md", "local edit\n");

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(matches!(err, GitError::CheckoutFailed { .. }), "{err:?}");
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), None);
}

// A branch that differs from pr/<n> only by case blocks the checkout on a case-insensitive repo.
#[test]
fn checkout_pr_case_variant_of_existing_branch_is_case_collision() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    pr_head(&bare, 7, "pr.txt", "pr\n", false);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("PR/7", &commit, false).unwrap();
    }
    let before = ref_oid(&path, "refs/heads/PR/7");
    common::set_ignorecase(&path, true);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::BranchCaseCollision { ref requested, ref existing } if requested == "pr/7" && existing == "PR/7"),
        "{err:?}"
    );
    assert_eq!(ref_oid(&path, "refs/heads/PR/7"), before);
    assert_eq!(common::head_branch_name(&path), head);
}

// Checking out without having fetched anything is a plain error, not a panic.
#[test]
fn checkout_fetch_head_without_a_fetch_head_is_revision_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch("origin", "refs/pull/7/head")
        .unwrap();

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "FETCH_HEAD"),
        "{err:?}"
    );
}

// Only the FETCH_HEAD entry of the fetched refspec counts: a later `git fetch origin`
// overwrites FETCH_HEAD with branch entries and must not redirect pr/<n>.
#[test]
fn checkout_fetch_head_ignores_other_fetch_head_entries() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    common::run_git_ok(&path, &["fetch", "origin"]);

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "FETCH_HEAD"),
        "{err:?}"
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), None);
}

// prepare_ref_fetch accepts a remote name or an https URL as the source and a refs/ refspec
// without destination, and refuses everything else before any process runs.
#[test]
fn prepare_ref_fetch_validates_source_and_refspec() {
    let (_d, _b, path, bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();

    let nope = session
        .prepare_ref_fetch("nope", "refs/pull/7/head")
        .unwrap_err();
    assert!(
        matches!(nope, GitError::RemoteNotFound(ref s) if s == "nope"),
        "{nope:?}"
    );
    let dash = session
        .prepare_ref_fetch("-x", "refs/pull/7/head")
        .unwrap_err();
    assert!(matches!(dash, GitError::RemoteNotFound(_)), "{dash:?}");
    for url in ["http://h/x.git", "https://h/x y", "https://h/x\n"] {
        let err = session
            .prepare_ref_fetch(url, "refs/pull/7/head")
            .unwrap_err();
        assert!(
            matches!(err, GitError::InvalidRemoteUrl(_)),
            "{url:?}: {err:?}"
        );
    }
    for refspec in [
        "pull/7/head",
        "+refs/pull/7/head",
        "refs/pull/7/head:refs/heads/main",
        "refs/heads/a..b",
        "refs/heads/x y",
    ] {
        let err = session.prepare_ref_fetch("origin", refspec).unwrap_err();
        assert!(
            matches!(err, GitError::InvalidBranchName(ref s) if s == refspec),
            "{refspec:?}: {err:?}"
        );
    }
    let origin = session
        .prepare_ref_fetch("origin", "refs/pull/7/head")
        .unwrap();
    assert_eq!(
        origin.urls().to_vec(),
        vec![bare.to_str().unwrap().to_owned()]
    );
    let fork = session
        .prepare_ref_fetch("https://bitbucket.org/bob/repo.git", "refs/heads/fix")
        .unwrap();
    assert_eq!(
        fork.urls().to_vec(),
        vec!["https://bitbucket.org/bob/repo.git".to_owned()]
    );
}

// A Bitbucket-style fork fetch of `refs/heads/<branch>`: git writes `branch 'feat/x' of <url>`
// to FETCH_HEAD and libgit2 must map that line back to `refs/heads/feat/x`.
#[test]
fn bitbucket_style_fork_fetch_of_refs_heads_lands_on_pr_n() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    let side_dir = tempfile::tempdir().expect("side dir");
    let side = side_dir.path().join("side");
    let out = std::process::Command::new("git")
        .arg("clone")
        .args(["-c", "core.autocrlf=false"])
        .arg(&bare)
        .arg(&side)
        .output()
        .expect("spawn git");
    assert!(out.status.success(), "clone failed");
    common::configure_identity(&side);
    common::run_git_ok(&side, &["switch", "-c", "feat/x"]);
    let oid = common::commit_file(&side, "x.txt", "x\n", "feat x");
    common::run_git_ok(&side, &["push", "-q", "origin", "feat/x"]);
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch("origin", "refs/heads/feat/x")
        .unwrap();
    fetch.run(None).unwrap();

    let outcome = session.checkout_fetch_head(&fetch, 11, false).unwrap();

    assert_eq!(outcome, checked_out("pr/11"));
    assert_eq!(ref_oid(&path, "refs/heads/pr/11"), Some(oid.to_string()));
}
