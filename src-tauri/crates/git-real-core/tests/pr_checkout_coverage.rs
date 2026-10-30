//! Branch-level coverage for `remote::pr_checkout`: every refspec and source rejection, the
//! switch-only / create / fast-forward / reset paths with and without `reset`, dirty trees,
//! fork URL sources, tag isolation and a damaged `FETCH_HEAD`.

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

/// Commits `file` on a side clone of `bare` and force-pushes it to `target_ref` of `bare`.
/// With `extend` the commit sits on top of the current `target_ref`, else on the default branch.
fn push_commit(bare: &Path, target_ref: &str, file: &str, content: &str, extend: bool) -> String {
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
    if extend {
        common::run_git_ok(&side, &["fetch", "origin", target_ref]);
        common::run_git_ok(&side, &["checkout", "-q", "--detach", "FETCH_HEAD"]);
    }
    let oid = common::commit_file(&side, file, content, &format!("{target_ref} {file}"));
    common::run_git_ok(
        &side,
        &["push", "-q", "origin", &format!("+HEAD:{target_ref}")],
    );
    oid.to_string()
}

fn pr_head(bare: &Path, n: u64, file: &str, content: &str, extend: bool) -> String {
    push_commit(bare, &format!("refs/pull/{n}/head"), file, content, extend)
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

/// Fetches PR `n` and checks out `pr/n`, then switches back to `head`.
fn adopt_pr(session: &RepoSession, path: &Path, head: &str, n: u64) {
    let fetch = fetch_pr(session, n);
    session.checkout_fetch_head(&fetch, n, false).unwrap();
    common::run_git_ok(path, &["switch", head]);
}

// ---------------------------------------------------------------- prepare_ref_fetch

#[test]
fn prepare_ref_fetch_refuses_refspecs_git_would_misread() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    for refspec in [
        "",
        "refs",
        "refs/",
        "HEAD",
        "heads/main",
        "refs/heads/*",
        "refs/pull/*/head",
        "refs/heads/a@{1}",
        "refs/heads/a~1",
        "refs/heads/a^",
        "refs/heads/a?",
        "refs/heads/a[b",
        "refs/heads/a\\b",
        "refs/heads/a\tb",
        "refs/heads/a\nb",
        "refs/heads/a\u{7f}b",
        "refs/heads/a.lock",
        "refs/heads/a/",
        "refs/heads//a",
        "refs/heads/.hidden",
        "refs/heads/a:b",
        ":refs/heads/a",
        "refs/heads/a:",
        "+refs/heads/a",
        "refs/heads/a+b",
        " refs/heads/a",
        "refs/heads/a ",
        "--upload-pack=refs/x",
    ] {
        let err = session.prepare_ref_fetch("origin", refspec).unwrap_err();
        assert!(
            matches!(err, GitError::InvalidBranchName(ref s) if s == refspec),
            "{refspec:?}: {err:?}"
        );
    }
}

#[test]
fn prepare_ref_fetch_accepts_ordinary_and_nested_refs() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    for refspec in [
        "refs/pull/7/head",
        "refs/merge-requests/7/head",
        "refs/heads/feature/deep/name",
        "refs/heads/fix-1_2.3",
        "refs/tags/v1",
    ] {
        assert!(
            session.prepare_ref_fetch("origin", refspec).is_ok(),
            "{refspec}"
        );
    }
}

#[test]
fn prepare_ref_fetch_refuses_every_url_source_that_is_not_plain_https() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    for url in [
        "http://h/x.git",
        "HTTPS://h/x.git",
        "ssh://git@h/x.git",
        "git://h/x.git",
        "file:///srv/x.git",
        "ext::sh://x",
        "https://",
        "https://:443/x",
        "https:///x",
        "https://h x/y",
        "https://h/x\ty",
        "https://h/x\r\n",
        "https://h/\u{7f}",
        "https://h:99999999/x",
        " https://h/x.git",
        "https://h/x.git ",
    ] {
        let err = session
            .prepare_ref_fetch(url, "refs/heads/fix")
            .unwrap_err();
        assert!(
            matches!(err, GitError::InvalidRemoteUrl(ref s) if s == url),
            "{url:?}: {err:?}"
        );
    }
}

