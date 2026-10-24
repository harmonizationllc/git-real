//! Integration tests for the hosting command `*_inner` functions and `NetworkAuth` (GR-13a).
//! A `FakeTransport` stands in for the provider's REST API; git runs for real against a local
//! bare repository that `origin` reaches through `url.<bare>.insteadOf`, so detection sees a
//! hosted-looking `https://github.com/o/r.git` while fetch stays offline.

mod common;

use std::path::{Path, PathBuf};

use common::{FakeTransport, MemoryTokenStore, github_account, hosting_store, hosting_store_with};
use git_real_core::hosting::{
    CheckoutPrOutcome, HostedRepoInfo, Method, NewPullRequest, Provider, RepoRef, Token,
};
use git_real_core::{Credentials, PullRequestDraft, PushTarget, RepoSession};
use git_real_lib::commands::hosting::{
    CreatePrRequest, hosting_checkout_pull_request_inner, hosting_connect_inner,
    hosting_create_pull_request_inner, hosting_disconnect_inner, hosting_list_accounts_inner,
    hosting_list_issues_inner, hosting_list_my_repos_inner, hosting_list_pull_requests_inner,
    hosting_pull_request_draft_inner, hosting_repo_context_inner, hosting_repo_info_inner,
};
use git_real_lib::commands::remote::{NetworkAuth, fetch_inner, list_remotes_inner};
use git_real_lib::error::AppErrorKind;
use git_real_lib::hosting_store::HostingStore;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::{BranchType, Repository};
use tempfile::TempDir;

const SECRET: &str = "ghp_SECRET-token-123";
const MISSING_ID: RepoId = 4242;
const ORIGIN_URL: &str = "https://github.com/o/r.git";

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

/// The oid `name` points at in `path`, if it exists.
fn ref_oid(path: &Path, name: &str) -> Option<String> {
    Repository::open(path)
        .unwrap()
        .find_reference(name)
        .ok()
        .and_then(|r| r.target())
        .map(|o| o.to_string())
}

/// Commits `file` on a side clone of `bare` (on top of the default branch) and force-pushes it
/// to `refs/pull/<n>/head`. Returns the new oid.
fn push_pr_head(bare: &Path, n: u64, file: &str) -> String {
    let side_dir = tempfile::tempdir().unwrap();
    let side = side_dir.path().join("side");
    git(
        side_dir.path(),
        &["clone", "-q", bare.to_str().unwrap(), "side"],
    );
    common::configure_identity(&side);
    let oid = common::commit_file(&side, file, "pr\n", &format!("pr {n} {file}"));
    git(
        &side,
        &["push", "-q", "origin", &format!("+HEAD:refs/pull/{n}/head")],
    );
    oid.to_string()
}

/// Pushes a branch `name` with one commit to `bare` from a side clone.
fn push_branch_to_bare(bare: &Path, name: &str) {
    let side_dir = tempfile::tempdir().unwrap();
    let side = side_dir.path().join("side");
    git(
        side_dir.path(),
        &["clone", "-q", bare.to_str().unwrap(), "side"],
    );
    common::configure_identity(&side);
    git(&side, &["checkout", "-q", "-b", name]);
    common::commit_file(&side, "feature.txt", "f\n", "feature work");
    git(&side, &["push", "-q", "origin", name]);
}

/// A repository whose `origin` is `https://github.com/o/r.git`, redirected to a local bare
/// clone by `insteadOf`, registered in a fresh registry with an empty account store.
struct Hosted {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    head: String,
    reg: RepoRegistry,
    id: RepoId,
    store: HostingStore,
    tokens: MemoryTokenStore,
}

fn hosted() -> Hosted {
    hosted_with(MemoryTokenStore::default())
}

fn hosted_with(tokens: MemoryTokenStore) -> Hosted {
    let (d1, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (d2, bare) = common::temp_bare_clone(&path);
    git(&path, &["remote", "add", "origin", ORIGIN_URL]);
    git(
        &path,
        &[
            "config",
            &format!("url.{}.insteadOf", bare.display()),
            ORIGIN_URL,
        ],
    );
    git(&path, &["fetch", "-q", "origin"]);
    // The setup fetch wrote FETCH_HEAD; tests assert on what the commands write.
    let _ = std::fs::remove_file(path.join(".git/FETCH_HEAD"));
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (d3, store, tokens) = hosting_store_with(tokens);
    Hosted {
        _dirs: [d1, d2, d3],
        path,
        bare,
        head,
        reg,
        id,
        store,
        tokens,
    }
}

impl Hosted {
    /// Connects `octo` on github.com through the store.
    fn connect(&self) {
        self.store
            .connect(github_account("octo"), &Token::new(SECRET).unwrap())
            .unwrap();
    }

    fn checkout(
        &self,
        t: &FakeTransport,
        number: u64,
        reset: bool,
    ) -> Result<CheckoutPrOutcome, git_real_lib::error::AppError> {
        hosting_checkout_pull_request_inner(&self.reg, &self.store, t, self.id, number, reset, None)
    }
}

/// A GitHub single-PR JSON body. `fork` puts the head in `bob/r`.
fn github_pr(n: u64, src: &str, fork: bool) -> String {
    let head_repo = if fork { "bob/r" } else { "o/r" };
    serde_json::json!({
        "number": n,
        "title": format!("pull {n}"),
        "user": { "login": "bob" },
        "head": { "ref": src, "repo": { "full_name": head_repo, "clone_url": format!("https://github.com/{head_repo}.git") } },
        "base": { "ref": "main", "repo": { "full_name": "o/r", "clone_url": ORIGIN_URL } },
        "draft": false,
        "updated_at": "2026-01-02T03:04:05Z",
        "html_url": format!("https://github.com/o/r/pull/{n}")
    })
    .to_string()
}

// --- accounts: list, connect, disconnect ---

#[test]
fn list_accounts_returns_the_stores_accounts() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    assert_eq!(hosting_list_accounts_inner(&store), vec![a]);
}

