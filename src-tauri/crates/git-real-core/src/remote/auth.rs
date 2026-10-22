//! HTTPS credentials for one git run (spec §3.1): a one-shot inline helper,
//! scoped to one origin, reads them from the environment, so they never reach
//! the command line; after a successful run `git credential approve` hands
//! them to the user's own helper.
//!
//! The environment of that run is inherited by git's children, so a
//! repository's own hooks (`pre-push`) can read `GR_TOKEN`.

use std::fmt;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

use crate::error::GitError;
use crate::git_cli;

/// The inline helper. `printf '%s\n'`, not `echo`: dash's `echo` expands
/// backslash escapes and would corrupt a token. Only `get` is answered.
pub const HELPER: &str = r#"!f() { test "$1" = get || return 0; printf '%s\n' "username=$GR_USERNAME" "password=$GR_TOKEN"; }; f"#;
const USERNAME_ENV: &str = "GR_USERNAME";
const TOKEN_ENV: &str = "GR_TOKEN";

/// A username and token for one `http(s)://host[:port]` origin.
#[derive(Clone, Deserialize)]
#[serde(try_from = "CredentialsInput")]
pub struct Credentials {
    origin: String,
    username: String,
    token: String,
}

/// The IPC shape, validated through [`Credentials::new`]. No `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsInput {
    origin: String,
    username: String,
    token: String,
}

impl TryFrom<CredentialsInput> for Credentials {
    type Error = GitError;

    fn try_from(input: CredentialsInput) -> Result<Self, GitError> {
        Self::new(&input.origin, &input.username, &input.token)
    }
}

impl Credentials {
    /// `InvalidCredentials` unless `origin` passes the origin rule and both
    /// values are non-empty without line breaks or NUL (which could forge
    /// helper output or config).
    pub fn new(origin: &str, username: &str, token: &str) -> Result<Self, GitError> {
        let clean = |s: &str| !s.is_empty() && !s.contains(['\n', '\r', '\0']);
        if !is_valid_origin(origin) || !clean(username) || !clean(token) {
            return Err(GitError::InvalidCredentials);
        }
        Ok(Self {
            origin: origin.to_owned(),
            username: username.to_owned(),
            token: token.to_owned(),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    /// True when `url` is on these credentials' origin; git matches hosts
    /// case-insensitively, and so does this.
    pub(crate) fn covers(&self, url: &str) -> bool {
        origin_of(url).is_some_and(|o| o.eq_ignore_ascii_case(&self.origin))
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("token", &"***")
            .finish()
    }
}

/// Adds the scoped helper (`-c credential.<origin>.helper=` resets the list
/// for that origin only, then the inline helper) and the two env vars. Call it
/// after `-C <workdir>` and before the subcommand. `None` adds nothing.
///
/// `GIT_TRACE_REDACT=1` keeps a user-set `GIT_TRACE_CURL` from copying the
/// Authorization header (the token) into stderr, and from there into an error.
pub fn apply(cmd: &mut Command, creds: Option<&Credentials>) {
    let Some(c) = creds else { return };
    let key = format!("credential.{}.helper", c.origin);
    cmd.arg("-c")
        .arg(format!("{key}="))
        .arg("-c")
        .arg(format!("{key}={HELPER}"))
        .env(USERNAME_ENV, &c.username)
        .env(TOKEN_ENV, &c.token)
        .env("GIT_TRACE_REDACT", "1");
}

/// Stores `creds` for `url` in the user's credential helper. Failure is
/// ignored: no helper configured is not an error.
pub(crate) fn approve(git: &Path, workdir: &Path, url: &str, creds: &Credentials) {
    if url.contains(['\n', '\r', '\0']) {
        return;
    }
    let mut cmd = git_cli::command(git);
    cmd.arg("-C").arg(workdir).args(["credential", "approve"]);
    let input = format!(
        "url={url}\nusername={}\npassword={}\n\n",
        creds.username, creds.token
    );
    let _ = git_cli::capture_with_input(&mut cmd, input.as_bytes());
}

/// True for an `http://` or `https://` URL (ASCII case-insensitive).
pub(crate) fn is_http(url: &str) -> bool {
    ["http://", "https://"].iter().any(|p| {
        url.get(..p.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(p))
    })
}

/// `scheme://host[:port]` of an HTTP(S) URL, userinfo and path dropped.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let origin = format!("{scheme}://{host}");
    is_valid_origin(&origin).then_some(origin)
}

/// The origin rule (Global Constraints): it becomes part of a `-c` config key.
fn is_valid_origin(origin: &str) -> bool {
    let Some(authority) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    let (host_ok, port) = match authority.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((h, port)) => (
                !h.is_empty()
                    && h.chars()
                        .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.'),
                port,
            ),
            None => return false,
        },
        None => {
            let (h, port) = authority
                .find(':')
                .map_or((authority, ""), |i| authority.split_at(i));
            (
                !h.is_empty()
                    && h.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'),
                port,
            )
        }
    };
    let port_ok = port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    host_ok && port_ok
}
