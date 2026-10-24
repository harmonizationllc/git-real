//! Branch-level coverage for GR-13b: optional JSON fields of repository info and issues,
//! the error-message extraction order, create-request edge cases, and pull request draft
//! edges (humanizing, behind or diverged branches, slashed targets).

mod common;

use std::path::{Path, PathBuf};

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::http::percent_encode as enc;
use git_real_core::hosting::{self, NewPullRequest, Provider as P, RepoRef, Token, UserInfo};
use git_real_core::remote::pr_draft::humanize_branch;
use git_real_core::{PullRequestDraft, RepoSession};
use tempfile::TempDir;

const SECRET: &str = "ghp_TOPSECRET123";

fn tok() -> Token {
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
fn gh() -> RepoRef {
    repo(P::GitHub, "github.com", "gorlox", "test-repo")
}
fn gl() -> RepoRef {
    repo(P::GitLab, "gitlab.com", "group/sub", "proj")
}
fn bb() -> RepoRef {
    repo(P::Bitbucket, "bitbucket.org", "ws", "repo")
}
fn header<'a>(req: &'a hosting::Request, name: &str) -> Vec<&'a str> {
    req.headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
        .collect()
}
fn unexpected(host: &str) -> String {
    format!("unexpected response from {host}")
}

// ------------------------------------------------------------------ repository info

fn info(r: &RepoRef, body: &str) -> (Option<String>, bool) {
    let i = hosting::repo_info(&FakeTransport::new().reply(200, body), r, &tok()).unwrap();
    (i.default_branch, i.issues_enabled)
}