#[test]
fn list_accounts_is_empty_without_accounts() {
    let (_dir, store, _tokens) = hosting_store();
    assert!(hosting_list_accounts_inner(&store).is_empty());
}

#[test]
fn disconnect_removes_the_account() {
    let (_dir, store, tokens) = hosting_store();
    let a = store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    hosting_disconnect_inner(&store, &a.id).unwrap();
    assert!(
        hosting_list_accounts_inner(&store).is_empty() && tokens.map.lock().unwrap().is_empty()
    );
}

#[test]
fn disconnect_of_an_unknown_id_succeeds() {
    let (_dir, store, _tokens) = hosting_store();
    assert!(hosting_disconnect_inner(&store, "nope").is_ok());
}

#[test]
fn disconnect_with_a_failing_keychain_is_keychain_unavailable() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_delete: true,
        ..Default::default()
    });
    let a = store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    let err = hosting_disconnect_inner(&store, &a.id).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::KeychainUnavailable);
}

// The token is checked against the provider before it is stored.
#[test]
fn connect_returns_the_account_the_provider_reports() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(200, r#"{"login":"octo","name":"Octo"}"#);
    let a =
        hosting_connect_inner(&store, &t, Provider::GitHub, Some("GitHub.com"), SECRET).unwrap();
    assert_eq!(
        (a.id.as_str(), a.display_name.as_deref()),
        ("github:github.com:octo", Some("Octo"))
    );
}

#[test]
fn connect_asks_the_providers_user_endpoint_with_a_bearer_token() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap();
    assert_eq!(t.requests()[0].url, "https://api.github.com/user");
}

#[test]
fn connect_stores_the_token_in_the_keychain() {
    let (_dir, store, tokens) = hosting_store();
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap();
    assert_eq!(
        tokens
            .map
            .lock()
            .unwrap()
            .get("github:github.com:octo")
            .map(String::as_str),
        Some(SECRET)
    );
}

#[test]
fn connect_lists_the_account_afterwards() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap();
    assert_eq!(hosting_list_accounts_inner(&store).len(), 1);
}

#[test]
fn connect_with_a_rejected_token_is_hosting_auth() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingAuth);
}

#[test]
fn connect_with_a_rejected_token_stores_nothing() {
    let (_dir, store, tokens) = hosting_store();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let _ = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET);
    assert!(store.accounts().is_empty() && tokens.map.lock().unwrap().is_empty());
}

#[test]
fn connect_never_leaks_a_token_the_provider_echoes_in_its_error() {
    let (_dir, store, _tokens) = hosting_store();
    let body = format!(r#"{{"message":"token {SECRET} is revoked"}}"#);
    let t = FakeTransport::new().reply(401, &body);
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap_err();
    for text in [format!("{err:?}"), serde_json::to_string(&err).unwrap()] {
        assert!(!text.contains(SECRET), "{text}");
    }
}

#[test]
fn connect_with_a_line_break_in_the_token_is_invalid_token() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new();
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, "a\nb").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidToken);
}

#[test]
fn connect_with_an_empty_token_is_invalid_token() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new();
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, "").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidToken);
}

#[test]
fn connect_with_an_invalid_token_sends_no_request() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new();
    let _ = hosting_connect_inner(&store, &t, Provider::GitHub, None, "a\nb");
    assert!(t.requests().is_empty());
}

#[test]
fn connect_to_bitbucket_with_a_custom_host_is_invalid_hosting_host() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new();
    let err = hosting_connect_inner(&store, &t, Provider::Bitbucket, Some("bb.corp"), SECRET)
        .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidHostingHost);
}

#[test]
fn connect_with_a_malformed_host_sends_no_request_and_stores_nothing() {
    let (_dir, store, tokens) = hosting_store();
    let t = FakeTransport::new();
    let _ = hosting_connect_inner(&store, &t, Provider::GitHub, Some("bad host/"), SECRET);
    assert!(
        t.requests().is_empty()
            && store.accounts().is_empty()
            && tokens.map.lock().unwrap().is_empty()
    );
}

#[test]
fn connect_with_a_failing_keychain_is_keychain_unavailable() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_set: true,
        ..Default::default()
    });
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::KeychainUnavailable);
}

#[test]
fn connect_with_a_failing_keychain_lists_no_account() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_set: true,
        ..Default::default()
    });
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    let _ = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET);
    assert!(store.accounts().is_empty());
}

#[test]
fn connect_when_the_provider_is_unreachable_is_hosting_unreachable() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(503, "");
    let err = hosting_connect_inner(&store, &t, Provider::GitHub, None, SECRET).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingUnreachable);
}

// --- repo context: origin detection and the account attached to it ---

#[test]
fn repo_context_detects_the_hosted_repository_behind_origin() {
    let fx = hosted();
    let ctx = hosting_repo_context_inner(&fx.reg, &fx.store, fx.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        ctx.repo,
        RepoRef {
            provider: Provider::GitHub,
            host: "github.com".to_owned(),
            namespace: "o".to_owned(),
            name: "r".to_owned(),
        }
    );
}

// Detection reads the raw configured URL (what `list_remotes` reports); only fetch applies
// insteadOf. git2's `Remote::url()` already applies it, so it is not the source of truth.
#[test]
fn repo_context_reads_the_raw_origin_url_not_the_rewritten_one() {
    let fx = hosted();
    let remotes = list_remotes_inner(&fx.reg, fx.id).unwrap();
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert_eq!(origin.fetch_url, ORIGIN_URL);
}

