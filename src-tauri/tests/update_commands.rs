//! App-crate integration tests for the update-check command (GR-15 Cycle 1, Task 2).
//!
//! RED PHASE: `git_real_lib::commands::update` does not exist yet, and
//! `AppErrorKind::UpdateCheckFailed` is not in the enum. All tests fail to
//! compile until the developer adds both.

mod common;

use git_real_core::error::GitError;
use git_real_core::hosting::http::{Request, Response, Transport};
use git_real_lib::commands::update::check_for_update_inner; // RED: module missing
use git_real_lib::error::{AppError, AppErrorKind}; // AppErrorKind::UpdateCheckFailed missing

// ---------------------------------------------------------------------------
// Inline fake HTTP transport for update-check tests.
// The shared `FakeTransport` in `common` implements the authenticated hosting
// Transport; the update check uses the simpler `hosting::http::Transport`.
// ---------------------------------------------------------------------------

struct FakeHttp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    /// When Some, `send` returns this message wrapped in `HostingUnreachable`.
    fail_message: Option<String>,
}

impl FakeHttp {
    fn ok(tag: &str, url: &str) -> Self {
        FakeHttp {
            status: 200,
            headers: vec![],
            body: format!(r#"{{"tag_name":"{tag}","html_url":"{url}"}}"#),
            fail_message: None,
        }
    }

    /// Makes every `send` return `GitError::HostingUnreachable { message }`.
    fn fail_with(message: impl Into<String>) -> Self {
        FakeHttp {
            status: 0,
            headers: vec![],
            body: String::new(),
            fail_message: Some(message.into()),
        }
    }
}

impl Transport for FakeHttp {
    fn send(&self, _req: &Request) -> Result<Response, GitError> {
        if let Some(msg) = &self.fail_message {
            return Err(GitError::HostingUnreachable {
                message: msg.clone(),
            });
        }
        Ok(Response {
            status: self.status,
            headers: self.headers.clone(),
            body: self.body.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// A successful lookup with a newer release returns `UpdateInfo` with
/// `available = true`.
#[test]
fn check_for_update_returns_info() {
    let transport = FakeHttp::ok(
        "v1.0.0",
        "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0",
    );
    let info = check_for_update_inner(&transport).expect("should succeed");
    assert!(info.available, "newer release is available");
    assert_eq!(info.latest.as_deref(), Some("1.0.0"), "v prefix stripped");
}

/// A transport error is converted to `AppError { kind: updateCheckFailed, … }`.
#[test]
fn check_for_update_maps_failure_to_update_check_failed() {
    let transport = FakeHttp::fail_with("DNS failure");
    let err: AppError = check_for_update_inner(&transport).unwrap_err();
    assert_eq!(
        err.kind,
        AppErrorKind::UpdateCheckFailed, // RED: variant missing
        "error kind must be updateCheckFailed"
    );
    assert!(
        err.message.contains("DNS failure"),
        "original message forwarded: {}",
        err.message
    );
}

/// `AppErrorKind::UpdateCheckFailed` serialises to `"updateCheckFailed"` under
/// the `#[serde(rename_all = "camelCase")]` derive.
#[test]
fn app_error_kind_serializes_update_check_failed() {
    let kind = AppErrorKind::UpdateCheckFailed; // RED: variant missing
    let serialized = serde_json::to_string(&kind).expect("serialize kind");
    assert_eq!(serialized, r#""updateCheckFailed""#);
}
