//! Coverage audit tests for GR-13a Task 2: `HostingStore` file edge cases, keychain failures in
//! the hosting commands, and every network command running through `NetworkAuth::Accounts`
//! when the keychain cannot be read (Review Focus 5).

mod common;

use std::path::{Path, PathBuf};

use common::{FakeTransport, MemoryTokenStore, github_account, hosting_store_with};
use git_real_core::hosting::{Account, Provider, Token, UserInfo};
use git_real_core::{PullMode, PushTarget, RepoSession};
use git_real_lib::commands::hosting::hosting_list_pull_requests_inner;
use git_real_lib::commands::refs::delete_remote_branch_inner;
use git_real_lib::commands::remote::{NetworkAuth, pull_inner, push_inner};
use git_real_lib::commands::repo::clone_repo_inner;
use git_real_lib::commands::tags::{delete_remote_tag_inner, push_tag_inner};
use git_real_lib::error::AppErrorKind;
use git_real_lib::hosting_store::HostingStore;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::Repository;
use tempfile::TempDir;

const SECRET: &str = "ghp_SECRET-token-123";
const ORIGIN_URL: &str = "https://github.com/o/r.git";

fn token() -> Token {
    Token::new(SECRET).unwrap()
}

// --- HostingStore: file edge cases ---

#[test]
fn an_unreadable_accounts_path_loads_empty() {
    // A directory where the file should be: reading it fails with something other than NotFound.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosting_accounts.json");
    std::fs::create_dir(&path).unwrap();
    let store = HostingStore::load(path, Box::new(MemoryTokenStore::default()));
    assert!(store.accounts().is_empty());
}

#[test]
fn a_file_of_the_wrong_shape_loads_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosting_accounts.json");
    std::fs::write(&path, r#"{"provider":"github"}"#).unwrap();
    let store = HostingStore::load(path, Box::new(MemoryTokenStore::default()));
    assert!(store.accounts().is_empty());
}

#[test]
fn connect_still_succeeds_when_the_parent_directory_cannot_be_created() {
    // The accounts path sits below a regular file, so create_dir_all fails.
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    let tokens = MemoryTokenStore::default();
    let store = HostingStore::load(
        blocker.join("hosting_accounts.json"),
        Box::new(tokens.clone()),
    );
    let a = store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(store.accounts(), vec![a]);
    assert_eq!(
        tokens.map.lock().unwrap().get("github:github.com:octo"),
        Some(&SECRET.to_owned())
    );
}

#[test]
fn connect_still_succeeds_and_cleans_up_when_the_rename_fails() {
    // A directory at the target path: the tmp write works, the rename over it does not.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosting_accounts.json");
    std::fs::create_dir(&path).unwrap();
    let store = HostingStore::load(path, Box::new(MemoryTokenStore::default()));
    let a = store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(store.accounts(), vec![a]);
    assert!(!dir.path().join("hosting_accounts.json.tmp").exists());
}

#[test]
fn disconnect_still_succeeds_when_the_file_cannot_be_saved() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    let tokens = MemoryTokenStore::default();
    let store = HostingStore::load(blocker.join("a.json"), Box::new(tokens.clone()));
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.disconnect(&a.id).unwrap();
    assert!(store.accounts().is_empty());
    assert!(tokens.map.lock().unwrap().is_empty());
}

#[test]
fn display_name_and_avatar_survive_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosting_accounts.json");
    let tokens = MemoryTokenStore::default();
    let store = HostingStore::load(path.clone(), Box::new(tokens.clone()));
    let account = Account::new(
        Provider::GitHub,
        "github.com",
        UserInfo {
            username: "octo".to_owned(),
            display_name: Some("Octo Cat".to_owned()),
            avatar_url: Some("https://avatars.example/octo.png".to_owned()),
        },
    );
    let connected = store.connect(account, &token()).unwrap();
    let reloaded = HostingStore::load(path, Box::new(tokens));
    assert_eq!(reloaded.accounts(), vec![connected]);
}

#[test]
fn credentials_for_matches_the_host_case_insensitively() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore::default());
    store.connect(github_account("octo"), &token()).unwrap();
    let c = store
        .credentials_for(&["https://GitHub.COM/o/r.git".to_owned()])
        .unwrap();
    assert_eq!(c.origin(), "https://github.com");
}

#[test]
fn credentials_for_skips_an_http_url_and_uses_a_later_https_one() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore::default());
    store.connect(github_account("octo"), &token()).unwrap();
    let urls = [
        "http://github.com/o/r.git".to_owned(),
        ORIGIN_URL.to_owned(),
    ];
    assert!(store.credentials_for(&urls).is_some());
}

// --- hosting commands: failing keychain ---

