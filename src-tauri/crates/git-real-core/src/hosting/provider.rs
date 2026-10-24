//! Which provider hosts a remote (spec §3.2): parsing remote URLs into a [`RepoRef`],
//! validating a host typed by the user, and the `https://` host an account token may go to.

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::remote::auth::origin_of;
use crate::remote::host::{is_drive_path, strip_user, valid};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    GitHub,
    GitLab,
    Bitbucket,
}

impl Provider {
    const ALL: [Provider; 3] = [Provider::GitHub, Provider::GitLab, Provider::Bitbucket];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
            Provider::Bitbucket => "bitbucket",
        }
    }

    pub fn default_host(self) -> &'static str {
        match self {
            Provider::GitHub => "github.com",
            Provider::GitLab => "gitlab.com",
            Provider::Bitbucket => "bitbucket.org",
        }
    }

    /// The REST API root for `host`, without a trailing `/`.
    pub fn api_base(self, host: &str) -> String {
        match self {
            Provider::GitHub if host == "github.com" => "https://api.github.com".to_owned(),
            Provider::GitHub => format!("https://{host}/api/v3"),
            Provider::GitLab => format!("https://{host}/api/v4"),
            Provider::Bitbucket => "https://api.bitbucket.org/2.0".to_owned(),
        }
    }

    /// The HTTPS username git sends with an account token.
    pub fn git_username(self) -> &'static str {
        match self {
            Provider::GitHub => "x-access-token",
            Provider::GitLab => "oauth2",
            Provider::Bitbucket => "x-bitbucket-api-token-auth",
        }
    }
}

/// A repository on a provider. GitLab's `namespace` may hold several `/`-separated groups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub provider: Provider,
    /// Lower-case `name[:port]`.
    pub host: String,
    pub namespace: String,
    pub name: String,
}

impl RepoRef {
    pub fn web_url(&self) -> String {
        format!("https://{}/{}/{}", self.host, self.namespace, self.name)
    }
}

/// The hosted repository behind a remote URL (`https://`, `http://`, `ssh://`, `git+ssh://` or
/// scp-like), or `None` when no provider hosts it. A `custom_hosts` entry wins over the
/// default hosts.
pub fn detect(url: &str, custom_hosts: &[(Provider, String)]) -> Option<RepoRef> {
    let (host, path) = split_url(url)?;
    let host = match host.as_str() {
        "ssh.github.com" => "github.com".to_owned(),
        "altssh.gitlab.com" => "gitlab.com".to_owned(),
        _ => host,
    };
    let provider = custom_hosts
        .iter()
        .find(|(_, h)| h.eq_ignore_ascii_case(&host))
        .map(|(p, _)| *p)
        .or_else(|| Provider::ALL.into_iter().find(|p| p.default_host() == host))?;

    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().any(|s| !is_plain_segment(s)) {
        return None;
    }
    let (name, namespace) = segments.split_last()?;
    let fits = match provider {
        Provider::GitHub | Provider::Bitbucket => namespace.len() == 1,
        Provider::GitLab => !namespace.is_empty(),
    };
    fits.then(|| RepoRef {
        provider,
        host,
        namespace: namespace.join("/"),
        name: (*name).to_owned(),
    })
}

/// `[A-Za-z0-9._-]+`, but not `.` or `..`.
pub(crate) fn is_plain_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The lower-cased host (`name[:port]`, the scheme's default port dropped) and the path after
/// it, userinfo dropped.
fn split_url(url: &str) -> Option<(String, &str)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        let default_port = match scheme.to_ascii_lowercase().as_str() {
            "https" => Some("443"),
            "http" => Some("80"),
            "ssh" | "git+ssh" => None,
            _ => return None,
        };
        let (authority, path) = rest.split_once('/')?;
        let (name, port) = host_port(strip_user(authority))?;
        let host = match (default_port, port) {
            (Some(default), Some(port)) if port != default => format!("{name}:{port}"),
            _ => name,
        };
        return Some((host, path));
    }
    if is_drive_path(url) {
        return None;
    }
    let (authority, path) = url.split_once(':')?;
    if authority.contains('/') {
        return None;
    }
    let (name, _) = host_port(strip_user(authority))?;
    Some((name, path))
}

/// Splits `name[:port]` and lower-cases the name: `[a-z0-9.-]+` not starting with `-` or `.`
/// (no IPv6 literals), port 1–65535 written in at most 5 digits.
pub(crate) fn host_port(host: &str) -> Option<(String, Option<&str>)> {
    let (name, port) = match host.split_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    let port_ok = port.is_none_or(|p| {
        (1..=5).contains(&p.len())
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u16>().is_ok_and(|n| n > 0)
    });
    let name = valid(name).filter(|n| !n.starts_with('.') && !n.contains(':'))?;
    port_ok.then(|| (name.to_ascii_lowercase(), port))
}

/// The host for a new account: the provider's default when `host` is absent or blank, else
/// the lower-cased `name[:port]`, `:443` dropped as [`detect`] and [`https_host`] drop it.
/// Bitbucket accepts only `bitbucket.org`, without a port.
pub fn validate_host(provider: Provider, host: Option<&str>) -> Result<String, GitError> {
    let Some(input) = host.filter(|h| !h.trim().is_empty()) else {
        return Ok(provider.default_host().to_owned());
    };
    let invalid = || GitError::InvalidHostingHost(input.to_owned());
    let (name, port) = host_port(input.trim()).ok_or_else(invalid)?;
    // Bitbucket Cloud is only ever `bitbucket.org`, written without a port.
    if provider == Provider::Bitbucket && (port.is_some() || name != provider.default_host()) {
        return Err(invalid());
    }
    Ok(match port {
        Some(p) if p != "443" => format!("{name}:{p}"),
        _ => name,
    })
}

/// The lower-cased `host[:port]` of an `https://` URL (port 443 dropped, userinfo dropped);
/// `None` for any other scheme.
pub fn https_host(url: &str) -> Option<String> {
    let origin = origin_of(url)?;
    let host = origin.strip_prefix("https://")?.to_ascii_lowercase();
    Some(host.strip_suffix(":443").map(str::to_owned).unwrap_or(host))
}
