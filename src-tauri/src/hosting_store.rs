//! Connected hosting accounts (GR-13a): metadata in a JSON file, tokens only in the OS keychain.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::{fs, io::ErrorKind};

use git_real_core::hosting::provider::https_host;
use git_real_core::hosting::{Account, Provider, Token, UserInfo};
use git_real_core::{Credentials, GitError};
use serde::{Deserialize, Serialize};

/// Where account tokens live, keyed by [`Account::id`].
pub trait TokenStore: Send + Sync {
    fn set(&self, key: &str, token: &Token) -> Result<(), GitError>;
    /// `Ok(None)` when there is no entry for `key`.
    fn get(&self, key: &str) -> Result<Option<Token>, GitError>;
    /// Deleting a missing entry is `Ok(())`.
    fn delete(&self, key: &str) -> Result<(), GitError>;
}

/// The keychain service every account token is stored under.
pub const KEYRING_SERVICE: &str = "git-real";

/// The OS keychain (Secret Service, macOS Keychain, Windows Credential Manager).
pub struct KeyringTokenStore;

impl KeyringTokenStore {
    fn entry(key: &str) -> Result<keyring::Entry, GitError> {
        keyring::Entry::new(KEYRING_SERVICE, key).map_err(keychain_error)
    }
}

impl TokenStore for KeyringTokenStore {
    fn set(&self, key: &str, token: &Token) -> Result<(), GitError> {
        Self::entry(key)?
            .set_password(token.expose_secret())
            .map_err(keychain_error)
    }

    fn get(&self, key: &str) -> Result<Option<Token>, GitError> {
        match Self::entry(key)?.get_password() {
            Ok(secret) => Token::new(&secret).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }

    fn delete(&self, key: &str) -> Result<(), GitError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(e)),
        }
    }
}

/// Every keyring failure is `KeychainUnavailable`; there is no file fallback.
pub fn keychain_error(e: keyring::Error) -> GitError {
    GitError::KeychainUnavailable(e.to_string())
}

/// The file format: an account without its id (derived) or `needs_reconnect` (in memory only).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRecord {
    provider: Provider,
    host: String,
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

impl From<&Account> for AccountRecord {
    fn from(a: &Account) -> Self {
        Self {
            provider: a.provider,
            host: a.host.clone(),
            username: a.username.clone(),
            display_name: a.display_name.clone(),
            avatar_url: a.avatar_url.clone(),
        }
    }
}

impl From<AccountRecord> for Account {
    fn from(r: AccountRecord) -> Self {
        Account::new(
            r.provider,
            &r.host,
            UserInfo {
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
            },
        )
    }
}

/// One account per `(provider, host)`. The accounts lock is never held across keychain I/O, so
/// a Secret Service unlock prompt cannot stall other callers. Save failures are logged.
pub struct HostingStore {
    path: PathBuf,
    accounts: Mutex<Vec<Account>>,
    tokens: Box<dyn TokenStore>,
}

impl HostingStore {
    /// Loads the store; a missing, unreadable or corrupt file yields no accounts.
    pub fn load(path: PathBuf, tokens: Box<dyn TokenStore>) -> Self {
        let records: Vec<AccountRecord> = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("hosting accounts: ignoring corrupt {}: {e}", path.display());
                Vec::new()
            }),
            Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                eprintln!("hosting accounts: cannot read {}: {e}", path.display());
                Vec::new()
            }
        };
        Self {
            path,
            accounts: Mutex::new(records.into_iter().map(Account::from).collect()),
            tokens,
        }
    }

    /// Every account, in file order.
    pub fn accounts(&self) -> Vec<Account> {
        self.lock().clone()
    }

    pub fn find(&self, provider: Provider, host: &str) -> Option<Account> {
        self.lock()
            .iter()
            .find(|a| a.provider == provider && a.host.eq_ignore_ascii_case(host))
            .cloned()
    }

    /// Each account's `(provider, host)`, for detecting custom hosts.
    pub fn hosts(&self) -> Vec<(Provider, String)> {
        self.lock()
            .iter()
            .map(|a| (a.provider, a.host.clone()))
            .collect()
    }

    pub fn token(&self, account: &Account) -> Result<Option<Token>, GitError> {
        self.tokens.get(&account.id)
    }

    /// Stores `token` and lists `account`, replacing any account on the same `(provider, host)`.
    /// A failure to store the token changes nothing; a failure to delete the replaced account's
    /// secret afterwards is logged and the connect still succeeds.
    pub fn connect(&self, account: Account, token: &Token) -> Result<Account, GitError> {
        self.tokens.set(&account.id, token)?;
        let replaced = {
            let mut accounts = self.lock();
            let slot = accounts.iter().position(|a| {
                a.provider == account.provider && a.host.eq_ignore_ascii_case(&account.host)
            });
            let replaced = match slot {
                Some(i) => Some(std::mem::replace(&mut accounts[i], account.clone())),
                None => {
                    accounts.push(account.clone());
                    None
                }
            };
            self.save_logged(&accounts);
            replaced
        };
        // A same-id reconnect was overwritten by `set`; only another user's secret is deleted.
        if let Some(old) = replaced.filter(|old| old.id != account.id)
            && let Err(e) = self.tokens.delete(&old.id)
        {
            eprintln!(
                "hosting accounts: cannot delete the token of {}: {e}",
                old.id
            );
        }
        Ok(account)
    }

    /// Deletes the secret, then the entry; the entry stays when the keychain refuses, so a
    /// token is never orphaned silently. An unknown id is `Ok(())`.
    pub fn disconnect(&self, account_id: &str) -> Result<(), GitError> {
        if !self.lock().iter().any(|a| a.id == account_id) {
            return Ok(());
        }
        self.tokens.delete(account_id)?;
        let mut accounts = self.lock();
        accounts.retain(|a| a.id != account_id);
        self.save_logged(&accounts);
        Ok(())
    }

    /// Flags the account whose token the provider rejected; not persisted.
    pub fn mark_needs_reconnect(&self, account_id: &str) {
        if let Some(a) = self.lock().iter_mut().find(|a| a.id == account_id) {
            a.needs_reconnect = true;
        }
    }

    /// Account credentials for the first of `urls` that is `https://` on an account's host;
    /// `None` when there is none, or its token is missing or unreadable.
    pub fn credentials_for(&self, urls: &[String]) -> Option<Credentials> {
        let account = urls.iter().find_map(|url| {
            let host = https_host(url)?;
            self.lock()
                .iter()
                .find(|a| a.host.eq_ignore_ascii_case(&host))
                .cloned()
        })?;
        let token = self.token(&account).ok()??;
        let origin = format!("https://{}", account.host);
        Credentials::account(&origin, account.provider.git_username(), &token).ok()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Account>> {
        self.accounts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn save_logged(&self, accounts: &[Account]) {
        if let Err(e) = self.save(accounts) {
            eprintln!("hosting accounts: cannot save {}: {e}", self.path.display());
        }
    }

    /// Writes to `<path>.tmp` then renames, so a crash never leaves a half-written file.
    fn save(&self, accounts: &[Account]) -> io::Result<()> {
        let records: Vec<AccountRecord> = accounts.iter().map(AccountRecord::from).collect();
        let json = serde_json::to_string_pretty(&records).map_err(io::Error::other)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut tmp: OsString = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
    }
}
