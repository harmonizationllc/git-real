//! Pure GR-12 network helpers: stderr classification against samples of real
//! git output, the origin parsed from git's own `fatal:` line, credential
//! validation and redaction, and the arguments `auth::apply` adds.

use std::ffi::OsStr;
use std::process::Command;

use git_real_core::remote::auth::{self, Credentials, HELPER, origin_of};
use git_real_core::remote::classify::{auth_origin, classify};
use git_real_core::{GitError, NetworkErrorKind as K};

const TOKEN: &str = "TOPSECRET-123";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("fixtures/network_stderr/", $name))
    };
}

#[test]
fn classifies_every_fixture() {
    let cases = [
        (fixture!("https_username_prompt.txt"), K::HttpsAuthRequired),
        (fixture!("https_password_prompt.txt"), K::HttpsAuthRequired),
        (fixture!("https_auth_failed.txt"), K::HttpsAuthRejected),
        (fixture!("https_403.txt"), K::HttpsAuthRejected),
        (fixture!("ssh_publickey.txt"), K::SshAuthFailed),
        (fixture!("ssh_host_key.txt"), K::HostKeyUnverified),
        (fixture!("https_dns.txt"), K::HostUnreachable),
        (fixture!("ssh_dns.txt"), K::HostUnreachable),
        (fixture!("http_refused.txt"), K::HostUnreachable),
        (fixture!("ssh_refused.txt"), K::HostUnreachable),
        (fixture!("ssh_timeout.txt"), K::HostUnreachable),
        (fixture!("local_not_a_repo.txt"), K::RepoNotFound),
        (fixture!("https_404.txt"), K::RepoNotFound),
        (fixture!("github_repo_not_found.txt"), K::RepoNotFound),
        (fixture!("fetch_all_partial.txt"), K::RepoNotFound),
        (
            fixture!("push_fetch_first.txt"),
            K::PushRejectedNonFastForward,
        ),
        (
            fixture!("push_non_fast_forward.txt"),
            K::PushRejectedNonFastForward,
        ),
        (fixture!("push_stale_info.txt"), K::LeaseStale),
        (fixture!("push_tag_exists.txt"), K::Other),
        (fixture!("remote_ref_missing.txt"), K::Other),
    ];
    for (stderr, want) in cases {
        assert_eq!(classify(stderr), want, "{stderr}");
    }
}

#[test]
fn classify_is_other_for_empty_and_unknown_output() {
    assert_eq!(classify(""), K::Other);
    assert_eq!(
        classify("error: src refspec nope does not match any\n"),
        K::Other
    );
}

#[test]
fn classify_takes_the_first_matching_kind() {
    let auth_and_dns = "fatal: could not read Username for 'https://h': terminal prompts disabled\nCould not resolve host: h\n";
    assert_eq!(classify(auth_and_dns), K::HttpsAuthRequired);
    let rejected_and_refused = " ! [rejected]        main -> main (fetch first)\nssh: connect to host h port 22: Connection refused\n";
    assert_eq!(classify(rejected_and_refused), K::HostUnreachable);
}

#[test]
fn a_reason_without_a_rejection_is_other() {
    assert_eq!(classify("(stale info)\n"), K::Other);
    assert_eq!(classify("(fetch first)\n"), K::Other);
}

#[test]
fn auth_origin_reads_git_s_fatal_line() {
    assert_eq!(
        auth_origin(fixture!("https_username_prompt.txt")).as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        auth_origin(fixture!("https_password_prompt.txt")).as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        auth_origin(fixture!("https_auth_failed.txt")).as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        auth_origin(fixture!("https_403.txt")).as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        auth_origin("fatal: could not read Username for 'http://127.0.0.1:18431': terminal prompts disabled\n").as_deref(),
        Some("http://127.0.0.1:18431")
    );
}

#[test]
fn auth_origin_ignores_server_lines_and_non_http_output() {
    assert_eq!(
        auth_origin("remote: fatal: could not read Username for 'https://evil.test': x\n"),
        None
    );
    assert_eq!(auth_origin(fixture!("ssh_publickey.txt")), None);
    assert_eq!(auth_origin(fixture!("local_not_a_repo.txt")), None);
    assert_eq!(
        auth_origin("fatal: Authentication failed for 'https://bad host/x'\n"),
        None
    );
}

#[test]
fn origin_of_keeps_scheme_host_and_port_only() {
    assert_eq!(
        origin_of("https://me:pw@github.com/me/x.git").as_deref(),
        Some("https://github.com")
    );
    assert_eq!(
        origin_of("HTTP://127.0.0.1:8080/r.git").as_deref(),
        Some("http://127.0.0.1:8080")
    );
    assert_eq!(
        origin_of("https://[::1]:8443/r").as_deref(),
        Some("https://[::1]:8443")
    );
    for url in [
        "ssh://git@github.com/x.git",
        "git@github.com:me/x.git",
        "/srv/bare.git",
        "file:///srv/x",
        "https://",
        "https://h:123456/x",
        "https://h_x/y",
    ] {
        assert_eq!(origin_of(url), None, "{url}");
    }
}

#[test]
fn credentials_accept_http_and_https_origins() {
    for origin in [
        "https://github.com",
        "http://127.0.0.1:8080",
        "https://[::1]:8443",
        "https://git.example-host.org",
    ] {
        let c = Credentials::new(origin, "me", TOKEN).unwrap();
        assert_eq!((c.origin(), c.username()), (origin, "me"));
    }
}

