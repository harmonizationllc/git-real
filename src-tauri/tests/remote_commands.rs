//! Integration tests for the GR-12 remote command `*_inner` functions, against
//! real temp repositories with local bare remotes (no network beyond a refused
//! loopback port).

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{
    Credentials, NetworkErrorKind, OperationOutcome, PullMode, PushTarget, RemoteInfo, RepoSession,
};
use git_real_lib::commands::refs::delete_remote_branch_inner;
use git_real_lib::commands::remote::{
    CredentialsArg, add_remote_inner, credentials_from_arg, fetch_inner, fetch_remote_inner,
    list_remotes_inner, pull_default_mode_inner, pull_inner, push_inner, remove_remote_inner,
    update_remote_inner,
};
use git_real_lib::commands::tags::{delete_remote_tag_inner, push_tag_inner};
use git_real_lib::error::{AppErrorKind, NetworkInfo};
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{BranchType, Repository};
use serde_json::json;
use tempfile::TempDir;

const MISSING_ID: RepoId = 4242;
const TOKEN: &str = "TOPSECRET-123";

/// `path` tracks `origin` (a local bare clone) on its HEAD branch; `other` is
/// a second clone of the bare repo that pushes.
struct Fx {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    other: PathBuf,
    head: String,
}

fn fx() -> Fx {
    let (d1, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare);
    Repository::open(&path)
        .unwrap()
        .find_branch(&head, BranchType::Local)
        .unwrap()
        .set_upstream(Some(&format!("origin/{head}")))
        .unwrap();
    let d3 = tempfile::tempdir().unwrap();
    git(d3.path(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    let other = d3.path().join("other");
    common::configure_identity(&other);
    Fx {
        _dirs: [d1, d2, d3],
        path,
        bare,
        other,
        head,
    }
}

/// A registry holding a fresh session of `path` (opened after any config change).
fn registered(path: &Path) -> (RepoRegistry, RepoId) {
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(path).unwrap());
    (reg, id)
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn tip(repo: &Path, spec: &str) -> String {
    let repo = Repository::open(repo).unwrap();
    let id = repo
        .revparse_single(spec)
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id();
    id.to_string()
}

fn push_from_other(fx: &Fx, file: &str, content: &str) -> String {
    let oid = common::commit_file(&fx.other, file, content, "theirs").to_string();
    git(&fx.other, &["push", "-q", "origin", "HEAD"]);
    oid
}

#[test]
fn fetch_inner_updates_the_tracking_refs() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    let (reg, id) = registered(&fx.path);
    fetch_inner(&reg, id, None).unwrap();
    assert_eq!(
        tip(&fx.path, &format!("refs/remotes/origin/{}", fx.head)),
        theirs
    );
}

#[test]
fn fetch_inner_without_remotes_is_no_remotes() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    let err = fetch_inner(&reg, id, None).unwrap_err();
    assert_eq!((err.kind, err.network), (AppErrorKind::NoRemotes, None));
}

#[test]
fn pull_default_mode_inner_reads_pull_rebase() {
    let (_d, path) = common::temp_repo_with_commit();
    Repository::open(&path)
        .unwrap()
        .config()
        .unwrap()
        .set_str("pull.rebase", "true")
        .unwrap();
    let (reg, id) = registered(&path);
    assert_eq!(pull_default_mode_inner(&reg, id).unwrap(), PullMode::Rebase);
    assert_eq!(
        serde_json::to_value(PullMode::Rebase).unwrap(),
        json!("rebase")
    );
    assert_eq!(
        serde_json::to_value(PullMode::Merge).unwrap(),
        json!("merge")
    );
}

#[test]
fn pull_inner_fast_forwards_to_the_upstream() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    let (reg, id) = registered(&fx.path);
    assert_eq!(
        pull_inner(&reg, id, PullMode::Merge, None).unwrap(),
        OperationOutcome::Completed
    );
    assert_eq!(tip(&fx.path, "HEAD"), theirs);
}

#[test]
fn pull_inner_rebase_mode_replays_local_commits() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let theirs = push_from_other(&fx, "b.txt", "b\n");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    assert_eq!(
        pull_inner(&reg, id, PullMode::Rebase, None).unwrap(),
        OperationOutcome::Completed
    );
    assert_eq!(tip(&fx.path, "HEAD~1"), theirs);
}

