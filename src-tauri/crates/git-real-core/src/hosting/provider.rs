//! Which provider hosts a remote (spec §3.2): parsing remote URLs into a [`RepoRef`],
//! validating a host typed by the user, and the `https://` host an account token may go to.
//!
//! An Azure DevOps account and repository are per organization, all on `dev.azure.com`, so
//! their host is `dev.azure.com/<org>` and git credentials match on the organization too.

use serde::{Deserialize, Serialize};

use super::http::percent_encode;
use crate::error::GitError;
use crate::remote::auth::origin_of;
use crate::remote::host::{is_drive_path, strip_user, valid};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    GitHub,
    GitLab,
    Bitbucket,
    /// Azure DevOps Services (`dev.azure.com`); an account's host is `dev.azure.com/<org>`.
    #[serde(rename = "azure")]
    AzureDevOps,
}

/// How a request carries an account token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    /// `Authorization: Bearer <token>`.
    Bearer,
    /// `Authorization: Basic base64(":" + token)`, Azure DevOps' personal access tokens.
    BasicPat,
}

impl Provider {
    const ALL: [Provider; 4] = [
        Provider::GitHub,
        Provider::GitLab,
        Provider::Bitbucket,
        Provider::AzureDevOps,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
            Provider::Bitbucket => "bitbucket",
            Provider::AzureDevOps => "azure",
        }
    }

    pub fn default_host(self) -> &'static str {
        match self {
            Provider::GitHub => "github.com",
            Provider::GitLab => "gitlab.com",
            Provider::Bitbucket => "bitbucket.org",
            Provider::AzureDevOps => "dev.azure.com",
        }
    }

    /// The REST API root for `host`, without a trailing `/`.
    pub fn api_base(self, host: &str) -> String {
        match self {
            Provider::GitHub if host == "github.com" => "https://api.github.com".to_owned(),
            Provider::GitHub => format!("https://{host}/api/v3"),
            Provider::GitLab => format!("https://{host}/api/v4"),
            Provider::Bitbucket => "https://api.bitbucket.org/2.0".to_owned(),
            // `host` is `dev.azure.com/<org>`, for an account and a repository alike.
            Provider::AzureDevOps => format!("https://{host}"),
        }
    }

    /// The HTTPS username git sends with an account token.
    pub fn git_username(self) -> &'static str {
        match self {
            Provider::GitHub => "x-access-token",
            Provider::GitLab => "oauth2",
            Provider::Bitbucket => "x-bitbucket-api-token-auth",
            // Azure DevOps ignores the username for a PAT, but git needs a non-empty one.
            Provider::AzureDevOps => "git-real",
        }
    }

    /// How this provider's REST API takes the account token.
    pub fn auth_scheme(self) -> AuthScheme {
        match self {
            Provider::AzureDevOps => AuthScheme::BasicPat,
            _ => AuthScheme::Bearer,
        }
    }
}

/// A repository on a provider. GitLab's `namespace` may hold several `/`-separated groups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub provider: Provider,
    /// Lower-case `name[:port]`; for Azure DevOps `dev.azure.com/<org>`, the organization in
    /// the case typed (compared ASCII case-insensitively).
    pub host: String,
    pub namespace: String,
    pub name: String,
}

impl RepoRef {
    /// For Azure DevOps `https://{host}/{project}/_git/{repo}`, the names percent-encoded.
    pub fn web_url(&self) -> String {
        match self.provider {
            Provider::AzureDevOps => format!(
                "https://{}/{}/_git/{}",
                self.host,
                percent_encode(&self.namespace),
                percent_encode(&self.name)
            ),
            _ => format!("https://{}/{}/{}", self.host, self.namespace, self.name),
        }
    }
}

/// The hosted repository behind a remote URL (`https://`, `http://`, `ssh://`, `git+ssh://` or
/// scp-like), or `None` when no provider hosts it. A `custom_hosts` entry wins over the
/// default hosts; Azure DevOps hosts are recognised before either (spec §4.3).
pub fn detect(url: &str, custom_hosts: &[(Provider, String)]) -> Option<RepoRef> {
    let (host, path) = split_url(url)?;
    if host == "dev.azure.com" || host == "ssh.dev.azure.com" || host.ends_with(".visualstudio.com")
    {
        // Azure DevOps is never reached on an explicit port.
        return if has_port(url) {
            None
        } else {
            detect_azure(&host, path)
        };
    }
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
        // Azure DevOps URLs have their own grammar; none has this generic shape.
        Provider::AzureDevOps => false,
    };
    fits.then(|| RepoRef {
        provider,
        host,
        namespace: namespace.join("/"),
        name: (*name).to_owned(),
    })
}

/// The raw authority and the path after its `/` of a `scheme://` URL; `None` for another form
/// or a URL with no path.
fn authority_and_path(url: &str) -> Option<(&str, &str)> {
    url.split_once("://")?.1.split_once('/')
}

/// The authority of a `scheme://` URL names a port (`split_url` drops a default one).
fn has_port(url: &str) -> bool {
    authority_and_path(url)
        .and_then(|(authority, _)| host_port(strip_user(authority)))
        .is_some_and(|(_, port)| port.is_some())
}