#[test]
fn credentials_refuse_other_origins_and_line_breaks() {
    let bad_origins = [
        "github.com",
        "ssh://github.com",
        "https://github.com/",
        "https://me@github.com",
        "https://h:123456",
        "HTTPS://h",
        "https://h\n",
        "https://h.helper=x",
        "https://",
    ];
    for origin in bad_origins {
        assert!(
            matches!(
                Credentials::new(origin, "me", TOKEN),
                Err(GitError::InvalidCredentials)
            ),
            "{origin:?}"
        );
    }
    for (user, token) in [
        ("", TOKEN),
        ("me", ""),
        ("m\ne", TOKEN),
        ("me", "a\rb"),
        ("me", "a\0b"),
        ("me", "a\nusername=evil"),
    ] {
        assert!(
            matches!(
                Credentials::new("https://h", user, token),
                Err(GitError::InvalidCredentials)
            ),
            "{user:?}"
        );
    }
}

#[test]
fn credentials_debug_redacts_the_token() {
    let c = Credentials::new("https://github.com", "me", TOKEN).unwrap();
    let text = format!("{c:?}");
    assert!(!text.contains(TOKEN), "{text}");
    assert!(
        text.contains(r#"token: "***""#)
            && text.contains("https://github.com")
            && text.contains(r#""me""#),
        "{text}"
    );
}

#[test]
fn credentials_deserialize_through_validation_without_echoing_the_token() {
    let ok: Credentials = serde_json::from_value(
        serde_json::json!({ "origin": "https://h", "username": "me", "token": TOKEN }),
    )
    .unwrap();
    assert_eq!(ok.origin(), "https://h");
    let err = serde_json::from_value::<Credentials>(
        serde_json::json!({ "origin": "ftp://h", "username": "me", "token": TOKEN }),
    )
    .unwrap_err();
    assert!(!err.to_string().contains(TOKEN), "{err}");
}

fn args(cmd: &Command) -> Vec<String> {
    cmd.get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn apply_scopes_the_helper_and_puts_secrets_only_in_the_environment() {
    let c = Credentials::new("https://github.com", "me", TOKEN).unwrap();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg("/w");
    auth::apply(&mut cmd, Some(&c));
    cmd.arg("fetch");
    let helper = format!("credential.https://github.com.helper={HELPER}");
    assert_eq!(
        args(&cmd),
        [
            "-C",
            "/w",
            "-c",
            "credential.https://github.com.helper=",
            "-c",
            helper.as_str(),
            "fetch"
        ]
    );
    assert!(!args(&cmd).iter().any(|a| a.contains(TOKEN)));
    let envs: Vec<_> = cmd.get_envs().collect();
    assert!(
        envs.contains(&(OsStr::new("GR_USERNAME"), Some(OsStr::new("me")))),
        "{envs:?}"
    );
    assert!(
        envs.contains(&(OsStr::new("GR_TOKEN"), Some(OsStr::new(TOKEN)))),
        "{envs:?}"
    );
}

// Architect R2: a user-set GIT_TRACE_CURL must not copy the Authorization
// header (the token in base64) into stderr and from there into an AppError.
#[test]
fn apply_pins_trace_redaction_when_credentials_are_present() {
    let c = Credentials::new("https://github.com", "me", TOKEN).unwrap();
    let mut cmd = Command::new("git");
    auth::apply(&mut cmd, Some(&c));
    let envs: Vec<_> = cmd.get_envs().collect();
    assert!(
        envs.contains(&(OsStr::new("GIT_TRACE_REDACT"), Some(OsStr::new("1")))),
        "{envs:?}"
    );
}

#[test]
fn apply_without_credentials_does_not_set_trace_redaction() {
    let mut cmd = Command::new("git");
    auth::apply(&mut cmd, None);
    assert!(
        cmd.get_envs()
            .all(|(k, _)| k != OsStr::new("GIT_TRACE_REDACT"))
    );
}

#[test]
fn apply_without_credentials_adds_nothing() {
    let mut cmd = Command::new("git");
    auth::apply(&mut cmd, None);
    assert!(args(&cmd).is_empty());
    assert_eq!(cmd.get_envs().count(), 0);
}

#[test]
fn the_helper_is_the_verified_printf_form() {
    assert_eq!(
        HELPER,
        r#"!f() { test "$1" = get || return 0; printf '%s\n' "username=$GR_USERNAME" "password=$GR_TOKEN"; }; f"#
    );
}

#[test]
fn origin_of_accepts_an_ipv6_literal_with_an_embedded_ipv4_dotted_quad() {
    assert_eq!(
        origin_of("https://[::ffff:1.2.3.4]:8443/r").as_deref(),
        Some("https://[::ffff:1.2.3.4]:8443")
    );
}

#[test]
fn origin_of_rejects_ipv6_literals_with_non_hex_characters() {
    assert_eq!(origin_of("https://[::g]/r"), None);
    assert_eq!(origin_of("https://[::1 ]/r"), None);
}

#[test]
fn auth_origin_skips_a_fatal_line_with_an_unterminated_quote() {
    assert_eq!(
        auth_origin(
            "fatal: could not read Username for 'https://broken.test\n\
             fatal: Authentication failed for 'https://good.test/x'\n"
        )
        .as_deref(),
        Some("https://good.test")
    );
}

#[test]
fn origin_of_rejects_an_ipv6_literal_without_a_closing_bracket() {
    assert_eq!(origin_of("https://[::1/r"), None);
}