#[test]
fn pull_inner_reports_conflicts_for_the_banner() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    push_from_other(&fx, "README.md", "theirs\n");
    common::commit_file(&fx.path, "README.md", "ours\n", "ours");
    let (reg, id) = registered(&fx.path);
    let outcome = pull_inner(&reg, id, PullMode::Merge, None).unwrap();
    assert_eq!(serde_json::to_value(outcome).unwrap(), json!("conflicts"));
}

#[test]
fn pull_and_push_inner_map_head_and_upstream_errors() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (reg, id) = registered(&path);
    assert_eq!(
        pull_inner(&reg, id, PullMode::Merge, None)
            .unwrap_err()
            .kind,
        AppErrorKind::NoUpstream
    );
    assert_eq!(
        push_inner(&reg, id, &PushTarget::Upstream, false, &head, None)
            .unwrap_err()
            .kind,
        AppErrorKind::NoUpstream
    );
    let repo = Repository::open(&path).unwrap();
    repo.set_head_detached(repo.head().unwrap().target().unwrap())
        .unwrap();
    assert_eq!(
        pull_inner(&reg, id, PullMode::Merge, None)
            .unwrap_err()
            .kind,
        AppErrorKind::DetachedHead
    );
    assert_eq!(
        push_inner(&reg, id, &PushTarget::Upstream, false, &head, None)
            .unwrap_err()
            .kind,
        AppErrorKind::DetachedHead
    );
}

#[test]
fn push_inner_pushes_to_the_upstream_and_publishes_a_new_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let ours = common::commit_file(&fx.path, "c.txt", "c\n", "ours").to_string();
    let (reg, id) = registered(&fx.path);
    push_inner(&reg, id, &PushTarget::Upstream, false, &fx.head, None).unwrap();
    assert_eq!(tip(&fx.bare, &format!("refs/heads/{}", fx.head)), ours);
    let target: PushTarget = serde_json::from_value(
        json!({ "kind": "setUpstream", "remote": "origin", "branch": "pub" }),
    )
    .unwrap();
    push_inner(&reg, id, &target, false, &fx.head, None).unwrap();
    assert_eq!(tip(&fx.bare, "refs/heads/pub"), ours);
}

// I1: the app layer forwards the expected branch; a HEAD on another branch is OperationInProgress.
#[test]
fn push_inner_is_operation_in_progress_when_head_is_not_the_expected_branch() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let (reg, id) = registered(&fx.path);
    let before = tip(&fx.bare, &format!("refs/heads/{}", fx.head));
    let err = push_inner(&reg, id, &PushTarget::Upstream, true, "not-the-head", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
    assert_eq!(tip(&fx.bare, &format!("refs/heads/{}", fx.head)), before);
}

#[test]
fn a_rejected_push_maps_to_network_failed_with_its_payload() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    push_from_other(&fx, "b.txt", "b\n");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, false, &fx.head, None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(
        err.network,
        Some(NetworkInfo {
            verb: "push".into(),
            kind: NetworkErrorKind::PushRejectedNonFastForward,
            https: false,
            origin: None,
            host: None,
            reason: None
        })
    );
    assert!(err.message.contains("[rejected]"), "{}", err.message);
    let value = serde_json::to_value(&err).unwrap();
    assert_eq!(
        value["network"],
        json!({ "verb": "push", "kind": "pushRejectedNonFastForward", "https": false, "origin": null, "host": null, "reason": null })
    );
}

#[test]
fn a_force_push_over_an_unseen_remote_update_is_lease_stale() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    push_from_other(&fx, "b.txt", "b\n"); // not fetched: the tracking ref is stale
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, true, &fx.head, None).unwrap_err();
    assert_eq!(
        err.network.map(|n| n.kind),
        Some(NetworkErrorKind::LeaseStale)
    );
}

#[test]
fn credentials_never_appear_in_an_app_error() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote_set_url("origin", "http://127.0.0.1:1/x.git")
        .unwrap();
    let (reg, id) = registered(&fx.path);
    let creds = Credentials::new("http://127.0.0.1:1", "me", TOKEN).unwrap();
    let errors = [
        fetch_inner(&reg, id, Some(&creds)).unwrap_err(),
        pull_inner(&reg, id, PullMode::Merge, Some(&creds)).unwrap_err(),
        push_inner(
            &reg,
            id,
            &PushTarget::Upstream,
            false,
            &fx.head,
            Some(&creds),
        )
        .unwrap_err(),
    ];
    for err in errors {
        assert_eq!(err.kind, AppErrorKind::NetworkFailed);
        let info = err.network.clone().unwrap();
        assert_eq!(
            (info.kind, info.https, info.origin),
            (NetworkErrorKind::HostUnreachable, true, None)
        );
        for text in [format!("{err:?}"), serde_json::to_string(&err).unwrap()] {
            assert!(!text.contains(TOKEN), "{text}");
        }
    }
}

