//! Update check domain: `Version`, `UpdateInfo`, `check_for_update`.
//!
//! One unauthenticated GET of a provider's "latest release" endpoint, over the
//! shared [`Transport`] port, turned into an [`UpdateInfo`] the UI can act on.
//! All failures are [`GitError::UpdateCheckFailed`]; a 404 is not a failure but
//! "no release published yet".

use std::cmp::Ordering;

use serde::Serialize;

use crate::error::GitError;
use crate::hosting::http::{Method, Request, Transport};

/// A release version: `MAJOR.MINOR.PATCH` with an optional `-PRE` suffix, with
/// or without a leading `v`/`V`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Everything after the first `-`; never empty when present.
    pub pre: Option<String>,
}

impl Version {
    /// Parses `MAJOR.MINOR.PATCH[-PRE]`, trimming surrounding whitespace and
    /// stripping at most one leading `v`/`V`. The triple must be exactly three
    /// decimal integers; a `-PRE` suffix (anything after the first `-`) must be
    /// non-empty. Build metadata (`+…`), extra segments, and non-numeric parts
    /// are rejected.
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim();
        let s = s
            .strip_prefix('v')
            .or_else(|| s.strip_prefix('V'))
            .unwrap_or(s);
        let (core, pre) = match s.split_once('-') {
            Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_owned())),
            Some(_) => return None,
            None => (s, None),
        };
        let mut parts = core.split('.');
        let major = parse_u64(parts.next()?)?;
        let minor = parse_u64(parts.next()?)?;
        let patch = parse_u64(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        Some(Version {
            major,
            minor,
            patch,
            pre,
        })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                // A pre-release sorts below the same triple without one.
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A non-empty run of ASCII digits as a `u64`.
fn parse_u64(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// What the UI needs to decide whether to prompt an update (serde camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The running version, as given to [`check_for_update`].
    pub current: String,
    /// The latest release's tag without a leading `v`; `None` when none exists.
    pub latest: Option<String>,
    /// Whether `latest` is newer than `current`.
    pub available: bool,
    /// The latest release's `html_url`; `None` when none exists.
    pub url: Option<String>,
}

/// The GitHub "latest release" API version header value.
const GITHUB_API_VERSION: &str = "2022-11-28";

/// One GET of the "latest release" endpoint at `api_url`, comparing the tag it
/// returns with `current`. 200 → parsed; 404 → no release yet (`available`
/// false, `latest`/`url` `None`); anything else, or a transport failure, or an
/// unexpected body → [`GitError::UpdateCheckFailed`].
pub fn check_for_update(
    transport: &dyn Transport,
    current: &str,
    api_url: &str,
) -> Result<UpdateInfo, GitError> {
    let req = Request {
        method: Method::Get,
        url: api_url.to_owned(),
        headers: vec![
            (
                "Accept".to_owned(),
                "application/vnd.github+json".to_owned(),
            ),
            (
                "X-GitHub-Api-Version".to_owned(),
                GITHUB_API_VERSION.to_owned(),
            ),
        ],
        body: None,
    };
    let resp = transport.send(&req).map_err(|e| failed(e.to_string()))?;
    match resp.status {
        200 => parse_release(&resp.body, current),
        404 => Ok(UpdateInfo {
            current: current.to_owned(),
            latest: None,
            available: false,
            url: None,
        }),
        403 if resp.header("x-ratelimit-remaining") == Some("0") => {
            Err(failed("GitHub answered 403 (rate limited)".to_owned()))
        }
        status => Err(failed(format!("GitHub answered {status}"))),
    }
}

/// Turns a 200 body into an [`UpdateInfo`], or an `UpdateCheckFailed` with a
/// reason when the body is not the shape expected or a tag does not parse.
fn parse_release(body: &str, current: &str) -> Result<UpdateInfo, GitError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| failed("unexpected response".to_owned()))?;
    let tag = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failed("unexpected response".to_owned()))?;
    let url = value
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| failed("unexpected response".to_owned()))?;
    let current_version = Version::parse(current)
        .ok_or_else(|| failed(format!("unrecognised current version {current}")))?;
    let latest_version =
        Version::parse(tag).ok_or_else(|| failed(format!("unrecognised release tag {tag}")))?;
    Ok(UpdateInfo {
        current: current.to_owned(),
        latest: Some(strip_leading_v(tag).to_owned()),
        available: latest_version > current_version,
        url: Some(url.to_owned()),
    })
}

/// The tag with at most one leading `v`/`V` removed.
fn strip_leading_v(tag: &str) -> &str {
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
}

/// Shorthand for the one error this module produces.
fn failed(message: String) -> GitError {
    GitError::UpdateCheckFailed { message }
}

