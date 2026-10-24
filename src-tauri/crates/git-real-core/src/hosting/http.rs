//! The HTTP seam of the hosting domain: requests and responses, the [`Transport`]
//! port, and the mapping of a provider's status and body to a result (spec §4.2).
//!
//! A token never reaches a `Debug` text or an error: [`Token`] and [`Request`] redact it, and
//! a provider message that quotes it has it replaced by `***`.

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::GitError;
use crate::token::Token;

const MAX_MESSAGE_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                let v = if k.eq_ignore_ascii_case("authorization") {
                    "***"
                } else {
                    v.as_str()
                };
                (k.as_str(), v)
            })
            .collect();
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .field("body", &self.body)
            .finish()
    }
}

/// A provider's answer; header names are lower-case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    /// The first header called `name` (ASCII case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Sends one request. Any HTTP status is a `Response`; only a failure to get one (DNS, TLS,
/// refused, timeout) is an error, `HostingUnreachable`.
pub trait Transport: Send + Sync {
    fn send(&self, req: &Request) -> Result<Response, GitError>;
}

/// Epoch seconds of an RFC 3339 timestamp: `YYYY-MM-DDTHH:MM:SS`, an optional fraction of any
/// length, then `Z` or `±HH:MM`.
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(&b[0..4])?;
    let (month, day) = (digits(&b[5..7])?, digits(&b[8..10])?);
    let (hour, minute, second) = (
        digits(&b[11..13])?,
        digits(&b[14..16])?,
        digits(&b[17..19])?,
    );
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut zone = &b[19..];
    if let Some(fraction) = zone.strip_prefix(b".") {
        let len = fraction.iter().take_while(|c| c.is_ascii_digit()).count();
        if len == 0 {
            return None;
        }
        zone = &fraction[len..];
    }
    let offset = match zone {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let (h, m) = (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?);
            if h > 23 || m > 59 {
                return None;
            }
            let secs = h * 3600 + m * 60;
            if *sign == b'+' { secs } else { -secs }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

fn digits(b: &[u8]) -> Option<i64> {
    b.iter().try_fold(0i64, |n, c| {
        c.is_ascii_digit().then(|| n * 10 + i64::from(c - b'0'))
    })
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A GET with `Authorization: Bearer <token>` and `Accept: application/json`; `extra` headers
/// are added after, and an `accept` among them replaces the default.
pub(crate) fn get(url: String, token: &Token, extra: &[(&str, &str)]) -> Request {
    let mut headers = vec![authorization(token)];
    if !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("accept")) {
        headers.push(("Accept".to_owned(), "application/json".to_owned()));
    }
    headers.extend(
        extra
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
    );
    Request {
        method: Method::Get,
        url,
        headers,
        body: None,
    }
}

/// A POST of `body` as JSON, with `Authorization: Bearer <token>`, `Accept: application/json`
/// and `Content-Type: application/json`.
pub fn post_json(url: String, token: &Token, body: &Value) -> Request {
    Request {
        method: Method::Post,
        url,
        headers: vec![
            authorization(token),
            ("Accept".to_owned(), "application/json".to_owned()),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(body.to_string()),
    }
}

/// The `Authorization: Bearer <token>` header.
fn authorization(token: &Token) -> (String, String) {
    (
        "Authorization".to_owned(),
        format!("Bearer {}", token.expose_secret()),
    )
}

/// Sends `req` and parses a 2xx body as `T`; any other status becomes the matching hosting
/// error. `host` names the provider in the unexpected-response message.
pub(crate) fn send_json<T: DeserializeOwned>(
    t: &dyn Transport,
    req: &Request,
    token: &Token,
    host: &str,
) -> Result<T, GitError> {
    let resp = t.send(req)?;
    let status = resp.status;
    let rate_limited =
        status == 429 || (status == 403 && resp.header("x-ratelimit-remaining") == Some("0"));
    match status {
        200..=299 => serde_json::from_str(&resp.body).map_err(|_| unexpected(host)),
        _ if rate_limited => Err(GitError::HostingRateLimited {
            reset_epoch: reset_epoch(&resp),
        }),
        401 | 403 => Err(GitError::HostingAuth {
            message: message(&resp, token),
        }),
        404 => Err(GitError::HostingNotFound),
        500..=599 => Err(GitError::HostingUnreachable {
            message: format!("HTTP {status}"),
        }),
        _ => Err(GitError::HostingRejected {
            message: message(&resp, token),
        }),
    }
}

/// The body did not have the expected shape.
pub(crate) fn unexpected(host: &str) -> GitError {
    GitError::HostingUnreachable {
        message: format!("unexpected response from {host}"),
    }
}

/// `x-ratelimit-reset`, else `ratelimit-reset` (epoch seconds), else `retry-after` (seconds
/// from now).
fn reset_epoch(resp: &Response) -> Option<u64> {
    let read = |name| resp.header(name).and_then(|v| v.trim().parse::<u64>().ok());
    read("x-ratelimit-reset")
        .or_else(|| read("ratelimit-reset"))
        .or_else(|| {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
            read("retry-after").map(|secs| now + secs)
        })
}

/// The provider's own words for a refusal, first match wins: `errors[0].message` (GitHub's
/// `Validation Failed` details), `message` as a string or as an array of strings joined with
/// `; ` (GitLab), `error`, `error.message`, else `HTTP <status>`; the token replaced by `***`,
/// then cut to 200 characters.
fn message(resp: &Response, token: &Token) -> String {
    let body: Value = serde_json::from_str(&resp.body).unwrap_or(Value::Null);
    let text = body["errors"][0]["message"]
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .or_else(|| body["message"].as_str().map(str::to_owned))
        .or_else(|| joined_strings(&body["message"]))
        .or_else(|| body["error"].as_str().map(str::to_owned))
        .or_else(|| body["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("HTTP {}", resp.status))
        .replace(token.expose_secret(), "***");
    if text.chars().count() > MAX_MESSAGE_CHARS {
        let cut: String = text.chars().take(MAX_MESSAGE_CHARS).collect();
        format!("{cut}…")
    } else {
        text
    }
}

/// The string entries of an array joined with `; `; `None` for a non-array or when no entry is
/// a string.
fn joined_strings(value: &Value) -> Option<String> {
    let parts: Vec<&str> = value.as_array()?.iter().filter_map(Value::as_str).collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// A user's issue search text as sent to a provider: surrounding whitespace dropped, so an
/// all-blank query is no query.
pub(crate) fn issue_query(query: &str) -> &str {
    query.trim()
}

/// Percent-encodes everything but `A-Za-z0-9-._~`, so `segment` stays one path segment.
pub fn percent_encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
