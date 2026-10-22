//! The exact argv, environment and approve input of the GR-12 network runs,
//! observed through a scripted stand-in for `git` first on `PATH` (set once,
//! before any test body). Under `<workdir>/.git/` the stand-in records
//! `argv.txt` and `env.txt` for an operation, `helper-out.txt` (what the inline
//! helper prints when asked `get`), and, for `credential approve`,
//! `approve-argv.txt` plus every approve input appended to `approve-stdin.txt`.
//! `<workdir>/.git/behaviour`, when present, is sourced to script the outcome.

#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use git_real_core::remote::auth::{Credentials, HELPER};
use git_real_core::{GitError, NetworkErrorKind, PushTarget, RepoSession};
use git2::Repository;

const SCRIPT: &str = r#"d="$2/.git"
if [ "$3" = credential ]; then
  printf '%s\n' "$@" > "$d/approve-argv.txt"
  cat >> "$d/approve-stdin.txt"
  exit 0
fi
printf '%s\n' "$@" > "$d/argv.txt"
printf '%s\n' "${GR_USERNAME-<unset>}" "${GR_TOKEN-<unset>}" > "$d/env.txt"
prev=
for a in "$@"; do
  if [ "$prev" = -c ]; then
    case "$a" in
      credential.*.helper=!*) h="${a#*.helper=!}"; sh -c "$h get" > "$d/helper-out.txt" ;;
    esac
  fi
  prev="$a"
done
[ -f "$d/behaviour" ] && . "$d/behaviour"
exit 0"#;

const TOKEN: &str = "TOPSECRET-123";
const URL: &str = "https://example.test/me/x.git";

static FAKE_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

fn use_fake_git() {
    FAKE_DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        common::fake_git(dir.path(), SCRIPT);
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&old));
        // SAFETY: runs inside `get_or_init`, before any test body reads PATH.
        unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
        dir
    });
}

fn read(path: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(path.join(".git").join(file)).ok()
}

/// Everything after `-C <workdir>` of the last operation.
fn after_workdir(path: &Path) -> Vec<String> {
    let args: Vec<String> = read(path, "argv.txt")
        .expect("git was not run")
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(args[0], "-C", "{args:?}");
    args[2..].to_vec()
}

fn behaviour(path: &Path, body: &str) {
    std::fs::write(path.join(".git").join("behaviour"), body).unwrap();
}

fn creds() -> Credentials {
    Credentials::new("https://example.test", "me", TOKEN).unwrap()
}

fn auth_args(origin: &str) -> Vec<String> {
    vec![
        "-c".into(),
        format!("credential.{origin}.helper="),
        "-c".into(),
        format!("credential.{origin}.helper={HELPER}"),
    ]
}

fn approved(url: &str) -> String {
    format!("url={url}\nusername=me\npassword={TOKEN}\n\n")
}

/// A repo whose HEAD branch tracks `origin`, fetched from a local bare repo
/// with git2 and then re-pointed at an HTTPS URL the stand-in never contacts.
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, String) {
    use_fake_git();
    let (dir, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    Repository::open(&path)
        .unwrap()
        .remote_set_url("origin", URL)
        .unwrap();
    (dir, bare_dir, path, head)
}

fn session(path: &Path) -> RepoSession {
    RepoSession::open(path).unwrap()
}

// ---------- argv ----------

#[test]
fn fetch_runs_fetch_all_without_credentials() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_fetch().unwrap().run(None).unwrap();
    assert_eq!(after_workdir(&path), ["fetch", "--all"]);
    assert_eq!(read(&path, "env.txt").unwrap(), "<unset>\n<unset>\n");
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn pull_fetches_only_the_upstream_remote() {
    let (_d, _b, path, _h) = fixture();
    session(&path).prepare_pull().unwrap().fetch(None).unwrap();
    assert_eq!(after_workdir(&path), ["fetch", "origin"]);
}

#[test]
fn push_to_the_upstream_names_the_remote_branch() {
    let (_d, _b, path, head) = fixture();
    session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "push",
            "origin",
            &format!("refs/heads/{head}:refs/heads/{head}")
        ]
    );
}