/// An Azure DevOps repository from its lower-cased `host` and the `path` after it:
/// `v3/<org>/<project>/<repo>` over SSH, else `[<org>/]<project>/_git/<repo>` or the shorthand
/// `_git/<repo>` (project = repo), the organization taken from a `<org>.visualstudio.com` host
/// and a leading `DefaultCollection` dropped there.
fn detect_azure(host: &str, path: &str) -> Option<RepoRef> {
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments: Vec<&str> = path.split('/').collect();
    let (org, project, name) = match host {
        "ssh.dev.azure.com" | "vs-ssh.visualstudio.com" => match segments.as_slice() {
            ["v3", org, project, name] => (*org, *project, *name),
            _ => return None,
        },
        "dev.azure.com" => {
            // `split` yields at least one segment.
            let (project, name) = git_marker(&segments[1..])?;
            (segments[0], project, name)
        }
        _ => {
            // `host` ends with `.visualstudio.com`; a dotted label fails `is_azure_org`.
            let org = host.strip_suffix(".visualstudio.com").unwrap_or(host);
            let rest = segments
                .strip_prefix(&["DefaultCollection"][..])
                .unwrap_or(&segments);
            let (project, name) = git_marker(rest)?;
            (org, project, name)
        }
    };
    let decoded = |s: &str| percent_decode(s).filter(|d| azure_segment_ok(d));
    let (project, name) = (decoded(project)?, decoded(name)?);
    is_azure_org(org).then(|| RepoRef {
        provider: Provider::AzureDevOps,
        host: format!("dev.azure.com/{org}"),
        namespace: project,
        name,
    })
}

/// `(project, repo)` from `<project>/_git/<repo>` or `_git/<repo>`.
fn git_marker<'a>(rest: &[&'a str]) -> Option<(&'a str, &'a str)> {
    match rest {
        [project, "_git", name] => Some((project, name)),
        ["_git", name] => Some((name, name)),
        _ => None,
    }
}

/// `s` with each `%XX` turned into its byte; `None` for a bare or malformed `%` or a result
/// that is not UTF-8.
pub(crate) fn percent_decode(s: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(s.len());
    let mut rest = s.as_bytes();
    while let Some((&b, tail)) = rest.split_first() {
        if b == b'%' {
            let (pair, after) = tail.split_at_checked(2)?;
            let digit = |c: u8| char::from(c).to_digit(16);
            // Two hex digits make at most 255.
            bytes.push((digit(pair[0])? * 16 + digit(pair[1])?) as u8);
            rest = after;
        } else {
            bytes.push(b);
            rest = tail;
        }
    }
    String::from_utf8(bytes).ok()
}

/// A decoded Azure DevOps project or repository name: non-empty, not `.` or `..`, with no `/`,
/// `\`, `%`, NUL or other control character.
pub(crate) fn azure_segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '%') || c.is_control())
}

/// Azure DevOps' organization rule: `[A-Za-z0-9][A-Za-z0-9-]*`.
fn is_azure_org(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The organization in `input`: an organization name, or one taken from
/// `[https://]dev.azure.com/<org>[/…]` or `[https://][user@]<org>.visualstudio.com[/…]`. A
/// typed name or a `dev.azure.com` path keeps its case, a host label is lower-cased; `None` for
/// anything else.
pub fn azure_org(input: &str) -> Option<String> {
    let input = input.trim();
    let (has_scheme, rest) = match input.get(..8) {
        Some(s) if s.eq_ignore_ascii_case("https://") => (true, &input[8..]),
        _ => (false, input),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (rest, None),
    };
    let authority = strip_user(authority).to_ascii_lowercase();
    let org = if authority == "dev.azure.com" {
        path?.split('/').next().unwrap_or_default()
    } else if let Some(label) = authority.strip_suffix(".visualstudio.com") {
        label
    } else if !has_scheme && path.is_none() {
        rest
    } else {
        return None;
    };
    is_azure_org(org).then(|| org.to_owned())
}

/// The `https://` origin to scope an account's git credentials to when `url` belongs to the
/// account on `account_host`; `None` otherwise. A plain host matches the URL's https host; an
/// Azure DevOps `dev.azure.com/<org>` matches `https://dev.azure.com/<org>/…` (organization
/// compared ASCII case-insensitively) or `https://<org>.visualstudio.com/…`, and never a path
/// with a `.` or `..` segment.
pub fn account_origin_for(account_host: &str, url: &str) -> Option<String> {
    let host = https_host(url)?;
    let Some((base, org)) = account_host.split_once('/') else {
        // An account without an organization is never an Azure DevOps one.
        let lower = account_host.to_ascii_lowercase();
        if lower == Provider::AzureDevOps.default_host() || lower.ends_with(".visualstudio.com") {
            return None;
        }
        return host
            .eq_ignore_ascii_case(account_host)
            .then(|| format!("https://{host}"));
    };
    if base != Provider::AzureDevOps.default_host() {
        return None;
    }
    let path = authority_and_path(url).map_or("", |(_, path)| path);
    // A `.` or `..` segment (encoded or not) could walk the path out of the organization.
    let dot_segment = |s: &str| percent_decode(s).is_some_and(|d| d == "." || d == "..");
    if path.split('/').any(dot_segment) {
        return None;
    }
    let matches = if host == "dev.azure.com" {
        let first = path.split_once('/').map_or(path, |(first, _)| first);
        first.eq_ignore_ascii_case(org)
    } else {
        host.strip_suffix(".visualstudio.com")
            .is_some_and(|label| label.eq_ignore_ascii_case(org))
    };
    matches.then(|| format!("https://{host}"))
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
    // An Azure DevOps account is one organization, with no default: `dev.azure.com/<org>`.
    if provider == Provider::AzureDevOps {
        let input = host.unwrap_or_default();
        return azure_org(input)
            .map(|org| format!("dev.azure.com/{org}"))
            .ok_or_else(|| GitError::InvalidHostingHost(input.to_owned()));
    }
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