#[cfg(test)]
mod tests {
    use crate::error::GitError;
    use crate::hosting::http::{Method, Request, Response, Transport};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    // Inline fake transport – core has no shared FakeTransport (that lives in
    // src-tauri/tests/common), so the core tests define their own, as the
    // hosting tests do.
    struct Fake {
        replies: Mutex<VecDeque<Result<Response, GitError>>>,
        seen: Mutex<Vec<Request>>,
    }

    impl Fake {
        fn new() -> Self {
            Fake {
                replies: Mutex::new(VecDeque::new()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn reply(self, status: u16, body: &str) -> Self {
            self.reply_with(status, &[], body)
        }

        fn reply_with(self, status: u16, headers: &[(&str, &str)], body: &str) -> Self {
            self.replies.lock().unwrap().push_back(Ok(Response {
                status,
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_owned()))
                    .collect(),
                body: body.to_owned(),
            }));
            self
        }

        fn fail(self, err: GitError) -> Self {
            self.replies.lock().unwrap().push_back(Err(err));
            self
        }

        fn last_request(&self) -> Request {
            self.seen
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("no requests recorded")
        }
    }

    impl Transport for Fake {
        fn send(&self, req: &Request) -> Result<Response, GitError> {
            self.seen.lock().unwrap().push(req.clone());
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("unexpected request {}", req.url))
        }
    }

    const API_URL: &str = "https://api.github.com/repos/harmonizationllc/git-real/releases/latest";
    const CURRENT: &str = "0.1.0";

