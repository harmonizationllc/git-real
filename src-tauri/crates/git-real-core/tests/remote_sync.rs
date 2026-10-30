//! GR-12 fetch, pull, push and remote management against real temp
//! repositories, with local bare repositories as remotes (no network) and the
//! system git CLI.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    GitError, NetworkErrorKind, OperationOutcome, OperationState, PullMode, PushTarget, RemoteInfo,
    RepoSession,
};
use git2::{BranchType, Repository};
use tempfile::TempDir;

/// `path` tracks `origin` (a bare clone of it) on its HEAD branch; `other` is
/// a second clone of the bare repo that pushes "someone else's" commits.
struct Fx {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    other: PathBuf,
    head: String,
    session: RepoSession,
}

fn fx() -> Fx {
    let (d1, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    let d3 = tempfile::tempdir().unwrap();
    common::run_git_ok(
        d3.path(),
        &[
            "clone",
            "-c",
            "core.autocrlf=false",
            "-q",
            bare.to_str().unwrap(),
            "other",
        ],
    );
    let other = d3.path().join("other");
    common::configure_identity(&other);
    let session = RepoSession::open(&path).unwrap();
    Fx {
        _dirs: [d1, d2, d3],
        path,
        bare,
        other,
        head,
        session,
    }
}

impl Fx {
    /// Commits `file` in `other` and pushes it; returns the new tip.
    fn push_from_other(&self, file: &str, content: &str) -> String {
        let oid = common::commit_file(&self.other, file, content, "from other").to_string();
        common::run_git_ok(&self.other, &["push", "-q", "origin", "HEAD"]);
        oid
    }
    fn commit_here(&self, file: &str, content: &str) -> String {
        common::commit_file(&self.path, file, content, "local").to_string()
    }
    fn head_oid(&self) -> String {
        tip(&self.path, "HEAD").unwrap()
    }
    fn bare_tip(&self, branch: &str) -> Option<String> {
        tip(&self.bare, &format!("refs/heads/{branch}"))
    }
    fn tracking(&self) -> Option<String> {
        tip(&self.path, &format!("refs/remotes/origin/{}", self.head))
    }
    fn fetch(&self) {
        self.session.prepare_fetch().unwrap().run(None).unwrap();
    }
    fn set_config(&self, key: &str, value: &str) {
        Repository::open(&self.path)
            .unwrap()
            .config()
            .unwrap()
            .set_str(key, value)
            .unwrap();
    }
    fn reopen(&self) -> RepoSession {
        RepoSession::open(&self.path).unwrap()
    }
}

fn tip(repo: &Path, spec: &str) -> Option<String> {
    let repo = Repository::open(repo).ok()?;
    let commit = repo.revparse_single(spec).ok()?.peel_to_commit().ok()?;
    Some(commit.id().to_string())
}

#[track_caller]
fn network_failure(err: GitError) -> (&'static str, NetworkErrorKind, bool, String) {
    match err {
        GitError::NetworkFailed {
            verb,
            kind,
            https,
            stderr,
            ..
        } => (verb, kind, https, stderr),
        other => panic!("expected NetworkFailed, got {other:?}"),
    }
}

/// A repo whose HEAD branch tracks `origin` (git2 only, no CLI).
fn tracked() -> (TempDir, TempDir, PathBuf, String, RepoSession) {
    let (d1, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    let session = RepoSession::open(&path).unwrap();
    (d1, d2, path, head, session)
}

fn plain() -> (TempDir, PathBuf, RepoSession) {
    let (d, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).unwrap();
    (d, path, session)
}

fn info(name: &str, url: &str, push: Option<&str>) -> RemoteInfo {
    RemoteInfo {
        name: name.into(),
        fetch_url: url.into(),
        push_url: push.map(Into::into),
    }
}

fn set_upstream(remote: &str, branch: &str) -> PushTarget {
    PushTarget::SetUpstream {
        remote: remote.into(),
        branch: branch.into(),
    }
}

// ---------- fetch ----------

#[test]
fn prepare_fetch_without_remotes_is_no_remotes() {
    let (_d, _p, session) = plain();
    assert!(matches!(session.prepare_fetch(), Err(GitError::NoRemotes)));
}

#[test]
fn fetch_updates_the_remote_tracking_refs() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.fetch();
    assert_eq!(fx.tracking().as_deref(), Some(theirs.as_str()));
}

#[test]
fn fetch_fetches_every_remote() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("mirror", fx.bare.to_str().unwrap())
        .unwrap();
    fx.reopen().prepare_fetch().unwrap().run(None).unwrap();
    assert!(tip(&fx.path, &format!("refs/remotes/mirror/{}", fx.head)).is_some());
}

#[test]
fn fetch_of_a_missing_remote_is_network_failed_repo_not_found() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("gone", "/nonexistent/gone.git")
        .unwrap();
    let err = fx.reopen().prepare_fetch().unwrap().run(None).unwrap_err();
    let (verb, kind, https, stderr) = network_failure(err);
    assert_eq!(
        (verb, kind, https),
        ("fetch", NetworkErrorKind::RepoNotFound, false),
        "{stderr}"
    );
}

#[test]
fn https_flag_is_false_for_local_and_ssh_remotes() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("ssh", "git@example.test:me/x.git")
        .unwrap();
    assert!(!fx.reopen().prepare_fetch().unwrap().https());
}