#[test]
fn prepare_ref_fetch_checks_the_source_before_the_refspec() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    let err = session
        .prepare_ref_fetch("http://h/x", "not-a-ref")
        .unwrap_err();
    assert!(matches!(err, GitError::InvalidRemoteUrl(_)), "{err:?}");
    let err = session.prepare_ref_fetch("nope", "not-a-ref").unwrap_err();
    assert!(matches!(err, GitError::RemoteNotFound(_)), "{err:?}");
    // A name libgit2 refuses as a remote name never reaches git: an error, not a fetch.
    for name in [
        "ext::sh -c evil",
        "origin ",
        "a b",
        "origin/",
        "--upload-pack=x",
    ] {
        assert!(
            session.prepare_ref_fetch(name, "refs/pull/7/head").is_err(),
            "{name:?}"
        );
    }
    for name in ["", "Origin", "-origin"] {
        let err = session
            .prepare_ref_fetch(name, "refs/pull/7/head")
            .unwrap_err();
        assert!(
            matches!(err, GitError::RemoteNotFound(_)),
            "{name:?}: {err:?}"
        );
    }
}

#[test]
fn a_userinfo_free_https_source_with_a_port_and_path_is_accepted() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch("https://git.corp:8443/ws/repo.git", "refs/heads/fix")
        .unwrap();
    assert_eq!(
        fetch.urls().to_vec(),
        vec!["https://git.corp:8443/ws/repo.git".to_owned()]
    );
}

// ---------------------------------------------------------------- RefFetch::run

#[test]
fn running_a_fetch_for_a_ref_the_server_lacks_is_network_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, _head) = fx();
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch("origin", "refs/pull/404/head")
        .unwrap();

    let err = fetch.run(None).unwrap_err();

    assert!(
        matches!(err, GitError::NetworkFailed { verb: "fetch", .. }),
        "{err:?}"
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/404"), None);
}

#[test]
fn the_fetch_writes_no_remote_tracking_ref_and_no_tags() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    let oid = pr_head(&bare, 7, "a.txt", "a\n", false);
    // A tag on the very commit that gets fetched: plain `git fetch` would auto-follow it.
    common::run_git_ok(&bare, &["tag", "v-from-fork", &oid]);
    let session = RepoSession::open(&path).unwrap();

    fetch_pr(&session, 7);

    let repo = Repository::open(&path).unwrap();
    assert!(repo.tag_names(None).unwrap().is_empty());
    assert!(repo.find_reference("refs/tags/v-from-fork").is_err());
    assert!(repo.find_reference("refs/pull/7/head").is_err());
    assert!(
        repo.find_branch("origin/pr/7", git2::BranchType::Remote)
            .is_err()
    );
    // The object is there, through FETCH_HEAD only.
    assert!(repo.find_commit(oid.parse().unwrap()).is_ok());
}

// ---------------------------------------------------------------- checkout_fetch_head

#[test]
fn the_first_checkout_creates_pr_n_at_the_head_and_leaves_other_branches_alone() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    let before = ref_oid(&path, &format!("refs/heads/{head}"));
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, false).unwrap(),
        checked_out("pr/7")
    );

    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
    assert_eq!(ref_oid(&path, &format!("refs/heads/{head}")), before);
    assert_eq!(common::head_branch_name(&path), "pr/7");
    assert!(path.join("a.txt").exists());
}

#[test]
fn two_pull_requests_get_two_branches() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    let b = pr_head(&bare, 8, "b.txt", "b\n", false);
    let session = RepoSession::open(&path).unwrap();
    for n in [7, 8] {
        let fetch = fetch_pr(&session, n);
        session.checkout_fetch_head(&fetch, n, false).unwrap();
    }
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
    assert_eq!(ref_oid(&path, "refs/heads/pr/8"), Some(b));
    assert_eq!(common::head_branch_name(&path), "pr/8");
}

