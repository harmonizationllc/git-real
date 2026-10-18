//! Pure rules for turning a subject + body into one message and back.

use crate::model::CommitMessage;

/// Splits a raw message: the first line (trimmed) is the subject; the rest,
/// minus leading blank lines and trailing whitespace, is the body.
pub fn split(raw: &str) -> CommitMessage {
    let mut lines = raw.lines();
    let subject = lines.next().unwrap_or("").trim().to_string();
    let body = lines
        .skip_while(|line| line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string();
    CommitMessage { subject, body }
}

/// Joins a message for `git commit -F -`: `subject\n` or `subject\n\nbody\n`.
///
/// Each line break inside the subject (CRLF counts as one) becomes a space,
/// CRLF in the body becomes LF, and blank lines at either edge of the body
/// are dropped. Lines starting with `#` are kept; the caller passes
/// `--cleanup=whitespace` so git keeps them too.
pub fn join(message: &CommitMessage) -> String {
    let subject = message
        .subject
        .replace("\r\n", "\n")
        .replace(['\r', '\n'], " ");
    let subject = subject.trim();
    let body = message.body.replace("\r\n", "\n");
    let body = body
        .lines()
        .skip_while(|line| line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let body = body.trim_end();
    if body.is_empty() {
        format!("{subject}\n")
    } else {
        format!("{subject}\n\n{body}\n")
    }
}
