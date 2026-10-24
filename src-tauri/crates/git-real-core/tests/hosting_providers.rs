//! The three providers against hand-written fixtures through a FakeTransport: URLs, JSON
//! mapping, paging, single-PR reads and the checkout plan.

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::{
    self, CheckoutPlan, CiState, HostedRepoInfo, Issue, Method, NewPullRequest, Provider as P,
    PullRequest, RepoRef, Token, UserInfo,
};

macro_rules! fixture {
    ($n:literal) => {
        include_str!(concat!("fixtures/hosting/", $n))
    };
}

fn tok() -> Token {
    Token::new("t0k").unwrap()
}
fn repo(provider: P, host: &str, namespace: &str, name: &str) -> RepoRef {
    RepoRef {
        provider,
        host: host.into(),
        namespace: namespace.into(),
        name: name.into(),
    }
}
/// The JSON of element `i` of a list fixture (Bitbucket's `values`), for single-PR reads.
fn element(list: &str, i: usize) -> String {
    let v: serde_json::Value = serde_json::from_str(list).unwrap();
    v.get("values").unwrap_or(&v)[i].to_string()
}

#[test]
fn current_user_for_each_provider() {
    let want = |avatar: &str| UserInfo {
        username: "octo".into(),
        display_name: Some("Octo Cat".into()),
        avatar_url: Some(avatar.into()),
    };
    let gh = FakeTransport::new().reply(200, fixture!("github_user.json"));
    assert_eq!(
        hosting::current_user(&gh, P::GitHub, "ghe.corp", &tok()).unwrap(),
        want("https://avatars.githubusercontent.com/u/1")
    );
    assert_eq!(gh.requests()[0].url, "https://ghe.corp/api/v3/user");
    let gl = FakeTransport::new().reply(200, fixture!("gitlab_user.json"));
    assert_eq!(
        hosting::current_user(&gl, P::GitLab, "gitlab.com", &tok()).unwrap(),
        want("https://gitlab.com/uploads/a.png")
    );
    assert_eq!(gl.requests()[0].url, "https://gitlab.com/api/v4/user");
    let bb = FakeTransport::new().reply(200, fixture!("bitbucket_user.json"));
    assert_eq!(
        hosting::current_user(&bb, P::Bitbucket, "bitbucket.org", &tok()).unwrap(),
        want("https://avatar.example/a.png")
    );
    assert_eq!(bb.requests()[0].url, "https://api.bitbucket.org/2.0/user");
    let nick = FakeTransport::new().reply(200, r#"{"nickname":"nick"}"#);
    assert_eq!(
        hosting::current_user(&nick, P::Bitbucket, "bitbucket.org", &tok()).unwrap(),
        UserInfo {
            username: "nick".into(),
            display_name: None,
            avatar_url: None
        }
    );
    let gh_no_name = FakeTransport::new().reply(200, r#"{"login":"octo","name":null}"#);
    assert_eq!(
        hosting::current_user(&gh_no_name, P::GitHub, "github.com", &tok())
            .unwrap()
            .display_name,
        None
    );
}

#[test]
fn every_provider_sends_a_bearer_token() {
    for (p, host, body) in [
        (P::GitLab, "gitlab.com", fixture!("gitlab_user.json")),
        (
            P::Bitbucket,
            "bitbucket.org",
            fixture!("bitbucket_user.json"),
        ),
    ] {
        let t = FakeTransport::new().reply(200, body);
        hosting::current_user(&t, p, host, &tok()).unwrap();
        let req = &t.requests()[0];
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("authorization") && v == "Bearer t0k"),
            "{p:?}"
        );
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("accept") && v == "application/json"),
            "{p:?}"
        );
    }
}