#[test]
fn checking_out_the_same_unchanged_pr_twice_is_a_noop_switch() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    adopt_pr(&session, &path, &head, 7);
    let fetch = fetch_pr(&session, 7);

    // Same commit: also without `reset`, never NeedsReset.
    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, false).unwrap(),
        checked_out("pr/7")
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
    assert_eq!(common::head_branch_name(&path), "pr/7");
}

#[test]
fn reset_true_does_not_change_the_result_when_pr_n_is_already_at_the_head() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    adopt_pr(&session, &path, &head, 7);
    let fetch = fetch_pr(&session, 7);

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, true).unwrap(),
        checked_out("pr/7")
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
}

#[test]
fn reset_true_never_discards_local_commits_that_contain_the_head() {
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

    // `reset` only moves a branch that diverged; one that is ahead keeps its commits.
    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, true).unwrap(),
        checked_out("pr/7")
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(local.to_string()));
}

#[test]
fn reset_true_also_fast_forwards_when_the_pr_only_moved_ahead() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    adopt_pr(&session, &path, &head, 7);
    let b = pr_head(&bare, 7, "b.txt", "b\n", true);
    let fetch = fetch_pr(&session, 7);

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, true).unwrap(),
        checked_out("pr/7")
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(b));
}

#[test]
fn needs_reset_changes_nothing_not_even_the_checked_out_branch() {
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
    common::write_file(&path, "untracked.txt", "keep me\n");
    pr_head(&bare, 7, "b.txt", "b\n", false);
    let fetch = fetch_pr(&session, 7);

    let outcome = session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(
        outcome,
        CheckoutPrOutcome::NeedsReset {
            branch: "pr/7".to_owned()
        }
    );
    assert_eq!(common::head_branch_name(&path), head);
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(local.to_string()));
    assert!(path.join("untracked.txt").exists());
}

#[test]
fn reset_works_while_pr_n_is_the_checked_out_branch() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    session.checkout_fetch_head(&fetch, 7, false).unwrap();
    common::commit_file(&path, "l.txt", "local\n", "local commit");
    // Force-push: the PR now has a different history from the local pr/7.
    let b = pr_head(&bare, 7, "b.txt", "b\n", false);
    let fetch = fetch_pr(&session, 7);
    assert_eq!(common::head_branch_name(&path), "pr/7");

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, false).unwrap(),
        CheckoutPrOutcome::NeedsReset {
            branch: "pr/7".into()
        }
    );
    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, true).unwrap(),
        checked_out("pr/7")
    );

    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(b));
    assert!(path.join("b.txt").exists());
    assert!(!path.join("l.txt").exists());
    assert_eq!(common::head_branch_name(&path), "pr/7");
}

#[test]
fn a_non_conflicting_dirty_tree_is_carried_over() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    common::write_file(&path, "README.md", "local edit\n");

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, false).unwrap(),
        checked_out("pr/7")
    );

    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "local edit\n"
    );
    assert!(path.join("a.txt").exists());
}

#[test]
fn a_conflicting_dirty_tree_blocks_reset_too_and_moves_nothing() {
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
    pr_head(&bare, 7, "README.md", "pr readme\n", false);
    let fetch = fetch_pr(&session, 7);
    common::write_file(&path, "README.md", "local edit\n");

    let err = session.checkout_fetch_head(&fetch, 7, true).unwrap_err();

    assert!(matches!(err, GitError::CheckoutFailed { .. }), "{err:?}");
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(local.to_string()));
    assert_eq!(common::head_branch_name(&path), head);
}

#[test]
fn checking_out_from_a_detached_head_works() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    common::run_git_ok(&path, &["switch", "--detach", "HEAD"]);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);

    assert_eq!(
        session.checkout_fetch_head(&fetch, 7, false).unwrap(),
        checked_out("pr/7")
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
}

#[test]
fn a_user_branch_named_like_pr_n_prefix_is_not_confused_with_it() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    common::run_git_ok(&path, &["branch", "pr/70"]);
    let a = pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);

    session.checkout_fetch_head(&fetch, 7, false).unwrap();

    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), Some(a));
    assert_ne!(
        ref_oid(&path, "refs/heads/pr/70"),
        ref_oid(&path, "refs/heads/pr/7")
    );
}