    fn release_body(tag: &str, url: &str) -> String {
        format!(r#"{{"tag_name":"{tag}","html_url":"{url}"}}"#)
    }

    // -------------------------------------------------------------------------
    // Version::parse
    // -------------------------------------------------------------------------

    /// Accepts plain semver, a leading lowercase v, a leading uppercase V, and
    /// a pre-release suffix; the leading v/V is stripped before returning.
    #[test]
    fn parse_accepts_plain_v_and_prerelease() {
        use super::Version;

        // plain semver
        assert!(Version::parse("1.2.3").is_some(), "1.2.3 must parse");

        // leading lowercase v; triple must be 1.2.3
        let v = Version::parse("v1.2.3").expect("v1.2.3 must parse");
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        assert!(v.pre.is_none(), "no pre-release for v1.2.3");

        // leading uppercase V
        assert!(Version::parse("V2.0.0").is_some(), "V2.0.0 must parse");

        // pre-release suffix
        let pre = Version::parse("1.2.3-beta.1").expect("1.2.3-beta.1 must parse");
        assert_eq!(pre.pre.as_deref(), Some("beta.1"));

        // pre-release with v prefix
        let vp = Version::parse("v1.0.0-rc.1").expect("v1.0.0-rc.1 must parse");
        assert_eq!(vp.pre.as_deref(), Some("rc.1"));
    }

    /// Rejects `1.2` (missing patch), `1.2.3.4` (extra segment), `a.b.c`
    /// (non-numeric), empty string, and `1.2.3+build` (build metadata).
    #[test]
    fn parse_rejects_malformed() {
        use super::Version;

        assert!(Version::parse("1.2").is_none(), "1.2: missing patch");
        assert!(
            Version::parse("1.2.3.4").is_none(),
            "1.2.3.4: extra segment"
        );
        assert!(Version::parse("a.b.c").is_none(), "a.b.c: non-numeric");
        assert!(Version::parse("").is_none(), "empty string");
        assert!(
            Version::parse("1.2.3+build").is_none(),
            "1.2.3+build: build metadata"
        );
    }

    /// Numeric ordering by patch, minor, major; a pre-release sorts below the
    /// same triple without a pre-release; two pre-releases compare as strings.
    #[test]
    fn ordering_numeric_then_prerelease_below_release() {
        use super::Version;

        let v = |s: &str| Version::parse(s).unwrap();

        assert!(v("1.0.1") > v("1.0.0"), "patch increment");
        assert!(v("1.1.0") > v("1.0.9"), "minor increment");
        assert!(v("2.0.0") > v("1.9.9"), "major increment");

        // Pre-release is below the same plain release.
        assert!(v("1.0.0-alpha") < v("1.0.0"), "pre < release");

        // Two pre-releases compare as plain strings.
        assert!(v("1.0.0-alpha") < v("1.0.0-beta"), "alpha < beta (string)");
        assert!(v("1.0.0-rc.2") > v("1.0.0-rc.1"), "rc.2 > rc.1 (string)");
    }

    // -------------------------------------------------------------------------
    // check_for_update
    // -------------------------------------------------------------------------

    /// A newer release returns available=true with the tag (v-stripped) and url.
    #[test]
    fn newer_release_is_available() {
        use super::check_for_update;

        let url = "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0";
        let t = Fake::new().reply(200, &release_body("v1.0.0", url));
        let info = check_for_update(&t, CURRENT, API_URL).unwrap();

        assert!(info.available, "available must be true");
        assert_eq!(info.latest.as_deref(), Some("1.0.0"), "leading v stripped");
        assert_eq!(info.url.as_deref(), Some(url));
        assert_eq!(info.current, CURRENT);
    }

    /// An equal or older tag returns available=false.
    #[test]
    fn equal_or_older_is_not_available() {
        use super::check_for_update;

        let t = Fake::new().reply(200, &release_body("v0.1.0", "https://example.com"));
        assert!(!check_for_update(&t, "0.1.0", API_URL).unwrap().available);

        let t = Fake::new().reply(200, &release_body("v0.0.9", "https://example.com"));
        assert!(!check_for_update(&t, "0.1.0", API_URL).unwrap().available);
    }

    /// A 404 means no release has been published: available=false, latest=None, url=None.
    #[test]
    fn not_found_means_no_release() {
        use super::check_for_update;

        let t = Fake::new().reply(404, "Not Found");
        let info = check_for_update(&t, CURRENT, API_URL).unwrap();

        assert!(!info.available);
        assert!(info.latest.is_none(), "latest must be None on 404");
        assert!(info.url.is_none());
    }

    /// A 403 with x-ratelimit-remaining: 0 maps to
    /// `UpdateCheckFailed { message: "GitHub answered 403 (rate limited)" }`.
    #[test]
    fn rate_limited_403_is_named() {
        use super::check_for_update;

        let t = Fake::new().reply_with(403, &[("x-ratelimit-remaining", "0")], "Forbidden");
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(message.contains("403"), "status in message: {message}");
                assert!(
                    message.contains("rate limited"),
                    "rate limited in message: {message}"
                );
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// Any other non-200/404 status becomes
    /// `UpdateCheckFailed { message: "GitHub answered <status>" }`.
    #[test]
    fn other_status_is_reported() {
        use super::check_for_update;

        let t = Fake::new().reply(500, "Internal Server Error");
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(message.contains("500"), "status in message: {message}");
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// A non-JSON body on 200 maps to `UpdateCheckFailed { message: "unexpected response" }`.
    #[test]
    fn non_json_body_is_unexpected() {
        use super::check_for_update;

        let t = Fake::new().reply(200, "not json");
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(
                    message.contains("unexpected"),
                    "unexpected in message: {message}"
                );
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// Missing or non-string `tag_name` on 200 maps to `"unexpected response"`.
    #[test]
    fn missing_tag_name_is_unexpected() {
        use super::check_for_update;

        let t = Fake::new().reply(200, r#"{"html_url":"https://example.com"}"#);
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(
                    message.contains("unexpected"),
                    "unexpected in message: {message}"
                );
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// A tag that `Version::parse` rejects becomes
    /// `UpdateCheckFailed { message: "unrecognised release tag <tag>" }`.
    #[test]
    fn unparseable_tag_is_reported() {
        use super::check_for_update;

        let body = r#"{"tag_name":"not-a-version","html_url":"https://example.com"}"#;
        let t = Fake::new().reply(200, body);
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(
                    message.contains("unrecognised release tag"),
                    "message: {message}"
                );
                assert!(
                    message.contains("not-a-version"),
                    "tag in message: {message}"
                );
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// A transport `Err(e)` is rewrapped as
    /// `UpdateCheckFailed { message: e.to_string() }`.
    #[test]
    fn transport_error_is_wrapped() {
        use super::check_for_update;

        let t = Fake::new().fail(GitError::HostingUnreachable {
            message: "DNS failed".to_owned(),
        });
        let err = check_for_update(&t, CURRENT, API_URL).unwrap_err();

        match err {
            GitError::UpdateCheckFailed { message } => {
                assert!(message.contains("DNS failed"), "transport error: {message}");
            }
            other => panic!("expected UpdateCheckFailed, got {other:?}"),
        }
    }

    /// The request sent must be a GET to `api_url` with the two GitHub headers
    /// and no Authorization header.
    #[test]
    fn request_has_github_headers_and_url() {
        use super::check_for_update;

        let t = Fake::new().reply(200, &release_body("v1.0.0", "https://example.com"));
        let _ = check_for_update(&t, CURRENT, API_URL);

        let req = t.last_request();
        assert_eq!(req.url, API_URL);
        assert_eq!(req.method, Method::Get);
        assert!(
            req.headers
                .iter()
                .all(|(k, _)| !k.eq_ignore_ascii_case("authorization")),
            "no Authorization header"
        );

        let hdr = |name: &str| -> Option<&str> {
            req.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(
            hdr("accept"),
            Some("application/vnd.github+json"),
            "accept header"
        );
        assert_eq!(
            hdr("x-github-api-version"),
            Some("2022-11-28"),
            "api-version header"
        );
    }
}