#[test]
fn tag_and_remote_branch_pushes_take_credentials_and_map_network_failures() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    {
        let repo = Repository::open(&fx.path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.tag_lightweight("v1", head.as_object(), false).unwrap();
    }
    git(
        &fx.other,
        &["push", "-q", "origin", "HEAD:refs/heads/gone-soon"],
    );
    let (reg, id) = registered(&fx.path);
    fetch_inner(&reg, id, None).unwrap();
    push_tag_inner(&reg, id, "origin", "v1", None).unwrap();
    delete_remote_tag_inner(&reg, id, "origin", "v1", None).unwrap();
    let err = delete_remote_tag_inner(&reg, id, "origin", "v1", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(
        err.network.map(|n| (n.verb, n.kind)),
        Some(("push".to_owned(), NetworkErrorKind::Other))
    );
    assert!(
        err.message.contains("remote ref does not exist"),
        "{}",
        err.message
    );
    delete_remote_branch_inner(&reg, id, "origin", "gone-soon", None).unwrap();
    assert!(
        Repository::open_bare(&fx.bare)
            .unwrap()
            .find_reference("refs/heads/gone-soon")
            .is_err()
    );
}

#[test]
fn remote_crud_through_the_commands() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    add_remote_inner(&reg, id, "origin", "https://h.test/x.git", None).unwrap();
    add_remote_inner(&reg, id, "mirror", "/srv/m.git", Some("git@h.test:m.git")).unwrap();
    assert_eq!(
        list_remotes_inner(&reg, id).unwrap(),
        vec![
            RemoteInfo {
                name: "mirror".into(),
                fetch_url: "/srv/m.git".into(),
                push_url: Some("git@h.test:m.git".into())
            },
            RemoteInfo {
                name: "origin".into(),
                fetch_url: "https://h.test/x.git".into(),
                push_url: None
            },
        ]
    );
    update_remote_inner(&reg, id, "mirror", "backup", "/srv/b.git", None).unwrap();
    remove_remote_inner(&reg, id, "origin").unwrap();
    assert_eq!(
        list_remotes_inner(&reg, id).unwrap(),
        vec![RemoteInfo {
            name: "backup".into(),
            fetch_url: "/srv/b.git".into(),
            push_url: None
        }]
    );
}

#[test]
fn remote_commands_map_the_new_kinds() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (reg, id) = registered(&path);
    add_remote_inner(&reg, id, "origin", "/srv/a.git", None).unwrap();
    add_remote_inner(&reg, id, "other", "/srv/b.git", None).unwrap();
    assert_eq!(
        add_remote_inner(&reg, id, "a b", "/x", None)
            .unwrap_err()
            .kind,
        AppErrorKind::InvalidRemoteName
    );
    assert_eq!(
        add_remote_inner(&reg, id, "origin", "/x", None)
            .unwrap_err()
            .kind,
        AppErrorKind::RemoteExists
    );
    assert_eq!(
        add_remote_inner(&reg, id, "new", " ", None)
            .unwrap_err()
            .kind,
        AppErrorKind::InvalidRemoteUrl
    );
    assert_eq!(
        update_remote_inner(&reg, id, "ghost", "ghost", "/x", None)
            .unwrap_err()
            .kind,
        AppErrorKind::RemoteNotFound
    );
    assert_eq!(
        update_remote_inner(&reg, id, "origin", "other", "/x", None)
            .unwrap_err()
            .kind,
        AppErrorKind::RemoteExists
    );
    assert_eq!(
        remove_remote_inner(&reg, id, "ghost").unwrap_err().kind,
        AppErrorKind::RemoteNotFound
    );
    let set_upstream = PushTarget::SetUpstream {
        remote: "nope".into(),
        branch: "b".into(),
    };
    assert_eq!(
        push_inner(&reg, id, &set_upstream, false, &head, None)
            .unwrap_err()
            .kind,
        AppErrorKind::RemoteNotFound
    );
}

// ---------- GR-12 follow-ups ----------

