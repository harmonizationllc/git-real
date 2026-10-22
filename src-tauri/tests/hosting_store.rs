//! Integration tests for `HostingStore` (GR-13a): connected accounts persisted as metadata in
//! `hosting_accounts.json`, tokens only in the keychain (a `MemoryTokenStore` here), and the
//! account-token credentials a git operation falls back on.

mod common;

use common::{MemoryTokenStore, github_account, hosting_store, hosting_store_with};
use git_real_core::GitError;
use git_real_core::hosting::{Account, Provider, Token, UserInfo};
use git_real_lib::hosting_store::HostingStore;

const SECRET: &str = "ghp_SECRET-token-123";

fn token() -> Token {
    Token::new(SECRET).unwrap()
}

fn account(provider: Provider, host: &str, username: &str) -> Account {
    Account::new(
        provider,
        host,
        UserInfo {
            username: username.to_owned(),
            display_name: None,
            avatar_url: None,
        },
    )
}

fn stored(tokens: &MemoryTokenStore, key: &str) -> Option<String> {
    tokens.map.lock().unwrap().get(key).cloned()
}

// --- loading ---

#[test]
fn a_missing_file_loads_empty_without_creating_it() {
    let (dir, store, _tokens) = hosting_store();
    assert!(store.accounts().is_empty());
    assert!(!dir.path().join("hosting_accounts.json").exists());
}

#[test]
fn a_corrupt_file_loads_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosting_accounts.json");
    std::fs::write(&path, "not json").unwrap();
    let store = HostingStore::load(path, Box::new(MemoryTokenStore::default()));
    assert!(store.accounts().is_empty());
}

// --- connect ---

#[test]
fn connect_returns_the_account_with_its_keychain_id() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(a.id, "github:github.com:octo");
}

#[test]
fn connect_stores_the_token_in_the_keychain_under_the_account_id() {
    let (_dir, store, tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(
        stored(&tokens, "github:github.com:octo").as_deref(),
        Some(SECRET)
    );
}

#[test]
fn connect_writes_only_metadata_to_the_file() {
    let (dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    let text = std::fs::read_to_string(dir.path().join("hosting_accounts.json")).unwrap();
    assert!(
        !text.contains(SECRET) && !text.contains("needsReconnect"),
        "{text}"
    );
}

#[test]
fn connect_writes_a_camel_case_json_array_of_account_records() {
    let (dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    let text = std::fs::read_to_string(dir.path().join("hosting_accounts.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        json,
        serde_json::json!([{
            "provider": "github",
            "host": "github.com",
            "username": "octo",
            "displayName": null,
            "avatarUrl": null
        }])
    );
}

#[test]
fn connect_leaves_no_tmp_file_behind() {
    let (dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(!dir.path().join("hosting_accounts.json.tmp").exists());
}

#[test]
fn accounts_survive_a_reload_from_the_file() {
    let (dir, store, tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    let reloaded = HostingStore::load(
        dir.path().join("hosting_accounts.json"),
        Box::new(tokens.clone()),
    );
    assert_eq!(reloaded.accounts(), vec![a]);
}

#[test]
fn connect_replaces_the_account_on_the_same_host() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    let other = store.connect(github_account("other"), &token()).unwrap();
    assert_eq!(store.accounts(), vec![other]);
}

#[test]
fn connect_deletes_the_replaced_accounts_secret() {
    let (_dir, store, tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    store.connect(github_account("other"), &token()).unwrap();
    assert_eq!(stored(&tokens, "github:github.com:octo"), None);
}

#[test]
fn connect_keeps_accounts_on_other_hosts() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    let lab = store
        .connect(account(Provider::GitLab, "gitlab.com", "tanuki"), &token())
        .unwrap();
    store.connect(github_account("other"), &token()).unwrap();
    assert!(store.accounts().contains(&lab));
}

#[test]
fn connect_aborts_with_keychain_unavailable_when_the_old_secret_cannot_be_deleted() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_delete: true,
        ..Default::default()
    });
    store.connect(github_account("octo"), &token()).unwrap();
    let err = store
        .connect(github_account("other"), &token())
        .unwrap_err();
    assert!(matches!(err, GitError::KeychainUnavailable(_)), "{err:?}");
}

#[test]
fn connect_keeps_the_old_account_when_the_old_secret_cannot_be_deleted() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_delete: true,
        ..Default::default()
    });
    let old = store.connect(github_account("octo"), &token()).unwrap();
    let _ = store.connect(github_account("other"), &token());
    assert_eq!(store.accounts(), vec![old]);
}