#[test]
fn https_flag_follows_insteadof_rewrites() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("gh", "gh:me/x.git")
        .unwrap();
    assert!(!fx.reopen().prepare_fetch().unwrap().https());
    fx.set_config("url.https://github.com/.insteadOf", "gh:");
    assert!(fx.reopen().prepare_fetch().unwrap().https());
}

// ---------- fetch one remote (GR-12 follow-up W3) ----------

#[test]
fn prepare_fetch_remote_of_an_unknown_remote_is_remote_not_found() {
    let fx = fx();
    assert!(matches!(
        fx.session.prepare_fetch_remote("nope"),
        Err(GitError::RemoteNotFound(name)) if name == "nope"
    ));
}

#[test]
fn prepare_fetch_remote_without_any_remotes_is_remote_not_found_not_no_remotes() {
    let (_d, _p, session) = plain();
    assert!(matches!(
        session.prepare_fetch_remote("origin"),
        Err(GitError::RemoteNotFound(name)) if name == "origin"
    ));
}

#[test]
fn prepare_fetch_remote_with_a_leading_dash_is_remote_not_found() {
    let fx = fx();
    for name in ["-x", "--all", "--upload-pack=evil", "-"] {
        assert!(
            matches!(
                fx.session.prepare_fetch_remote(name),
                Err(GitError::RemoteNotFound(ref n)) if n == name
            ),
            "{name}"
        );
    }
}

#[test]
fn prepare_fetch_remote_with_an_empty_name_is_remote_not_found() {
    let fx = fx();
    assert!(matches!(
        fx.session.prepare_fetch_remote(""),
        Err(GitError::RemoteNotFound(name)) if name.is_empty()
    ));
}

#[test]
fn fetch_remote_updates_only_that_remotes_tracking_refs() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let (_d, mirror_bare) = common::temp_bare_clone(&fx.path);
    Repository::open(&fx.path)
        .unwrap()
        .remote("mirror", mirror_bare.to_str().unwrap())
        .unwrap();
    let before = fx.tracking();
    fx.push_from_other("b.txt", "b\n"); // origin moved; a fetch of everything would see it
    fx.reopen()
        .prepare_fetch_remote("mirror")
        .unwrap()
        .run(None)
        .unwrap();
    assert!(tip(&fx.path, &format!("refs/remotes/mirror/{}", fx.head)).is_some());
    assert_eq!(fx.tracking(), before);
}

#[test]
fn fetch_remote_of_the_origin_does_not_create_other_remotes_tracking_refs() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let (_d, mirror_bare) = common::temp_bare_clone(&fx.path);
    Repository::open(&fx.path)
        .unwrap()
        .remote("mirror", mirror_bare.to_str().unwrap())
        .unwrap();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.reopen()
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(fx.tracking().as_deref(), Some(theirs.as_str()));
    assert_eq!(
        tip(&fx.path, &format!("refs/remotes/mirror/{}", fx.head)),
        None
    );
}

#[test]
fn fetch_remote_failure_is_network_failed_with_verb_fetch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("gone", "/nonexistent/gone.git")
        .unwrap();
    let err = fx
        .reopen()
        .prepare_fetch_remote("gone")
        .unwrap()
        .run(None)
        .unwrap_err();
    let (verb, kind, https, stderr) = network_failure(err);
    assert_eq!(
        (verb, kind, https),
        ("fetch", NetworkErrorKind::RepoNotFound, false),
        "{stderr}"
    );
}

#[test]
fn fetch_remote_https_flag_counts_only_that_remote() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("web", "https://example.test/me/x.git")
        .unwrap();
    let session = fx.reopen();
    assert!(!session.prepare_fetch_remote("origin").unwrap().https());
    assert!(session.prepare_fetch_remote("web").unwrap().https());
}

#[test]
fn fetch_remote_https_flag_is_false_when_only_another_remote_is_https() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("ssh", "git@example.test:me/x.git")
        .unwrap();
    Repository::open(&fx.path)
        .unwrap()
        .remote("web", "https://example.test/me/x.git")
        .unwrap();
    assert!(!fx.reopen().prepare_fetch_remote("ssh").unwrap().https());
}

#[test]
fn fetch_remote_https_flag_follows_insteadof_rewrites() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("gh", "gh:me/x.git")
        .unwrap();
    assert!(!fx.reopen().prepare_fetch_remote("gh").unwrap().https());
    fx.set_config("url.https://github.com/.insteadOf", "gh:");
    assert!(fx.reopen().prepare_fetch_remote("gh").unwrap().https());
}

// ---------- pull ----------

#[test]
fn pull_default_mode_follows_pull_rebase() {
    let (_d, path, session) = plain();
    let global_unset = git2::Config::open_default()
        .and_then(|c| c.get_string("pull.rebase"))
        .is_err();
    if global_unset {
        assert_eq!(session.pull_default_mode().unwrap(), PullMode::Merge);
    }
    let cases = [
        ("false", PullMode::Merge),
        ("no", PullMode::Merge),
        ("true", PullMode::Rebase),
        ("yes", PullMode::Rebase),
        ("1", PullMode::Rebase),
        ("merges", PullMode::Rebase),
        ("interactive", PullMode::Rebase),
        ("bogus", PullMode::Merge),
    ];
    for (value, want) in cases {
        Repository::open(&path)
            .unwrap()
            .config()
            .unwrap()
            .set_str("pull.rebase", value)
            .unwrap();
        assert_eq!(
            RepoSession::open(&path)
                .unwrap()
                .pull_default_mode()
                .unwrap(),
            want,
            "{value}"
        );
    }
}

