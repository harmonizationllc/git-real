//! Turning git's stderr into a [`NetworkErrorKind`] the UI can act on, and
//! finding the origin git asked credentials for.

use super::auth::origin_of;
use crate::model::NetworkErrorKind;

const UNREACHABLE: [&str; 6] = [
    "Could not resolve host",
    "Connection refused",
    "Connection timed out",
    "Network is unreachable",
    "Failed to connect to",
    "Couldn't connect to server",
];

/// git's ref status for a ref the server refused. It never contains `[rejected]`.
const REMOTE_REJECTED: &str = "[remote rejected]";

/// A server's error line, as git relays it.
const REMOTE_ERROR: &str = "remote: error:";

/// First match wins, in the order of the Global Constraints list.
pub fn classify(stderr: &str) -> NetworkErrorKind {
    let has = |s: &str| stderr.contains(s);
    let rejected = has("[rejected]");
    if has("could not read Username")
        || has("could not read Password")
        || has("terminal prompts disabled")
    {
        NetworkErrorKind::HttpsAuthRequired
    } else if has("Authentication failed for")
        || has("returned error: 401")
        || has("returned error: 403")
    {
        NetworkErrorKind::HttpsAuthRejected
    } else if has("Permission denied (publickey") {
        NetworkErrorKind::SshAuthFailed
    } else if has("Host key verification failed") {
        NetworkErrorKind::HostKeyUnverified
    } else if UNREACHABLE.iter().any(|s| has(s)) {
        NetworkErrorKind::HostUnreachable
    } else if has("Repository not found")
        || has("does not appear to be a git repository")
        || stderr.lines().any(is_missing_repository_line)
    {
        NetworkErrorKind::RepoNotFound
    } else if has(REMOTE_REJECTED) {
        NetworkErrorKind::RemoteRejected
    } else if rejected && (has("(fetch first)") || has("(non-fast-forward)")) {
        NetworkErrorKind::PushRejectedNonFastForward
    } else if rejected && has("(stale info)") {
        NetworkErrorKind::LeaseStale
    } else {
        NetworkErrorKind::Other
    }
}

/// git's HTTP 404: `fatal: repository '<url>' not found`.
fn is_missing_repository_line(line: &str) -> bool {
    line.starts_with("fatal: repository '") && line.trim_end().ends_with("' not found")
}

/// The origin of the first `'`-quoted HTTP(S) URL on one of git's own
/// `fatal:` lines; a server's `remote:` lines never count.
pub fn auth_origin(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .filter(|l| l.starts_with("fatal: "))
        .find_map(|line| {
            let (_, rest) = line.split_once('\'')?;
            let (url, _) = rest.split_once('\'')?;
            origin_of(url)
        })
}

/// Why the server refused a push: the first non-empty `remote: error:` line with the prefix
/// stripped, or else the parenthesised reason on the `[remote rejected] a -> b (reason)` line.
pub fn rejection_reason(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find_map(|line| non_empty(line.strip_prefix(REMOTE_ERROR)?))
        .or_else(|| {
            stderr
                .lines()
                .find(|l| l.contains(REMOTE_REJECTED))
                .and_then(parenthesised_reason)
        })
}

/// The text between the first ` (` after ` -> ` and the line's final `)`.
fn parenthesised_reason(line: &str) -> Option<String> {
    let (_, after_arrow) = line.split_once(" -> ")?;
    let (_, reason) = after_arrow.split_once(" (")?;
    non_empty(reason.trim_end().strip_suffix(')')?)
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