#[test]
fn connect_with_a_failing_keychain_is_keychain_unavailable() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_set: true,
        ..Default::default()
    });
    let err = store.connect(github_account("octo"), &token()).unwrap_err();
    assert!(matches!(err, GitError::KeychainUnavailable(_)), "{err:?}");
}

#[test]
fn connect_with_a_failing_keychain_lists_no_account() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_set: true,
        ..Default::default()
    });
    let _ = store.connect(github_account("octo"), &token());
    assert!(store.accounts().is_empty());
}

#[test]
fn connect_with_a_failing_keychain_writes_no_file() {
    let (dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_set: true,
        ..Default::default()
    });
    let _ = store.connect(github_account("octo"), &token());
    assert!(!dir.path().join("hosting_accounts.json").exists());
}

// --- lookup ---

#[test]
fn find_returns_the_account_for_a_provider_and_host() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(store.find(Provider::GitHub, "github.com"), Some(a));
}

#[test]
fn find_is_none_for_another_provider_or_host() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert_eq!(
        (
            store.find(Provider::GitLab, "github.com"),
            store.find(Provider::GitHub, "ghe.corp")
        ),
        (None, None)
    );
}

#[test]
fn hosts_lists_each_connected_provider_and_host_in_file_order() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    store
        .connect(account(Provider::GitLab, "gl.corp", "tanuki"), &token())
        .unwrap();
    assert_eq!(
        store.hosts(),
        vec![
            (Provider::GitHub, "github.com".to_owned()),
            (Provider::GitLab, "gl.corp".to_owned())
        ]
    );
}

#[test]
fn token_returns_the_stored_secret() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    let t = store.token(&a).unwrap().unwrap();
    assert_eq!(t.expose_secret(), SECRET);
}

#[test]
fn token_is_none_when_the_keychain_has_no_entry() {
    let (_dir, store, tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    tokens.map.lock().unwrap().clear();
    assert!(store.token(&a).unwrap().is_none());
}

#[test]
fn token_with_a_failing_keychain_is_keychain_unavailable() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_get: true,
        ..Default::default()
    });
    let a = store.connect(github_account("octo"), &token()).unwrap();
    let err = store.token(&a).err().unwrap();
    assert!(matches!(err, GitError::KeychainUnavailable(_)), "{err:?}");
}

// --- disconnect ---

#[test]
fn disconnect_removes_the_secret() {
    let (_dir, store, tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.disconnect(&a.id).unwrap();
    assert!(tokens.map.lock().unwrap().is_empty());
}

#[test]
fn disconnect_removes_the_entry_from_the_list_and_the_file() {
    let (dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.disconnect(&a.id).unwrap();
    let text = std::fs::read_to_string(dir.path().join("hosting_accounts.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!((store.accounts().len(), json), (0, serde_json::json!([])));
}

#[test]
fn disconnect_of_an_unknown_id_is_ok() {
    let (_dir, store, _tokens) = hosting_store();
    assert!(store.disconnect("nope").is_ok());
}

#[test]
fn disconnect_with_a_failing_keychain_is_keychain_unavailable() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_delete: true,
        ..Default::default()
    });
    let a = store.connect(github_account("octo"), &token()).unwrap();
    let err = store.disconnect(&a.id).unwrap_err();
    assert!(matches!(err, GitError::KeychainUnavailable(_)), "{err:?}");
}

#[test]
fn disconnect_that_fails_keeps_the_entry_listed() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_delete: true,
        ..Default::default()
    });
    let a = store.connect(github_account("octo"), &token()).unwrap();
    let _ = store.disconnect(&a.id);
    assert_eq!(store.accounts(), vec![a]);
}

// --- needs_reconnect ---

#[test]
fn mark_needs_reconnect_sets_the_flag_in_memory() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.mark_needs_reconnect(&a.id);
    assert!(store.accounts()[0].needs_reconnect);
}

#[test]
fn needs_reconnect_is_not_persisted() {
    let (dir, store, tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.mark_needs_reconnect(&a.id);
    let reloaded = HostingStore::load(
        dir.path().join("hosting_accounts.json"),
        Box::new(tokens.clone()),
    );
    assert!(!reloaded.accounts()[0].needs_reconnect);
}

#[test]
fn reconnecting_clears_needs_reconnect() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.mark_needs_reconnect(&a.id);
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(!store.accounts()[0].needs_reconnect);
}