#[test]
fn repo_context_has_no_account_before_one_is_connected() {
    let fx = hosted();
    let ctx = hosting_repo_context_inner(&fx.reg, &fx.store, fx.id)
        .unwrap()
        .unwrap();
    assert!(ctx.account.is_none());
}

#[test]
fn repo_context_attaches_the_account_for_the_host() {
    let fx = hosted();
    fx.connect();
    let ctx = hosting_repo_context_inner(&fx.reg, &fx.store, fx.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        ctx.account.map(|a| a.id),
        Some("github:github.com:octo".to_owned())
    );
}

#[test]
fn repo_context_ignores_an_account_on_another_host() {
    let fx = hosted();
    let t = FakeTransport::new().reply(200, r#"{"username":"tanuki"}"#);
    hosting_connect_inner(&fx.store, &t, Provider::GitLab, None, SECRET).unwrap();
    let ctx = hosting_repo_context_inner(&fx.reg, &fx.store, fx.id)
        .unwrap()
        .unwrap();
    assert!(ctx.account.is_none());
}

#[test]
fn repo_context_is_none_without_an_origin() {
    let (_d, path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (_sd, store, _tokens) = hosting_store();
    assert_eq!(hosting_repo_context_inner(&reg, &store, id).unwrap(), None);
}

#[test]
fn repo_context_is_none_for_an_origin_that_is_a_local_path() {
    let (_d, path) = common::temp_repo_with_commit();
    Repository::open(&path)
        .unwrap()
        .remote("origin", "/srv/x.git")
        .unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (_sd, store, _tokens) = hosting_store();
    assert_eq!(hosting_repo_context_inner(&reg, &store, id).unwrap(), None);
}

#[test]
fn repo_context_is_none_when_origin_is_on_an_unknown_host() {
    let (_d, path) = common::temp_repo_with_commit();
    Repository::open(&path)
        .unwrap()
        .remote("origin", "https://git.example.org/o/r.git")
        .unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (_sd, store, _tokens) = hosting_store();
    assert_eq!(hosting_repo_context_inner(&reg, &store, id).unwrap(), None);
}

#[test]
fn repo_context_treats_a_connected_custom_host_as_its_provider() {
    let (_d, path) = common::temp_repo_with_commit();
    Repository::open(&path)
        .unwrap()
        .remote("origin", "https://ghe.corp/o/r.git")
        .unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (_sd, store, _tokens) = hosting_store();
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    hosting_connect_inner(&store, &t, Provider::GitHub, Some("ghe.corp"), SECRET).unwrap();
    let ctx = hosting_repo_context_inner(&reg, &store, id)
        .unwrap()
        .unwrap();
    assert_eq!(ctx.repo.provider, Provider::GitHub);
}

#[test]
fn repo_context_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let err = hosting_repo_context_inner(&RepoRegistry::default(), &store, MISSING_ID).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- pull request list ---

#[test]
fn list_pull_requests_returns_the_providers_open_pull_requests() {
    let fx = hosted();
    fx.connect();
    let body = format!(
        "[{},{}]",
        github_pr(2, "b", false),
        github_pr(1, "a", false)
    );
    let t = FakeTransport::new().reply(200, &body);
    let prs = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap();
    assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), [2, 1]);
}

#[test]
fn list_pull_requests_asks_the_requested_page() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, "[]");
    hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 2).unwrap();
    assert!(
        t.requests()[0].url.ends_with("&page=2"),
        "{}",
        t.requests()[0].url
    );
}

#[test]
fn list_pull_requests_sends_page_zero_as_page_one() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, "[]");
    hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 0).unwrap();
    assert!(
        t.requests()[0].url.ends_with("&page=1"),
        "{}",
        t.requests()[0].url
    );
}

#[test]
fn list_pull_requests_targets_the_detected_repository() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, "[]");
    hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap();
    assert!(
        t.requests()[0]
            .url
            .starts_with("https://api.github.com/repos/o/r/pulls?"),
        "{}",
        t.requests()[0].url
    );
}

#[test]
fn list_pull_requests_authenticates_with_the_stored_token() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, "[]");
    hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap();
    let auth = t.requests()[0]
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone());
    assert_eq!(auth, Some(format!("Bearer {SECRET}")));
}

#[test]
fn list_pull_requests_without_an_account_is_no_hosting_account() {
    let fx = hosted();
    let t = FakeTransport::new();
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
}

#[test]
fn list_pull_requests_without_an_account_calls_no_api() {
    let fx = hosted();
    let t = FakeTransport::new();
    let _ = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1);
    assert!(t.requests().is_empty());
}

#[test]
fn list_pull_requests_without_a_stored_token_is_no_hosting_account() {
    let fx = hosted();
    fx.connect();
    fx.tokens.map.lock().unwrap().clear();
    let t = FakeTransport::new();
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
}

#[test]
fn list_pull_requests_for_a_repo_without_a_hosted_origin_is_no_hosting_account() {
    let (_d, path) = common::temp_repo_with_commit();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (_sd, store, _tokens) = hosting_store();
    let err =
        hosting_list_pull_requests_inner(&reg, &store, &FakeTransport::new(), id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
}

#[test]
fn list_pull_requests_with_a_rejected_token_is_hosting_auth() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingAuth);
}

#[test]
fn list_pull_requests_with_a_rejected_token_marks_the_account_for_reconnect() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let _ = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1);
    assert!(fx.store.accounts()[0].needs_reconnect);
}

