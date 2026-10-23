//! Token validation and redaction, Request Debug, RFC 3339 parsing, and the HTTP status →
//! GitError mapping (exercised through GitHub's current_user, the smallest call).

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::http::parse_timestamp;
use git_real_core::hosting::{self, Method, Provider, Request, Token};

const SECRET: &str = "ghp_TOPSECRET123";

fn token() -> Token {
    Token::new(SECRET).unwrap()
}
fn user(t: &FakeTransport) -> Result<hosting::UserInfo, GitError> {
    hosting::current_user(t, Provider::GitHub, "github.com", &token())
}

#[test]
fn token_accepts_up_to_4096_bytes_without_line_breaks() {
    assert_eq!(
        Token::new(&"a".repeat(4096)).unwrap().expose_secret().len(),
        4096
    );
    for bad in ["", "a\nb", "a\rb", "a\0b", &"a".repeat(4097)] {
        assert!(
            matches!(Token::new(bad), Err(GitError::InvalidToken)),
            "{bad:?}"
        );
    }
}

#[test]
fn token_debug_is_redacted() {
    assert_eq!(format!("{:?}", token()), r#"Token("***")"#);
}

#[test]
fn request_debug_redacts_authorization_in_any_case() {
    let req = Request {
        method: Method::Get,
        url: "https://api.github.com/user".into(),
        headers: vec![
            ("Authorization".into(), format!("Bearer {SECRET}")),
            ("accept".into(), "application/json".into()),
        ],
        body: None,
    };
    let text = format!("{req:?}");
    assert!(!text.contains(SECRET), "{text}");
    assert!(
        text.contains("***")
            && text.contains("api.github.com/user")
            && text.contains("application/json"),
        "{text}"
    );
}

#[test]
fn parse_timestamp_handles_zulu_fractions_and_offsets() {
    assert_eq!(parse_timestamp("2026-10-20T12:00:00Z"), Some(1792497600));
    assert_eq!(
        parse_timestamp("2026-10-20T12:00:00.123Z"),
        Some(1792497600)
    );
    assert_eq!(
        parse_timestamp("2026-10-20T12:00:00.123456+00:00"),
        Some(1792497600)
    );
    assert_eq!(
        parse_timestamp("2026-10-19T08:30:15.000+02:00"),
        Some(1792391415)
    );
    assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_timestamp("2000-02-29T23:59:59Z"), Some(951868799));
    for bad in [
        "",
        "2026-10-20",
        "2026-10-20 12:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-10-20T12:00:00",
        "x",
    ] {
        assert_eq!(parse_timestamp(bad), None, "{bad:?}");
    }
}

#[test]
fn the_github_request_carries_bearer_accept_and_api_version() {
    let t = FakeTransport::new().reply(200, include_str!("fixtures/hosting/github_user.json"));
    user(&t).unwrap();
    let req = &t.requests()[0];
    assert_eq!(
        (req.method, req.url.as_str()),
        (Method::Get, "https://api.github.com/user")
    );
    let h = |n: &str| {
        req.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(n))
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(
        h("authorization"),
        Some(format!("Bearer {SECRET}").as_str())
    );
    assert_eq!(h("accept"), Some("application/vnd.github+json"));
    assert_eq!(h("x-github-api-version"), Some("2022-11-28"));
}