#[test]
fn fetch_remote_inner_fetches_only_the_named_remote() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    let (_d, mirror_bare) = common::temp_bare_clone(&fx.path);
    Repository::open(&fx.path)
        .unwrap()
        .remote("mirror", mirror_bare.to_str().unwrap())
        .unwrap();
    let before = tip(&fx.path, &format!("refs/remotes/origin/{}", fx.head));
    push_from_other(&fx, "b.txt", "b\n");
    let (reg, id) = registered(&fx.path);
    fetch_remote_inner(&reg, id, "mirror", None).unwrap();
    assert_eq!(
        tip(&fx.path, &format!("refs/remotes/mirror/{}", fx.head)),
        before
    );
    assert_eq!(
        tip(&fx.path, &format!("refs/remotes/origin/{}", fx.head)),
        before
    );
}

#[test]
fn fetch_remote_inner_of_an_unknown_remote_is_remote_not_found() {
    let (_d, path) = common::temp_repo_with_commit();
    let (reg, id) = registered(&path);
    let err = fetch_remote_inner(&reg, id, "nope", None).unwrap_err();
    assert_eq!(
        (err.kind, err.network),
        (AppErrorKind::RemoteNotFound, None)
    );
}

#[test]
fn fetch_remote_inner_with_a_leading_dash_is_remote_not_found() {
    let fx = fx();
    let (reg, id) = registered(&fx.path);
    let err = fetch_remote_inner(&reg, id, "--all", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
}

#[test]
fn fetch_remote_inner_failure_maps_to_network_failed_with_the_fetch_verb() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("gone", "/nonexistent/gone.git")
        .unwrap();
    let (reg, id) = registered(&fx.path);
    let err = fetch_remote_inner(&reg, id, "gone", None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(
        err.network.map(|n| (n.verb, n.kind)),
        Some(("fetch".to_owned(), NetworkErrorKind::RepoNotFound))
    );
}

#[test]
fn fetch_remote_never_leaks_credentials_into_an_app_error() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    Repository::open(&fx.path)
        .unwrap()
        .remote("web", "http://127.0.0.1:1/x.git")
        .unwrap();
    let (reg, id) = registered(&fx.path);
    let creds = Credentials::new("http://127.0.0.1:1", "me", TOKEN).unwrap();
    let err = fetch_remote_inner(&reg, id, "web", Some(&creds)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    for text in [format!("{err:?}"), serde_json::to_string(&err).unwrap()] {
        assert!(!text.contains(TOKEN), "{text}");
    }
}

#[test]
fn the_fetch_remote_command_is_registered_with_the_invoke_handler() {
    assert!(include_str!("../src/lib.rs").contains("commands::remote::fetch_remote,"));
}

/// Installs an executable pre-receive hook that prints `output` to stderr and refuses the push.
#[cfg(unix)]
fn decline_pushes(bare: &Path, output: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hook = bare.join("hooks").join("pre-receive");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, format!("#!/bin/sh\necho '{output}' >&2\nexit 1\n")).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_push_declined_by_a_hook_is_remote_rejected_with_the_hooks_error_text_as_the_reason() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    decline_pushes(&fx.bare, "error: no direct pushes to main");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, false, &fx.head, None).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(
        err.network,
        Some(NetworkInfo {
            verb: "push".into(),
            kind: NetworkErrorKind::RemoteRejected,
            https: false,
            origin: None,
            host: None,
            reason: Some("no direct pushes to main".into())
        })
    );
}

#[cfg(unix)]
#[test]
fn a_push_declined_without_an_error_line_uses_the_parenthesised_reason_and_serializes_it() {
    if !common::git_available() {
        return;
    }
    let fx = fx();
    decline_pushes(&fx.bare, "just no");
    common::commit_file(&fx.path, "c.txt", "c\n", "ours");
    let (reg, id) = registered(&fx.path);
    let err = push_inner(&reg, id, &PushTarget::Upstream, false, &fx.head, None).unwrap_err();
    let value = serde_json::to_value(&err).unwrap();
    assert_eq!(
        value["network"],
        json!({
            "verb": "push",
            "kind": "remoteRejected",
            "https": false,
            "origin": null,
            "host": null,
            "reason": "pre-receive hook declined"
        })
    );
}