#[test]
fn set_upstream_push_adds_dash_u() {
    let (_d, _b, path, head) = fixture();
    let target = PushTarget::SetUpstream {
        remote: "origin".into(),
        branch: "topic/x".into(),
    };
    session(&path)
        .prepare_push(&target, false, &head)
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "push",
            "-u",
            "origin",
            &format!("refs/heads/{head}:refs/heads/topic/x")
        ]
    );
}

#[test]
fn force_push_carries_the_lease_before_the_remote() {
    let (_d, _b, path, head) = fixture();
    let oid = Repository::open(&path)
        .unwrap()
        .refname_to_id(&format!("refs/remotes/origin/{head}"))
        .unwrap();
    session(&path)
        .prepare_push(&PushTarget::Upstream, true, &head)
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "push",
            &format!("--force-with-lease=refs/heads/{head}:{oid}"),
            "origin",
            &format!("refs/heads/{head}:refs/heads/{head}")
        ]
    );
}

#[test]
fn set_upstream_force_push_without_a_tracking_ref_uses_an_empty_lease() {
    let (_d, _b, path, head) = fixture();
    let target = PushTarget::SetUpstream {
        remote: "origin".into(),
        branch: "fresh".into(),
    };
    session(&path)
        .prepare_push(&target, true, &head)
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(
        after_workdir(&path),
        [
            "push",
            "-u",
            "--force-with-lease=refs/heads/fresh:",
            "origin",
            &format!("refs/heads/{head}:refs/heads/fresh")
        ]
    );
}

// ---------- credentials ----------

#[test]
fn fetch_with_credentials_scopes_the_helper_and_keeps_the_token_out_of_argv() {
    let (_d, _b, path, _h) = fixture();
    session(&path)
        .prepare_fetch()
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    let mut want = auth_args("https://example.test");
    want.extend(["fetch".to_owned(), "--all".to_owned()]);
    assert_eq!(after_workdir(&path), want);
    assert!(!read(&path, "argv.txt").unwrap().contains(TOKEN));
    assert_eq!(read(&path, "env.txt").unwrap(), format!("me\n{TOKEN}\n"));
    assert_eq!(
        read(&path, "helper-out.txt").unwrap(),
        format!("username=me\npassword={TOKEN}\n")
    );
}

/// A remote URL holding `control` on the credentials' origin, next to a clean mirror
/// (so the approve harness demonstrably works): only the mirror may be approved.
fn approved_inputs_with_a_url_containing(control: char) -> String {
    let (_d, _b, path, _h) = fixture();
    let evil = format!("https://example.test/me/x.git{control}host=evil.test");
    {
        let repo = Repository::open(&path).unwrap();
        repo.remote("mirror", "https://example.test/me/mirror.git")
            .unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("remote.origin.url", &evil).unwrap();
    }
    session(&path)
        .prepare_fetch()
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    read(&path, "approve-stdin.txt").unwrap_or_default()
}

// Credential-protocol injection defence: a URL with a line break would add its own
// key=value lines to the approve input, so it is never approved.
#[test]
fn a_url_with_a_newline_is_never_sent_to_credential_approve() {
    assert_eq!(
        approved_inputs_with_a_url_containing('\n'),
        approved("https://example.test/me/mirror.git")
    );
}

#[test]
fn a_url_with_a_carriage_return_is_never_sent_to_credential_approve() {
    assert_eq!(
        approved_inputs_with_a_url_containing('\r'),
        approved("https://example.test/me/mirror.git")
    );
}

