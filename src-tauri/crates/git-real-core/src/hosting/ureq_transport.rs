//! The real [`Transport`]: a blocking `ureq` agent over rustls with a 15 s overall timeout.
//! Every status comes back as a [`Response`]; the status mapping lives in [`super::http`].

use std::time::Duration;

use super::http::{Method, Request, Response, Transport};
use crate::error::GitError;

const USER_AGENT: &str = concat!("git-real/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);

pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for UreqTransport {
    fn send(&self, req: &Request) -> Result<Response, GitError> {
        let sent = match req.method {
            Method::Get => {
                let mut builder = self.agent.get(&req.url);
                for (name, value) in &req.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            Method::Post => {
                let mut builder = self.agent.post(&req.url);
                for (name, value) in &req.headers {
                    builder = builder.header(name, value);
                }
                builder.send(req.body.as_deref().unwrap_or_default())
            }
        };
        let mut resp = sent.map_err(unreachable)?;
        let headers = resp
            .headers()
            .iter()
            .map(|(name, value)| {
                let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
                (name.as_str().to_ascii_lowercase(), value)
            })
            .collect();
        let body = resp.body_mut().read_to_string().map_err(unreachable)?;
        Ok(Response {
            status: resp.status().as_u16(),
            headers,
            body,
        })
    }
}

fn unreachable(e: ureq::Error) -> GitError {
    GitError::HostingUnreachable {
        message: e.to_string(),
    }
}