#[test]
fn remote_commands_report_unknown_repo() {
    let reg = RepoRegistry::default();
    let kinds = [
        fetch_inner(&reg, MISSING_ID, None).unwrap_err().kind,
        fetch_remote_inner(&reg, MISSING_ID, "origin", None)
            .unwrap_err()
            .kind,
        pull_default_mode_inner(&reg, MISSING_ID).unwrap_err().kind,
        pull_inner(&reg, MISSING_ID, PullMode::Merge, None)
            .unwrap_err()
            .kind,
        push_inner(&reg, MISSING_ID, &PushTarget::Upstream, false, "main", None)
            .unwrap_err()
            .kind,
        list_remotes_inner(&reg, MISSING_ID).unwrap_err().kind,
        add_remote_inner(&reg, MISSING_ID, "o", "/x", None)
            .unwrap_err()
            .kind,
        update_remote_inner(&reg, MISSING_ID, "o", "o", "/x", None)
            .unwrap_err()
            .kind,
        remove_remote_inner(&reg, MISSING_ID, "o").unwrap_err().kind,
    ];
    assert!(
        kinds.iter().all(|k| *k == AppErrorKind::UnknownRepo),
        "{kinds:?}"
    );
}

#[test]
fn remote_models_cross_the_seam_in_camel_case() {
    let info = RemoteInfo {
        name: "o".into(),
        fetch_url: "/f".into(),
        push_url: None,
    };
    assert_eq!(
        serde_json::to_value(info).unwrap(),
        json!({ "name": "o", "fetchUrl": "/f", "pushUrl": null })
    );
    assert_eq!(
        serde_json::from_value::<PushTarget>(json!({ "kind": "upstream" })).unwrap(),
        PushTarget::Upstream
    );
    assert_eq!(
        serde_json::from_value::<PullMode>(json!("merge")).unwrap(),
        PullMode::Merge
    );
    let creds: Credentials =
        serde_json::from_value(json!({ "origin": "https://h", "username": "me", "token": TOKEN }))
            .unwrap();
    assert_eq!(creds.origin(), "https://h");
    assert_eq!(
        serde_json::to_value(NetworkErrorKind::LeaseStale).unwrap(),
        json!("leaseStale")
    );
}

// --- CredentialsArg: invalid credentials surface as `invalidCredentials` ---

fn arg(origin: &str, username: &str, token: &str) -> CredentialsArg {
    serde_json::from_value(json!({ "origin": origin, "username": username, "token": token }))
        .unwrap()
}

#[test]
fn credentials_arg_deserializes_camel_case_without_validating() {
    let parsed: Result<CredentialsArg, _> = serde_json::from_value(
        json!({ "origin": "not-an-origin", "username": "", "token": TOKEN }),
    );
    assert!(parsed.is_ok());
}

#[test]
fn credentials_from_arg_passes_none_through() {
    assert!(credentials_from_arg(None).unwrap().is_none());
}

#[test]
fn credentials_from_arg_converts_valid_input() {
    let creds = credentials_from_arg(Some(arg("https://h.test:8443", "me", TOKEN)))
        .unwrap()
        .unwrap();
    assert_eq!(
        (creds.origin(), creds.username()),
        ("https://h.test:8443", "me")
    );
}

#[test]
fn credentials_from_arg_maps_a_bad_origin_to_invalid_credentials() {
    let err = credentials_from_arg(Some(arg("ftp://h.test", "me", TOKEN)))
        .err()
        .unwrap();
    assert_eq!(err.kind, AppErrorKind::InvalidCredentials);
}

#[test]
fn credentials_from_arg_maps_a_line_break_in_the_token_to_invalid_credentials() {
    let err = credentials_from_arg(Some(arg("https://h.test", "me", "a\nb")))
        .err()
        .unwrap();
    assert_eq!(err.kind, AppErrorKind::InvalidCredentials);
}

#[test]
fn credentials_from_arg_maps_an_empty_username_to_invalid_credentials() {
    let err = credentials_from_arg(Some(arg("https://h.test", "", TOKEN)))
        .err()
        .unwrap();
    assert_eq!(err.kind, AppErrorKind::InvalidCredentials);
}

#[test]
fn invalid_credentials_error_carries_no_token_text_and_no_network_payload() {
    let err = credentials_from_arg(Some(arg("ftp://h.test", "me", TOKEN)))
        .err()
        .unwrap();
    assert!(err.network.is_none());
    for text in [
        err.message.clone(),
        format!("{err:?}"),
        serde_json::to_string(&err).unwrap(),
    ] {
        assert!(!text.contains(TOKEN), "{text}");
    }
}

#[test]
fn invalid_credentials_error_serializes_with_the_camel_case_kind() {
    let err = credentials_from_arg(Some(arg("ftp://h.test", "me", TOKEN)))
        .err()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&err).unwrap()["kind"],
        json!("invalidCredentials")
    );
}