#[test]
fn github_lists_pull_requests() {
    let t = FakeTransport::new().reply(200, fixture!("github_pulls.json"));
    let prs = hosting::list_pull_requests(
        &t,
        &repo(P::GitHub, "github.com", "gorlox", "test-repo"),
        &tok(),
        2,
    )
    .unwrap();
    assert_eq!(
        t.requests()[0].url,
        "https://api.github.com/repos/gorlox/test-repo/pulls?state=open&sort=updated&direction=desc&per_page=50&page=2"
    );
    assert_eq!(
        prs,
        vec![
            PullRequest {
                number: 12,
                title: "Add login".into(),
                author: "alice".into(),
                source_branch: "feature/login".into(),
                target_branch: "main".into(),
                from_fork: false,
                fork_clone_url: None,
                draft: false,
                ci_state: CiState::None,
                updated_at: 1792497600,
                web_url: "https://github.com/gorlox/test-repo/pull/12".into()
            },
            PullRequest {
                number: 9,
                title: "Fix typo".into(),
                author: "bob".into(),
                source_branch: "main".into(),
                target_branch: "main".into(),
                from_fork: true,
                fork_clone_url: Some("https://github.com/bob/test-repo.git".into()),
                draft: true,
                ci_state: CiState::None,
                updated_at: 1792398615,
                web_url: "https://github.com/gorlox/test-repo/pull/9".into()
            },
        ]
    );
}

#[test]
fn github_a_deleted_fork_is_from_fork_without_a_url() {
    let body = r#"[{"number":1,"title":"t","user":{"login":"a"},"updated_at":"2026-10-20T12:00:00Z","html_url":"https://github.com/o/r/pull/1","head":{"ref":"x","repo":null},"base":{"ref":"main","repo":{"full_name":"o/r"}}}]"#;
    let prs = hosting::list_pull_requests(
        &FakeTransport::new().reply(200, body),
        &repo(P::GitHub, "github.com", "o", "r"),
        &tok(),
        1,
    )
    .unwrap();
    assert!(prs[0].from_fork && prs[0].fork_clone_url.is_none() && !prs[0].draft);
}

#[test]
fn gitlab_lists_merge_requests_with_an_encoded_project_path() {
    let t = FakeTransport::new().reply(200, fixture!("gitlab_merge_requests.json"));
    let prs = hosting::list_pull_requests(
        &t,
        &repo(P::GitLab, "gitlab.com", "group/sub", "proj"),
        &tok(),
        1,
    )
    .unwrap();
    assert_eq!(
        t.requests()[0].url,
        "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50&page=1"
    );
    assert_eq!(
        (prs[0].number, prs[0].from_fork, prs[0].updated_at),
        (5, false, 1792497600)
    );
    assert_eq!(
        (
            prs[1].number,
            prs[1].from_fork,
            prs[1].draft,
            prs[1].fork_clone_url.as_deref()
        ),
        (4, true, true, None)
    );
    assert_eq!(prs[1].updated_at, 1792391415);
    assert_eq!(
        prs[1].web_url,
        "https://gitlab.com/group/sub/proj/-/merge_requests/4"
    );
}

#[test]
fn bitbucket_lists_pull_requests_from_values() {
    let t = FakeTransport::new().reply(200, fixture!("bitbucket_pullrequests.json"));
    let prs = hosting::list_pull_requests(
        &t,
        &repo(P::Bitbucket, "bitbucket.org", "ws", "repo"),
        &tok(),
        3,
    )
    .unwrap();
    assert_eq!(
        t.requests()[0].url,
        "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?state=OPEN&sort=-updated_on&pagelen=50&page=3"
    );
    assert_eq!(
        (
            prs[0].number,
            prs[0].author.as_str(),
            prs[0].from_fork,
            prs[0].draft
        ),
        (3, "alice", false, false)
    );
    assert_eq!(
        (
            prs[1].number,
            prs[1].author.as_str(),
            prs[1].from_fork,
            prs[1].draft
        ),
        (2, "Bob B", true, true)
    );
    assert_eq!(
        prs[1].fork_clone_url.as_deref(),
        Some("https://bitbucket.org/bob/repo.git")
    );
    assert_eq!(prs[0].updated_at, 1792497600);
}

#[test]
fn bitbucket_refuses_a_suspicious_fork_name_as_a_clone_url() {
    let body = r#"{"values":[{"id":1,"title":"t","author":{},"source":{"branch":{"name":"x"},"repository":{"full_name":"-c/x y"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/repo"}},"updated_on":"2026-10-20T12:00:00Z","links":{"html":{"href":"https://bitbucket.org/ws/repo/pull-requests/1"}}}]}"#;
    let prs = hosting::list_pull_requests(
        &FakeTransport::new().reply(200, body),
        &repo(P::Bitbucket, "bitbucket.org", "ws", "repo"),
        &tok(),
        1,
    )
    .unwrap();
    assert_eq!(
        (
            prs[0].from_fork,
            prs[0].fork_clone_url.as_deref(),
            prs[0].author.as_str()
        ),
        (true, None, "")
    );
}