#[test]
fn branch_rebase_overrides_pull_rebase() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config.set_str("pull.rebase", "true").unwrap();
    config
        .set_str(&format!("branch.{head}.rebase"), "false")
        .unwrap();
    assert_eq!(
        RepoSession::open(&path)
            .unwrap()
            .pull_default_mode()
            .unwrap(),
        PullMode::Merge
    );
    config.set_str("pull.rebase", "false").unwrap();
    config
        .set_str(&format!("branch.{head}.rebase"), "true")
        .unwrap();
    assert_eq!(
        RepoSession::open(&path)
            .unwrap()
            .pull_default_mode()
            .unwrap(),
        PullMode::Rebase
    );
}

#[test]
fn prepare_pull_and_push_on_an_unborn_head_are_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::UnbornHead)));
    assert!(matches!(
        session.prepare_push(&PushTarget::Upstream, false, "main"),
        Err(GitError::UnbornHead)
    ));
}

#[test]
fn prepare_pull_and_push_on_a_detached_head_are_detached_head() {
    let (_d, path, _s) = plain();
    let repo = Repository::open(&path).unwrap();
    repo.set_head_detached(repo.head().unwrap().target().unwrap())
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(
        session.prepare_pull(),
        Err(GitError::DetachedHead)
    ));
    assert!(matches!(
        session.prepare_push(&PushTarget::Upstream, false, "main"),
        Err(GitError::DetachedHead)
    ));
    assert!(matches!(
        session.prepare_push(&set_upstream("origin", "b"), true, "main"),
        Err(GitError::DetachedHead)
    ));
}

#[test]
fn prepare_pull_and_push_without_an_upstream_are_no_upstream() {
    let (_d, path, session) = plain();
    let head = common::head_branch_name(&path);
    assert!(matches!(session.prepare_pull(), Err(GitError::NoUpstream)));
    assert!(matches!(
        session.prepare_push(&PushTarget::Upstream, false, &head),
        Err(GitError::NoUpstream)
    ));
}

#[test]
fn an_upstream_on_the_local_repository_is_no_upstream() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config
        .set_str(&format!("branch.{head}.remote"), ".")
        .unwrap();
    config
        .set_str(
            &format!("branch.{head}.merge"),
            &format!("refs/heads/{head}"),
        )
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::NoUpstream)));
    assert!(matches!(
        session.prepare_push(&PushTarget::Upstream, false, &head),
        Err(GitError::NoUpstream)
    ));
}

// Architect R1: an upstream whose remote is not configured is RemoteNotFound,
// not NoUpstream.
#[test]
fn an_upstream_on_a_remote_that_is_not_configured_is_remote_not_found() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config
        .set_str(&format!("branch.{head}.remote"), "gone")
        .unwrap();
    config
        .set_str(
            &format!("branch.{head}.merge"),
            &format!("refs/heads/{head}"),
        )
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(matches!(session.prepare_pull(), Err(GitError::RemoteNotFound(r)) if r == "gone"));
    assert!(matches!(
        session.prepare_push(&PushTarget::Upstream, false, &head),
        Err(GitError::RemoteNotFound(r)) if r == "gone"
    ));
}

// Architect advisory: checkout is not gated by the network mutation, so HEAD
// can move between prepare/fetch and integrate. The pull must not merge the
// upstream into whatever branch is now checked out.
#[test]
fn integrate_pull_refuses_when_head_left_the_prepared_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.push_from_other("b.txt", "b\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    fx.session
        .create_and_checkout_branch("topic", None)
        .unwrap();
    let topic_before = fx.head_oid();
    for mode in [PullMode::Merge, PullMode::Rebase] {
        let err = fx.session.integrate_pull(&pull, mode).unwrap_err();
        assert!(matches!(err, GitError::OperationInProgress), "{err:?}");
    }
    assert_eq!(fx.head_oid(), topic_before);
}

#[test]
fn prepare_pull_during_a_merge_is_operation_in_progress() {
    let (_d, path, _s) = plain();
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    std::fs::write(path.join(".git").join("MERGE_HEAD"), format!("{head}\n")).unwrap();
    assert!(matches!(
        RepoSession::open(&path).unwrap().prepare_pull(),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn prepare_pull_names_the_upstream_remote_and_ref() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let pull = fx.session.prepare_pull().unwrap();
    assert_eq!(
        (pull.remote(), pull.upstream()),
        ("origin", format!("origin/{}", fx.head).as_str())
    );
    assert!(!pull.https());
}

#[test]
fn pull_merge_fast_forwards_without_a_merge_commit() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(
        fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(),
        OperationOutcome::Completed
    );
    assert_eq!(fx.head_oid(), theirs);
}

#[test]
fn pull_when_up_to_date_completes_and_changes_nothing() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let before = fx.head_oid();
    for mode in [PullMode::Merge, PullMode::Rebase] {
        let pull = fx.session.prepare_pull().unwrap();
        pull.fetch(None).unwrap();
        assert_eq!(
            fx.session.integrate_pull(&pull, mode).unwrap(),
            OperationOutcome::Completed
        );
        assert_eq!(fx.head_oid(), before);
    }
}