#[test]
fn github_has_issues_false_turns_issues_off_and_true_keeps_them_on() {
    assert_eq!(
        info(&gh(), r#"{"default_branch":"main","has_issues":false}"#),
        (Some("main".to_owned()), false)
    );
    assert_eq!(
        info(&gh(), r#"{"default_branch":"main","has_issues":true}"#),
        (Some("main".to_owned()), true)
    );
}

#[test]
fn gitlab_issues_are_on_unless_either_switch_says_off() {
    // (issues_access_level, issues_enabled) -> issues_enabled
    let cases = [
        (r#""enabled""#, "true", true),
        (r#""private""#, "true", true),
        (r#""disabled""#, "true", false),
        (r#""enabled""#, "false", false),
        (r#""disabled""#, "false", false),
        (r#""disabled""#, "null", false),
        (r#""enabled""#, "null", true),
        ("null", "false", false),
        ("null", "true", true),
        ("null", "null", true),
    ];
    for (level, flag, want) in cases {
        let body = format!(
            r#"{{"default_branch":"main","issues_access_level":{level},"issues_enabled":{flag}}}"#
        );
        assert_eq!(info(&gl(), &body).1, want, "{level} / {flag}");
    }
    // Each switch missing on its own.
    assert!(!info(&gl(), r#"{"issues_access_level":"disabled"}"#).1);
    assert!(info(&gl(), r#"{"issues_access_level":"enabled"}"#).1);
    assert!(info(&gl(), r#"{"issues_enabled":true}"#).1);
}

#[test]
fn bitbucket_has_issues_true_and_the_main_branch_name_are_read() {
    assert_eq!(
        info(
            &bb(),
            r#"{"mainbranch":{"name":"trunk"},"has_issues":true}"#
        ),
        (Some("trunk".to_owned()), true)
    );
    assert_eq!(
        info(
            &bb(),
            r#"{"mainbranch":{"name":"trunk"},"has_issues":false}"#
        ),
        (Some("trunk".to_owned()), false)
    );
}

#[test]
fn a_main_branch_without_a_name_is_an_unexpected_response() {
    let err = hosting::repo_info(
        &FakeTransport::new().reply(200, r#"{"mainbranch":{}}"#),
        &bb(),
        &tok(),
    )
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { ref message } if *message == unexpected("bitbucket.org")),
        "{err:?}"
    );
}

#[test]
fn repo_info_errors_map_like_every_other_call() {
    let status = |code, body: &str| {
        hosting::repo_info(&FakeTransport::new().reply(code, body), &gh(), &tok()).unwrap_err()
    };
    assert!(matches!(
        status(401, r#"{"message":"Bad credentials"}"#),
        GitError::HostingAuth { .. }
    ));
    assert!(matches!(
        status(404, r#"{"message":"Not Found"}"#),
        GitError::HostingNotFound
    ));
}

// ------------------------------------------------------------------ issues

fn issues(r: &RepoRef, body: &str) -> Vec<hosting::Issue> {
    hosting::list_issues(&FakeTransport::new().reply(200, body), r, &tok(), "", 1).unwrap()
}

#[test]
fn an_empty_issue_list_is_an_empty_vec_on_every_provider() {
    assert!(issues(&gh(), r#"{"items":[]}"#).is_empty());
    assert!(issues(&gl(), "[]").is_empty());
    assert!(issues(&bb(), r#"{"values":[]}"#).is_empty());
}

#[test]
fn a_github_search_of_only_pull_requests_is_empty() {
    let body = r#"{"items":[
        {"number":1,"title":"a","user":{"login":"u"},"labels":[],"pull_request":{},"updated_at":"2026-10-20T12:00:00Z","html_url":"x"},
        {"number":2,"title":"b","user":{"login":"u"},"labels":[],"pull_request":{"url":"y"},"updated_at":"2026-10-20T12:00:00Z","html_url":"x"}]}"#;
    assert!(issues(&gh(), body).is_empty());
}

#[test]
fn a_github_search_without_items_is_an_unexpected_response() {
    let err = hosting::list_issues(
        &FakeTransport::new().reply(200, r#"{"total_count":0}"#),
        &gh(),
        &tok(),
        "",
        1,
    )
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { ref message } if *message == unexpected("github.com")),
        "{err:?}"
    );
}

#[test]
fn an_unparsable_issue_timestamp_is_an_unexpected_response() {
    for (r, body, host) in [
        (
            gh(),
            r#"{"items":[{"number":1,"title":"t","user":{"login":"u"},"labels":[],"updated_at":"yesterday","html_url":"x"}]}"#,
            "github.com",
        ),
        (
            gl(),
            r#"[{"iid":1,"title":"t","author":{"username":"u"},"labels":[],"updated_at":"","web_url":"x"}]"#,
            "gitlab.com",
        ),
        (
            bb(),
            r#"{"values":[{"id":1,"title":"t","updated_on":"nope","links":{"html":{"href":"x"}}}]}"#,
            "bitbucket.org",
        ),
    ] {
        let err = hosting::list_issues(&FakeTransport::new().reply(200, body), &r, &tok(), "", 1)
            .unwrap_err();
        assert!(
            matches!(err, GitError::HostingUnreachable { ref message } if *message == unexpected(host)),
            "{host}: {err:?}"
        );
    }
}

#[test]
fn one_unparsable_issue_fails_the_whole_page() {
    let body = r#"[
        {"iid":2,"title":"ok","author":{"username":"u"},"labels":[],"updated_at":"2026-10-20T12:00:00Z","web_url":"x"},
        {"iid":1,"title":"bad","author":{"username":"u"},"labels":[],"updated_at":"?","web_url":"x"}]"#;
    let err = hosting::list_issues(&FakeTransport::new().reply(200, body), &gl(), &tok(), "", 1)
        .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { .. }),
        "{err:?}"
    );
}

#[test]
fn bitbucket_reporter_falls_back_from_nickname_to_display_name_to_empty() {
    let issue = |reporter: &str| {
        format!(
            r#"{{"values":[{{"id":1,"title":"t","reporter":{reporter},"updated_on":"2026-10-20T12:00:00+00:00","links":{{"html":{{"href":"x"}}}}}}]}}"#
        )
    };
    let author = |reporter: &str| issues(&bb(), &issue(reporter))[0].author.clone();
    assert_eq!(
        author(r#"{"nickname":"nick","display_name":"Disp"}"#),
        "nick"
    );
    assert_eq!(author(r#"{"nickname":null,"display_name":"Disp"}"#), "Disp");
    assert_eq!(author(r#"{"display_name":"Disp"}"#), "Disp");
    assert_eq!(author(r#"{"nickname":"nick"}"#), "nick");
    assert_eq!(author("{}"), "");
    assert_eq!(author("null"), "");
}

#[test]
fn bitbucket_kind_is_the_only_label_when_it_is_a_string() {
    let issue = |kind: &str| {
        format!(
            r#"{{"values":[{{"id":1,"title":"t"{kind},"updated_on":"2026-10-20T12:00:00+00:00","links":{{"html":{{"href":"x"}}}}}}]}}"#
        )
    };
    let labels = |kind: &str| issues(&bb(), &issue(kind))[0].labels.clone();
    assert_eq!(labels(r#","kind":"task""#), ["task"]);
    assert!(labels(r#","kind":null"#).is_empty());
    assert!(labels(r#","kind":7"#).is_empty());
    assert!(labels(r#","kind":["bug"]"#).is_empty());
    assert!(labels(r#","kind":{"a":1}"#).is_empty());
    assert!(labels("").is_empty());
}

#[test]
fn bitbucket_issue_without_links_html_is_an_unexpected_response() {
    let err = hosting::list_issues(
        &FakeTransport::new().reply(
            200,
            r#"{"values":[{"id":1,"title":"t","updated_on":"2026-10-20T12:00:00+00:00","links":{}}]}"#,
        ),
        &bb(),
        &tok(),
        "",
        1,
    )
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { .. }),
        "{err:?}"
    );
}

#[test]
fn a_github_item_with_many_labels_keeps_their_order() {
    let body = r#"{"items":[{"number":1,"title":"t","user":{"login":"u"},"labels":[{"name":"z"},{"name":"a"},{"name":"m"}],"updated_at":"2026-10-20T12:00:00Z","html_url":"x"}]}"#;
    assert_eq!(issues(&gh(), body)[0].labels, ["z", "a", "m"]);
}

#[test]
fn issue_pages_reach_every_provider_url() {
    let url = |r: &RepoRef, body: &str, page| {
        let t = FakeTransport::new().reply(200, body);
        hosting::list_issues(&t, r, &tok(), "", page).unwrap();
        t.requests()[0].url.clone()
    };
    assert!(url(&gh(), r#"{"items":[]}"#, 3).ends_with("&per_page=50&page=3"));
    assert!(url(&gl(), "[]", 4).ends_with("&per_page=50&page=4"));
    assert!(url(&bb(), r#"{"values":[]}"#, 5).contains("?pagelen=50&page=5&sort=-updated_on&q="));
}

#[test]
fn issue_urls_use_the_enterprise_and_self_managed_api_bases() {
    let ghe = repo(P::GitHub, "ghe.example.com", "o", "r");
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);
    hosting::list_issues(&t, &ghe, &tok(), "", 1).unwrap();
    assert!(
        t.requests()[0]
            .url
            .starts_with("https://ghe.example.com/api/v3/search/issues?q="),
        "{}",
        t.requests()[0].url
    );
    let selfhosted = repo(P::GitLab, "git.example.com", "g", "p");
    let t = FakeTransport::new().reply(200, "[]");
    hosting::list_issues(&t, &selfhosted, &tok(), "", 1).unwrap();
    assert!(
        t.requests()[0]
            .url
            .starts_with("https://git.example.com/api/v4/projects/g%2Fp/issues?"),
        "{}",
        t.requests()[0].url
    );
    let t = FakeTransport::new().reply(200, r#"{"default_branch":"main"}"#);
    hosting::repo_info(&t, &ghe, &tok()).unwrap();
    assert_eq!(
        t.requests()[0].url,
        "https://ghe.example.com/api/v3/repos/o/r"
    );
}

#[test]
fn non_ascii_queries_are_utf8_percent_encoded_on_every_provider() {
    let url = |r: &RepoRef, body: &str| {
        let t = FakeTransport::new().reply(200, body);
        hosting::list_issues(&t, r, &tok(), "café 日本", 1).unwrap();
        t.requests()[0].url.clone()
    };
    let want = "caf%C3%A9%20%E6%97%A5%E6%9C%AC";
    assert!(url(&gh(), r#"{"items":[]}"#).contains(&format!("is%3Aopen%20{want}&sort")));
    assert!(url(&gl(), "[]").ends_with(&format!("&search={want}")));
    let filter = r#"(state="new" OR state="open") AND title ~ "café 日本""#;
    assert!(url(&bb(), r#"{"values":[]}"#).ends_with(&format!("&q={}", enc(filter))));
}

#[test]
fn issue_search_uses_the_raw_repository_segments_encoded_once() {
    // A name with characters that need escaping is encoded one time, as part of `q`.
    let r = repo(P::GitHub, "github.com", "o", "my.repo_1");
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);
    hosting::list_issues(&t, &r, &tok(), "", 1).unwrap();
    assert!(
        t.requests()[0]
            .url
            .contains("q=repo%3Ao%2Fmy.repo_1%20is%3Aissue%20is%3Aopen&"),
        "{}",
        t.requests()[0].url
    );
}

#[test]
fn issue_requests_carry_a_bearer_token_and_the_provider_headers_once() {
    let t = FakeTransport::new().reply(200, r#"{"items":[]}"#);
    hosting::list_issues(&t, &gh(), &tok(), "", 1).unwrap();
    let req = &t.requests()[0];
    assert_eq!(header(req, "authorization"), [format!("Bearer {SECRET}")]);
    assert_eq!(header(req, "accept"), ["application/vnd.github+json"]);
}

// ------------------------------------------------------------------ error message order

fn user(t: &FakeTransport) -> Result<UserInfo, GitError> {
    hosting::current_user(t, P::GitHub, "github.com", &tok())
}
fn rejected(body: &str) -> String {
    match user(&FakeTransport::new().reply(422, body)).unwrap_err() {
        GitError::HostingRejected { message } => message,
        other => panic!("{other:?}"),
    }
}

#[test]
fn message_extraction_follows_the_documented_order() {
    let cases = [
        // 1. errors[0].message beats everything.
        (
            r#"{"errors":[{"message":"E"}],"message":"M","error":"X"}"#,
            "E",
        ),
        (r#"{"errors":[{"message":"E"}],"message":["a","b"]}"#, "E"),
        // errors[0] without a usable message falls through.
        (r#"{"errors":[],"message":"M"}"#, "M"),
        (r#"{"errors":[{"message":5}],"message":"M"}"#, "M"),
        (r#"{"errors":[{"message":null}],"message":"M"}"#, "M"),
        (r#"{"errors":"boom","message":"M"}"#, "M"),
        (r#"{"errors":{"message":"nope"},"message":"M"}"#, "M"),
        // Only the first entry counts.
        (
            r#"{"errors":[{"code":"x"},{"message":"second"}]}"#,
            "HTTP 422",
        ),
        // 2. message string beats array, error, error.message.
        (r#"{"message":"M","error":"X"}"#, "M"),
        (r#"{"message":"M","error":{"message":"N"}}"#, "M"),
        // message array joined; beats error.
        (r#"{"message":["a","b","c"],"error":"X"}"#, "a; b; c"),
        (r#"{"message":["only"]}"#, "only"),
        (r#"{"message":["a",1,null,"b"]}"#, "a; b"),
        // empty or non-string arrays fall through.
        (r#"{"message":[],"error":"X"}"#, "X"),
        (r#"{"message":[1,2],"error":{"message":"N"}}"#, "N"),
        (r#"{"message":{"a":1},"error":"X"}"#, "X"),
        // 3. error string beats error.message (a string error has no .message).
        (r#"{"error":"X"}"#, "X"),
        // 4. error.message.
        (r#"{"error":{"message":"N"}}"#, "N"),
        (r#"{"error":7,"message":null}"#, "HTTP 422"),
    ];
    for (body, want) in cases {
        assert_eq!(rejected(body), want, "{body}");
    }
}

#[test]
fn the_new_message_paths_redact_the_token_and_cut_to_200_characters() {
    assert_eq!(
        rejected(&format!(
            r#"{{"errors":[{{"message":"bad {SECRET} here"}}]}}"#
        )),
        "bad *** here"
    );
    assert_eq!(
        rejected(&format!(r#"{{"message":["x {SECRET}","y"]}}"#)),
        "x ***; y"
    );

    let long = "é".repeat(250);
    let from_errors = rejected(&format!(r#"{{"errors":[{{"message":"{long}"}}]}}"#));
    assert_eq!(from_errors.chars().count(), 201);
    assert!(from_errors.ends_with('…'));
    let from_array = rejected(&format!(r#"{{"message":["{long}","{long}"]}}"#));
    assert_eq!(from_array.chars().count(), 201);
    assert!(from_array.ends_with('…'));
    // Exactly 200 characters is not cut.
    let exact = "x".repeat(200);
    assert_eq!(rejected(&format!(r#"{{"message":["{exact}"]}}"#)), exact);
}

#[test]
fn the_new_extraction_applies_to_auth_failures_too() {
    let err = user(&FakeTransport::new().reply(
        401,
        r#"{"errors":[{"message":"Token expired"}],"message":"Bad credentials"}"#,
    ))
    .unwrap_err();
    assert!(matches!(err, GitError::HostingAuth { ref message } if message == "Token expired"));
}

// ------------------------------------------------------------------ create pull request

fn new_pr() -> NewPullRequest {
    NewPullRequest {
        title: "Add login".into(),
        body: "Body".into(),
        source_branch: "feature/login".into(),
        target_branch: "main".into(),
    }
}

#[test]
fn a_created_pull_request_without_the_required_fields_is_an_unexpected_response() {
    for (r, host) in [
        (gh(), "github.com"),
        (gl(), "gitlab.com"),
        (bb(), "bitbucket.org"),
    ] {
        let err = hosting::create_pull_request(
            &FakeTransport::new().reply(201, "{}"),
            &r,
            &tok(),
            &new_pr(),
        )
        .unwrap_err();
        assert!(
            matches!(err, GitError::HostingUnreachable { ref message } if *message == unexpected(host)),
            "{host}: {err:?}"
        );
    }
}

#[test]
fn create_rejections_show_each_providers_own_sentence() {
    let gitlab =
        r#"{"message":["Another open merge request already exists for this source branch: !5"]}"#;
    let bitbucket = r#"{"type":"error","error":{"message":"Branch feature/login not found"}}"#;
    for (r, status, body, want) in [
        (
            gl(),
            409,
            gitlab,
            "Another open merge request already exists for this source branch: !5",
        ),
        (bb(), 400, bitbucket, "Branch feature/login not found"),
    ] {
        let err = hosting::create_pull_request(
            &FakeTransport::new().reply(status, body),
            &r,
            &tok(),
            &new_pr(),
        )
        .unwrap_err();
        assert!(
            matches!(err, GitError::HostingRejected { ref message } if message == want),
            "{err:?}"
        );
    }
}

#[test]
fn a_rejected_token_on_create_is_a_hosting_auth_error_on_every_provider() {
    for r in [gh(), gl(), bb()] {
        let err = hosting::create_pull_request(
            &FakeTransport::new().reply(401, r#"{"message":"nope"}"#),
            &r,
            &tok(),
            &new_pr(),
        )
        .unwrap_err();
        assert!(matches!(err, GitError::HostingAuth { .. }), "{err:?}");
    }
}

#[test]
fn text_with_quotes_backslashes_and_newlines_round_trips_through_the_json_body() {
    let nasty = NewPullRequest {
        title: r#"He said "hi" \ done"#.into(),
        body: "line1\nline2\r\n\ttab é 日本 \u{1F600}".into(),
        ..new_pr()
    };
    let fixture = include_str!("fixtures/hosting/github_pulls.json");
    let first: serde_json::Value = serde_json::from_str(fixture).unwrap();
    let t = FakeTransport::new().reply(201, &first[0].to_string());
    hosting::create_pull_request(&t, &gh(), &tok(), &nasty).unwrap();
    let body: serde_json::Value =
        serde_json::from_str(t.requests()[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(body["title"], nasty.title);
    assert_eq!(body["body"], nasty.body);
}

#[test]
fn github_create_keeps_one_accept_and_the_bearer_token_gitlab_and_bitbucket_keep_json() {
    let pulls: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/hosting/github_pulls.json")).unwrap();
    let t = FakeTransport::new().reply(201, &pulls[0].to_string());
    hosting::create_pull_request(&t, &gh(), &tok(), &new_pr()).unwrap();
    let req = &t.requests()[0];
    assert_eq!(header(req, "accept"), ["application/vnd.github+json"]);
    assert_eq!(header(req, "authorization"), [format!("Bearer {SECRET}")]);
    assert_eq!(header(req, "x-github-api-version"), ["2022-11-28"]);

    let mrs: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/hosting/gitlab_merge_requests.json")).unwrap();
    let t = FakeTransport::new().reply(201, &mrs[0].to_string());
    hosting::create_pull_request(&t, &gl(), &tok(), &new_pr()).unwrap();
    assert_eq!(header(&t.requests()[0], "accept"), ["application/json"]);
    assert_eq!(
        header(&t.requests()[0], "authorization"),
        [format!("Bearer {SECRET}")]
    );

    let prs: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/hosting/bitbucket_pullrequests.json")).unwrap();
    let t = FakeTransport::new().reply(201, &prs["values"][0].to_string());
    hosting::create_pull_request(&t, &bb(), &tok(), &new_pr()).unwrap();
    assert_eq!(header(&t.requests()[0], "accept"), ["application/json"]);
}

#[test]
fn create_refuses_empty_branch_names_before_any_request() {
    for (source, target) in [
        ("", "main"),
        ("feat", ""),
        ("a..b", "main"),
        ("feat", "x.lock"),
    ] {
        let new = NewPullRequest {
            source_branch: source.into(),
            target_branch: target.into(),
            ..new_pr()
        };
        let t = FakeTransport::new();
        let err = hosting::create_pull_request(&t, &gl(), &tok(), &new).unwrap_err();
        assert!(
            matches!(err, GitError::InvalidBranchName(_)),
            "{source:?}->{target:?}: {err:?}"
        );
        assert!(t.requests().is_empty());
    }
}

// ------------------------------------------------------------------ pull request draft

#[test]
fn humanize_branch_edge_cases() {
    for (name, want) in [
        ("", ""),
        ("a/", ""),
        ("/", ""),
        ("feature/", ""),
        ("--", ""),
        ("__", ""),
        ("-_-", ""),
        ("-lead", "Lead"),
        ("trail-", "Trail"),
        ("a--b__c-_d", "A b c d"),
        ("a/b-c/d", "D"),
        ("feature/ünïcode-name", "Ünïcode name"),
        ("ßeta", "SSeta"),
        ("émile-zola", "Émile zola"),
        ("日本-語", "日本 語"),
        ("UPPER-case", "UPPER case"),
        ("already Spaced", "Already Spaced"),
        ("1-two", "1 two"),
        ("dot.name-x", "Dot.name x"),
    ] {
        assert_eq!(humanize_branch(name), want, "{name:?}");
    }
}

/// A repo with an identity whose `origin` is a local bare clone, fetched.
fn fx() -> (TempDir, TempDir, PathBuf, String) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    (dir, bare_dir, path, head)
}

fn on_branch(path: &Path, name: &str) {
    common::run_git_ok(path, &["switch", "-q", "-c", name]);
}

fn draft(path: &Path, target: &str) -> Result<PullRequestDraft, GitError> {
    RepoSession::open(path).unwrap().pull_request_draft(target)
}

#[test]
fn trailing_whitespace_and_leading_blank_lines_are_trimmed_from_the_body() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/x");
    common::commit_file(
        &path,
        "x.txt",
        "x\n",
        "Subject  \n\n\n\nBody line  \nsecond\n\n\n  \n",
    );

    let got = draft(&path, &head).unwrap();

    assert_eq!(
        (got.title.as_str(), got.body.as_str(), got.ahead),
        ("Subject", "Body line  \nsecond", 1)
    );
}

#[test]
fn a_message_without_a_blank_line_puts_the_rest_in_the_body() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/x");
    common::commit_file(&path, "x.txt", "x\n", "Subject\nsecond line\nthird");

    let got = draft(&path, &head).unwrap();

    assert_eq!(
        (got.title.as_str(), got.body.as_str()),
        ("Subject", "second line\nthird")
    );
}

#[test]
fn a_branch_behind_its_target_is_zero_ahead() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/stale-work");
    common::run_git_ok(&path, &["switch", "-q", &head]);
    common::commit_file(&path, "new.txt", "n\n", "advance target");
    common::push_branch(&path, &head);
    common::fetch_remote(&path, "origin");
    common::run_git_ok(&path, &["switch", "-q", "feature/stale-work"]);

    let got = draft(&path, &head).unwrap();

    assert_eq!(
        got,
        PullRequestDraft {
            title: "Stale work".into(),
            body: String::new(),
            ahead: 0
        }
    );
}

#[test]
fn a_diverged_branch_counts_only_its_own_commits() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/diverged");
    common::commit_file(&path, "mine.txt", "m\n", "Mine only\n\nBecause");
    common::run_git_ok(&path, &["switch", "-q", &head]);
    common::commit_file(&path, "theirs.txt", "t\n", "Theirs");
    common::push_branch(&path, &head);
    common::fetch_remote(&path, "origin");
    common::run_git_ok(&path, &["switch", "-q", "feature/diverged"]);

    let got = draft(&path, &head).unwrap();

    assert_eq!(
        got,
        PullRequestDraft {
            title: "Mine only".into(),
            body: "Because".into(),
            ahead: 1
        }
    );
}

#[test]
fn a_slashed_target_branch_resolves_under_origin() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _head) = fx();
    common::run_git_ok(&path, &["branch", "release/1.0"]);
    common::push_branch(&path, "release/1.0");
    common::fetch_remote(&path, "origin");
    on_branch(&path, "feature/hotfix");
    common::commit_file(&path, "h.txt", "h\n", "Hotfix");

    let got = draft(&path, "release/1.0").unwrap();

    assert_eq!((got.title.as_str(), got.ahead), ("Hotfix", 1));
}

#[test]
fn a_local_only_branch_is_not_a_target() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _head) = fx();
    common::run_git_ok(&path, &["branch", "local-only"]);
    on_branch(&path, "feature/x");

    let err = draft(&path, "local-only").unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "origin/local-only"),
        "{err:?}"
    );
}

#[test]
fn a_target_that_is_a_prefix_of_a_remote_branch_is_not_found() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _head) = fx();
    common::run_git_ok(&path, &["branch", "release/1.0"]);
    common::push_branch(&path, "release/1.0");
    common::fetch_remote(&path, "origin");
    on_branch(&path, "feature/x");

    let err = draft(&path, "release").unwrap_err();

    assert!(
        matches!(err, GitError::RevisionNotFound(ref s) if s == "origin/release"),
        "{err:?}"
    );
}

#[test]
fn exactly_one_thousand_commits_ahead_is_one_thousand_and_humanizes_the_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, head) = fx();
    on_branch(&path, "feature/bulk-import");
    {
        let repo = git2::Repository::open(&path).unwrap();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        for i in 0..1000 {
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("c{i}"),
                &tree,
                &[&parent],
            )
            .unwrap();
        }
    }

    let got = draft(&path, &head).unwrap();

    assert_eq!((got.title.as_str(), got.ahead), ("Bulk import", 1000));
}