#[test]
fn get_pull_request_reads_one_item_for_each_provider() {
    let cases = [
        (
            repo(P::GitHub, "github.com", "gorlox", "test-repo"),
            element(fixture!("github_pulls.json"), 1),
            9,
            "https://api.github.com/repos/gorlox/test-repo/pulls/9",
        ),
        (
            repo(P::GitLab, "gitlab.com", "group/sub", "proj"),
            element(fixture!("gitlab_merge_requests.json"), 1),
            4,
            "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests/4",
        ),
        (
            repo(P::Bitbucket, "bitbucket.org", "ws", "repo"),
            element(fixture!("bitbucket_pullrequests.json"), 1),
            2,
            "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/2",
        ),
    ];
    for (r, body, n, url) in cases {
        let t = FakeTransport::new().reply(200, &body);
        let pr = hosting::get_pull_request(&t, &r, &tok(), n).unwrap();
        assert_eq!(
            (pr.number, pr.from_fork, t.requests()[0].url.as_str()),
            (n, true, url)
        );
    }
}

#[test]
fn a_list_missing_a_required_field_is_an_unexpected_response() {
    let err = hosting::list_pull_requests(
        &FakeTransport::new().reply(200, r#"[{"number":1}]"#),
        &repo(P::GitHub, "github.com", "o", "r"),
        &tok(),
        1,
    )
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com")
    );
    let bad_time = r#"[{"iid":1,"title":"t","author":{"username":"a"},"source_branch":"x","target_branch":"main","source_project_id":1,"target_project_id":1,"updated_at":"yesterday","web_url":"https://gitlab.com/g/p/-/merge_requests/1"}]"#;
    assert!(matches!(
        hosting::list_pull_requests(
            &FakeTransport::new().reply(200, bad_time),
            &repo(P::GitLab, "gitlab.com", "g", "p"),
            &tok(),
            1
        )
        .unwrap_err(),
        GitError::HostingUnreachable { .. }
    ));
}