#[test]
fn a_successful_run_with_credentials_approves_only_urls_on_the_credentials_origin() {
    let (_d, _b, path, _h) = fixture();
    {
        let repo = Repository::open(&path).unwrap();
        repo.remote("mirror", "https://example.test/me/mirror.git")
            .unwrap();
        repo.remote("elsewhere", "https://other.test/me/x.git")
            .unwrap();
        repo.remote("local", "/srv/x.git").unwrap();
    }
    session(&path)
        .prepare_fetch()
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    assert_eq!(
        read(&path, "approve-stdin.txt").unwrap(),
        format!(
            "{}{}",
            approved("https://example.test/me/mirror.git"),
            approved(URL)
        )
    );
    let approve_argv = read(&path, "approve-argv.txt").unwrap();
    assert_eq!(
        approve_argv.lines().skip(2).collect::<Vec<_>>(),
        ["credential", "approve"]
    );
    assert!(!approve_argv.contains(TOKEN));
}

// Architect: git matches hosts case-insensitively, so approve must too.
#[test]
fn approve_matches_the_origin_host_case_insensitively() {
    let (_d, _b, path, _h) = fixture();
    Repository::open(&path)
        .unwrap()
        .remote_set_url("origin", "https://example.test/Me/x.git")
        .unwrap();
    let mixed = Credentials::new("https://Example.TEST", "me", TOKEN).unwrap();
    session(&path)
        .prepare_fetch()
        .unwrap()
        .run(Some(&mixed))
        .unwrap();
    assert_eq!(
        read(&path, "approve-stdin.txt").unwrap(),
        approved("https://example.test/Me/x.git")
    );
}

#[test]
fn a_failed_run_never_approves() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "echo boom >&2\nexit 128");
    assert!(
        session(&path)
            .prepare_fetch()
            .unwrap()
            .run(Some(&creds()))
            .is_err()
    );
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn pull_with_credentials_approves_the_upstream_url() {
    let (_d, _b, path, _h) = fixture();
    session(&path)
        .prepare_pull()
        .unwrap()
        .fetch(Some(&creds()))
        .unwrap();
    assert_eq!(after_workdir(&path)[4..], ["fetch", "origin"]);
    assert_eq!(read(&path, "approve-stdin.txt").unwrap(), approved(URL));
}

#[test]
fn push_with_credentials_approves_the_push_url_only() {
    let (_d, _b, path, head) = fixture();
    Repository::open(&path)
        .unwrap()
        .remote_set_pushurl("origin", Some("https://push.example.test/me/x.git"))
        .unwrap();
    let push_creds = Credentials::new("https://push.example.test", "me", TOKEN).unwrap();
    session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(Some(&push_creds))
        .unwrap();
    let mut want = auth_args("https://push.example.test");
    want.extend([
        "push".to_owned(),
        "origin".to_owned(),
        format!("refs/heads/{head}:refs/heads/{head}"),
    ]);
    assert_eq!(after_workdir(&path), want);
    assert_eq!(
        read(&path, "approve-stdin.txt").unwrap(),
        approved("https://push.example.test/me/x.git")
    );
}