#[test]
fn mark_needs_reconnect_of_an_unknown_id_changes_nothing() {
    let (_dir, store, _tokens) = hosting_store();
    let a = store.connect(github_account("octo"), &token()).unwrap();
    store.mark_needs_reconnect("nope");
    assert_eq!(store.accounts(), vec![a]);
}

// --- credentials_for (spec 6.3) ---

#[test]
fn credentials_for_gives_a_github_account_its_token_user_and_origin() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    let c = store
        .credentials_for(&["https://GitHub.com/o/r.git".to_owned()])
        .unwrap();
    assert_eq!(
        (c.origin(), c.username(), c.approves()),
        ("https://github.com", "x-access-token", false)
    );
}

#[test]
fn credentials_for_uses_the_gitlab_and_bitbucket_usernames() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(account(Provider::GitLab, "gitlab.com", "tanuki"), &token())
        .unwrap();
    store
        .connect(
            account(Provider::Bitbucket, "bitbucket.org", "bb"),
            &token(),
        )
        .unwrap();
    let names: Vec<String> = [
        "https://gitlab.com/g/p.git",
        "https://bitbucket.org/w/s.git",
    ]
    .iter()
    .map(|u| {
        store
            .credentials_for(&[(*u).to_owned()])
            .unwrap()
            .username()
            .to_owned()
    })
    .collect();
    assert_eq!(names, ["oauth2", "x-bitbucket-api-token-auth"]);
}

#[test]
fn credentials_for_never_matches_an_http_url() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(
        store
            .credentials_for(&["http://github.com/o/r.git".to_owned()])
            .is_none()
    );
}

#[test]
fn credentials_for_never_matches_an_scp_like_url() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(
        store
            .credentials_for(&["git@github.com:o/r.git".to_owned()])
            .is_none()
    );
}

#[test]
fn credentials_for_never_hands_a_token_to_another_host() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(
        store
            .credentials_for(&["https://gitlab.com/o/r.git".to_owned()])
            .is_none()
    );
}

#[test]
fn credentials_for_does_not_match_a_host_that_only_starts_with_the_account_host() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(
        store
            .credentials_for(&["https://github.com.evil.test/o/r".to_owned()])
            .is_none()
    );
}

#[test]
fn credentials_for_no_urls_is_none() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(store.credentials_for(&[]).is_none());
}

#[test]
fn credentials_for_a_local_path_is_none() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(store.credentials_for(&["/srv/a.git".to_owned()]).is_none());
}

#[test]
fn credentials_for_takes_the_first_matching_url() {
    let (_dir, store, _tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    store
        .connect(account(Provider::GitLab, "gitlab.com", "tanuki"), &token())
        .unwrap();
    let urls = [
        "/srv/a.git".to_owned(),
        "https://gitlab.com/g/p.git".to_owned(),
        "https://github.com/o/r.git".to_owned(),
    ];
    let c = store.credentials_for(&urls).unwrap();
    assert_eq!((c.origin(), c.username()), ("https://gitlab.com", "oauth2"));
}

#[test]
fn credentials_for_matches_a_custom_host_account() {
    let (_dir, store, _tokens) = hosting_store();
    store
        .connect(account(Provider::GitHub, "ghe.corp", "octo"), &token())
        .unwrap();
    let c = store
        .credentials_for(&["https://ghe.corp/o/r.git".to_owned()])
        .unwrap();
    assert_eq!(c.origin(), "https://ghe.corp");
}

#[test]
fn credentials_for_with_a_failing_keychain_is_none() {
    let (_dir, store, _tokens) = hosting_store_with(MemoryTokenStore {
        fail_get: true,
        ..Default::default()
    });
    store.connect(github_account("octo"), &token()).unwrap();
    assert!(
        store
            .credentials_for(&["https://github.com/o/r.git".to_owned()])
            .is_none()
    );
}

#[test]
fn credentials_for_without_a_stored_token_is_none() {
    let (_dir, store, tokens) = hosting_store();
    store.connect(github_account("octo"), &token()).unwrap();
    tokens.map.lock().unwrap().clear();
    assert!(
        store
            .credentials_for(&["https://github.com/o/r.git".to_owned()])
            .is_none()
    );
}