fn pr(from_fork: bool, fork: Option<&str>, src: &str) -> PullRequest {
    PullRequest {
        number: 7,
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
fn checkout_plans() {
    for p in [P::GitHub, P::GitLab, P::Bitbucket] {
        assert_eq!(
            hosting::checkout_plan(p, &pr(false, None, "feat")).unwrap(),
            CheckoutPlan::TrackBranch {
                branch: "feat".into()
            }
        );
    }
    assert_eq!(
        hosting::checkout_plan(P::GitHub, &pr(true, None, "main")).unwrap(),
        CheckoutPlan::FetchHead {
            source: "origin".into(),
            refspec: "refs/pull/7/head".into()
        }
    );
    assert_eq!(
        hosting::checkout_plan(P::GitLab, &pr(true, None, "main")).unwrap(),
        CheckoutPlan::FetchHead {
            source: "origin".into(),
            refspec: "refs/merge-requests/7/head".into()
        }
    );
    assert_eq!(
        hosting::checkout_plan(
            P::Bitbucket,
            &pr(true, Some("https://bitbucket.org/bob/repo.git"), "fix")
        )
        .unwrap(),
        CheckoutPlan::FetchHead {
            source: "https://bitbucket.org/bob/repo.git".into(),
            refspec: "refs/heads/fix".into()
        }
    );
    assert!(matches!(
        hosting::checkout_plan(P::Bitbucket, &pr(true, None, "fix")),
        Err(GitError::HostingNotFound)
    ));
    assert!(matches!(
        hosting::checkout_plan(
            P::Bitbucket,
            &pr(true, Some("https://bitbucket.org/b/r.git"), "a..b")
        ),
        Err(GitError::InvalidBranchName(_))
    ));
    assert!(matches!(
        hosting::checkout_plan(P::GitHub, &pr(false, None, "-x")),
        Err(GitError::InvalidBranchName(_))
    ));
}

// --- GR-13b: repository info, issues, create pull request ---

/// `percent_encode` of the hosting layer (it is crate-private): everything but `A-Za-z0-9-._~`
/// becomes `%XX`, so the expectations below are computed from the documented rule.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn header<'a>(req: &'a hosting::Request, name: &str) -> Vec<&'a str> {
    req.headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
        .collect()
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

fn info(r: &RepoRef, body: &str) -> Result<HostedRepoInfo, GitError> {
    hosting::repo_info(&FakeTransport::new().reply(200, body), r, &tok())
}

// Repository info: the default branch and whether issues are on, per provider.
#[test]
fn repo_info_for_each_provider() {
    let cases = [
        (
            gh(),
            fixture!("github_repo.json"),
            HostedRepoInfo {
                default_branch: Some("main".into()),
                issues_enabled: true,
            },
            "https://api.github.com/repos/gorlox/test-repo",
        ),
        (
            gl(),
            fixture!("gitlab_project.json"),
            HostedRepoInfo {
                default_branch: Some("develop".into()),
                issues_enabled: false,
            },
            "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj",
        ),
        (
            bb(),
            fixture!("bitbucket_repo.json"),
            HostedRepoInfo {
                default_branch: Some("master".into()),
                issues_enabled: false,
            },
            "https://api.bitbucket.org/2.0/repositories/ws/repo",
        ),
    ];
    for (r, body, want, url) in cases {
        let t = FakeTransport::new().reply(200, body);
        assert_eq!(hosting::repo_info(&t, &r, &tok()).unwrap(), want, "{url}");
        let req = &t.requests()[0];
        assert_eq!((req.method, req.url.as_str()), (Method::Get, url));
    }
}

#[test]
fn repo_info_defaults() {
    // GitHub: no default_branch is not a repository answer.
    assert!(matches!(
        info(&gh(), "{}").unwrap_err(),
        GitError::HostingUnreachable { ref message } if message == "unexpected response from github.com"
    ));
    let got = |r: &RepoRef, body: &str| {
        let i = info(r, body).unwrap();
        (i.default_branch, i.issues_enabled)
    };
    assert_eq!(
        got(&gh(), r#"{"default_branch":"main"}"#),
        (Some("main".to_owned()), true)
    );
    assert_eq!(got(&gl(), r#"{"default_branch":null}"#), (None, true));
    assert_eq!(
        got(&gl(), r#"{"issues_access_level":"private"}"#),
        (None, true)
    );
    assert_eq!(got(&gl(), r#"{"issues_enabled":false}"#), (None, false));
    assert_eq!(got(&bb(), r#"{"mainbranch":null}"#), (None, true));
    assert_eq!(got(&bb(), "{}"), (None, true));
}

// Issue lists: URL, JSON mapping, pull requests skipped on GitHub.
#[test]
fn github_lists_issues_from_search_and_skips_pull_requests() {
    let t = FakeTransport::new().reply(200, fixture!("github_search_issues.json"));
    let issues = hosting::list_issues(&t, &gh(), &tok(), "", 1).unwrap();
    assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), [7, 5]);
    assert_eq!(
        issues[0],
        Issue {
            number: 7,
            title: "Login fails".into(),
            author: "alice".into(),
            labels: vec!["bug".into(), "P1".into()],
            updated_at: 1792497600,
            web_url: "https://github.com/gorlox/test-repo/issues/7".into(),
        }
    );
    let req = &t.requests()[0];
    assert_eq!(
        req.url,
        "https://api.github.com/search/issues?q=repo%3Agorlox%2Ftest-repo%20is%3Aissue%20is%3Aopen&sort=updated&order=desc&per_page=50&page=1"
    );
    assert_eq!(header(req, "accept"), ["application/vnd.github+json"]);
    assert_eq!(header(req, "x-github-api-version"), ["2022-11-28"]);
}

#[test]
fn gitlab_lists_issues() {
    let t = FakeTransport::new().reply(200, fixture!("gitlab_issues.json"));
    let issues = hosting::list_issues(&t, &gl(), &tok(), "", 2).unwrap();
    assert_eq!(
        issues,
        vec![Issue {
            number: 11,
            title: "Crash on start".into(),
            author: "alice".into(),
            labels: vec!["bug".into()],
            updated_at: 1792497600,
            web_url: "https://gitlab.com/group/sub/proj/-/issues/11".into(),
        }]
    );
    assert_eq!(
        t.requests()[0].url,
        "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/issues?state=opened&order_by=updated_at&sort=desc&per_page=50&page=2"
    );
}

#[test]
fn bitbucket_lists_issues_from_values() {
    let t = FakeTransport::new().reply(200, fixture!("bitbucket_issues.json"));
    let issues = hosting::list_issues(&t, &bb(), &tok(), "", 1).unwrap();
    assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), [2, 1]);
    assert_eq!(
        (issues[0].labels.clone(), issues[0].author.as_str()),
        (vec!["bug".to_owned()], "alice")
    );
    assert_eq!(
        (issues[1].author.as_str(), issues[1].labels.is_empty()),
        ("", true)
    );
    assert_eq!(
        (issues[0].updated_at, issues[0].web_url.as_str()),
        (1792497600, "https://bitbucket.org/ws/repo/issues/2")
    );
    assert_eq!(
        t.requests()[0].url,
        "https://api.bitbucket.org/2.0/repositories/ws/repo/issues?pagelen=50&page=1&sort=-updated_on&q=%28state%3D%22new%22%20OR%20state%3D%22open%22%29"
    );
}

// Review Focus 3: a query with quotes, `#`, `&`, a backslash and spaces is percent-encoded on
// every provider, and Bitbucket strips `"` and `\` so the `title ~ "..."` literal cannot close.
#[test]
fn issue_queries_are_percent_encoded_for_every_provider() {
    let q = r#" login "fails" & #7 \"#;
    let url = |r: &RepoRef, query: &str, body: &str| {
        let t = FakeTransport::new().reply(200, body);
        hosting::list_issues(&t, r, &tok(), query, 1).unwrap();
        t.requests()[0].url.clone()
    };

    let github = url(&gh(), q, r#"{"items":[]}"#);
    assert!(
        github.starts_with("https://api.github.com/search/issues?q=repo%3Agorlox%2Ftest-repo%20is%3Aissue%20is%3Aopen%20login%20%22fails%22%20%26%20%237%20%5C&sort=updated"),
        "{github}"
    );
    assert_eq!(
        enc(r#"repo:gorlox/test-repo is:issue is:open login "fails" & #7 \"#),
        "repo%3Agorlox%2Ftest-repo%20is%3Aissue%20is%3Aopen%20login%20%22fails%22%20%26%20%237%20%5C"
    );

    let gitlab = url(&gl(), q, "[]");
    assert!(
        gitlab.ends_with("&search=login%20%22fails%22%20%26%20%237%20%5C"),
        "{gitlab}"
    );

    let bitbucket = url(&bb(), q, r#"{"values":[]}"#);
    let filter = format!(
        r#"(state="new" OR state="open") AND title ~ "{}""#,
        "login fails & #7 "
    );
    assert!(
        bitbucket.ends_with(&format!("&q={}", enc(&filter))),
        "{bitbucket}"
    );
    assert!(!bitbucket.contains("%5C"), "{bitbucket}");
}

#[test]
fn an_all_whitespace_issue_query_sends_the_no_query_url() {
    for (r, body) in [
        (gh(), r#"{"items":[]}"#),
        (gl(), "[]"),
        (bb(), r#"{"values":[]}"#),
    ] {
        let blank = FakeTransport::new().reply(200, body);
        hosting::list_issues(&blank, &r, &tok(), " \t ", 1).unwrap();
        let none = FakeTransport::new().reply(200, body);
        hosting::list_issues(&none, &r, &tok(), "", 1).unwrap();
        assert_eq!(blank.requests()[0].url, none.requests()[0].url, "{r:?}");
    }
}

#[test]
fn an_issue_list_missing_a_required_field_is_an_unexpected_response() {
    for (r, body, host) in [
        (gh(), r#"{"items":[{"number":1}]}"#, "github.com"),
        (gl(), r#"[{"iid":1}]"#, "gitlab.com"),
        (bb(), r#"{"values":[{"id":1}]}"#, "bitbucket.org"),
    ] {
        let err = hosting::list_issues(&FakeTransport::new().reply(200, body), &r, &tok(), "", 1)
            .unwrap_err();
        assert!(
            matches!(err, GitError::HostingUnreachable { ref message } if *message == format!("unexpected response from {host}")),
            "{host}: {err:?}"
        );
    }
}

// Create pull request: method, URL, headers and the exact JSON body per provider.
fn new_pr() -> NewPullRequest {
    NewPullRequest {
        title: "Add login".into(),
        body: "Why\n\nDetails".into(),
        source_branch: "feature/login".into(),
        target_branch: "main".into(),
    }
}

fn body_json(req: &hosting::Request) -> serde_json::Value {
    serde_json::from_str(req.body.as_deref().unwrap()).unwrap()
}

#[test]
fn create_pull_request_for_each_provider() {
    // GitHub
    let t = FakeTransport::new().reply(201, &element(fixture!("github_pulls.json"), 0));
    let created = hosting::create_pull_request(&t, &gh(), &tok(), &new_pr()).unwrap();
    assert_eq!(created.number, 12);
    let req = &t.requests()[0];
    assert_eq!(
        (req.method, req.url.as_str()),
        (
            Method::Post,
            "https://api.github.com/repos/gorlox/test-repo/pulls"
        )
    );
    assert_eq!(header(req, "content-type"), ["application/json"]);
    assert_eq!(header(req, "accept"), ["application/vnd.github+json"]);
    assert_eq!(header(req, "x-github-api-version"), ["2022-11-28"]);
    assert_eq!(
        body_json(req),
        serde_json::json!({"title":"Add login","body":"Why\n\nDetails","head":"feature/login","base":"main"})
    );

    // GitLab
    let t = FakeTransport::new().reply(201, &element(fixture!("gitlab_merge_requests.json"), 0));
    let created = hosting::create_pull_request(&t, &gl(), &tok(), &new_pr()).unwrap();
    assert_eq!(created.number, 5);
    let req = &t.requests()[0];
    assert_eq!(
        (req.method, req.url.as_str()),
        (
            Method::Post,
            "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests"
        )
    );
    assert_eq!(header(req, "content-type"), ["application/json"]);
    assert_eq!(
        body_json(req),
        serde_json::json!({"source_branch":"feature/login","target_branch":"main","title":"Add login","description":"Why\n\nDetails"})
    );

    // Bitbucket
    let t = FakeTransport::new().reply(201, &element(fixture!("bitbucket_pullrequests.json"), 0));
    let created = hosting::create_pull_request(&t, &bb(), &tok(), &new_pr()).unwrap();
    assert_eq!(created.number, 3);
    let req = &t.requests()[0];
    assert_eq!(
        (req.method, req.url.as_str()),
        (
            Method::Post,
            "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests"
        )
    );
    assert_eq!(header(req, "content-type"), ["application/json"]);
    assert_eq!(
        body_json(req),
        serde_json::json!({"title":"Add login","description":"Why\n\nDetails","source":{"branch":{"name":"feature/login"}},"destination":{"branch":{"name":"main"}}})
    );
}

#[test]
fn create_pull_request_refuses_bad_branch_names_before_any_request() {
    let bad_source = NewPullRequest {
        source_branch: "-x".into(),
        ..new_pr()
    };
    let bad_target = NewPullRequest {
        target_branch: "a b".into(),
        ..new_pr()
    };
    for new in [bad_source, bad_target] {
        let t = FakeTransport::new();
        let err = hosting::create_pull_request(&t, &gh(), &tok(), &new).unwrap_err();
        assert!(matches!(err, GitError::InvalidBranchName(_)), "{err:?}");
        assert!(t.requests().is_empty());
    }
}

#[test]
fn create_pull_request_rejection_passes_through() {
    let body = r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:feat."}]}"#;
    let err = hosting::create_pull_request(
        &FakeTransport::new().reply(422, body),
        &gh(),
        &tok(),
        &new_pr(),
    )
    .unwrap_err();
    assert!(
        matches!(err, GitError::HostingRejected { ref message } if message == "A pull request already exists for o:feat.")
    );
}

// Wire shapes: camelCase on the way out, and the create request on the way in.
#[test]
fn issue_and_repo_info_serialize_camel_case() {
    assert_eq!(
        serde_json::to_value(HostedRepoInfo {
            default_branch: None,
            issues_enabled: true
        })
        .unwrap(),
        serde_json::json!({"defaultBranch":null,"issuesEnabled":true})
    );
    let issue = serde_json::to_value(Issue {
        number: 1,
        title: "t".into(),
        author: "a".into(),
        labels: vec![],
        updated_at: 2,
        web_url: "u".into(),
    })
    .unwrap();
    let mut keys: Vec<&str> = issue
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["author", "labels", "number", "title", "updatedAt", "webUrl"]
    );
    assert_eq!(
        serde_json::from_str::<NewPullRequest>(
            r#"{"title":"t","body":"","sourceBranch":"s","targetBranch":"m"}"#
        )
        .unwrap(),
        NewPullRequest {
            title: "t".into(),
            body: String::new(),
            source_branch: "s".into(),
            target_branch: "m".into(),
        }
    );
}
