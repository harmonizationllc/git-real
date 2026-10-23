//! `KeyringTokenStore` over keyring's mock credential builder (GR-13a). This is the only test
//! binary that installs the mock builder, and it never touches a real keychain. keyring 3's mock
//! entries share no state between `Entry` values, so a get after a set cannot be observed here;
//! the acceptance walk covers the real Secret Service round trip.

use git_real_core::GitError;
use git_real_core::hosting::Token;
use git_real_lib::hosting_store::{KEYRING_SERVICE, KeyringTokenStore, TokenStore, keychain_error};

fn mock() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
}

#[test]
fn the_keychain_service_is_git_real() {
    assert_eq!(KEYRING_SERVICE, "git-real");
}

#[test]
fn set_succeeds_against_the_mock() {
    mock();
    let result = KeyringTokenStore.set("github:github.com:octo", &Token::new("t").unwrap());
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn get_of_a_missing_entry_is_none() {
    mock();
    assert!(
        KeyringTokenStore
            .get("github:github.com:nobody")
            .unwrap()
            .is_none()
    );
}

#[test]
fn delete_of_a_missing_entry_is_ok() {
    mock();
    assert!(KeyringTokenStore.delete("github:github.com:nobody").is_ok());
}

#[test]
fn a_no_storage_access_error_becomes_keychain_unavailable_with_its_text() {
    let e = keychain_error(keyring::Error::NoStorageAccess(Box::new(
        std::io::Error::other("locked"),
    )));
    assert!(
        matches!(e, GitError::KeychainUnavailable(ref m) if m.contains("locked")),
        "{e:?}"
    );
}

#[test]
fn a_platform_failure_becomes_keychain_unavailable() {
    let e = keychain_error(keyring::Error::PlatformFailure(Box::new(
        std::io::Error::other("no dbus"),
    )));
    assert!(
        matches!(e, GitError::KeychainUnavailable(ref m) if m.contains("no dbus")),
        "{e:?}"
    );
}

#[test]
fn a_no_entry_error_also_becomes_keychain_unavailable() {
    let e = keychain_error(keyring::Error::NoEntry);
    assert!(matches!(e, GitError::KeychainUnavailable(_)), "{e:?}");
}