#[test]
fn a_damaged_fetch_head_is_an_error_not_a_panic_or_a_wrong_checkout() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    std::fs::write(path.join(".git/FETCH_HEAD"), "this is not a fetch head\n").unwrap();

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::Git2(_) | GitError::RevisionNotFound(_)),
        "{err:?}"
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), None);
}

#[test]
fn an_empty_fetch_head_is_revision_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = fetch_pr(&session, 7);
    std::fs::write(path.join(".git/FETCH_HEAD"), "").unwrap();

    let err = session.checkout_fetch_head(&fetch, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "FETCH_HEAD"),
        "{err:?}"
    );
}

#[test]
fn the_fetch_head_entry_of_another_pr_is_not_used() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, _head) = fx();
    pr_head(&bare, 7, "a.txt", "a\n", false);
    pr_head(&bare, 8, "b.txt", "b\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch7 = session
        .prepare_ref_fetch("origin", "refs/pull/7/head")
        .unwrap();
    fetch_pr(&session, 8); // FETCH_HEAD now holds PR 8 only.

    let err = session.checkout_fetch_head(&fetch7, 7, false).unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "FETCH_HEAD"),
        "{err:?}"
    );
    assert_eq!(ref_oid(&path, "refs/heads/pr/7"), None);
}

// ---------------------------------------------------------------- fork URL sources (Bitbucket)

/// A second bare repository standing in for a fork, reached through an `insteadOf` rewrite of
/// the fork's https URL so no network is involved.
/// Returns (dirs, repo path, fork path, head branch name).
fn fork_fx() -> (Vec<TempDir>, PathBuf, PathBuf, String) {
    let (d, b, path, _bare, head) = fx();
    let (fork_dir, fork) = common::temp_bare_clone(&path);
    // `url.<base>.insteadOf <prefix>` makes git use <base> wherever <prefix> starts a URL.
    common::run_git_ok(
        &path,
        &[
            "config",
            &format!("url.{}.insteadOf", fork.display()),
            "https://bitbucket.org/bob/repo.git",
        ],
    );
    (vec![d, b, fork_dir], path, fork, head)
}

#[test]
fn a_fork_branch_called_main_fetched_by_url_lands_on_pr_n_and_never_touches_local_main() {
    if !common::git_available() {
        return;
    }
    let (_dirs, path, fork, head) = fork_fx();
    let local_main = ref_oid(&path, &format!("refs/heads/{head}"));
    let theirs = push_commit(&fork, &format!("refs/heads/{head}"), "f.txt", "f\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch(
            "https://bitbucket.org/bob/repo.git",
            &format!("refs/heads/{head}"),
        )
        .unwrap();

    fetch.run(None).unwrap();
    let outcome = session.checkout_fetch_head(&fetch, 9, false).unwrap();

    assert_eq!(outcome, checked_out("pr/9"));
    assert_eq!(ref_oid(&path, "refs/heads/pr/9"), Some(theirs));
    assert_eq!(ref_oid(&path, &format!("refs/heads/{head}")), local_main);
    assert!(path.join("f.txt").exists());
}

#[test]
fn a_fork_branch_with_slashes_is_matched_in_fetch_head() {
    if !common::git_available() {
        return;
    }
    let (_dirs, path, fork, _head) = fork_fx();
    let theirs = push_commit(&fork, "refs/heads/feature/deep/x", "f.txt", "f\n", false);
    let session = RepoSession::open(&path).unwrap();
    let fetch = session
        .prepare_ref_fetch(
            "https://bitbucket.org/bob/repo.git",
            "refs/heads/feature/deep/x",
        )
        .unwrap();
    fetch.run(None).unwrap();

    session.checkout_fetch_head(&fetch, 4, false).unwrap();

    assert_eq!(ref_oid(&path, "refs/heads/pr/4"), Some(theirs));
}