#[test]
fn list_pull_requests_with_a_not_found_repo_leaves_the_account_healthy() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(404, r#"{"message":"Not Found"}"#);
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(
        (err.kind, fx.store.accounts()[0].needs_reconnect),
        (AppErrorKind::HostingNotFound, false)
    );
}

#[test]
fn list_pull_requests_rate_limited_is_hosting_rate_limited() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(429, "");
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingRateLimited);
}

#[test]
fn list_pull_requests_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let err = hosting_list_pull_requests_inner(
        &RepoRegistry::default(),
        &store,
        &FakeTransport::new(),
        MISSING_ID,
        1,
    )
    .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- checkout: same-repo branch ---

#[test]
fn checkout_of_a_same_repo_pr_tracks_the_head_branch() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_branch_to_bare(&fx.bare, "feature");
    let t = FakeTransport::new().reply(200, &github_pr(3, "feature", false));
    let outcome = fx.checkout(&t, 3, false).unwrap();
    assert_eq!(
        outcome,
        CheckoutPrOutcome::CheckedOut {
            branch: "feature".to_owned()
        }
    );
}

#[test]
fn checkout_of_a_same_repo_pr_puts_head_on_the_branch() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_branch_to_bare(&fx.bare, "feature");
    let t = FakeTransport::new().reply(200, &github_pr(3, "feature", false));
    fx.checkout(&t, 3, false).unwrap();
    assert_eq!(common::head_branch_name(&fx.path), "feature");
}

#[test]
fn checkout_of_a_same_repo_pr_sets_the_upstream_to_origin() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_branch_to_bare(&fx.bare, "feature");
    let t = FakeTransport::new().reply(200, &github_pr(3, "feature", false));
    fx.checkout(&t, 3, false).unwrap();
    let repo = Repository::open(&fx.path).unwrap();
    let upstream = repo
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .upstream()
        .unwrap()
        .name()
        .unwrap()
        .map(str::to_owned);
    assert_eq!(upstream.as_deref(), Some("origin/feature"));
}

// --- checkout: fork PRs land on pr/<n> ---

// Review Focus 2: a fork's branch is often called like the user's own (`main`); it must land
// on pr/<n> and leave the same-named local branch alone.
#[test]
fn checkout_of_a_github_fork_pr_fetches_refs_pull_and_creates_pr_n() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    let pr_oid = push_pr_head(&fx.bare, 7, "fork.txt");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    let outcome = fx.checkout(&t, 7, false).unwrap();
    assert_eq!(
        (outcome, ref_oid(&fx.path, "refs/heads/pr/7")),
        (
            CheckoutPrOutcome::CheckedOut {
                branch: "pr/7".to_owned()
            },
            Some(pr_oid)
        )
    );
}

#[test]
fn checkout_of_a_fork_pr_never_touches_the_same_named_local_branch() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    let before = ref_oid(&fx.path, &format!("refs/heads/{}", fx.head));
    push_pr_head(&fx.bare, 7, "fork.txt");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    assert_eq!(
        ref_oid(&fx.path, &format!("refs/heads/{}", fx.head)),
        before
    );
}

#[test]
fn checkout_of_a_fork_pr_puts_head_on_pr_n() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_pr_head(&fx.bare, 7, "fork.txt");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    assert_eq!(common::head_branch_name(&fx.path), "pr/7");
}

#[test]
fn checkout_re_reads_the_pull_request_from_the_provider() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_pr_head(&fx.bare, 7, "fork.txt");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    let urls: Vec<String> = t.requests().into_iter().map(|r| r.url).collect();
    assert_eq!(urls, ["https://api.github.com/repos/o/r/pulls/7"]);
}

#[test]
fn checkout_of_a_pr_with_an_unsafe_head_branch_is_invalid_branch_name() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, &github_pr(7, "--upload-pack=x", false));
    let err = fx.checkout(&t, 7, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
}

// --- checkout: an existing pr/<n> that has diverged ---

/// Checks out PR 7 once, then commits locally on `pr/7` and moves the PR head elsewhere, so the
/// two have diverged. Returns the new PR head oid.
fn diverge_pr_7(fx: &Hosted) -> String {
    push_pr_head(&fx.bare, 7, "first.txt");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    common::commit_file(&fx.path, "local.txt", "mine\n", "local work on pr/7");
    push_pr_head(&fx.bare, 7, "second.txt")
}

#[test]
fn checkout_reports_needs_reset_when_pr_n_has_commits_the_head_lacks() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    diverge_pr_7(&fx);
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    let outcome = fx.checkout(&t, 7, false).unwrap();
    assert_eq!(
        outcome,
        CheckoutPrOutcome::NeedsReset {
            branch: "pr/7".to_owned()
        }
    );
}

#[test]
fn needs_reset_changes_nothing() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    diverge_pr_7(&fx);
    let before = ref_oid(&fx.path, "refs/heads/pr/7");
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    assert_eq!(ref_oid(&fx.path, "refs/heads/pr/7"), before);
}

#[test]
fn checkout_with_reset_moves_pr_n_to_the_pull_request_head() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    let new_head = diverge_pr_7(&fx);
    let t = FakeTransport::new().reply(200, &github_pr(7, &fx.head, true));
    let outcome = fx.checkout(&t, 7, true).unwrap();
    assert_eq!(
        (outcome, ref_oid(&fx.path, "refs/heads/pr/7")),
        (
            CheckoutPrOutcome::CheckedOut {
                branch: "pr/7".to_owned()
            },
            Some(new_head)
        )
    );
}