#[test]
fn pull_merge_of_diverged_history_records_a_merge_commit() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let ours = fx.commit_here("c.txt", "c\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(
        fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(),
        OperationOutcome::Completed
    );
    let repo = Repository::open(&fx.path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let parents: Vec<String> = head.parent_ids().map(|o| o.to_string()).collect();
    assert_eq!(parents, [ours, theirs]);
}

#[test]
fn pull_rebase_replays_local_commits_onto_the_upstream() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.commit_here("c.txt", "c\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(
        fx.session.integrate_pull(&pull, PullMode::Rebase).unwrap(),
        OperationOutcome::Completed
    );
    let repo = Repository::open(&fx.path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.parent_id(0).unwrap().to_string(), theirs);
    assert!(head.tree().unwrap().get_name("c.txt").is_some());
}

#[test]
fn pull_with_conflicting_changes_reports_conflicts() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.push_from_other("README.md", "theirs\n");
    fx.commit_here("README.md", "ours\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    assert_eq!(
        fx.session.integrate_pull(&pull, PullMode::Merge).unwrap(),
        OperationOutcome::Conflicts
    );
    assert!(matches!(
        fx.session.operation_state(),
        OperationState::Merge { .. }
    ));
}

#[test]
fn pull_fetch_failure_is_network_failed_with_verb_pull() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote_set_url("origin", "/nonexistent/gone.git")
        .unwrap();
    let err = fx.reopen().prepare_pull().unwrap().fetch(None).unwrap_err();
    let (verb, kind, https, _) = network_failure(err);
    assert_eq!(
        (verb, kind, https),
        ("pull", NetworkErrorKind::RepoNotFound, false)
    );
}

#[test]
fn pull_https_flag_follows_the_upstream_remote_url() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote_set_url("origin", "https://example.test/me/x.git")
        .unwrap();
    assert!(fx.reopen().prepare_pull().unwrap().https());
}

// ---------- push ----------

#[test]
fn prepare_set_upstream_push_checks_the_remote_then_the_branch_name() {
    let (_d, path, _s) = plain();
    let head = common::head_branch_name(&path);
    Repository::open(&path)
        .unwrap()
        .remote("origin", "/srv/x.git")
        .unwrap();
    let session = RepoSession::open(&path).unwrap();
    assert!(
        matches!(session.prepare_push(&set_upstream("nope", "b"), false, &head), Err(GitError::RemoteNotFound(r)) if r == "nope")
    );
    assert!(matches!(
        session.prepare_push(&set_upstream("-x", "b"), false, &head),
        Err(GitError::RemoteNotFound(_))
    ));
    assert!(matches!(
        session.prepare_push(&set_upstream("nope", "bad..name"), false, &head),
        Err(GitError::RemoteNotFound(_))
    ));
    for bad in ["bad..name", "-b", ""] {
        assert!(
            matches!(
                session.prepare_push(&set_upstream("origin", bad), false, &head),
                Err(GitError::InvalidBranchName(_))
            ),
            "{bad:?}"
        );
    }
}

#[test]
fn push_sends_head_to_the_upstream_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx
        .session
        .prepare_push(&PushTarget::Upstream, false, &fx.head)
        .unwrap();
    assert_eq!(
        (push.remote(), push.branch(), push.lease()),
        ("origin", fx.head.as_str(), None)
    );
    assert!(!push.https());
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(ours.as_str()));
}

// I1: the push names the branch the caller saw. When HEAD is on another branch it is
// OperationInProgress and nothing reaches the remote.
fn fx_on_another_branch() -> (Fx, String) {
    let fx = fx();
    fx.session
        .create_and_checkout_branch("other", None)
        .unwrap();
    let before = fx.bare_tip(&fx.head).unwrap();
    fx.commit_here("o.txt", "o\n");
    (fx, before)
}