#[test]
fn tag_push_and_remote_deletes_pass_credentials_through() {
    let (_d, _b, path, head) = fixture();
    common::tag_lightweight(
        &path,
        "v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    let session = session(&path);
    let c = creds();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(Some(&c))
        .unwrap();
    assert_eq!(
        after_workdir(&path)[..4],
        auth_args("https://example.test")[..]
    );
    assert_eq!(
        after_workdir(&path)[4..],
        ["push", "origin", "refs/tags/v1"]
    );
    session
        .prepare_remote_tag_delete("origin", "v1")
        .unwrap()
        .run(Some(&c))
        .unwrap();
    assert_eq!(
        after_workdir(&path)[4..],
        ["push", "origin", "--delete", "tags/v1"]
    );
    session
        .prepare_remote_delete("origin", &head)
        .unwrap()
        .run(Some(&c))
        .unwrap();
    assert_eq!(
        after_workdir(&path)[4..],
        ["push", "origin", "--delete", &format!("heads/{head}")]
    );
    assert_eq!(
        read(&path, "approve-stdin.txt").unwrap(),
        approved(URL).repeat(3)
    );
}

// ---------- failure mapping ----------

#[test]
fn an_https_auth_failure_carries_kind_https_origin_and_output() {
    let (_d, _b, path, _h) = fixture();
    behaviour(
        &path,
        r#"echo out
printf "fatal: could not read Username for 'https://example.test': terminal prompts disabled\n" >&2
exit 128"#,
    );
    match session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err()
    {
        GitError::NetworkFailed {
            verb,
            kind,
            https,
            origin,
            code,
            stdout,
            stderr,
            ..
        } => {
            assert_eq!(
                (verb, kind, https, origin.as_deref(), code),
                (
                    "fetch",
                    NetworkErrorKind::HttpsAuthRequired,
                    true,
                    Some("https://example.test"),
                    Some(128)
                )
            );
            assert_eq!(stdout, "out\n");
            assert!(
                stderr.starts_with("fatal: could not read Username"),
                "{stderr}"
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_non_auth_failure_has_no_origin() {
    let (_d, _b, path, head) = fixture();
    behaviour(
        &path,
        "printf ' ! [rejected]        HEAD -> main (fetch first)\\n' >&2\nexit 1",
    );
    let err = session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap_err();
    assert!(
        matches!(
            err,
            GitError::NetworkFailed {
                verb: "push",
                kind: NetworkErrorKind::PushRejectedNonFastForward,
                https: true,
                origin: None,
                code: Some(1),
                ..
            }
        ),
        "{err:?}"
    );
}

#[test]
fn a_failure_on_a_local_remote_is_not_https() {
    let (_d, _b, path, _h) = fixture();
    Repository::open(&path)
        .unwrap()
        .remote_set_url("origin", "/srv/x.git")
        .unwrap();
    behaviour(&path, "exit 1");
    let err = session(&path)
        .prepare_pull()
        .unwrap()
        .fetch(None)
        .unwrap_err();
    assert!(
        matches!(
            err,
            GitError::NetworkFailed {
                verb: "pull",
                https: false,
                kind: NetworkErrorKind::Other,
                ..
            }
        ),
        "{err:?}"
    );
}

#[test]
fn a_killed_run_reports_no_exit_code() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "kill -9 $$");
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert!(
        matches!(
            err,
            GitError::NetworkFailed {
                code: None,
                kind: NetworkErrorKind::Other,
                ..
            }
        ),
        "{err:?}"
    );
}

#[test]
fn credentials_never_appear_in_a_network_error() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "printf '%s\\n' \"$@\" >&2\nexit 1");
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(Some(&creds()))
        .unwrap_err();
    for text in [format!("{err:?}"), err.to_string()] {
        assert!(!text.contains(TOKEN), "{text}");
    }
}

// ---------- GR-12 follow-ups ----------

const SECOND_URL: &str = "https://example.test/me/y.git";

fn add_remote(path: &Path, name: &str, url: &str) {
    Repository::open(path).unwrap().remote(name, url).unwrap();
}

fn set_origin_url(path: &Path, url: &str) {
    Repository::open(path)
        .unwrap()
        .remote_set_url("origin", url)
        .unwrap();
}

fn network_failed(err: GitError) -> (NetworkErrorKind, Option<String>, Option<String>) {
    match err {
        GitError::NetworkFailed { kind, detail, .. } => (kind, detail.host, detail.reason),
        other => panic!("expected NetworkFailed, got {other:?}"),
    }
}

const HOST_KEY_FAILURE: &str = "printf 'Host key verification failed.\\n' >&2\nexit 128";

// W3: fetch_remote runs `git fetch <name>` and nothing else.
#[test]
fn fetch_remote_runs_fetch_with_only_the_remote_name() {
    let (_d, _b, path, _h) = fixture();
    add_remote(&path, "second", SECOND_URL);
    session(&path)
        .prepare_fetch_remote("second")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(after_workdir(&path), ["fetch", "second"]);
}

#[test]
fn fetch_remote_without_credentials_sets_no_secrets_and_approves_nothing() {
    let (_d, _b, path, _h) = fixture();
    session(&path)
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(read(&path, "env.txt").unwrap(), "<unset>\n<unset>\n");
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn fetch_remote_with_credentials_scopes_the_helper_and_keeps_the_token_out_of_argv() {
    let (_d, _b, path, _h) = fixture();
    session(&path)
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    let mut want = auth_args("https://example.test");
    want.push("fetch".into());
    want.push("origin".into());
    assert_eq!(after_workdir(&path), want);
    assert!(!after_workdir(&path).iter().any(|a| a.contains(TOKEN)));
}

// The approve and https handling consider the fetched remote only: a second remote on the same
// origin must not be approved by a fetch of the first.
#[test]
fn fetch_remote_approves_only_the_fetched_remotes_url() {
    let (_d, _b, path, _h) = fixture();
    add_remote(&path, "second", SECOND_URL);
    session(&path)
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    assert_eq!(read(&path, "approve-stdin.txt").unwrap(), approved(URL));
}

#[test]
fn fetch_remote_of_another_origin_approves_nothing_for_these_credentials() {
    let (_d, _b, path, _h) = fixture();
    add_remote(&path, "other", "https://elsewhere.test/me/z.git");
    session(&path)
        .prepare_fetch_remote("other")
        .unwrap()
        .run(Some(&creds()))
        .unwrap();
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn a_failed_fetch_remote_never_approves_and_is_a_fetch_failure() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, "exit 1");
    let err = session(&path)
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(Some(&creds()))
        .unwrap_err();
    assert!(
        matches!(
            err,
            GitError::NetworkFailed {
                verb: "fetch",
                https: true,
                ..
            }
        ),
        "{err:?}"
    );
    assert_eq!(read(&path, "approve-stdin.txt"), None);
}

#[test]
fn a_fetch_remote_failure_is_not_https_when_only_another_remote_is() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "/srv/local.git");
    add_remote(&path, "web", SECOND_URL);
    behaviour(&path, "exit 1");
    let err = session(&path)
        .prepare_fetch_remote("origin")
        .unwrap()
        .run(None)
        .unwrap_err();
    assert!(
        matches!(err, GitError::NetworkFailed { https: false, .. }),
        "{err:?}"
    );
}