#[test]
fn checkout_again_when_pr_n_already_contains_the_head_just_switches() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_pr_head(&fx.bare, 7, "first.txt");
    let t = FakeTransport::new()
        .reply(200, &github_pr(7, &fx.head, true))
        .reply(200, &github_pr(7, &fx.head, true));
    fx.checkout(&t, 7, false).unwrap();
    let outcome = fx.checkout(&t, 7, false).unwrap();
    assert_eq!(
        outcome,
        CheckoutPrOutcome::CheckedOut {
            branch: "pr/7".to_owned()
        }
    );
}

// --- checkout: refusals do no git work ---

#[test]
fn checkout_without_an_account_is_no_hosting_account() {
    let fx = hosted();
    let t = FakeTransport::new();
    let err = fx.checkout(&t, 7, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
}

#[test]
fn checkout_without_an_account_calls_no_api_and_writes_no_fetch_head() {
    let fx = hosted();
    let t = FakeTransport::new();
    let _ = fx.checkout(&t, 7, false);
    assert!(t.requests().is_empty() && !fx.path.join(".git/FETCH_HEAD").exists());
}

#[test]
fn checkout_with_a_rejected_token_is_hosting_auth() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = fx.checkout(&t, 7, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingAuth);
}

#[test]
fn checkout_with_a_rejected_token_marks_the_account_and_writes_no_fetch_head() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let _ = fx.checkout(&t, 7, false);
    assert!(fx.store.accounts()[0].needs_reconnect && !fx.path.join(".git/FETCH_HEAD").exists());
}

#[test]
fn checkout_of_a_missing_pull_request_is_hosting_not_found() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(404, r#"{"message":"Not Found"}"#);
    let err = fx.checkout(&t, 99, false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingNotFound);
}

#[test]
fn checkout_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let err = hosting_checkout_pull_request_inner(
        &RepoRegistry::default(),
        &store,
        &FakeTransport::new(),
        MISSING_ID,
        1,
        false,
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- NetworkAuth ---

fn urls() -> Vec<String> {
    vec![ORIGIN_URL.to_owned()]
}

#[test]
fn network_auth_prefers_typed_credentials() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    let typed = Credentials::new("https://github.com", "me", "typed").unwrap();
    let resolved = NetworkAuth::new(Some(&typed), &store).resolve(&urls());
    assert_eq!(resolved.unwrap().username(), "me");
}

#[test]
fn network_auth_falls_back_to_the_account_store() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    let resolved = NetworkAuth::new(None, &store).resolve(&urls());
    assert_eq!(resolved.unwrap().username(), "x-access-token");
}

#[test]
fn network_auth_account_credentials_are_not_approved() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    let resolved = NetworkAuth::Accounts(&store).resolve(&urls());
    assert!(!resolved.unwrap().approves());
}

#[test]
fn network_auth_accounts_resolve_nothing_for_a_host_without_an_account() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    let resolved =
        NetworkAuth::Accounts(&store).resolve(&["https://gitlab.com/g/p.git".to_owned()]);
    assert!(resolved.is_none());
}

#[test]
fn network_auth_new_without_credentials_or_accounts_resolves_nothing() {
    let (_dir, store, _tokens) = hosting_store();
    assert!(NetworkAuth::new(None, &store).resolve(&urls()).is_none());
}

#[test]
fn network_auth_explicit_resolves_the_typed_credentials_whatever_the_urls() {
    let typed = Credentials::new("https://github.com", "me", "typed").unwrap();
    let resolved = NetworkAuth::Explicit(&typed).resolve(&["/srv/a.git".to_owned()]);
    assert_eq!(resolved.unwrap().username(), "me");
}

#[test]
fn network_auth_accounts_over_an_empty_store_resolves_nothing() {
    let (_dir, store, _tokens) = hosting_store();
    assert!(NetworkAuth::Accounts(&store).resolve(&urls()).is_none());
}

// Review Focus 5: a locked keychain must not stop a fetch for a host with an account.
#[test]
fn fetch_with_account_auth_still_runs_when_the_keychain_cannot_be_read() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with(MemoryTokenStore {
        fail_get: true,
        ..Default::default()
    });
    fx.connect();
    push_branch_to_bare(&fx.bare, "feature");
    fetch_inner(&fx.reg, fx.id, NetworkAuth::Accounts(&fx.store)).unwrap();
    assert!(ref_oid(&fx.path, "refs/remotes/origin/feature").is_some());
}

#[test]
fn fetch_with_account_auth_updates_tracking_refs_through_the_rewritten_url() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_branch_to_bare(&fx.bare, "feature");
    fetch_inner(&fx.reg, fx.id, NetworkAuth::new(None, &fx.store)).unwrap();
    assert!(ref_oid(&fx.path, "refs/remotes/origin/feature").is_some());
}

// --- GR-13b: repository info, issues, PR draft, create pull request ---

impl Hosted {
    /// Switches to a new local branch `name` at the current HEAD.
    fn start_branch(&self, name: &str) {
        git(&self.path, &["switch", "-q", "-c", name]);
    }

    /// Commits one file on the checked-out branch and returns the new tip.
    fn commit(&self, file: &str, message: &str) -> String {
        common::commit_file(&self.path, file, "x\n", message).to_string()
    }

    fn create(
        &self,
        t: &FakeTransport,
        request: &CreatePrRequest,
    ) -> Result<git_real_core::hosting::PullRequest, git_real_lib::error::AppError> {
        hosting_create_pull_request_inner(&self.reg, &self.store, t, self.id, request, None)
    }
}

/// The Review Focus 1 body: GitHub's answer to a duplicate pull request.
const DUPLICATE_PR: &str = r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:feat."}]}"#;

fn create_request(fx: &Hosted, push: Option<PushTarget>) -> CreatePrRequest {
    CreatePrRequest {
        branch: "feat".to_owned(),
        push,
        pr: NewPullRequest {
            title: "T".to_owned(),
            body: "B".to_owned(),
            source_branch: "feat".to_owned(),
            target_branch: fx.head.clone(),
        },
    }
}