#[test]
fn push_is_operation_in_progress_when_head_is_not_the_expected_branch() {
    let (fx, _) = fx_on_another_branch();
    assert!(matches!(
        fx.session
            .prepare_push(&PushTarget::Upstream, false, &fx.head),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn force_push_is_operation_in_progress_when_head_is_not_the_expected_branch() {
    let (fx, _) = fx_on_another_branch();
    assert!(matches!(
        fx.session
            .prepare_push(&PushTarget::Upstream, true, &fx.head),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn set_upstream_push_is_operation_in_progress_when_head_is_not_the_expected_branch() {
    let (fx, _) = fx_on_another_branch();
    assert!(matches!(
        fx.session
            .prepare_push(&set_upstream("origin", "topic-pub"), false, &fx.head),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn a_mismatched_push_leaves_the_remote_untouched() {
    if !common::git_available() {
        return;
    }
    let (fx, before) = fx_on_another_branch();
    let _ = fx
        .session
        .prepare_push(&PushTarget::Upstream, true, &fx.head)
        .and_then(|p| p.run(None));
    let _ = fx
        .session
        .prepare_push(&set_upstream("origin", "topic-pub"), false, &fx.head)
        .and_then(|p| p.run(None));
    assert_eq!(
        (
            fx.bare_tip(&fx.head),
            fx.bare_tip("topic-pub"),
            fx.bare_tip("other")
        ),
        (Some(before), None, None)
    );
}

#[test]
fn the_expected_branch_check_comes_before_the_upstream_check() {
    let (fx, _) = fx_on_another_branch();
    // "other" has no upstream: a matching push would be NoUpstream, a mismatching one is not.
    assert!(matches!(
        fx.session
            .prepare_push(&PushTarget::Upstream, false, "other"),
        Err(GitError::NoUpstream)
    ));
    assert!(matches!(
        fx.session
            .prepare_push(&PushTarget::Upstream, false, "nope"),
        Err(GitError::OperationInProgress)
    ));
}

#[test]
fn set_upstream_push_of_the_expected_branch_publishes_that_branch() {
    if !common::git_available() {
        return;
    }
    let (fx, _) = fx_on_another_branch();
    let ours = fx.head_oid();
    fx.session
        .prepare_push(&set_upstream("origin", "other-pub"), false, "other")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(fx.bare_tip("other-pub").as_deref(), Some(ours.as_str()));
}

#[test]
fn push_to_an_upstream_with_another_name_updates_that_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    common::run_git_ok(
        &fx.path,
        &["push", "-q", "origin", "HEAD:refs/heads/published"],
    );
    common::fetch_remote(&fx.path, "origin");
    Repository::open(&fx.path)
        .unwrap()
        .find_branch(&fx.head, BranchType::Local)
        .unwrap()
        .set_upstream(Some("origin/published"))
        .unwrap();
    let before = fx.bare_tip(&fx.head);
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx
        .reopen()
        .prepare_push(&PushTarget::Upstream, false, &fx.head)
        .unwrap();
    assert_eq!(push.branch(), "published");
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip("published").as_deref(), Some(ours.as_str()));
    assert_eq!(fx.bare_tip(&fx.head), before);
}

#[test]
fn set_upstream_push_publishes_the_branch_and_records_the_upstream() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.session
        .create_and_checkout_branch("topic", None)
        .unwrap();
    let ours = fx.commit_here("t.txt", "t\n");
    let push = fx
        .session
        .prepare_push(&set_upstream("origin", "topic-pub"), false, "topic")
        .unwrap();
    assert_eq!(
        (push.remote(), push.branch(), push.lease()),
        ("origin", "topic-pub", None)
    );
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip("topic-pub").as_deref(), Some(ours.as_str()));
    let config = Repository::open(&fx.path)
        .unwrap()
        .config()
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(config.get_str("branch.topic.remote").unwrap(), "origin");
    assert_eq!(
        config.get_str("branch.topic.merge").unwrap(),
        "refs/heads/topic-pub"
    );
}

#[test]
fn push_behind_the_remote_is_push_rejected_non_fast_forward() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.push_from_other("b.txt", "b\n");
    fx.commit_here("c.txt", "c\n");
    let err = fx
        .session
        .prepare_push(&PushTarget::Upstream, false, &fx.head)
        .unwrap()
        .run(None)
        .unwrap_err();
    let (verb, kind, https, stderr) = network_failure(err);
    assert_eq!(
        (verb, kind, https),
        ("push", NetworkErrorKind::PushRejectedNonFastForward, false),
        "{stderr}"
    );
    assert!(stderr.contains("(fetch first)"), "{stderr}");
    fx.fetch();
    let err = fx
        .session
        .prepare_push(&PushTarget::Upstream, false, &fx.head)
        .unwrap()
        .run(None)
        .unwrap_err();
    let (_, kind, _, stderr) = network_failure(err);
    assert_eq!(kind, NetworkErrorKind::PushRejectedNonFastForward);
    assert!(stderr.contains("(non-fast-forward)"), "{stderr}");
}

#[test]
fn force_push_with_a_holding_lease_replaces_the_remote_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = fx.push_from_other("b.txt", "b\n");
    fx.fetch();
    let ours = fx.commit_here("c.txt", "c\n");
    let push = fx
        .session
        .prepare_push(&PushTarget::Upstream, true, &fx.head)
        .unwrap();
    assert_eq!(
        push.lease(),
        Some(format!("refs/heads/{}:{theirs}", fx.head).as_str())
    );
    push.run(None).unwrap();
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(ours.as_str()));
}

#[test]
fn force_push_is_lease_stale_when_the_remote_moved_after_the_last_fetch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.commit_here("c.txt", "c\n");
    let push = fx
        .session
        .prepare_push(&PushTarget::Upstream, true, &fx.head)
        .unwrap();
    let theirs = fx.push_from_other("b.txt", "b\n");
    let (_, kind, _, stderr) = network_failure(push.run(None).unwrap_err());
    assert_eq!(kind, NetworkErrorKind::LeaseStale, "{stderr}");
    assert_eq!(fx.bare_tip(&fx.head).as_deref(), Some(theirs.as_str()));
}

#[test]
fn force_push_without_a_tracking_ref_is_lease_stale_when_the_remote_branch_exists() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    common::run_git_ok(
        &fx.other,
        &["push", "-q", "origin", "HEAD:refs/heads/theirs-only"],
    );
    let before = fx.bare_tip("theirs-only");
    fx.commit_here("c.txt", "c\n");
    let push = fx
        .session
        .prepare_push(&set_upstream("origin", "theirs-only"), true, &fx.head)
        .unwrap();
    assert_eq!(push.lease(), Some("refs/heads/theirs-only:"));
    let (_, kind, _, _) = network_failure(push.run(None).unwrap_err());
    assert_eq!(kind, NetworkErrorKind::LeaseStale);
    assert_eq!(fx.bare_tip("theirs-only"), before);
}