// W4: the host for the SSH kinds.
#[test]
fn a_host_key_failure_names_the_host_from_stderr_first() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "git@url-host.test:me/x.git");
    behaviour(
        &path,
        "printf 'No ED25519 host key is known for [stderr-host.test]:2222 and you have requested strict checking.\\nHost key verification failed.\\n' >&2\nexit 128",
    );
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::HostKeyUnverified,
            Some("stderr-host.test".into()),
            None
        )
    );
}

#[test]
fn a_host_key_failure_without_a_host_in_stderr_uses_the_only_remotes_scp_url() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "git@url-host.test:me/x.git");
    behaviour(&path, HOST_KEY_FAILURE);
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::HostKeyUnverified,
            Some("url-host.test".into()),
            None
        )
    );
}

#[test]
fn an_ssh_auth_failure_uses_the_ssh_url_host_with_a_port() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "ssh://git@url-host.test:2222/me/x.git");
    behaviour(
        &path,
        "printf 'git@url-host.test: Permission denied (publickey).\\n' >&2\nexit 128",
    );
    let err = session(&path)
        .prepare_pull()
        .unwrap()
        .fetch(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::SshAuthFailed,
            Some("url-host.test".into()),
            None
        )
    );
}

#[test]
fn a_push_ssh_failure_uses_the_push_url_host() {
    let (_d, _b, path, head) = fixture();
    set_origin_url(&path, "git@fetch-host.test:me/x.git");
    Repository::open(&path)
        .unwrap()
        .remote_set_pushurl("origin", Some("git@push-host.test:me/x.git"))
        .unwrap();
    behaviour(&path, HOST_KEY_FAILURE);
    let err = session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::HostKeyUnverified,
            Some("push-host.test".into()),
            None
        )
    );
}