fn set_upstream_origin_feat() -> Option<PushTarget> {
    Some(PushTarget::SetUpstream {
        remote: "origin".to_owned(),
        branch: "feat".to_owned(),
    })
}

// Repository info passes the provider's answer through.
#[test]
fn repo_info_passes_through_the_provider_answer() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, r#"{"default_branch":"main","has_issues":false}"#);

    let info = hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id).unwrap();

    assert_eq!(
        info,
        HostedRepoInfo {
            default_branch: Some("main".to_owned()),
            issues_enabled: false
        }
    );
}

#[test]
fn repo_info_asks_the_detected_repository() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, r#"{"default_branch":"main"}"#);
    hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id).unwrap();
    assert_eq!(t.requests()[0].url, "https://api.github.com/repos/o/r");
}

#[test]
fn repo_info_without_an_account_is_no_hosting_account() {
    let fx = hosted();
    let t = FakeTransport::new();
    let err = hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
}

#[test]
fn repo_info_without_an_account_calls_no_api() {
    let fx = hosted();
    let t = FakeTransport::new();
    let _ = hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id);
    assert!(t.requests().is_empty());
}

#[test]
fn repo_info_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let err = hosting_repo_info_inner(
        &RepoRegistry::default(),
        &store,
        &FakeTransport::new(),
        MISSING_ID,
    )
    .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// Issues: the query and page reach the provider; a rejected token marks the account.
#[test]
fn list_issues_passes_the_query_and_page() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);

    let issues = hosting_list_issues_inner(&fx.reg, &fx.store, &t, fx.id, "crash", 3).unwrap();

    assert!(issues.is_empty());
    let url = &t.requests()[0].url;
    assert!(
        url.contains("q=repo%3Ao%2Fr%20is%3Aissue%20is%3Aopen%20crash") && url.ends_with("&page=3"),
        "{url}"
    );
}

#[test]
fn list_issues_sends_page_zero_as_page_one() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);
    hosting_list_issues_inner(&fx.reg, &fx.store, &t, fx.id, "", 0).unwrap();
    assert!(
        t.requests()[0].url.ends_with("&page=1"),
        "{}",
        t.requests()[0].url
    );
}

#[test]
fn list_issues_without_an_account_is_no_hosting_account() {
    let fx = hosted();
    let t = FakeTransport::new();
    let err = hosting_list_issues_inner(&fx.reg, &fx.store, &t, fx.id, "", 1).unwrap_err();
    assert_eq!(
        (err.kind, t.requests().is_empty()),
        (AppErrorKind::NoHostingAccount, true)
    );
}

#[test]
fn list_issues_with_a_rejected_token_marks_the_account_for_reconnect() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_list_issues_inner(&fx.reg, &fx.store, &t, fx.id, "", 1).unwrap_err();
    assert_eq!(
        (err.kind, fx.store.accounts()[0].needs_reconnect),
        (AppErrorKind::HostingAuth, true)
    );
}

#[test]
fn list_issues_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let err = hosting_list_issues_inner(
        &RepoRegistry::default(),
        &store,
        &FakeTransport::new(),
        MISSING_ID,
        "",
        1,
    )
    .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// GR-13c: the account's own repositories. The command takes an account id, not a repository.
const MY_ACCOUNT_ID: &str = "github:github.com:octo";

fn connected_store() -> (TempDir, HostingStore) {
    let (dir, store, _tokens) = hosting_store();
    store
        .connect(github_account("octo"), &Token::new(SECRET).unwrap())
        .unwrap();
    (dir, store)
}

#[test]
fn list_my_repos_uses_the_account_token_and_pages() {
    let (_dir, store) = connected_store();
    let t = FakeTransport::new().reply(
        200,
        r#"[{"full_name":"octo/r","name":"r","owner":{"login":"octo"},"description":null,"private":true,"updated_at":"2026-10-24T18:00:00Z","clone_url":"https://github.com/octo/r.git","html_url":"https://github.com/octo/r"}]"#,
    );

    let repos = hosting_list_my_repos_inner(&store, &t, MY_ACCOUNT_ID, "", 0).unwrap();

    let req = &t.requests()[0];
    let auth: Vec<_> = req
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(auth, [format!("Bearer {SECRET}")]);
    assert!(req.url.ends_with("&page=1"), "{}", req.url);
    assert_eq!(
        repos
            .iter()
            .map(|r| r.full_name.as_str())
            .collect::<Vec<_>>(),
        ["octo/r"]
    );
}

#[test]
fn list_my_repos_passes_the_query_and_page_through() {
    let (_dir, store) = connected_store();
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);
    hosting_list_my_repos_inner(&store, &t, MY_ACCOUNT_ID, "git", 3).unwrap();
    let url = &t.requests()[0].url;
    assert!(
        url.starts_with(
            "https://api.github.com/search/repositories?q=git%20in%3Aname%20user%3Aocto"
        ) && url.ends_with("&page=3"),
        "{url}"
    );
}

#[test]
fn list_my_repos_with_an_unknown_account_is_no_hosting_account() {
    let (_dir, store) = connected_store();
    let t = FakeTransport::new();
    let err =
        hosting_list_my_repos_inner(&store, &t, "gitlab:gitlab.com:nobody", "", 1).unwrap_err();
    assert_eq!(
        (err.kind, t.requests().is_empty()),
        (AppErrorKind::NoHostingAccount, true)
    );
}