#[test]
fn force_push_without_a_tracking_ref_creates_a_new_remote_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let ours = fx.head_oid();
    fx.session
        .prepare_push(&set_upstream("origin", "fresh"), true, &fx.head)
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(fx.bare_tip("fresh").as_deref(), Some(ours.as_str()));
}

#[test]
fn push_https_flag_follows_the_push_url_not_the_fetch_url() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let repo = Repository::open(&fx.path).unwrap();
    repo.remote_set_pushurl("origin", Some("https://example.test/me/x.git"))
        .unwrap();
    assert!(
        fx.reopen()
            .prepare_push(&PushTarget::Upstream, false, &fx.head)
            .unwrap()
            .https()
    );
    repo.remote_set_url("origin", "https://example.test/me/x.git")
        .unwrap();
    repo.remote_set_pushurl("origin", Some("git@example.test:me/x.git"))
        .unwrap();
    let session = fx.reopen();
    assert!(
        !session
            .prepare_push(&PushTarget::Upstream, false, &fx.head)
            .unwrap()
            .https()
    );
    assert!(session.prepare_fetch().unwrap().https());
}

#[test]
fn push_https_flag_follows_push_insteadof() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote_set_url("origin", "https://c.example/z.git")
        .unwrap();
    fx.set_config(
        "url.ssh://git@c.example/.pushInsteadOf",
        "https://c.example/",
    );
    assert!(
        !fx.reopen()
            .prepare_push(&PushTarget::Upstream, false, &fx.head)
            .unwrap()
            .https()
    );
}

// ---------- remotes (git2) ----------

#[test]
fn list_remotes_is_sorted_with_the_raw_config_urls() {
    let (_d, path, _s) = plain();
    let repo = Repository::open(&path).unwrap();
    repo.remote("zeta", "gh:me/z.git").unwrap();
    repo.remote("alpha", "https://a.test/a.git").unwrap();
    repo.remote_set_pushurl("alpha", Some("git@a.test:a.git"))
        .unwrap();
    repo.config()
        .unwrap()
        .set_str("url.https://github.com/.insteadOf", "gh:")
        .unwrap();
    assert_eq!(
        RepoSession::open(&path).unwrap().list_remotes().unwrap(),
        [
            info("alpha", "https://a.test/a.git", Some("git@a.test:a.git")),
            info("zeta", "gh:me/z.git", None)
        ]
    );
}

#[test]
fn add_remote_creates_it_with_the_default_refspec_and_an_optional_push_url() {
    let (_d, path, session) = plain();
    session
        .add_remote("origin", "https://h.test/x.git", None)
        .unwrap();
    session
        .add_remote("mirror", "/srv/m.git", Some("git@h.test:m.git"))
        .unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [
            info("mirror", "/srv/m.git", Some("git@h.test:m.git")),
            info("origin", "https://h.test/x.git", None)
        ]
    );
    let repo = Repository::open(&path).unwrap();
    let origin = repo.find_remote("origin").unwrap();
    assert_eq!(
        origin.fetch_refspecs().unwrap().get(0),
        Some("+refs/heads/*:refs/remotes/origin/*")
    );
}

#[test]
fn add_remote_with_an_invalid_name_is_invalid_remote_name() {
    let (_d, _p, session) = plain();
    for bad in ["", "a b", "-x", "a\0b", "bad..name"] {
        assert!(
            matches!(session.add_remote(bad, "/srv/x.git", None), Err(GitError::InvalidRemoteName(n)) if n == bad),
            "{bad:?}"
        );
    }
    assert!(session.list_remotes().unwrap().is_empty());
}

#[test]
fn add_remote_with_a_taken_name_is_remote_exists() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    assert!(
        matches!(session.add_remote("origin", "/srv/b.git", None), Err(GitError::RemoteExists(n)) if n == "origin")
    );
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("origin", "/srv/a.git", None)]
    );
}

#[test]
fn add_remote_with_an_invalid_url_is_invalid_remote_url() {
    let (_d, _p, session) = plain();
    for bad in ["", "   ", "-oProxyCommand=x", "a\nb"] {
        assert!(
            matches!(session.add_remote("origin", bad, None), Err(GitError::InvalidRemoteUrl(u)) if u == bad),
            "{bad:?}"
        );
    }
    assert!(matches!(
        session.add_remote("origin", "/srv/x.git", Some("")),
        Err(GitError::InvalidRemoteUrl(_))
    ));
    assert!(session.list_remotes().unwrap().is_empty());
}

#[test]
fn add_remote_checks_the_name_before_the_url() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    assert!(matches!(
        session.add_remote("a b", "", None),
        Err(GitError::InvalidRemoteName(_))
    ));
    assert!(matches!(
        session.add_remote("origin", "", None),
        Err(GitError::RemoteExists(_))
    ));
}

