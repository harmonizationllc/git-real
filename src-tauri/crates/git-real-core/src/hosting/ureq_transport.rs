//! The real [`Transport`]: a blocking `ureq` agent over rustls with a 15 s overall timeout.
//! Every status comes back as a [`Response`]; the status mapping lives in [`super::http`].
//!
//! Redirects are followed here rather than by ureq: ureq's `SameHost` policy ignores the port,
//! so it would hand the token to another origin on the same machine. The `Authorization`
//! header follows a redirect only to the same `scheme://host[:port]`.

use std::time::Duration;

use ureq::RequestBuilder;
use ureq::http::Response as HttpResponse;

use super::http::{Method, Request, Response, Transport};
use crate::error::GitError;
use crate::remote::auth::origin_of;

const USER_AGENT: &str = concat!("git-real/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 10;

pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .max_redirects(0)
            .build();
        Self {
            agent: config.into(),
        }
    }

    fn send_once(&self, req: &Request) -> Result<HttpResponse<ureq::Body>, GitError> {
        let sent = match req.method {
            Method::Get => with_headers(self.agent.get(&req.url), req).call(),
            Method::Post => with_headers(self.agent.post(&req.url), req)
                .send(req.body.as_deref().unwrap_or_default()),
        };
        sent.map_err(unreachable_err)
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for UreqTransport {
    fn send(&self, req: &Request) -> Result<Response, GitError> {
        let mut req = req.clone();
        for _ in 0..=MAX_REDIRECTS {
            let mut resp = self.send_once(&req)?;
            let Some(next) = redirect_target(&req.url, &resp) else {
                return read(&mut resp);
            };
            if !same_origin(&req.url, &next) {
                req.headers
                    .retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
            }
            let status = resp.status().as_u16();
            if status == 303 || (matches!(status, 301 | 302) && req.method == Method::Post) {
                req.method = Method::Get;
                req.body = None;
            }
            req.url = next;
        }
        Err(GitError::HostingUnreachable {
            message: "too many redirects".to_owned(),
        })
    }
}

/// The absolute `http(s)` URL a 301/302/303/307/308 points to; `None` for any other response
/// or a `Location` that is neither an absolute `http(s)` URL nor an absolute path.
fn redirect_target(url: &str, resp: &HttpResponse<ureq::Body>) -> Option<String> {
    if !matches!(resp.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let location = resp.headers().get("location")?.to_str().ok()?;
    let next = if location.starts_with('/') && !location.starts_with("//") {
        format!("{}{location}", origin_of(url)?)
    } else {
        location.to_owned()
    };
    origin_of(&next).is_some().then_some(next)
}

fn same_origin(a: &str, b: &str) -> bool {
    origin_of(a)
        .zip(origin_of(b))
        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(&b))
}

fn read(resp: &mut HttpResponse<ureq::Body>) -> Result<Response, GitError> {
    let headers = resp
        .headers()
        .iter()
        .map(|(name, value)| {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            (name.as_str().to_ascii_lowercase(), value)
        })
        .collect();
    // Lossy, so a body that is not UTF-8 keeps its status for the mapping.
    let bytes = resp.body_mut().read_to_vec().map_err(unreachable_err)?;
    Ok(Response {
        status: resp.status().as_u16(),
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn with_headers<B>(mut builder: RequestBuilder<B>, req: &Request) -> RequestBuilder<B> {
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    builder
}

fn unreachable_err(e: ureq::Error) -> GitError {
    GitError::HostingUnreachable {
        message: e.to_string(),
    }
}