#[test]
fn list_my_repos_with_no_accounts_at_all_is_no_hosting_account() {
    let (_dir, store, _tokens) = hosting_store();
    let t = FakeTransport::new();
    let err = hosting_list_my_repos_inner(&store, &t, MY_ACCOUNT_ID, "", 1).unwrap_err();
    assert_eq!(
        (err.kind, t.requests().is_empty()),
        (AppErrorKind::NoHostingAccount, true)
    );
}

#[test]
fn list_my_repos_marks_the_account_for_reconnect_on_401() {
    let (_dir, store) = connected_store();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_list_my_repos_inner(&store, &t, MY_ACCOUNT_ID, "", 1).unwrap_err();
    assert_eq!(
        (err.kind, store.accounts()[0].needs_reconnect),
        (AppErrorKind::HostingAuth, true)
    );
}

#[test]
fn list_my_repos_does_not_leak_the_token_in_an_error() {
    let (_dir, store) = connected_store();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_list_my_repos_inner(&store, &t, MY_ACCOUNT_ID, "", 1).unwrap_err();
    assert!(!err.message.contains(SECRET), "{}", err.message);
}

// HostingStore::account looks an account up by its id.
#[test]
fn store_account_finds_a_connected_account_by_id() {
    let (_dir, store) = connected_store();
    assert_eq!(
        store.account(MY_ACCOUNT_ID).map(|a| a.username),
        Some("octo".to_owned())
    );
}

#[test]
fn store_account_returns_none_for_an_unknown_id() {
    let (_dir, store) = connected_store();
    assert!(store.account("github:github.com:other").is_none());
}

// The draft is a local git read: no transport, no account.
#[test]
fn pull_request_draft_reads_commits_ahead_of_origin() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.start_branch("feat");
    fx.commit("thing.txt", "Add thing\n\nBody\n");

    let draft = hosting_pull_request_draft_inner(&fx.reg, fx.id, &fx.head).unwrap();

    assert_eq!(
        draft,
        PullRequestDraft {
            title: "Add thing".to_owned(),
            body: "Body".to_owned(),
            ahead: 1
        }
    );
}

#[test]
fn pull_request_draft_with_an_unknown_target_is_revision_not_found() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.start_branch("feat");
    let err = hosting_pull_request_draft_inner(&fx.reg, fx.id, "nope").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::RevisionNotFound);
}

#[test]
fn pull_request_draft_with_an_invalid_target_is_invalid_branch_name() {
    let fx = hosted();
    let err = hosting_pull_request_draft_inner(&fx.reg, fx.id, "-x").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
}

#[test]
fn pull_request_draft_for_an_unknown_repo_is_unknown_repo() {
    let err =
        hosting_pull_request_draft_inner(&RepoRegistry::default(), MISSING_ID, "main").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// Create without a push: one POST to the provider, returning the converted pull request.
#[test]
fn create_without_a_push_posts_and_returns_the_pull_request() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    push_branch_to_bare(&fx.bare, "feat");
    git(&fx.path, &["fetch", "-q", "origin"]);
    let t = FakeTransport::new().reply(201, &github_pr(21, "feat", false));

    let pr = fx.create(&t, &create_request(&fx, None)).unwrap();

    assert_eq!(pr.number, 21);
    let requests = t.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (requests[0].method, requests[0].url.as_str()),
        (Method::Post, "https://api.github.com/repos/o/r/pulls")
    );
    let body: serde_json::Value =
        serde_json::from_str(requests[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"title":"T","body":"B","head":"feat","base":fx.head})
    );
}

// Publish first: the branch lands on origin, becomes the upstream, then the provider is asked.
#[test]
fn create_with_publish_pushes_the_branch_first() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    let tip = fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new().reply(201, &github_pr(21, "feat", false));

    fx.create(&t, &create_request(&fx, set_upstream_origin_feat()))
        .unwrap();

    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), Some(tip));
    assert_eq!(t.requests().len(), 1);
}

#[test]
fn create_with_publish_sets_the_upstream_to_origin() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new().reply(201, &github_pr(21, "feat", false));

    fx.create(&t, &create_request(&fx, set_upstream_origin_feat()))
        .unwrap();

    let repo = Repository::open(&fx.path).unwrap();
    let upstream = repo
        .find_branch("feat", BranchType::Local)
        .unwrap()
        .upstream()
        .unwrap()
        .name()
        .unwrap()
        .map(str::to_owned);
    assert_eq!(upstream.as_deref(), Some("origin/feat"));
}

#[test]
fn create_with_push_ahead_pushes_to_the_upstream() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    fx.commit("one.txt", "one");
    git(&fx.path, &["push", "-q", "-u", "origin", "feat"]);
    let tip = fx.commit("two.txt", "two");
    let t = FakeTransport::new().reply(201, &github_pr(21, "feat", false));

    fx.create(&t, &create_request(&fx, Some(PushTarget::Upstream)))
        .unwrap();

    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), Some(tip));
}

// Review Focus 2: a failed push returns its error and the provider is never asked.
#[test]
fn create_with_a_failing_push_sends_no_provider_request() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new();
    let request = create_request(
        &fx,
        Some(PushTarget::SetUpstream {
            remote: "nope".to_owned(),
            branch: "feat".to_owned(),
        }),
    );

    let err = fx.create(&t, &request).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::RemoteNotFound);
    assert!(t.requests().is_empty());
}

#[test]
fn create_when_head_moved_is_operation_in_progress() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    let t = FakeTransport::new();
    let request = CreatePrRequest {
        branch: "other".to_owned(),
        ..create_request(&fx, Some(PushTarget::Upstream))
    };

    let err = fx.create(&t, &request).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::OperationInProgress);
    assert!(t.requests().is_empty());
}

