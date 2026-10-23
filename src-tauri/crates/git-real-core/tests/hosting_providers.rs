//! The three providers against hand-written fixtures through a FakeTransport: URLs, JSON
//! mapping, paging, single-PR reads and the checkout plan.

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::{
    self, CheckoutPlan, CiState, Provider as P, PullRequest, RepoRef, Token, UserInfo,
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