#[test]
fn update_remote_sets_the_urls_and_none_clears_the_push_url() {
    let (_d, _p, session) = plain();
    session
        .add_remote("origin", "/srv/a.git", Some("/srv/push.git"))
        .unwrap();
    session
        .update_remote("origin", "origin", "/srv/b.git", None)
        .unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("origin", "/srv/b.git", None)]
    );
    session
        .update_remote("origin", "origin", "/srv/b.git", None)
        .unwrap(); // no push URL to clear
    session
        .update_remote("origin", "origin", "/srv/b.git", Some("/srv/p2.git"))
        .unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("origin", "/srv/b.git", Some("/srv/p2.git"))]
    );
}

#[test]
fn update_remote_rename_keeps_backslash_url() {
    let (_d, path, session) = plain();
    session
        .add_remote("origin", r"C:\srv\a.git", Some(r"\\host\share\p.git"))
        .unwrap();
    session
        .update_remote(
            "origin",
            "upstream",
            r"C:\srv\a.git",
            Some(r"\\host\share\p.git"),
        )
        .unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [info(
            "upstream",
            r"C:\srv\a.git",
            Some(r"\\host\share\p.git")
        )]
    );
    let repo = Repository::open(&path).unwrap();
    repo.config().unwrap().snapshot().unwrap();
}

#[test]
fn update_remote_rename_keeps_extra_refspecs() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_multivar("remote.origin.fetch", "^$", "+refs/tags/*:refs/tags/*")
            .unwrap();
        cfg.set_multivar("remote.origin.push", "^$", "refs/heads/*:refs/heads/*")
            .unwrap();
    }
    session
        .update_remote("origin", "upstream", "/srv/a.git", None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let cfg = repo.config().unwrap();
    let multi = |key: &str| -> Vec<String> {
        let mut out = Vec::new();
        let mut it = cfg.multivar(key, None).unwrap();
        while let Some(e) = it.next() {
            out.push(e.unwrap().value().unwrap().to_owned());
        }
        out
    };
    let fetch = multi("remote.upstream.fetch");
    assert!(fetch.contains(&"+refs/heads/*:refs/remotes/upstream/*".to_owned()));
    assert!(fetch.contains(&"+refs/tags/*:refs/tags/*".to_owned()));
    assert_eq!(multi("remote.upstream.push"), ["refs/heads/*:refs/heads/*"]);
    let mut entries = cfg.entries(Some(r"remote\.origin\..*")).unwrap();
    assert!(entries.next().is_none());
}

#[test]
fn update_remote_rename_moves_tracking_refs_and_upstream_config() {
    let (_d1, _d2, path, head, session) = tracked();
    let url = session.list_remotes().unwrap()[0].fetch_url.clone();
    session
        .update_remote("origin", "upstream", &url, None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(
        repo.find_reference(&format!("refs/remotes/upstream/{head}"))
            .is_ok()
    );
    assert!(
        repo.find_reference(&format!("refs/remotes/origin/{head}"))
            .is_err()
    );
    let config = repo.config().unwrap().snapshot().unwrap();
    assert_eq!(
        config.get_str(&format!("branch.{head}.remote")).unwrap(),
        "upstream"
    );
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("upstream", &url, None)]
    );
}

fn multivar(cfg: &git2::Config, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = cfg.multivar(key, None).unwrap();
    while let Some(e) = it.next() {
        out.push(e.unwrap().value().unwrap().to_owned());
    }
    out
}

#[test]
fn update_remote_rename_keeps_special_characters_in_repeated_keys() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    let first = r"C:\srv\a";
    let second = r#"+refs\"q" b\\:refs/x/b"#;
    {
        let repo = Repository::open(&path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_multivar("remote.origin.note", "^$", r"C:\\srv\\a")
            .unwrap();
        cfg.set_multivar(
            "remote.origin.note",
            "^$",
            r#""+refs\\\"q\" b\\\\:refs/x/b""#,
        )
        .unwrap();
    }
    session
        .update_remote("origin", "upstream", "/srv/a.git", None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let cfg = repo.config().unwrap();
    let notes = multivar(&cfg, "remote.upstream.note");
    assert_eq!(notes, [first, second]);
}

#[test]
fn update_remote_rename_leaves_a_dotted_sibling_remote_alone() {
    let (_d, path, session) = plain();
    session.add_remote("foo", "/srv/a.git", None).unwrap();
    session.add_remote("foo.bar", "/srv/b.git", None).unwrap();
    session
        .update_remote("foo", "new", "/srv/a.git", None)
        .unwrap();
    assert_eq!(
        session.list_remotes().unwrap(),
        [
            info("foo.bar", "/srv/b.git", None),
            info("new", "/srv/a.git", None)
        ]
    );
    let repo = Repository::open(&path).unwrap();
    let cfg = repo.config().unwrap();
    assert_eq!(
        multivar(&cfg, "remote.foo.bar.fetch"),
        ["+refs/heads/*:refs/remotes/foo.bar/*"]
    );
}

#[test]
fn update_remote_rename_rewrites_every_tracking_refspec() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_multivar(
            "remote.origin.fetch",
            "^$",
            "+refs/heads/main:refs/remotes/origin/main",
        )
        .unwrap();
        cfg.set_multivar(
            "remote.origin.fetch",
            "^$",
            "+refs/pull/*:refs/remotes/origin/pr/*",
        )
        .unwrap();
    }
    session
        .update_remote("origin", "upstream", "/srv/a.git", None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let cfg = repo.config().unwrap();
    assert_eq!(
        multivar(&cfg, "remote.upstream.fetch"),
        [
            "+refs/heads/*:refs/remotes/upstream/*",
            "+refs/heads/main:refs/remotes/upstream/main",
            "+refs/pull/*:refs/remotes/upstream/pr/*"
        ]
    );
}

