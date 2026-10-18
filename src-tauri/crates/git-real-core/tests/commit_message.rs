use git_real_core::commit::message::{join, split};
use git_real_core::{CommitConfig, CommitMessage, CommitOutcome, GitError, SigningFormat};

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.to_string(),
        body: body.to_string(),
    }
}

// --- split ---

#[test]
fn split_single_line_has_empty_body() {
    assert_eq!(split("initial commit\n"), msg("initial commit", ""));
}

#[test]
fn split_takes_first_line_as_subject_and_rest_as_body() {
    let m = split("Fix the thing\n\nIt was broken.\nNow it is not.\n");
    assert_eq!(m, msg("Fix the thing", "It was broken.\nNow it is not."));
}

#[test]
fn split_drops_leading_blank_lines_of_body_but_keeps_inner_ones() {
    let m = split("Subject\n\n\n  \nPara one\n\nPara two\n");
    assert_eq!(m.body, "Para one\n\nPara two");
}

#[test]
fn split_trims_subject_and_handles_crlf() {
    let m = split("  Subject with spaces  \r\n\r\nBody line\r\n");
    assert_eq!(m.subject, "Subject with spaces");
    assert_eq!(m.body, "Body line");
}

#[test]
fn split_keeps_hash_lines_in_body() {
    let m = split("Subject\n\n# not a comment\nreal line\n");
    assert_eq!(m.body, "# not a comment\nreal line");
}

#[test]
fn split_empty_string_is_empty_message() {
    assert_eq!(split(""), msg("", ""));
}

#[test]
fn split_multi_line_first_paragraph_puts_second_line_in_body() {
    // Git's subject is the first paragraph; the UI subject is one line.
    let m = split("Line one\nLine two\n\nBody\n");
    assert_eq!(m.subject, "Line one");
    assert_eq!(m.body, "Line two\n\nBody");
}

// --- join ---

#[test]
fn join_subject_only_ends_with_single_newline() {
    assert_eq!(join(&msg("Subject", "")), "Subject\n");
}

#[test]
fn join_whitespace_only_body_counts_as_empty() {
    assert_eq!(join(&msg("Subject", "  \n\n")), "Subject\n");
}

#[test]
fn join_separates_subject_and_body_with_blank_line() {
    assert_eq!(join(&msg("Subject", "Body")), "Subject\n\nBody\n");
}

#[test]
fn join_flattens_newlines_in_subject() {
    assert_eq!(
        join(&msg("Line one\nLine two\r\nThree", "")),
        "Line one Line two Three\n"
    );
}

#[test]
fn join_trims_subject() {
    assert_eq!(join(&msg("  Subject  ", "")), "Subject\n");
}

#[test]
fn join_trims_body_edges_and_normalises_crlf() {
    assert_eq!(
        join(&msg("S", "\n\nfirst\r\nsecond  \n\n")),
        "S\n\nfirst\nsecond\n"
    );
}

#[test]
fn join_keeps_hash_lines_and_inner_blank_lines() {
    assert_eq!(join(&msg("S", "# kept\n\nnext")), "S\n\n# kept\n\nnext\n");
}

#[test]
fn join_then_split_round_trips() {
    let original = msg("Subject", "Para one\n\nPara two");
    assert_eq!(split(&join(&original)), original);
}

#[test]
fn join_blank_subject_keeps_body_after_blank_lines() {
    // The caller (Task 2) treats this as EmptyMessage; join itself stays total.
    assert_eq!(join(&msg("   ", "body")), "\n\nbody\n");
}

// --- serde shapes ---

#[test]
fn commit_message_serializes_camel_case() {
    let json = serde_json::to_value(msg("s", "b")).unwrap();
    assert_eq!(json, serde_json::json!({ "subject": "s", "body": "b" }));
    let back: CommitMessage = serde_json::from_value(json).unwrap();
    assert_eq!(back, msg("s", "b"));
}

#[test]
fn signing_format_serializes_as_spec_names() {
    assert_eq!(
        serde_json::to_value(SigningFormat::OpenPgp).unwrap(),
        "openPgp"
    );
    assert_eq!(serde_json::to_value(SigningFormat::X509).unwrap(), "x509");
    assert_eq!(serde_json::to_value(SigningFormat::Ssh).unwrap(), "ssh");
}

#[test]
fn commit_config_serializes_with_nulls() {
    let cfg = CommitConfig {
        name: None,
        email: Some("a@b.c".into()),
        signing: Some(SigningFormat::Ssh),
    };
    assert_eq!(
        serde_json::to_value(cfg).unwrap(),
        serde_json::json!({ "name": null, "email": "a@b.c", "signing": "ssh" })
    );
}

#[test]
fn commit_outcome_serializes_camel_case() {
    let out = CommitOutcome {
        oid: "abc".into(),
        summary: "s".into(),
    };
    assert_eq!(
        serde_json::to_value(out).unwrap(),
        serde_json::json!({ "oid": "abc", "summary": "s" })
    );
}

// --- errors ---

#[test]
fn new_error_variants_have_messages() {
    assert_eq!(
        GitError::EmptyMessage.to_string(),
        "the commit message has no subject"
    );
    assert_eq!(
        GitError::NothingToCommit.to_string(),
        "nothing is staged to commit"
    );
    let failed = GitError::CommitFailed {
        code: Some(1),
        stdout: String::new(),
        stderr: "hook says no".into(),
    };
    assert_eq!(
        failed.to_string(),
        "git commit failed (exit code Some(1)): hook says no"
    );
}
