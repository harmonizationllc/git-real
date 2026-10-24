//! Branch-level coverage for the GR-13a hosting domain: status mapping and token redaction in
//! every message path, timestamp edge cases, URL detection rejections, host validation, and the
//! optional or missing JSON fields of each provider.

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::http::parse_timestamp;
use git_real_core::hosting::provider::{detect, https_host, validate_host};
use git_real_core::hosting::{
    self, Account, CheckoutPlan, CiState, Provider as P, PullRequest, RepoRef, Response, Token,
    UserInfo,
};
use git_real_core::remote::auth::Credentials;

const SECRET: &str = "ghp_TOPSECRET123";

fn token() -> Token {
    Token::new(SECRET).unwrap()
}
fn repo(provider: P, host: &str, namespace: &str, name: &str) -> RepoRef {
    RepoRef {
        provider,
        host: host.into(),
        namespace: namespace.into(),
        name: name.into(),
    }
}
fn user(t: &FakeTransport) -> Result<UserInfo, GitError> {
    hosting::current_user(t, P::GitHub, "github.com", &token())
}
fn rejected_message(body: &str) -> String {
    match user(&FakeTransport::new().reply(422, body)).unwrap_err() {
        GitError::HostingRejected { message } => message,
        other => panic!("{other:?}"),
    }
}
fn auth_message(body: &str) -> String {
    match user(&FakeTransport::new().reply(401, body)).unwrap_err() {
        GitError::HostingAuth { message } => message,
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------- Token and Response

#[test]
fn token_length_limit_counts_bytes_not_characters() {
    // 2049 two-byte characters are 4098 bytes.
    assert!(matches!(
        Token::new(&"é".repeat(2049)),
        Err(GitError::InvalidToken)
    ));
    assert_eq!(
        Token::new(&"é".repeat(2048)).unwrap().expose_secret().len(),
        4096
    );
    // Spaces and tabs are legal inside a token; only CR, LF and NUL are not.
    assert!(Token::new("a b\tc").is_ok());
}

#[test]
fn response_header_is_case_insensitive_and_returns_the_first_match() {
    let resp = Response {
        status: 200,
        headers: vec![
            ("X-RateLimit-Remaining".into(), "first".into()),
            ("x-ratelimit-remaining".into(), "second".into()),
        ],
        body: String::new(),
    };
    assert_eq!(resp.header("x-ratelimit-remaining"), Some("first"));
    assert_eq!(resp.header("X-RATELIMIT-REMAINING"), Some("first"));
    assert_eq!(resp.header("missing"), None);
}

// ---------------------------------------------------------------- parse_timestamp

#[test]
fn parse_timestamp_applies_negative_offsets() {
    assert_eq!(
        parse_timestamp("2026-10-20T07:00:00-05:00"),
        Some(1792497600)
    );
}

#[test]
fn parse_timestamp_refuses_every_malformed_part() {
    for bad in [
        "2026-10-20T12:00:00.Z",         // a dot with no digits
        "2026-10-20T12:00:00.",          // ... and nothing after
        "2026-10-20T12:00:00z",          // lower-case zulu
        "2026-10-20T12:00:00+0200",      // offset without a colon
        "2026-10-20T12:00:00+2:00",      // short offset
        "2026-10-20T12:00:00+24:00",     // hour out of range
        "2026-10-20T12:00:00+02:60",     // minute out of range
        "2026-10-20T12:00:00Zjunk",      // trailing junk
        "2026-10-20T12:00:00 +02:00",    // space before the offset
        "2026-00-20T12:00:00Z",          // month 0
        "2026-10-00T12:00:00Z",          // day 0
        "2026-10-32T12:00:00Z",          // day 32
        "2026-10-20T24:00:00Z",          // hour 24
        "2026-10-20T12:60:00Z",          // minute 60
        "2026-10-20T12:00:60Z",          // second 60
        "2026-10-20T12:00:0xZ",          // non-digit second
        "20x6-10-20T12:00:00Z",          // non-digit year
        "2026/10/20T12:00:00Z",          // wrong separators
        "2026-10-20t12:00:00Z",          // lower-case T
        "2026-10-20T12-00-00Z",          // wrong time separators
        "2026-10-20T12:00:00.12x+00:00", // fraction with a letter
    ] {
        assert_eq!(parse_timestamp(bad), None, "{bad:?}");
    }
}

#[test]
fn parse_timestamp_boundaries_of_a_valid_value() {
    assert_eq!(parse_timestamp("2026-12-31T23:59:59Z"), Some(1798761599));
    assert_eq!(parse_timestamp("2026-01-01T00:00:00Z"), Some(1767225600));
    assert_eq!(parse_timestamp("1969-12-31T23:59:59Z"), Some(-1));
    // A one-digit fraction and a long one parse the same second.
    assert_eq!(
        parse_timestamp("2026-10-20T12:00:00.5Z"),
        parse_timestamp("2026-10-20T12:00:00.123456789Z")
    );
    // The largest offset still in range.
    assert_eq!(
        parse_timestamp("2026-10-20T12:00:00+23:59"),
        Some(1792497600 - (23 * 3600 + 59 * 60))
    );
}

// ---------------------------------------------------------------- status mapping

#[test]
fn a_403_without_a_zero_remaining_count_is_an_auth_error() {
    let with_budget = FakeTransport::new().reply_with(
        403,
        &[("X-RateLimit-Remaining", "4999")],
        r#"{"message":"Resource not accessible"}"#,
    );
    assert!(matches!(
        user(&with_budget).unwrap_err(),
        GitError::HostingAuth { ref message } if message == "Resource not accessible"
    ));
}

#[test]
fn a_401_with_a_zero_remaining_count_is_still_an_auth_error() {
    let t = FakeTransport::new().reply_with(
        401,
        &[("X-RateLimit-Remaining", "0")],
        r#"{"message":"Bad credentials"}"#,
    );
    assert!(matches!(
        user(&t).unwrap_err(),
        GitError::HostingAuth { .. }
    ));
}

#[test]
fn rate_limit_reset_prefers_x_ratelimit_reset_and_skips_unparsable_values() {
    let both = FakeTransport::new().reply_with(
        429,
        &[("RateLimit-Reset", "222"), ("X-RateLimit-Reset", "111")],
        "{}",
    );
    assert!(matches!(
        user(&both).unwrap_err(),
        GitError::HostingRateLimited {
            reset_epoch: Some(111)
        }
    ));
    let garbage_first = FakeTransport::new().reply_with(
        429,
        &[("X-RateLimit-Reset", "soon"), ("RateLimit-Reset", " 333 ")],
        "{}",
    );
    assert!(matches!(
        user(&garbage_first).unwrap_err(),
        GitError::HostingRateLimited {
            reset_epoch: Some(333)
        }
    ));
    let all_garbage = FakeTransport::new().reply_with(
        429,
        &[("X-RateLimit-Reset", "-1"), ("Retry-After", "Wed, 21 Oct")],
        "{}",
    );
    assert!(matches!(
        user(&all_garbage).unwrap_err(),
        GitError::HostingRateLimited { reset_epoch: None }
    ));
}

#[test]
fn status_boundaries_between_success_client_and_server_errors() {
    for status in [200, 201, 299] {
        let ok = user(&FakeTransport::new().reply(status, r#"{"login":"octo"}"#));
        assert_eq!(ok.unwrap().username, "octo", "{status}");
    }
    // 204 has no JSON body: not the expected shape.
    assert!(matches!(
        user(&FakeTransport::new().reply(204, "")).unwrap_err(),
        GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com"
    ));
    assert!(matches!(
        user(&FakeTransport::new().reply(499, "{}")).unwrap_err(),
        GitError::HostingRejected { ref message } if message == "HTTP 499"
    ));
    assert!(matches!(
        user(&FakeTransport::new().reply(500, "{}")).unwrap_err(),
        GitError::HostingUnreachable { ref message } if message == "HTTP 500"
    ));
    assert!(matches!(
        user(&FakeTransport::new().reply(599, "{}")).unwrap_err(),
        GitError::HostingUnreachable { ref message } if message == "HTTP 599"
    ));
    assert!(matches!(
        user(&FakeTransport::new().reply(600, "{}")).unwrap_err(),
        GitError::HostingRejected { ref message } if message == "HTTP 600"
    ));
    assert!(matches!(
        user(&FakeTransport::new().reply(199, "{}")).unwrap_err(),
        GitError::HostingRejected { ref message } if message == "HTTP 199"
    ));
}

#[test]
fn a_server_error_never_quotes_its_body() {
    let echo = format!(r#"{{"message":"boom for {SECRET}"}}"#);
    let err = user(&FakeTransport::new().reply(500, &echo)).unwrap_err();
    assert!(!format!("{err:?}{err}").contains(SECRET), "{err:?}");
}

#[test]
fn a_404_does_not_quote_the_body_either() {
    let echo = format!(r#"{{"message":"no {SECRET}"}}"#);
    let err = user(&FakeTransport::new().reply(404, &echo)).unwrap_err();
    assert!(matches!(err, GitError::HostingNotFound));
}

// ---------------------------------------------------------------- message extraction

#[test]
fn message_field_order_is_message_then_error_then_error_message() {
    assert_eq!(
        rejected_message(r#"{"message":"m","error":"e","error":"e2"}"#),
        "m"
    );
    assert_eq!(
        rejected_message(r#"{"message":"m","error":{"message":"nested"}}"#),
        "m"
    );
    assert_eq!(rejected_message(r#"{"error":"e","other":"x"}"#), "e");
    assert_eq!(
        rejected_message(r#"{"error":{"message":"nested"}}"#),
        "nested"
    );
}

#[test]
fn a_message_that_is_not_a_string_falls_back_to_the_status() {
    for body in [
        r#"{"message":42}"#,
        r#"{"message":null,"error":null}"#,
        r#"{"message":[1]}"#,
        r#"{"error":{"message":7}}"#,
        r#"{"error":{}}"#,
        r#"["message"]"#,
        r#""just a string""#,
        "{}",
        "",
        "<html>boom</html>",
    ] {
        assert_eq!(rejected_message(body), "HTTP 422", "{body:?}");
    }
}

#[test]
fn a_non_string_message_falls_through_to_a_later_string_field() {
    assert_eq!(
        rejected_message(r#"{"message":42,"error":"fallback"}"#),
        "fallback"
    );
}

// ---------------------------------------------------------------- redaction and the cut

#[test]
fn the_token_is_redacted_in_every_field_the_message_can_come_from() {
    let in_message = format!(r#"{{"message":"a {SECRET} b"}}"#);
    let in_error = format!(r#"{{"error":"a {SECRET} b"}}"#);
    let in_nested = format!(r#"{{"error":{{"message":"a {SECRET} b"}}}}"#);
    for body in [&in_message, &in_error, &in_nested] {
        // Both message-carrying statuses: 4xx rejected and 401 auth.
        assert_eq!(rejected_message(body), "a *** b", "{body}");
        assert_eq!(auth_message(body), "a *** b", "{body}");
    }
}

#[test]
fn every_occurrence_of_the_token_is_redacted() {
    let body = format!(r#"{{"message":"{SECRET} and {SECRET}, again {SECRET}"}}"#);
    let message = rejected_message(&body);
    assert_eq!(message, "*** and ***, again ***");
}

#[test]
fn a_token_that_straddles_the_200_char_cut_is_redacted_before_the_cut() {
    // The token starts at character 190, so a cut-then-replace would leak its first 10 chars.
    let body = format!(
        r#"{{"message":"{}{SECRET}{}"}}"#,
        "x".repeat(190),
        "y".repeat(100)
    );
    let message = rejected_message(&body);
    assert!(!message.contains("ghp_"), "{message}");
    assert!(message.contains("***"), "{message}");
    assert_eq!(message.chars().count(), 201);
    assert!(message.ends_with('…'));
}

#[test]
fn a_message_of_exactly_200_chars_is_not_cut_and_201_is() {
    let exact = rejected_message(&format!(r#"{{"message":"{}"}}"#, "x".repeat(200)));
    assert_eq!(exact.chars().count(), 200);
    assert!(!exact.ends_with('…'));
    let over = rejected_message(&format!(r#"{{"message":"{}"}}"#, "x".repeat(201)));
    assert_eq!(over.chars().count(), 201);
    assert!(over.ends_with('…'));
}

#[test]
fn the_cut_counts_characters_not_bytes() {
    // 300 four-byte characters: a byte-based cut would panic or split a character.
    let message = rejected_message(&format!(r#"{{"message":"{}"}}"#, "😀".repeat(300)));
    assert_eq!(message.chars().count(), 201);
    assert!(message.starts_with(&"😀".repeat(200)));
}

#[test]
fn redaction_uses_the_token_of_the_call_not_a_pattern() {
    // A different token in the body is the provider's own text and stays.
    let body = r#"{"message":"token ghp_OTHER is bad"}"#;
    assert_eq!(rejected_message(body), "token ghp_OTHER is bad");
}

// ---------------------------------------------------------------- every provider, every call

fn header<'a>(req: &'a hosting::Request, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn provider_repos() -> [RepoRef; 3] {
    [
        repo(P::GitHub, "github.com", "o", "r"),
        repo(P::GitLab, "gitlab.com", "g", "p"),
        repo(P::Bitbucket, "bitbucket.org", "ws", "r"),
    ]
}

#[test]
fn list_and_get_send_a_bearer_token_on_every_provider() {
    for r in provider_repos() {
        let list = FakeTransport::new().reply(200, r#"{"values":[]}"#);
        let list = if r.provider == P::Bitbucket {
            list
        } else {
            FakeTransport::new().reply(200, "[]")
        };
        hosting::list_pull_requests(&list, &r, &token(), 1).unwrap();
        let req = &list.requests()[0];
        assert_eq!(
            header(req, "authorization"),
            Some(format!("Bearer {SECRET}").as_str()),
            "{:?}",
            r.provider
        );
        let want_accept = if r.provider == P::GitHub {
            "application/vnd.github+json"
        } else {
            "application/json"
        };
        assert_eq!(header(req, "accept"), Some(want_accept));
        assert_eq!(
            header(req, "x-github-api-version").is_some(),
            r.provider == P::GitHub
        );

        // A 404 on the single read maps the same way on every provider.
        let gone = FakeTransport::new().reply(404, "{}");
        assert!(matches!(
            hosting::get_pull_request(&gone, &r, &token(), 3),
            Err(GitError::HostingNotFound)
        ));
        assert_eq!(
            header(&gone.requests()[0], "authorization"),
            Some(format!("Bearer {SECRET}").as_str())
        );
    }
}

#[test]
fn list_errors_are_mapped_and_redacted_on_every_provider() {
    let echo = format!(r#"{{"message":"bad token {SECRET}"}}"#);
    for r in provider_repos() {
        let err =
            hosting::list_pull_requests(&FakeTransport::new().reply(401, &echo), &r, &token(), 1)
                .unwrap_err();
        assert!(
            matches!(err, GitError::HostingAuth { ref message } if message == "bad token ***"),
            "{:?}: {err:?}",
            r.provider
        );
        let err =
            hosting::get_pull_request(&FakeTransport::new().reply(422, &echo), &r, &token(), 1)
                .unwrap_err();
        assert!(
            matches!(err, GitError::HostingRejected { ref message } if message == "bad token ***"),
            "{:?}: {err:?}",
            r.provider
        );
        let down = FakeTransport::new().fail(GitError::HostingUnreachable {
            message: "dns".into(),
        });
        assert!(matches!(
            hosting::list_pull_requests(&down, &r, &token(), 1),
            Err(GitError::HostingUnreachable { ref message }) if message == "dns"
        ));
        let rate = FakeTransport::new().reply_with(429, &[("Retry-After", "1")], "{}");
        assert!(matches!(
            hosting::get_pull_request(&rate, &r, &token(), 1),
            Err(GitError::HostingRateLimited {
                reset_epoch: Some(_)
            })
        ));
    }
}

#[test]
fn current_user_errors_are_mapped_on_gitlab_and_bitbucket() {
    for (p, host) in [(P::GitLab, "gl.corp"), (P::Bitbucket, "bitbucket.org")] {
        let err = hosting::current_user(
            &FakeTransport::new().reply(401, &format!(r#"{{"message":"{SECRET}"}}"#)),
            p,
            host,
            &token(),
        )
        .unwrap_err();
        assert!(
            matches!(err, GitError::HostingAuth { ref message } if message == "***"),
            "{p:?}: {err:?}"
        );
        let garbage =
            hosting::current_user(&FakeTransport::new().reply(200, "[]"), p, host, &token())
                .unwrap_err();
        assert!(
            matches!(garbage, GitError::HostingUnreachable { ref message } if *message == format!("unexpected response from {host}")),
            "{p:?}: {garbage:?}"
        );
    }
}

#[test]
fn empty_lists_are_empty() {
    let gh = FakeTransport::new().reply(200, "[]");
    assert!(
        hosting::list_pull_requests(&gh, &repo(P::GitHub, "github.com", "o", "r"), &token(), 1)
            .unwrap()
            .is_empty()
    );
    let bb = FakeTransport::new().reply(200, r#"{"values":[],"next":"https://x"}"#);
    assert!(
        hosting::list_pull_requests(
            &bb,
            &repo(P::Bitbucket, "bitbucket.org", "ws", "r"),
            &token(),
            2
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn path_segments_are_percent_encoded_in_provider_urls() {
    let t = FakeTransport::new().reply(200, "[]");
    hosting::list_pull_requests(
        &t,
        &repo(P::GitHub, "github.com", "a b", "r?x#é/y"),
        &token(),
        1,
    )
    .unwrap();
    assert!(
        t.requests()[0]
            .url
            .starts_with("https://api.github.com/repos/a%20b/r%3Fx%23%C3%A9%2Fy/pulls?"),
        "{}",
        t.requests()[0].url
    );
    let t = FakeTransport::new().reply(200, "[]");
    hosting::list_pull_requests(&t, &repo(P::GitLab, "gitlab.com", "g", "p%2e"), &token(), 1)
        .unwrap();
    assert!(
        t.requests()[0]
            .url
            .contains("/projects/g%2Fp%252e/merge_requests?"),
        "{}",
        t.requests()[0].url
    );
    // Unreserved characters stay as they are.
    let t = FakeTransport::new().reply(200, r#"{"values":[]}"#);
    hosting::list_pull_requests(
        &t,
        &repo(P::Bitbucket, "bitbucket.org", "A-b_c.d~e", "R9"),
        &token(),
        1,
    )
    .unwrap();
    assert!(
        t.requests()[0]
            .url
            .contains("/repositories/A-b_c.d~e/R9/pullrequests?")
    );
}

// ---------------------------------------------------------------- GitHub JSON

const GH_BASE: &str = r#""number":1,"title":"t","user":{"login":"a"},"updated_at":"2026-10-20T12:00:00Z","html_url":"https://github.com/o/r/pull/1""#;

fn gh_pr(head: &str, base_repo: &str, extra: &str) -> PullRequest {
    let body = format!(
        r#"[{{{GH_BASE},"head":{head},"base":{{"ref":"main","repo":{base_repo}}}{extra}}}]"#
    );
    hosting::list_pull_requests(
        &FakeTransport::new().reply(200, &body),
        &repo(P::GitHub, "github.com", "o", "r"),
        &token(),
        1,
    )
    .unwrap()
    .remove(0)
}

#[test]
fn github_clone_url_only_survives_for_a_fork_and_only_over_https() {
    let base = r#"{"full_name":"o/r"}"#;
    let fork = |clone: &str| {
        gh_pr(
            &format!(r#"{{"ref":"x","repo":{{"full_name":"bob/r"{clone}}}}}"#),
            base,
            "",
        )
    };
    let https = fork(r#","clone_url":"https://github.com/bob/r.git""#);
    assert!(https.from_fork);
    assert_eq!(
        https.fork_clone_url.as_deref(),
        Some("https://github.com/bob/r.git")
    );
    for url in [
        r#","clone_url":"git://github.com/bob/r.git""#,
        r#","clone_url":"http://github.com/bob/r.git""#,
        r#","clone_url":"git@github.com:bob/r.git""#,
        r#","clone_url":"""#,
        r#","clone_url":null"#,
        "",
    ] {
        let pr = fork(url);
        assert!(pr.from_fork && pr.fork_clone_url.is_none(), "{url}");
    }
    // Same repository: not a fork, and the URL is dropped even when present.
    let same = gh_pr(
        r#"{"ref":"x","repo":{"full_name":"o/r","clone_url":"https://github.com/o/r.git"}}"#,
        base,
        "",
    );
    assert!(!same.from_fork && same.fork_clone_url.is_none());
}

#[test]
fn github_draft_is_read_when_present_and_false_when_absent_or_null() {
    let head = r#"{"ref":"x","repo":{"full_name":"o/r"}}"#;
    let base = r#"{"full_name":"o/r"}"#;
    assert!(gh_pr(head, base, r#","draft":true"#).draft);
    assert!(!gh_pr(head, base, r#","draft":false"#).draft);
    assert!(!gh_pr(head, base, r#","draft":null"#).draft);
    assert!(!gh_pr(head, base, "").draft);
}

#[test]
fn github_current_user_with_missing_optional_fields() {
    let t = FakeTransport::new().reply(200, r#"{"login":"octo"}"#);
    assert_eq!(
        user(&t).unwrap(),
        UserInfo {
            username: "octo".into(),
            display_name: None,
            avatar_url: None
        }
    );
    let t = FakeTransport::new().reply(200, r#"{"name":"No Login"}"#);
    assert!(matches!(
        user(&t).unwrap_err(),
        GitError::HostingUnreachable { .. }
    ));
}

#[test]
fn github_required_fields_and_bad_timestamps_are_unexpected_responses() {
    let ok_head = r#"{"ref":"x","repo":{"full_name":"o/r"}}"#;
    let bad_time = format!(
        r#"[{{"number":1,"title":"t","user":{{"login":"a"}},"updated_at":"yesterday","html_url":"u","head":{ok_head},"base":{{"ref":"main","repo":{{"full_name":"o/r"}}}}}}]"#
    );
    // The base repository is required, the head repository is not.
    let no_base_repo = format!(r#"[{{{GH_BASE},"head":{ok_head},"base":{{"ref":"main"}}}}]"#);
    let no_user = format!(
        r#"[{{"number":1,"title":"t","updated_at":"2026-10-20T12:00:00Z","html_url":"u","head":{ok_head},"base":{{"ref":"main","repo":{{"full_name":"o/r"}}}}}}]"#
    );
    for body in [bad_time, no_base_repo, no_user] {
        let err = hosting::list_pull_requests(
            &FakeTransport::new().reply(200, &body),
            &repo(P::GitHub, "ghe.corp", "o", "r"),
            &token(),
            1,
        )
        .unwrap_err();
        assert!(
            matches!(err, GitError::HostingUnreachable { ref message } if message == "unexpected response from ghe.corp"),
            "{body}: {err:?}"
        );
    }
    // An object where a list is expected.
    assert!(matches!(
        hosting::list_pull_requests(
            &FakeTransport::new().reply(200, "{}"),
            &repo(P::GitHub, "github.com", "o", "r"),
            &token(),
            1
        ),
        Err(GitError::HostingUnreachable { .. })
    ));
}

#[test]
fn one_bad_item_fails_the_whole_page() {
    let body = format!(
        r#"[{{{GH_BASE},"head":{{"ref":"x","repo":null}},"base":{{"ref":"main","repo":{{"full_name":"o/r"}}}}}},{{"number":2}}]"#
    );
    assert!(
        hosting::list_pull_requests(
            &FakeTransport::new().reply(200, &body),
            &repo(P::GitHub, "github.com", "o", "r"),
            &token(),
            1
        )
        .is_err()
    );
}

// ---------------------------------------------------------------- GitLab JSON

fn gl_mr(extra: &str, source: u64, target: u64) -> String {
    format!(
        r#"{{"iid":3,"title":"t","author":{{"username":"a"}},"source_branch":"x","target_branch":"main","source_project_id":{source},"target_project_id":{target},"updated_at":"2026-10-20T12:00:00Z","web_url":"https://gl/-/merge_requests/3"{extra}}}"#
    )
}

#[test]
fn gitlab_draft_and_fork_flags() {
    let r = repo(P::GitLab, "gitlab.com", "g", "p");
    let get = |body: String| {
        hosting::get_pull_request(&FakeTransport::new().reply(200, &body), &r, &token(), 3).unwrap()
    };
    assert!(!get(gl_mr("", 1, 1)).draft);
    assert!(!get(gl_mr(r#","draft":null"#, 1, 1)).draft);
    assert!(get(gl_mr(r#","draft":true"#, 1, 1)).draft);
    let same = get(gl_mr("", 5, 5));
    assert!(!same.from_fork);
    let fork = get(gl_mr("", 6, 5));
    assert!(fork.from_fork && fork.fork_clone_url.is_none());
    // The reverse is also "different".
    assert!(get(gl_mr("", 5, 6)).from_fork);
}

#[test]
fn gitlab_current_user_without_optional_fields_and_missing_username() {
    let t = FakeTransport::new().reply(200, r#"{"username":"octo"}"#);
    assert_eq!(
        hosting::current_user(&t, P::GitLab, "gitlab.com", &token()).unwrap(),
        UserInfo {
            username: "octo".into(),
            display_name: None,
            avatar_url: None
        }
    );
    let t = FakeTransport::new().reply(200, r#"{"name":"x"}"#);
    assert!(hosting::current_user(&t, P::GitLab, "gitlab.com", &token()).is_err());
}

#[test]
fn gitlab_self_managed_host_shapes_the_api_url_and_error_text() {
    let t = FakeTransport::new().reply(200, "<html>");
    let err = hosting::get_pull_request(
        &t,
        &repo(P::GitLab, "git.corp:8443", "a/b", "c"),
        &token(),
        9,
    )
    .unwrap_err();
    assert_eq!(
        t.requests()[0].url,
        "https://git.corp:8443/api/v4/projects/a%2Fb%2Fc/merge_requests/9"
    );
    assert!(
        matches!(err, GitError::HostingUnreachable { ref message } if message == "unexpected response from git.corp:8443")
    );
}

#[test]
fn gitlab_missing_required_fields_are_unexpected() {
    let r = repo(P::GitLab, "gitlab.com", "g", "p");
    for body in [
        r#"{"iid":3}"#.to_owned(),
        gl_mr("", 1, 1).replace(r#""source_project_id":1,"#, ""),
        gl_mr("", 1, 1).replace(r#""author":{"username":"a"},"#, ""),
        gl_mr("", 1, 1).replace("2026-10-20T12:00:00Z", "nope"),
    ] {
        assert!(
            matches!(
                hosting::get_pull_request(&FakeTransport::new().reply(200, &body), &r, &token(), 3),
                Err(GitError::HostingUnreachable { .. })
            ),
            "{body}"
        );
    }
}

// ---------------------------------------------------------------- Bitbucket JSON

fn bb_pr(source: &str, destination: &str, author: &str, extra: &str) -> String {
    format!(
        r#"{{"id":4,"title":"t","author":{author},"source":{source},"destination":{destination},"updated_on":"2026-10-20T12:00:00.123456+00:00","links":{{"html":{{"href":"https://bitbucket.org/ws/r/pull-requests/4"}}}}{extra}}}"#
    )
}
fn end(name: &str, full_name: Option<&str>) -> String {
    match full_name {
        Some(f) => {
            format!(r#"{{"branch":{{"name":"{name}"}},"repository":{{"full_name":"{f}"}}}}"#)
        }
        None => format!(r#"{{"branch":{{"name":"{name}"}},"repository":null}}"#),
    }
}
fn bb_get(body: &str) -> Result<PullRequest, GitError> {
    hosting::get_pull_request(
        &FakeTransport::new().reply(200, body),
        &repo(P::Bitbucket, "bitbucket.org", "ws", "r"),
        &token(),
        4,
    )
}

#[test]
fn bitbucket_fork_detection_and_clone_url() {
    let dest = end("main", Some("ws/r"));
    let same = bb_get(&bb_pr(&end("x", Some("ws/r")), &dest, "{}", "")).unwrap();
    assert!(!same.from_fork && same.fork_clone_url.is_none());

    let fork = bb_get(&bb_pr(&end("x", Some("bob/r.v2")), &dest, "{}", "")).unwrap();
    assert!(fork.from_fork);
    assert_eq!(
        fork.fork_clone_url.as_deref(),
        Some("https://bitbucket.org/bob/r.v2.git")
    );

    // A deleted fork is still a fork, but there is nothing to clone.
    let gone = bb_get(&bb_pr(&end("x", None), &dest, "{}", "")).unwrap();
    assert!(gone.from_fork && gone.fork_clone_url.is_none());
}

#[test]
fn bitbucket_clone_url_accepts_only_workspace_slash_slug() {
    let dest = end("main", Some("ws/r"));
    for name in [
        "a/b/c", "a/", "/b", "noslash", "a/b?x", "a/b#x", "a b/c", "a/b c", "a/b:c", "a@b/c",
        "é/c", "a\\b/c", "",
    ] {
        let pr = bb_get(&bb_pr(&end("x", Some(name)), &dest, "{}", "")).unwrap();
        assert!(
            pr.from_fork && pr.fork_clone_url.is_none(),
            "{name:?} -> {:?}",
            pr.fork_clone_url
        );
    }
    for name in ["a/b", "A.b_c-d/E.f_g-h", "9/9", "-x/y"] {
        let pr = bb_get(&bb_pr(&end("x", Some(name)), &dest, "{}", "")).unwrap();
        assert_eq!(
            pr.fork_clone_url,
            Some(format!("https://bitbucket.org/{name}.git")),
            "{name:?}"
        );
    }
}

#[test]
fn bitbucket_a_missing_destination_repository_is_unexpected() {
    let err = bb_get(&bb_pr(
        &end("x", Some("ws/r")),
        &end("main", None),
        "{}",
        "",
    ))
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { ref message } if message == "unexpected response from bitbucket.org")
    );
}

#[test]
fn bitbucket_author_prefers_nickname_then_display_name_then_empty() {
    let (s, d) = (end("x", Some("ws/r")), end("main", Some("ws/r")));
    let author = |a: &str| bb_get(&bb_pr(&s, &d, a, "")).unwrap().author;
    assert_eq!(
        author(r#"{"nickname":"nick","display_name":"Display"}"#),
        "nick"
    );
    assert_eq!(author(r#"{"display_name":"Display"}"#), "Display");
    assert_eq!(
        author(r#"{"nickname":null,"display_name":"Display"}"#),
        "Display"
    );
    assert_eq!(author("{}"), "");
}

#[test]
fn bitbucket_draft_updated_on_offset_and_web_url() {
    let (s, d) = (end("x", Some("ws/r")), end("main", Some("ws/r")));
    let pr = bb_get(&bb_pr(&s, &d, "{}", r#","draft":true"#)).unwrap();
    assert!(pr.draft);
    assert_eq!(pr.updated_at, 1792497600);
    assert_eq!(pr.web_url, "https://bitbucket.org/ws/r/pull-requests/4");
    assert_eq!(pr.ci_state, CiState::None);
    assert!(
        !bb_get(&bb_pr(&s, &d, "{}", r#","draft":null"#))
            .unwrap()
            .draft
    );
    assert!(!bb_get(&bb_pr(&s, &d, "{}", "")).unwrap().draft);
}

#[test]
fn bitbucket_required_fields_and_timestamps() {
    let (s, d) = (end("x", Some("ws/r")), end("main", Some("ws/r")));
    let good = bb_pr(&s, &d, "{}", "");
    for body in [
        good.replace("2026-10-20T12:00:00.123456+00:00", "never"),
        good.replace(
            r#""links":{"html":{"href":"https://bitbucket.org/ws/r/pull-requests/4"}}"#,
            r#""links":{}"#,
        ),
        good.replace(r#""id":4,"#, ""),
        r#"{"values":[{"id":1}]}"#.to_owned(),
    ] {
        assert!(
            matches!(bb_get(&body), Err(GitError::HostingUnreachable { .. })),
            "{body}"
        );
    }
    // The list wrapper itself is required.
    assert!(
        hosting::list_pull_requests(
            &FakeTransport::new().reply(200, "[]"),
            &repo(P::Bitbucket, "bitbucket.org", "ws", "r"),
            &token(),
            1
        )
        .is_err()
    );
}

#[test]
fn bitbucket_current_user_field_precedence_and_missing_pieces() {
    let get = |body: &str| {
        hosting::current_user(
            &FakeTransport::new().reply(200, body),
            P::Bitbucket,
            "bitbucket.org",
            &token(),
        )
    };
    assert_eq!(
        get(r#"{"username":"user","nickname":"nick"}"#)
            .unwrap()
            .username,
        "user"
    );
    assert_eq!(get(r#"{"nickname":"nick"}"#).unwrap().username, "nick");
    assert!(matches!(
        get(r#"{"display_name":"No Id"}"#),
        Err(GitError::HostingUnreachable { ref message }) if message == "unexpected response from bitbucket.org"
    ));
    for links in [
        r#""links":null"#,
        r#""links":{}"#,
        r#""links":{"avatar":null}"#,
        r#""links":{"avatar":{}}"#,
        r#""links":{"avatar":{"href":null}}"#,
    ] {
        let info = get(&format!(r#"{{"nickname":"n",{links}}}"#)).unwrap();
        assert_eq!(info.avatar_url, None, "{links}");
    }
    let info =
        get(r#"{"nickname":"n","display_name":"D","links":{"avatar":{"href":"https://a/b.png"}}}"#)
            .unwrap();
    assert_eq!(
        (info.display_name.as_deref(), info.avatar_url.as_deref()),
        (Some("D"), Some("https://a/b.png"))
    );
}

// ---------------------------------------------------------------- checkout_plan

fn pr(from_fork: bool, fork: Option<&str>, src: &str, n: u64) -> PullRequest {
    PullRequest {
        number: n,
        title: "t".into(),
        author: "a".into(),
        source_branch: src.into(),
        target_branch: "main".into(),
        from_fork,
        fork_clone_url: fork.map(Into::into),
        draft: false,
        ci_state: CiState::None,
        updated_at: 0,
        web_url: "https://h/x".into(),
    }
}

#[test]
fn checkout_plan_ignores_a_fork_url_on_github_and_gitlab() {
    for (p, refspec) in [
        (P::GitHub, "refs/pull/42/head"),
        (P::GitLab, "refs/merge-requests/42/head"),
    ] {
        assert_eq!(
            hosting::checkout_plan(p, &pr(true, Some("https://evil/x.git"), "main", 42)).unwrap(),
            CheckoutPlan::FetchHead {
                source: "origin".into(),
                refspec: refspec.into()
            }
        );
    }
}

#[test]
fn checkout_plan_tracks_the_branch_for_a_same_repository_bitbucket_pr_even_with_a_url() {
    assert_eq!(
        hosting::checkout_plan(
            P::Bitbucket,
            &pr(false, Some("https://bitbucket.org/a/b.git"), "feature/x", 1)
        )
        .unwrap(),
        CheckoutPlan::TrackBranch {
            branch: "feature/x".into()
        }
    );
}

#[test]
fn checkout_plan_keeps_slashes_in_a_bitbucket_fork_branch_and_uses_u64_numbers() {
    assert_eq!(
        hosting::checkout_plan(
            P::Bitbucket,
            &pr(true, Some("https://bitbucket.org/b/r.git"), "feature/x", 1)
        )
        .unwrap(),
        CheckoutPlan::FetchHead {
            source: "https://bitbucket.org/b/r.git".into(),
            refspec: "refs/heads/feature/x".into()
        }
    );
    assert_eq!(
        hosting::checkout_plan(P::GitHub, &pr(true, None, "x", u64::MAX)).unwrap(),
        CheckoutPlan::FetchHead {
            source: "origin".into(),
            refspec: format!("refs/pull/{}/head", u64::MAX)
        }
    );
}

#[test]
fn checkout_plan_validates_the_branch_before_anything_else() {
    // A bad branch is InvalidBranchName even when a Bitbucket fork would be HostingNotFound.
    for bad in [
        "",
        "-x",
        "--upload-pack=evil",
        "a..b",
        "a b",
        "x.lock",
        "a~1",
        "/a",
        "a/",
    ] {
        for (fork, url) in [(false, None), (true, None), (true, Some("https://h/x.git"))] {
            for p in [P::GitHub, P::GitLab, P::Bitbucket] {
                assert!(
                    matches!(
                        hosting::checkout_plan(p, &pr(fork, url, bad, 1)),
                        Err(GitError::InvalidBranchName(ref s)) if s == bad
                    ),
                    "{p:?} {bad:?} fork={fork}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------- Account and model types

#[test]
fn account_new_derives_its_id_and_starts_without_reconnect() {
    let account = Account::new(
        P::GitLab,
        "git.corp:8443",
        UserInfo {
            username: "octo".into(),
            display_name: None,
            avatar_url: Some("https://a".into()),
        },
    );
    assert_eq!(account.id, "gitlab:git.corp:8443:octo");
    assert_eq!(
        Account::key(P::Bitbucket, "bitbucket.org", "u"),
        "bitbucket:bitbucket.org:u"
    );
    assert!(!account.needs_reconnect);
    assert_eq!(
        serde_json::to_value(&account).unwrap(),
        serde_json::json!({
            "id": "gitlab:git.corp:8443:octo",
            "provider": "gitlab",
            "host": "git.corp:8443",
            "username": "octo",
            "displayName": null,
            "avatarUrl": "https://a",
            "needsReconnect": false,
        })
    );
}

#[test]
fn pull_request_and_repo_context_serialize_camel_case() {
    let json = serde_json::to_value(pr(true, Some("https://h/x.git"), "b", 3)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "number": 3, "title": "t", "author": "a", "sourceBranch": "b",
            "targetBranch": "main", "fromFork": true, "forkCloneUrl": "https://h/x.git",
            "draft": false, "ciState": "none", "updatedAt": 0, "webUrl": "https://h/x",
        })
    );
    for (state, text) in [
        (CiState::Passing, "passing"),
        (CiState::Failing, "failing"),
        (CiState::Pending, "pending"),
        (CiState::None, "none"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), text);
    }
    let ctx = hosting::RepoContext {
        repo: repo(P::GitHub, "github.com", "o", "r"),
        account: None,
    };
    assert_eq!(
        serde_json::to_value(&ctx).unwrap(),
        serde_json::json!({
            "repo": {"provider": "github", "host": "github.com", "namespace": "o", "name": "r"},
            "account": null,
        })
    );
}

#[test]
fn provider_serde_rejects_unknown_names_and_round_trips_all() {
    for p in [P::GitHub, P::GitLab, P::Bitbucket] {
        let json = serde_json::to_value(p).unwrap();
        assert_eq!(json, p.as_str());
        assert_eq!(serde_json::from_value::<P>(json).unwrap(), p);
        assert_eq!(
            p.default_host(),
            format!(
                "{}.{}",
                p.as_str(),
                if p == P::Bitbucket { "org" } else { "com" }
            )
        );
    }
    assert!(serde_json::from_value::<P>("gitea".into()).is_err());
    assert!(serde_json::from_value::<P>("GitHub".into()).is_err());
}

// ---------------------------------------------------------------- detect

#[test]
fn detect_refuses_each_malformed_shape() {
    for url in [
        "https://github.com",            // no path at all
        "https://github.com/",           // empty path
        "https://github.com/o/",         // empty name
        "https://github.com/o/r/",       // fine below, but...
        "https://github.com/o/.git",     // name is only the suffix
        "https://github.com/o/./r",      // dot segment
        "https://github.com/./r",        // dot namespace
        "https://github.com/../r",       // parent namespace
        "https://github.com/o/..",       // parent name
        "https://github.com/o//r",       // empty middle segment
        "https://gitlab.com/g//p",       // empty middle segment on gitlab
        "https://gitlab.com/g/./p",      // dot segment on gitlab
        "https://[::1]/o/r",             // IPv6 literal
        "https://[::1]:8443/o/r",        // IPv6 literal with a port
        "https://.github.com/o/r",       // leading dot
        "https://github.com:abc/o/r",    // non-numeric port
        "https://github.com:/o/r",       // empty port
        "https://github.com:123456/o/r", // six-digit port
        "https://github.com:8443/o/r",   // a port the default host does not have
        "https://github.com:80/o/r",     // http's default is not https's
        "http://github.com:443/o/r",     // https's default is not http's
        "https://gith ub.com/o/r",       // space in the host
        "https://git_hub.com/o/r",       // underscore in the host
        "https://@/o/r",                 // empty host after userinfo
        "https:///o/r",                  // no authority
        "://github.com/o/r",             // no scheme
        "git://github.com/o/r",          // unsupported scheme
        "ftp://github.com/o/r",          // unsupported scheme
        "file://github.com/o/r",         // unsupported scheme
        "github.com:o",                  // scp-like with one segment
        "git@github.com:o/r/extra",      // scp-like with three segments on github
        "git@github.com:/o/r",           // scp-like absolute path (empty first segment)
        "git@:o/r",                      // scp-like with no host
        "git@-host.com:o/r",             // leading dash host (flag-like)
        "-oProxyCommand=x:o/r",          // option-like authority
        "./relative:o/r",                // authority with a slash is a local path
        "../up/dir:o/r",                 // ditto
        "some/dir:o/r",                  // ditto
        "c:/repos/x",                    // lower-case drive path
        "C:\\o\\r",                      // backslash drive path
        "git@bitbucket.org:ws",          // one segment on bitbucket
        "git@bitbucket.org:a/b/c",       // three segments on bitbucket
    ] {
        let want_some = url == "https://github.com/o/r/";
        assert_eq!(detect(url, &[]).is_some(), want_some, "{url:?}");
    }
}

#[test]
fn detect_lowercases_hosts_and_scheme_and_keeps_path_case() {
    assert_eq!(
        detect("HTTPS://GitHub.COM/Octo/Test-Repo.git", &[]),
        Some(repo(P::GitHub, "github.com", "Octo", "Test-Repo"))
    );
    assert_eq!(
        detect("Git@BitBucket.org:WS/Repo", &[]),
        Some(repo(P::Bitbucket, "bitbucket.org", "WS", "Repo"))
    );
}

#[test]
fn detect_strips_git_suffix_and_slashes_in_all_combinations() {
    for url in [
        "https://github.com/o/r.git",
        "https://github.com/o/r.git/",
        "https://github.com/o/r//",
        "https://github.com/o/r/",
        "https://github.com/o/r",
    ] {
        assert_eq!(
            detect(url, &[]),
            Some(repo(P::GitHub, "github.com", "o", "r")),
            "{url}"
        );
    }
    // Only one `.git` is a suffix; a second is part of the name.
    assert_eq!(
        detect("https://github.com/o/r.git.git", &[]),
        Some(repo(P::GitHub, "github.com", "o", "r.git"))
    );
    assert_eq!(
        detect("https://github.com/o/dot.github.io", &[]),
        Some(repo(P::GitHub, "github.com", "o", "dot.github.io"))
    );
}

#[test]
fn detect_ssh_ports_are_dropped_and_alias_hosts_are_normalized() {
    // Only the https/http default ports are dropped on those schemes; for ssh any port goes.
    assert_eq!(
        detect("ssh://git@github.com:22/o/r", &[]),
        Some(repo(P::GitHub, "github.com", "o", "r"))
    );
    assert_eq!(
        detect("git+ssh://gitlab.com:2222/g/s/p", &[]),
        Some(repo(P::GitLab, "gitlab.com", "g/s", "p"))
    );
    assert_eq!(
        detect("git@ssh.github.com:o/r.git", &[]),
        Some(repo(P::GitHub, "github.com", "o", "r"))
    );
    assert_eq!(
        detect("git@altssh.gitlab.com:g/p.git", &[]),
        Some(repo(P::GitLab, "gitlab.com", "g", "p"))
    );
    assert_eq!(
        detect("https://SSH.GitHub.com/o/r", &[]),
        Some(repo(P::GitHub, "github.com", "o", "r"))
    );
    let custom = [(P::GitHub, "ghe.corp".to_owned())];
    assert_eq!(
        detect("ssh://git@ghe.corp:2222/o/r.git", &custom),
        Some(repo(P::GitHub, "ghe.corp", "o", "r"))
    );
}

#[test]
fn detect_custom_hosts_are_case_insensitive_first_match_wins_and_need_the_port() {
    let custom = [
        (P::GitLab, "GIT.Corp".to_owned()),
        (P::GitHub, "git.corp".to_owned()),
        (P::GitHub, "ghe.corp:8443".to_owned()),
    ];
    assert_eq!(
        detect("https://git.corp/g/s/p", &custom),
        Some(repo(P::GitLab, "git.corp", "g/s", "p"))
    );
    // A URL on the custom host with another port is a different host.
    assert_eq!(detect("https://ghe.corp:9443/o/r", &custom), None);
    assert_eq!(detect("https://ghe.corp/o/r", &custom), None);
    assert_eq!(
        detect("https://ghe.corp:8443/o/r", &custom),
        Some(repo(P::GitHub, "ghe.corp:8443", "o", "r"))
    );
    // A custom host never matches a lookalike.
    assert_eq!(detect("https://git.corp.evil/g/p", &custom), None);
    assert_eq!(detect("https://evilgit.corp/g/p", &custom), None);
    // The shape rules follow the custom entry's provider.
    assert_eq!(detect("https://ghe.corp:8443/a/b/c", &custom), None);
}

// ---------------------------------------------------------------- validate_host / https_host

#[test]
fn validate_host_trims_and_error_carries_the_untrimmed_input() {
    assert_eq!(
        validate_host(P::GitLab, Some("  Git.Corp:8443  ")).unwrap(),
        "git.corp:8443"
    );
    assert_eq!(validate_host(P::GitHub, Some("")).unwrap(), "github.com");
    assert_eq!(
        validate_host(P::Bitbucket, Some("BitBucket.ORG")).unwrap(),
        "bitbucket.org"
    );
    assert!(matches!(
        validate_host(P::GitHub, Some("  bad host ")),
        Err(GitError::InvalidHostingHost(s)) if s == "  bad host "
    ));
}

#[test]
fn validate_host_refuses_ipv6_leading_dot_and_url_shapes() {
    for h in [
        "[::1]",
        "::1",
        "[::1]:8443",
        ".corp",
        "-corp",
        "ghe.corp:",
        "ghe.corp:80a",
        "ghe.corp:1:2",
        "ghe.corp/",
        "ghe.corp?x",
        "ghe.corp#x",
        "user@ghe.corp",
        "ghe_corp",
        "ghe corp",
        "ghé.corp",
        "http://ghe.corp",
    ] {
        assert!(
            matches!(
                validate_host(P::GitHub, Some(h)),
                Err(GitError::InvalidHostingHost(_))
            ),
            "{h:?}"
        );
    }
}

#[test]
fn validate_host_bitbucket_accepts_only_the_default_host_even_with_a_port() {
    for h in [
        "bitbucket.org:443",
        "bitbucket.org:7990",
        "api.bitbucket.org",
        "bb.corp",
    ] {
        assert!(
            matches!(
                validate_host(P::Bitbucket, Some(h)),
                Err(GitError::InvalidHostingHost(_))
            ),
            "{h}"
        );
    }
    // The same hosts are fine for the other providers.
    assert_eq!(
        validate_host(P::GitLab, Some("bitbucket.org:7990")).unwrap(),
        "bitbucket.org:7990"
    );
}

#[test]
fn https_host_refuses_every_non_https_or_malformed_origin() {
    for url in [
        "",
        "https://",
        "https://:443/x",
        "https://ex ample.com/x",
        "https://ex_ample.com/x",
        "https://example.com:99999999/x",
        "https://example.com:x/x",
        "git+https://example.com/x",
        "HTTP://example.com/x",
        "ftp://example.com/x",
        "example.com/x",
    ] {
        assert_eq!(https_host(url), None, "{url:?}");
    }
    assert_eq!(
        https_host("HTTPS://Example.COM:8443/x?y#z").as_deref(),
        Some("example.com:8443")
    );
    assert_eq!(
        https_host("https://example.com").as_deref(),
        Some("example.com")
    );
    assert_eq!(
        https_host("https://u:p@example.com:443").as_deref(),
        Some("example.com")
    );
    // Only the :443 suffix goes; other ports and ports ending in 443 stay.
    assert_eq!(
        https_host("https://example.com:1443/x").as_deref(),
        Some("example.com:1443")
    );
}

// ---------------------------------------------------------------- Credentials::account

#[test]
fn account_credentials_refuse_every_invalid_origin_before_any_use() {
    let t = Token::new("tok").unwrap();
    for origin in [
        "",
        "github.com",
        "ssh://github.com",
        "git@github.com:o/r",
        "https://",
        "https://:443",
        "https://git hub.com",
        "https://github.com/",
        "https://github.com/o/r",
        "https://github.com:123456",
        "https://github.com:x",
        "https://u@github.com",
        "https://[]",
        "https://[::1",
        "https://[zz]",
        "ftp://github.com",
    ] {
        assert!(
            matches!(
                Credentials::account(origin, "x-access-token", &t),
                Err(GitError::InvalidCredentials)
            ),
            "{origin:?}"
        );
    }
    for username in ["", "a\nb", "a\rb", "a\0b"] {
        assert!(
            matches!(
                Credentials::account("https://github.com", username, &t),
                Err(GitError::InvalidCredentials)
            ),
            "{username:?}"
        );
    }
}

#[test]
fn account_credentials_accept_https_http_ipv6_and_ports() {
    let t = Token::new("tok").unwrap();
    for origin in [
        "https://github.com",
        "http://localhost:8080",
        "https://ghe.corp:8443",
        "https://[::1]:8443",
        "https://127.0.0.1",
    ] {
        let c = Credentials::account(origin, "oauth2", &t).unwrap();
        assert_eq!(c.origin(), origin);
        assert!(!c.approves(), "{origin}");
    }
}

#[test]
fn account_credentials_hide_the_token_in_debug() {
    let c = Credentials::account("https://github.com", "u", &token()).unwrap();
    assert!(!format!("{c:?}").contains(SECRET));
}

// ---------------------------------------------------------------- fix loop (red until fixed)

#[test]
fn validate_host_drops_only_the_https_default_port_like_detect_and_https_host() {
    assert_eq!(
        validate_host(P::GitHub, Some("ghe.corp:443")).unwrap(),
        "ghe.corp"
    );
    assert_eq!(
        validate_host(P::GitLab, Some(" GIT.corp:443 ")).unwrap(),
        "git.corp"
    );
    assert_eq!(
        validate_host(P::GitHub, Some("GHE.corp:8443")).unwrap(),
        "ghe.corp:8443"
    );
    // The stored host is what detect and https_host produce for the same server.
    let host = validate_host(P::GitHub, Some("ghe.corp:443")).unwrap();
    assert_eq!(
        detect("https://ghe.corp/o/r", &[(P::GitHub, host.clone())]),
        Some(repo(P::GitHub, "ghe.corp", "o", "r"))
    );
    assert_eq!(https_host("https://ghe.corp:443/o/r"), Some(host));
}

#[test]
fn validate_host_refuses_ports_outside_1_to_65535() {
    for h in [
        "ghe.corp:0",
        "ghe.corp:00",
        "ghe.corp:65536",
        "ghe.corp:99999",
    ] {
        assert!(
            matches!(
                validate_host(P::GitHub, Some(h)),
                Err(GitError::InvalidHostingHost(_))
            ),
            "{h}"
        );
    }
    for (h, want) in [
        ("ghe.corp:1", "ghe.corp:1"),
        ("ghe.corp:65535", "ghe.corp:65535"),
    ] {
        assert_eq!(validate_host(P::GitHub, Some(h)).unwrap(), want);
    }
}

#[test]
fn detect_refuses_path_segments_outside_the_plain_character_set() {
    for url in [
        "https://github.com/o x/r",
        "https://github.com/o/r y",
        "https://github.com/o/r?x=1",
        "https://github.com/o/r#f",
        "https://github.com/o:x/r",
        "https://github.com/o@x/r",
        "https://github.com/o%20x/r",
        "https://github.com/o/r\u{e9}",
        "https://github.com/o/r\\x",
        "https://github.com/o/r\nx",
        "https://gitlab.com/g/s p/proj",
        "https://gitlab.com/g/s?x/proj",
        "git@github.com:22:o/r",
        "git@github.com:o r/x",
        "https://github.com/./r",
        "https://github.com/o/..",
        "https://gitlab.com/g/../p",
    ] {
        assert_eq!(detect(url, &[]), None, "{url:?}");
    }
    // The plain set stays accepted.
    assert_eq!(
        detect("https://github.com/A-b_c.d/E.f_g-h9", &[]),
        Some(repo(P::GitHub, "github.com", "A-b_c.d", "E.f_g-h9"))
    );
}

#[test]
fn bitbucket_clone_url_refuses_dot_segments() {
    let dest = end("main", Some("ws/r"));
    for name in ["../x", "./x", "x/..", "x/.", "../..", "./."] {
        let pr = bb_get(&bb_pr(&end("x", Some(name)), &dest, "{}", "")).unwrap();
        assert!(
            pr.from_fork && pr.fork_clone_url.is_none(),
            "{name:?} -> {:?}",
            pr.fork_clone_url
        );
    }
}