#[test]
fn a_fetch_remote_ssh_failure_uses_that_remotes_url_host() {
    let (_d, _b, path, _h) = fixture();
    add_remote(&path, "mirror", "git@mirror-host.test:me/x.git");
    behaviour(&path, HOST_KEY_FAILURE);
    let err = session(&path)
        .prepare_fetch_remote("mirror")
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::HostKeyUnverified,
            Some("mirror-host.test".into()),
            None
        )
    );
}

#[test]
fn a_fetch_of_several_remotes_has_no_host_when_stderr_names_none() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "git@one.test:me/x.git");
    add_remote(&path, "mirror", "git@two.test:me/x.git");
    behaviour(&path, HOST_KEY_FAILURE);
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (NetworkErrorKind::HostKeyUnverified, None, None)
    );
}

#[test]
fn a_fetch_of_several_remotes_still_takes_the_host_from_stderr() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "git@one.test:me/x.git");
    add_remote(&path, "mirror", "git@two.test:me/x.git");
    behaviour(
        &path,
        "printf 'Host key for two.test has changed and you have requested strict checking.\\nHost key verification failed.\\n' >&2\nexit 128",
    );
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::HostKeyUnverified,
            Some("two.test".into()),
            None
        )
    );
}

#[test]
fn an_ssh_failure_on_a_non_ssh_remote_has_no_host() {
    let (_d, _b, path, _h) = fixture();
    behaviour(&path, HOST_KEY_FAILURE);
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (NetworkErrorKind::HostKeyUnverified, None, None)
    );
}

#[test]
fn a_non_ssh_kind_has_no_host_even_on_an_ssh_remote() {
    let (_d, _b, path, _h) = fixture();
    set_origin_url(&path, "git@url-host.test:me/x.git");
    behaviour(
        &path,
        "printf 'ssh: Could not resolve hostname url-host.test: Name or service not known\\n' >&2\nexit 128",
    );
    let err = session(&path)
        .prepare_fetch()
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (NetworkErrorKind::HostUnreachable, None, None)
    );
}

// W7: the reason, for RemoteRejected only.
#[test]
fn a_remote_rejected_push_carries_the_remote_error_line_as_its_reason() {
    let (_d, _b, path, head) = fixture();
    behaviour(
        &path,
        "cat >&2 <<'EOF'\nremote: error: GH007: Your push would publish a private email address.        \n ! [remote rejected] a -> a (push declined due to email privacy restrictions)\nEOF\nexit 1",
    );
    let err = session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::RemoteRejected,
            None,
            Some("GH007: Your push would publish a private email address.".into())
        )
    );
}

#[test]
fn a_hook_declined_push_carries_the_parenthesised_reason() {
    let (_d, _b, path, head) = fixture();
    behaviour(
        &path,
        "printf ' ! [remote rejected] main -> main (pre-receive hook declined)\\n' >&2\nexit 1",
    );
    let err = session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (
            NetworkErrorKind::RemoteRejected,
            None,
            Some("pre-receive hook declined".into())
        )
    );
}

#[test]
fn a_failure_that_is_not_remote_rejected_has_no_reason() {
    let (_d, _b, path, head) = fixture();
    behaviour(
        &path,
        "printf ' ! [rejected]        HEAD -> main (fetch first)\\n' >&2\nexit 1",
    );
    let err = session(&path)
        .prepare_push(&PushTarget::Upstream, false, &head)
        .unwrap()
        .run(None)
        .unwrap_err();
    assert_eq!(
        network_failed(err),
        (NetworkErrorKind::PushRejectedNonFastForward, None, None)
    );
}