struct Hosted {
    _dirs: [TempDir; 3],
    path: PathBuf,
    bare: PathBuf,
    head: String,
    reg: RepoRegistry,
    id: RepoId,
    store: HostingStore,
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

/// `origin` is `https://github.com/o/r.git`, redirected to a local bare clone by `insteadOf`,
/// with the head branch tracking `origin/<head>`. The keychain is down for reads.
fn hosted_with_a_locked_keychain() -> Hosted {
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
    git(
        &path,
        &["branch", "-u", &format!("origin/{head}"), head.as_str()],
    );
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    let (d3, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_get: true,
        ..Default::default()
    });
    store
        .connect(github_account("octo"), &token())
        .expect("set is allowed");
    Hosted {
        _dirs: [d1, d2, d3],
        path,
        bare,
        head,
        reg,
        id,
        store,
    }
}

fn bare_has(bare: &Path, name: &str) -> bool {
    Repository::open_bare(bare)
        .unwrap()
        .find_reference(name)
        .is_ok()
}

#[test]
fn list_pull_requests_with_a_locked_keychain_is_keychain_unavailable_and_calls_no_api() {
    let fx = hosted_with_a_locked_keychain();
    let t = FakeTransport::new();
    let err = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::KeychainUnavailable);
    assert!(t.requests().is_empty());
}

#[test]
fn a_locked_keychain_does_not_flag_the_account_for_reconnect() {
    let fx = hosted_with_a_locked_keychain();
    let t = FakeTransport::new();
    let _ = hosting_list_pull_requests_inner(&fx.reg, &fx.store, &t, fx.id, 1);
    assert!(!fx.store.accounts()[0].needs_reconnect);
}

// --- Review Focus 5: every network command still runs without the token ---

#[test]
fn pull_with_account_auth_runs_when_the_keychain_cannot_be_read() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with_a_locked_keychain();
    let outcome = pull_inner(
        &fx.reg,
        fx.id,
        PullMode::Merge,
        NetworkAuth::Accounts(&fx.store),
    );
    assert!(outcome.is_ok());
}

#[test]
fn push_with_account_auth_runs_when_the_keychain_cannot_be_read() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with_a_locked_keychain();
    let tip = common::commit_file(&fx.path, "new.txt", "n\n", "local work").to_string();
    push_inner(
        &fx.reg,
        fx.id,
        &PushTarget::Upstream,
        false,
        &fx.head,
        NetworkAuth::Accounts(&fx.store),
    )
    .unwrap();
    let pushed = Repository::open_bare(&fx.bare)
        .unwrap()
        .find_reference(&format!("refs/heads/{}", fx.head))
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    assert_eq!(pushed, tip);
}

#[test]
fn tag_push_and_remote_delete_with_account_auth_run_when_the_keychain_cannot_be_read() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with_a_locked_keychain();
    let tip = Repository::open(&fx.path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    git_real_lib::commands::tags::create_tag_inner(&fx.reg, fx.id, "v1", &tip, None).unwrap();
    let auth = NetworkAuth::Accounts(&fx.store);
    push_tag_inner(&fx.reg, fx.id, "origin", "v1", auth).unwrap();
    assert!(bare_has(&fx.bare, "refs/tags/v1"));
    delete_remote_tag_inner(&fx.reg, fx.id, "origin", "v1", auth).unwrap();
    assert!(!bare_has(&fx.bare, "refs/tags/v1"));
}

#[test]
fn remote_branch_delete_with_account_auth_runs_when_the_keychain_cannot_be_read() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with_a_locked_keychain();
    git(&fx.path, &["branch", "side"]);
    git(&fx.path, &["push", "-q", "origin", "side"]);
    assert!(bare_has(&fx.bare, "refs/heads/side"));
    delete_remote_branch_inner(
        &fx.reg,
        fx.id,
        "origin",
        "side",
        NetworkAuth::Accounts(&fx.store),
    )
    .unwrap();
    assert!(!bare_has(&fx.bare, "refs/heads/side"));
}

// --- clone with account auth ---

#[test]
fn clone_with_account_auth_of_a_local_source_runs_even_with_a_locked_keychain() {
    if !common::git_available() {
        return;
    }
    let fx = hosted_with_a_locked_keychain();
    let (_state, reg, recent) = common::fresh_state();
    let work = tempfile::tempdir().unwrap();
    let dest = work.path().join("dest");
    let mut sink = common::RecordingSink(Vec::new());
    let opened = clone_repo_inner(
        &reg,
        &recent,
        &common::file_url(&fx.bare),
        dest.to_str().unwrap(),
        NetworkAuth::Accounts(&fx.store),
        &mut sink,
    )
    .unwrap();
    assert_eq!(opened.summary.path, dunce::canonicalize(&dest).unwrap());
}

#[test]
fn clone_with_account_auth_resolves_the_account_for_the_clone_url() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore::default());
    store.connect(github_account("octo"), &token()).unwrap();
    // resolve() is what clone_repo_inner calls with `[url]`; a clone URL on another host gets none.
    assert!(
        NetworkAuth::Accounts(&store)
            .resolve(&["https://gitlab.com/g/p.git".to_owned()])
            .is_none()
    );
    assert!(
        NetworkAuth::Accounts(&store)
            .resolve(&[ORIGIN_URL.to_owned()])
            .is_some()
    );
}