#[test]
fn statuses_map_to_hosting_errors() {
    let auth =
        user(&FakeTransport::new().reply(401, r#"{"message":"Bad credentials"}"#)).unwrap_err();
    assert!(
        matches!(auth, GitError::HostingAuth { ref message } if message == "Bad credentials"),
        "{auth:?}"
    );
    let forbidden = user(&FakeTransport::new().reply(403, "not json")).unwrap_err();
    assert!(matches!(forbidden, GitError::HostingAuth { ref message } if message == "HTTP 403"));
    assert!(matches!(
        user(&FakeTransport::new().reply(404, "{}")).unwrap_err(),
        GitError::HostingNotFound
    ));
    let limited = FakeTransport::new().reply_with(
        403,
        &[
            ("X-RateLimit-Remaining", "0"),
            ("X-RateLimit-Reset", "1792497600"),
        ],
        "{}",
    );
    assert!(matches!(
        user(&limited).unwrap_err(),
        GitError::HostingRateLimited {
            reset_epoch: Some(1792497600)
        }
    ));
    let gitlab = FakeTransport::new().reply_with(429, &[("RateLimit-Reset", "1792497601")], "{}");
    assert!(matches!(
        user(&gitlab).unwrap_err(),
        GitError::HostingRateLimited {
            reset_epoch: Some(1792497601)
        }
    ));
    let after = FakeTransport::new().reply_with(429, &[("Retry-After", "60")], "{}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(
        matches!(user(&after).unwrap_err(), GitError::HostingRateLimited { reset_epoch: Some(t) } if t >= now + 60)
    );
    assert!(matches!(
        user(&FakeTransport::new().reply(429, "")).unwrap_err(),
        GitError::HostingRateLimited { reset_epoch: None }
    ));
    let rejected =
        user(&FakeTransport::new().reply(422, r#"{"error":{"message":"already exists"}}"#))
            .unwrap_err();
    assert!(
        matches!(rejected, GitError::HostingRejected { ref message } if message == "already exists")
    );
    let plain = user(&FakeTransport::new().reply(400, r#"{"error":"bad thing"}"#)).unwrap_err();
    assert!(matches!(plain, GitError::HostingRejected { ref message } if message == "bad thing"));
    assert!(
        matches!(user(&FakeTransport::new().reply(302, "")).unwrap_err(), GitError::HostingRejected { ref message } if message == "HTTP 302")
    );
    assert!(
        matches!(user(&FakeTransport::new().reply(502, "")).unwrap_err(), GitError::HostingUnreachable { ref message } if message == "HTTP 502")
    );
    let garbage = user(&FakeTransport::new().reply(200, "<html>")).unwrap_err();
    assert!(
        matches!(garbage, GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com")
    );
    let down = FakeTransport::new().fail(GitError::HostingUnreachable {
        message: "dns".into(),
    });
    assert!(
        matches!(user(&down).unwrap_err(), GitError::HostingUnreachable { ref message } if message == "dns")
    );
}

#[test]
fn an_error_body_that_echoes_the_token_is_redacted() {
    let echo = format!(r#"{{"message":"token {SECRET} lacks scope repo"}}"#);
    let err = user(&FakeTransport::new().reply(403, &echo)).unwrap_err();
    assert!(
        matches!(err, GitError::HostingAuth { ref message } if message == "token *** lacks scope repo"),
        "{err:?}"
    );
    assert!(!err.to_string().contains(SECRET));
}

#[test]
fn long_provider_messages_are_cut_to_200_chars() {
    let long = format!(r#"{{"message":"{}"}}"#, "x".repeat(500));
    let GitError::HostingRejected { message } =
        user(&FakeTransport::new().reply(422, &long)).unwrap_err()
    else {
        panic!()
    };
    assert_eq!(message.chars().count(), 201);
    assert!(message.ends_with('…'));
}

// Item 1: `Token` lives in the neutral `token` module; `hosting::Token` is a re-export.
mod neutral_token {
    use git_real_core::GitError;
    use git_real_core::token::Token;

    #[test]
    fn token_module_round_trips_a_valid_token() {
        assert_eq!(Token::new("ghp_abc").unwrap().expose_secret(), "ghp_abc");
    }

    #[test]
    fn token_module_accepts_exactly_4096_bytes() {
        assert_eq!(
            Token::new(&"a".repeat(4096)).unwrap().expose_secret().len(),
            4096
        );
    }

    #[test]
    fn token_module_rejects_empty_token() {
        assert!(matches!(Token::new(""), Err(GitError::InvalidToken)));
    }

    #[test]
    fn token_module_rejects_more_than_4096_bytes() {
        assert!(matches!(
            Token::new(&"a".repeat(4097)),
            Err(GitError::InvalidToken)
        ));
    }

    #[test]
    fn token_module_rejects_line_feed() {
        assert!(matches!(Token::new("a\nb"), Err(GitError::InvalidToken)));
    }

    #[test]
    fn token_module_rejects_carriage_return() {
        assert!(matches!(Token::new("a\rb"), Err(GitError::InvalidToken)));
    }

    #[test]
    fn token_module_rejects_nul() {
        assert!(matches!(Token::new("a\0b"), Err(GitError::InvalidToken)));
    }

    #[test]
    fn token_module_debug_is_redacted() {
        assert_eq!(
            format!("{:?}", Token::new("ghp_SECRET").unwrap()),
            r#"Token("***")"#
        );
    }

    #[test]
    fn hosting_token_is_the_same_type_as_the_token_module_token() {
        assert_eq!(
            std::any::TypeId::of::<git_real_core::token::Token>(),
            std::any::TypeId::of::<git_real_core::hosting::Token>()
        );
    }
}

// Item 4: `post_json` builds an authenticated JSON POST request.
mod post_json_builder {
    use git_real_core::hosting::http::post_json;
    use git_real_core::hosting::{Method, Request, Token};

    const SECRET: &str = "ghp_TOPSECRET123";
    const URL: &str = "https://api.github.com/repos/o/r/pulls";

    fn body() -> serde_json::Value {
        serde_json::json!({"title": "t", "head": "h", "base": "b"})
    }
    fn built() -> Request {
        post_json(URL.to_owned(), &Token::new(SECRET).unwrap(), &body())
    }
    fn header_values(req: &Request, name: &str) -> Vec<String> {
        req.headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .collect()
    }

    #[test]
    fn should_use_post_when_building_a_json_request() {
        assert_eq!(built().method, Method::Post);
    }

    #[test]
    fn should_pass_the_url_through_unchanged() {
        assert_eq!(built().url, URL);
    }

    #[test]
    fn should_send_one_bearer_authorization_header() {
        assert_eq!(
            header_values(&built(), "Authorization"),
            vec![format!("Bearer {SECRET}")]
        );
    }

    #[test]
    fn should_send_one_json_accept_header() {
        assert_eq!(
            header_values(&built(), "Accept"),
            vec!["application/json".to_owned()]
        );
    }

    #[test]
    fn should_send_one_json_content_type_header() {
        assert_eq!(
            header_values(&built(), "Content-Type"),
            vec!["application/json".to_owned()]
        );
    }

    #[test]
    fn should_serialize_the_body_with_to_string() {
        assert_eq!(built().body, Some(body().to_string()));
    }

    #[test]
    fn should_redact_the_token_in_debug_output() {
        let dbg = format!("{:?}", built());
        assert!(!dbg.contains(SECRET), "{dbg}");
        assert!(dbg.contains("***"), "{dbg}");
    }
}