// Review Focus 1: the user reads the provider's sentence, not "Validation Failed".
#[test]
fn create_rejection_passes_through() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(422, DUPLICATE_PR);

    let err = fx.create(&t, &create_request(&fx, None)).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::HostingRejected);
    assert!(err.message.contains("already exists"), "{}", err.message);
}

#[test]
fn create_with_a_rejected_token_marks_the_account_for_reconnect() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = fx.create(&t, &create_request(&fx, None)).unwrap_err();
    assert_eq!(
        (err.kind, fx.store.accounts()[0].needs_reconnect),
        (AppErrorKind::HostingAuth, true)
    );
}

// The account check comes before the push: no account, nothing leaves the machine.
#[test]
fn create_without_an_account_is_no_hosting_account() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new();

    let err = fx
        .create(&t, &create_request(&fx, set_upstream_origin_feat()))
        .unwrap_err();

    assert_eq!(err.kind, AppErrorKind::NoHostingAccount);
    assert!(t.requests().is_empty());
}

#[test]
fn create_without_an_account_does_not_push() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let _ = fx.create(
        &FakeTransport::new(),
        &create_request(&fx, set_upstream_origin_feat()),
    );
    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), None);
}

#[test]
fn create_of_an_unknown_repo_is_unknown_repo() {
    let (_sd, store, _tokens) = hosting_store();
    let request = CreatePrRequest {
        branch: "feat".to_owned(),
        push: None,
        pr: NewPullRequest {
            title: "T".to_owned(),
            body: String::new(),
            source_branch: "feat".to_owned(),
            target_branch: "main".to_owned(),
        },
    };
    let err = hosting_create_pull_request_inner(
        &RepoRegistry::default(),
        &store,
        &FakeTransport::new(),
        MISSING_ID,
        &request,
        None,
    )
    .unwrap_err();
    assert_eq!(err.kind, AppErrorKind::UnknownRepo);
}

// --- GR-13b coverage: gaps found by the audit ---

#[test]
fn repo_info_with_a_rejected_token_marks_the_account_for_reconnect() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#);
    let err = hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id).unwrap_err();
    assert_eq!(
        (err.kind, fx.store.accounts()[0].needs_reconnect),
        (AppErrorKind::HostingAuth, true)
    );
}

#[test]
fn repo_info_sends_the_stored_token_as_a_bearer_header() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().reply(200, r#"{"default_branch":"main"}"#);
    hosting_repo_info_inner(&fx.reg, &fx.store, &t, fx.id).unwrap();
    let auth: Vec<_> = t.requests()[0]
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(auth, [format!("Bearer {SECRET}")]);
}

// A provider refusal after a good push keeps the branch published, and the retry succeeds: the
// second push has nothing to send and the provider is asked again.
#[test]
fn create_rejected_after_a_successful_push_leaves_the_branch_published_and_retry_works() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    let tip = fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new()
        .reply(422, DUPLICATE_PR)
        .reply(201, &github_pr(21, "feat", false));
    let request = create_request(&fx, set_upstream_origin_feat());

    let first = fx.create(&t, &request).unwrap_err();
    assert_eq!(first.kind, AppErrorKind::HostingRejected);
    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), Some(tip.clone()));

    let second = fx.create(&t, &request).unwrap();

    assert_eq!(second.number, 21);
    assert_eq!(t.requests().len(), 2);
    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), Some(tip));
}

// A transport failure (offline) on the create call is the hosting error, not a panic or a
// swallowed push.
#[test]
fn create_with_the_provider_unreachable_reports_it() {
    let fx = hosted();
    fx.connect();
    let t = FakeTransport::new().fail(git_real_core::GitError::HostingUnreachable {
        message: "offline".to_owned(),
    });
    let err = fx.create(&t, &create_request(&fx, None)).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::HostingUnreachable);
}

// Typed credentials reach the push: with a local bare behind insteadOf they are never asked
// for, so the push must still publish the branch and then open the pull request.
#[test]
fn create_with_typed_credentials_still_publishes_and_opens_the_pull_request() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    let tip = fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new().reply(201, &github_pr(21, "feat", false));
    let typed = Credentials::new("https://github.com", "me", "typed").unwrap();

    let pr = hosting_create_pull_request_inner(
        &fx.reg,
        &fx.store,
        &t,
        fx.id,
        &create_request(&fx, set_upstream_origin_feat()),
        Some(&typed),
    )
    .unwrap();

    assert_eq!(pr.number, 21);
    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), Some(tip));
}

// Publishing a branch that is not checked out is refused before anything is sent.
#[test]
fn create_with_a_push_for_a_branch_that_is_not_checked_out_pushes_nothing() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new();
    let request = CreatePrRequest {
        branch: "other".to_owned(),
        ..create_request(&fx, set_upstream_origin_feat())
    };

    let _ = fx.create(&t, &request).unwrap_err();

    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), None);
    assert_eq!(ref_oid(&fx.bare, "refs/heads/other"), None);
}

// An invalid target is refused before the push, so nothing is published for a PR that cannot
// be opened.
#[test]
fn create_with_an_invalid_target_pushes_nothing() {
    if !common::git_available() {
        return;
    }
    let fx = hosted();
    fx.connect();
    fx.start_branch("feat");
    fx.commit("feature.txt", "feature work");
    let t = FakeTransport::new();
    let mut request = create_request(&fx, set_upstream_origin_feat());
    request.pr.target_branch = "a b".to_owned();

    let err = fx.create(&t, &request).unwrap_err();

    assert_eq!(err.kind, AppErrorKind::InvalidBranchName);
    assert_eq!(ref_oid(&fx.bare, "refs/heads/feat"), None);
    assert!(t.requests().is_empty());
}
