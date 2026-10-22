//! The inline credential helper through real `git credential fill` (GR-12):
//! the exact `-c` arguments `auth::apply` adds, in a scratch HOME with no
//! system or global config, so the developer's own helpers never answer.

mod common;

use std::io::Write;
use std::process::{Output, Stdio};

use git_real_core::git_cli;
use git_real_core::remote::auth::{self, Credentials};

/// `git [-c extra]... [auth] credential fill` for `url`.
fn fill(creds: &Credentials, extra: &[&str], url: &str) -> Output {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = git_cli::command(&git_cli::locate().unwrap());
    cmd.current_dir(home.path())
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.path().join("none"))
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS");
    for c in extra {
        cmd.arg("-c").arg(c);
    }
    auth::apply(&mut cmd, Some(creds));
    cmd.args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("url={url}\n\n").as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn inline_helper_passes_backslashes_quotes_and_dollars_through_real_git() {
    if !common::git_available() {
        return;
    }
    let token = r#"a\b$c'd %s "e"#;
    let creds = Credentials::new("https://example.test", "al ice", token).unwrap();
    let out = fill(&creds, &[], "https://example.test/me/x.git");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("username=al ice\n"), "{stdout}");
    assert!(stdout.contains(&format!("password={token}\n")), "{stdout}");
}

#[test]
fn inline_helper_does_not_answer_another_origin() {
    if !common::git_available() {
        return;
    }
    let creds = Credentials::new("https://example.test", "me", "TOKEN-123").unwrap();
    let out = fill(&creds, &[], "https://other.test/me/x.git");
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("TOKEN-123"));
}

#[test]
fn inline_helper_replaces_a_configured_helper_for_its_origin() {
    if !common::git_available() {
        return;
    }
    let creds = Credentials::new("https://example.test", "me", "fresh").unwrap();
    let stale = "credential.helper=!f() { echo username=old; echo password=stale; }; f";
    let stdout =
        String::from_utf8(fill(&creds, &[stale], "https://example.test/me/x.git").stdout).unwrap();
    assert!(
        stdout.contains("password=fresh\n") && !stdout.contains("stale"),
        "{stdout}"
    );
}

#[test]
fn inline_helper_matches_a_url_with_a_port_and_a_username() {
    if !common::git_available() {
        return;
    }
    let creds = Credentials::new("http://127.0.0.1:8080", "me", "tok").unwrap();
    let stdout =
        String::from_utf8(fill(&creds, &[], "http://bob@127.0.0.1:8080/r.git").stdout).unwrap();
    assert!(stdout.contains("password=tok\n"), "{stdout}");
}