#[test]
fn update_remote_rename_repoints_push_remote_and_push_default() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    session.add_remote("other", "/srv/b.git", None).unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("remote.pushDefault", "origin").unwrap();
        cfg.set_str("branch.main.pushRemote", "origin").unwrap();
        cfg.set_str("branch.dev.pushRemote", "other").unwrap();
    }
    session
        .update_remote("origin", "upstream", "/srv/a.git", None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let cfg = repo.config().unwrap();
    assert_eq!(cfg.get_string("remote.pushDefault").unwrap(), "upstream");
    assert_eq!(
        cfg.get_string("branch.main.pushRemote").unwrap(),
        "upstream"
    );
    assert_eq!(cfg.get_string("branch.dev.pushRemote").unwrap(), "other");
}

#[test]
fn update_remote_rename_refuses_orphan_keys_of_the_new_name() {
    let (_d, path, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str(
            "remote.upstream.fetch",
            "+refs/heads/*:refs/remotes/upstream/*",
        )
        .unwrap();
    }
    assert!(matches!(
        session.update_remote("origin", "upstream", "/srv/a.git", None),
        Err(GitError::RemoteExists(_))
    ));
    assert_eq!(
        session.list_remotes().unwrap(),
        [info("origin", "/srv/a.git", None)]
    );
}

#[test]
fn update_remote_rename_retargets_the_symbolic_remote_head() {
    let (_d1, _d2, path, head, session) = tracked();
    let url = session.list_remotes().unwrap()[0].fetch_url.clone();
    {
        let repo = Repository::open(&path).unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{head}"),
            true,
            "test",
        )
        .unwrap();
    }
    session
        .update_remote("origin", "upstream", &url, None)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let new_head = repo.find_reference("refs/remotes/upstream/HEAD").unwrap();
    assert_eq!(
        new_head.symbolic_target(),
        Some(format!("refs/remotes/upstream/{head}").as_str())
    );
    assert!(repo.find_reference("refs/remotes/origin/HEAD").is_err());
}

#[test]
fn update_remote_reports_errors_in_order_and_changes_nothing() {
    let (_d, _p, session) = plain();
    session.add_remote("origin", "/srv/a.git", None).unwrap();
    session.add_remote("other", "/srv/b.git", None).unwrap();
    assert!(matches!(
        session.update_remote("ghost", "ghost", "/x", None),
        Err(GitError::RemoteNotFound(_))
    ));
    assert!(matches!(
        session.update_remote("-x", "y", "/x", None),
        Err(GitError::RemoteNotFound(_))
    ));
    assert!(matches!(
        session.update_remote("origin", "a b", "", None),
        Err(GitError::InvalidRemoteName(_))
    ));
    assert!(matches!(
        session.update_remote("origin", "other", " ", None),
        Err(GitError::InvalidRemoteUrl(_))
    ));
    assert!(matches!(
        session.update_remote("origin", "origin", "/x", Some("")),
        Err(GitError::InvalidRemoteUrl(_))
    ));
    assert!(
        matches!(session.update_remote("origin", "other", "/x", None), Err(GitError::RemoteExists(n)) if n == "other")
    );
    assert_eq!(
        session.list_remotes().unwrap(),
        [
            info("origin", "/srv/a.git", None),
            info("other", "/srv/b.git", None)
        ]
    );
}

#[test]
fn remove_remote_deletes_tracking_refs_and_upstream_config() {
    let (_d1, _d2, path, head, session) = tracked();
    session.remove_remote("origin").unwrap();
    let repo = Repository::open(&path).unwrap();
    assert!(
        repo.find_reference(&format!("refs/remotes/origin/{head}"))
            .is_err()
    );
    assert!(
        repo.config()
            .unwrap()
            .snapshot()
            .unwrap()
            .get_str(&format!("branch.{head}.remote"))
            .is_err()
    );
    assert!(session.list_remotes().unwrap().is_empty());
    assert!(matches!(
        session.remove_remote("origin"),
        Err(GitError::RemoteNotFound(_))
    ));
    assert!(matches!(
        session.remove_remote("-x"),
        Err(GitError::RemoteNotFound(_))
    ));
}

#[test]
fn integrate_pull_propagates_a_git2_error_when_head_is_corrupt() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    fx.push_from_other("b.txt", "b\n");
    let pull = fx.session.prepare_pull().unwrap();
    pull.fetch(None).unwrap();
    std::fs::write(fx.path.join(".git").join("HEAD"), "not a valid head\n").unwrap();
    let err = fx
        .session
        .integrate_pull(&pull, PullMode::Merge)
        .unwrap_err();
    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}
