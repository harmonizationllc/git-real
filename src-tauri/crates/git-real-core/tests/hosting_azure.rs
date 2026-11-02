//! Azure DevOps (GR-41) against hand-written REST 7.1 fixtures through a FakeTransport: Basic PAT
//! auth, URLs with `api-version=7.1`, JSON mapping, client-side paging, the scope-naming auth
//! messages and the fork checkout plan.

mod common;

use common::FakeTransport;
use git_real_core::GitError;
use git_real_core::hosting::azure::{pull_request_web_url, work_item_web_url};
use git_real_core::hosting::http::parse_timestamp;
use git_real_core::hosting::{
    self, Account, AuthScheme, CheckoutPlan, CiState, HostedRepoInfo, Method, NewPullRequest,
    Provider as P, PullRequest, RepoRef, Token, UserInfo,
};
use serde_json::json;

macro_rules! fixture {
    ($n:literal) => {
        include_str!(concat!("fixtures/hosting/", $n))
    };
}

const BASE: &str = "https://dev.azure.com/contoso";
const REPO_API: &str =
    "https://dev.azure.com/contoso/My%20Project/_apis/git/repositories/my%20repo";
const SCOPE_CODE: &str =
    "The token can't read this repository. It needs the Code (Read & write) scope.";
const SCOPE_PR_CREATE: &str =
    "The token can't open pull requests. It needs the Code (Read & write) scope.";
const SCOPE_WORK: &str = "The token can't read work items. It needs the Work items (Read) scope.";
const SCOPE_PROJECT: &str =
    "The token can't list projects. It needs the Project and team (Read) scope.";

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
fn ado() -> RepoRef {
    repo(
        P::AzureDevOps,
        "dev.azure.com/contoso",
        "My Project",
        "my repo",
    )
}
fn account() -> Account {
    Account::new(
        P::AzureDevOps,
        "dev.azure.com/contoso",
        UserInfo {
            username: "jason@example.com".into(),
            display_name: None,
            avatar_url: None,
        },
    )
}
fn header<'a>(req: &'a hosting::Request, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}
fn auth(message: &str) -> GitError {
    GitError::HostingAuth {
        message: message.into(),
    }
}
fn unexpected() -> GitError {
    GitError::HostingUnreachable {
        message: "unexpected response from dev.azure.com/contoso".into(),
    }
}
/// `GitError` has no `PartialEq`: errors are compared by their `Debug` text.
fn err<T: std::fmt::Debug>(r: Result<T, GitError>) -> String {
    format!("{:?}", r.unwrap_err())
}
fn e(want: GitError) -> String {
    format!("{want:?}")
}
/// The JSON of element `i` of a `{ "value": [...] }` fixture, edited by `f`.
fn element(list: &str, i: usize, f: impl FnOnce(&mut serde_json::Value)) -> String {
    let v: serde_json::Value = serde_json::from_str(list).unwrap();
    let mut e = v["value"][i].clone();
    f(&mut e);
    e.to_string()
}
fn wrap(items: Vec<String>) -> String {
    format!(
        r#"{{"count":{},"value":[{}]}}"#,
        items.len(),
        items.join(",")
    )
}
fn prs(t: &FakeTransport) -> Result<Vec<PullRequest>, GitError> {
    hosting::list_pull_requests(t, &ado(), &tok(), 1)
}

// --- provider basics ---

#[test]
fn azure_provider_strings_and_scheme() {
    assert_eq!(serde_json::to_value(P::AzureDevOps).unwrap(), "azure");
    assert_eq!(
        serde_json::from_value::<P>("azure".into()).unwrap(),
        P::AzureDevOps
    );
    assert_eq!(P::AzureDevOps.as_str(), "azure");
    assert_eq!(P::AzureDevOps.default_host(), "dev.azure.com");
    assert_eq!(P::AzureDevOps.api_base("dev.azure.com/contoso"), BASE);
    assert_eq!(P::AzureDevOps.git_username(), "git-real");
    assert_eq!(P::AzureDevOps.auth_scheme(), AuthScheme::BasicPat);
    for p in [P::GitHub, P::GitLab, P::Bitbucket] {
        assert_eq!(p.auth_scheme(), AuthScheme::Bearer, "{p:?}");
    }
}

// --- current user ---

#[test]
fn current_user_reads_connection_data_with_basic_auth() {
    let t = FakeTransport::new().reply(200, fixture!("azure_connection_data.json"));
    assert_eq!(
        hosting::current_user(&t, P::AzureDevOps, "dev.azure.com/contoso", &tok()).unwrap(),
        UserInfo {
            username: "jason@example.com".into(),
            display_name: Some("Jason Harmon".into()),
            avatar_url: None,
        }
    );
    let req = &t.requests()[0];
    assert_eq!(req.method, Method::Get);
    assert_eq!(
        req.url,
        "https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1"
    );
    assert_eq!(header(req, "authorization"), Some("Basic OnQwaw=="));
    assert_eq!(header(req, "accept"), Some("application/json"));
    assert!(!format!("{req:?}").contains("OnQwaw=="));

    let no_account =
        r#"{"authenticatedUser":{"providerDisplayName":"Jason Harmon","properties":{}}}"#;
    let t = FakeTransport::new().reply(200, no_account);
    assert_eq!(
        hosting::current_user(&t, P::AzureDevOps, "dev.azure.com/contoso", &tok()).unwrap(),
        UserInfo {
            username: "Jason Harmon".into(),
            display_name: Some("Jason Harmon".into()),
            avatar_url: None,
        }
    );
}

#[test]
fn current_user_without_any_name_is_unexpected() {
    let t = FakeTransport::new().reply(200, r#"{"authenticatedUser":{"id":"x"}}"#);
    assert_eq!(
        err(hosting::current_user(
            &t,
            P::AzureDevOps,
            "dev.azure.com/contoso",
            &tok()
        )),
        e(unexpected())
    );
}

#[test]
fn current_user_203_names_the_organization() {
    let want = e(auth(
        "The token can't reach the organization contoso. Check that it is current and was created there.",
    ));
    for status in [203, 401] {
        let t = FakeTransport::new().reply(status, "<html>sign in</html>");
        assert_eq!(
            err(hosting::current_user(
                &t,
                P::AzureDevOps,
                "dev.azure.com/contoso",
                &tok()
            )),
            want,
            "{status}"
        );
    }
    // A bare organization as host still names it.
    let t = FakeTransport::new().reply(401, "{}");
    assert_eq!(
        err(hosting::current_user(&t, P::AzureDevOps, "contoso", &tok())),
        want
    );
    let t = FakeTransport::new().reply(404, "{}");
    assert_eq!(
        err(hosting::current_user(
            &t,
            P::AzureDevOps,
            "dev.azure.com/contoso",
            &tok()
        )),
        e(GitError::HostingNotFound)
    );
}

// --- pull requests ---

#[test]
fn list_pull_requests_builds_url_and_maps_fields() {
    let t = FakeTransport::new().reply(200, fixture!("azure_pullrequests.json"));
    let list = hosting::list_pull_requests(&t, &ado(), &tok(), 2).unwrap();
    let req = &t.requests()[0];
    assert_eq!(
        req.url,
        format!(
            "{REPO_API}/pullrequests?searchCriteria.status=active&$top=50&$skip=50&api-version=7.1"
        )
    );
    assert_eq!(header(req, "authorization"), Some("Basic OnQwaw=="));
    let r = ado();
    assert_eq!(
        list,
        vec![
            PullRequest {
                number: 22,
                title: "Add the sidebar".into(),
                author: "Jason Harmon".into(),
                source_branch: "topic".into(),
                target_branch: "main".into(),
                from_fork: false,
                fork_clone_url: None,
                draft: false,
                ci_state: CiState::None,
                updated_at: parse_timestamp("2026-10-20T12:00:00.1234567Z").unwrap(),
                web_url: pull_request_web_url(&r, 22),
            },
            PullRequest {
                number: 21,
                title: "WIP: rework the toolbar".into(),
                author: "sam@example.com".into(),
                source_branch: "wip/toolbar".into(),
                target_branch: "main".into(),
                from_fork: false,
                fork_clone_url: None,
                draft: true,
                ci_state: CiState::None,
                updated_at: parse_timestamp("2026-10-19T08:30:00Z").unwrap(),
                web_url: pull_request_web_url(&r, 21),
            },
            PullRequest {
                number: 17,
                title: "Fix the crash on open".into(),
                author: "Alex Fork".into(),
                source_branch: "feature".into(),
                target_branch: "main".into(),
                from_fork: true,
                fork_clone_url: Some(
                    "https://dev.azure.com/contoso/My%20Project/_git/fork-repo".into()
                ),
                draft: false,
                ci_state: CiState::None,
                updated_at: parse_timestamp("2026-10-18T09:15:42.5Z").unwrap(),
                web_url: pull_request_web_url(&r, 17),
            },
        ]
    );
    assert_eq!(
        list[0].web_url,
        "https://dev.azure.com/contoso/My%20Project/_git/my%20repo/pullrequest/22"
    );
}

#[test]
fn page_one_skips_nothing() {
    let t = FakeTransport::new().reply(200, r#"{"value":[],"count":0}"#);
    assert_eq!(prs(&t).unwrap(), vec![]);
    assert!(t.requests()[0].url.contains("&$top=50&$skip=0&"));
}

#[test]
fn a_pull_request_without_any_author_name_or_draft_flag_has_defaults() {
    let body = element(fixture!("azure_pullrequests.json"), 0, |e| {
        e["createdBy"] = json!({ "id": "x" });
        e.as_object_mut().unwrap().remove("isDraft");
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    let pr = &prs(&t).unwrap()[0];
    assert_eq!((pr.author.as_str(), pr.draft), ("", false));
    let body = element(fixture!("azure_pullrequests.json"), 0, |e| {
        e.as_object_mut().unwrap().remove("createdBy");
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    assert_eq!(prs(&t).unwrap()[0].author, "");
}

#[test]
fn a_source_ref_that_is_not_a_branch_is_unexpected() {
    for field in ["sourceRefName", "targetRefName"] {
        let body = element(fixture!("azure_pullrequests.json"), 0, |e| {
            e[field] = json!("refs/tags/v1");
        });
        let t = FakeTransport::new().reply(200, &wrap(vec![body]));
        assert_eq!(err(prs(&t)), e(unexpected()), "{field}");
    }
}

#[test]
fn an_unparsable_creation_date_is_unexpected() {
    let body = element(fixture!("azure_pullrequests.json"), 0, |e| {
        e["creationDate"] = json!("yesterday");
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    assert_eq!(err(prs(&t)), e(unexpected()));
}

#[test]
fn a_fork_url_on_another_host_is_dropped() {
    for remote in [
        json!("https://evil.example/x"),
        json!("https://dev.azure.com/other/p/_git/r"),
        json!("ssh://dev.azure.com/contoso/p/_git/r"),
        json!(null),
    ] {
        let body = element(fixture!("azure_pullrequests.json"), 2, |e| {
            e["forkSource"]["repository"]["remoteUrl"] = remote.clone();
        });
        let t = FakeTransport::new().reply(200, &wrap(vec![body]));
        let pr = prs(&t).unwrap().remove(0);
        assert!(pr.from_fork, "{remote}");
        assert_eq!(pr.fork_clone_url, None, "{remote}");
        assert_eq!(
            err(hosting::checkout_plan(P::AzureDevOps, &pr)),
            e(GitError::HostingNotFound)
        );
    }
    let body = element(fixture!("azure_pullrequests.json"), 2, |e| {
        e["forkSource"] = json!({ "name": "refs/heads/feature" });
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    let pr = prs(&t).unwrap().remove(0);
    assert_eq!((pr.from_fork, pr.fork_clone_url), (true, None));
}

#[test]
fn a_fork_url_in_another_case_of_the_organization_is_kept() {
    let body = element(fixture!("azure_pullrequests.json"), 2, |e| {
        e["forkSource"]["repository"]["remoteUrl"] =
            json!("https://Contoso@dev.azure.com/Contoso/My%20Project/_git/fork-repo");
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    assert_eq!(
        prs(&t).unwrap()[0].fork_clone_url.as_deref(),
        Some("https://dev.azure.com/Contoso/My%20Project/_git/fork-repo")
    );
}

#[test]
fn a_fork_url_on_the_organizations_visualstudio_host_is_kept() {
    let body = element(fixture!("azure_pullrequests.json"), 2, |e| {
        e["forkSource"]["repository"]["remoteUrl"] =
            json!("https://contoso.visualstudio.com/My%20Project/_git/fork-repo");
    });
    let t = FakeTransport::new().reply(200, &wrap(vec![body]));
    assert_eq!(
        prs(&t).unwrap()[0].fork_clone_url.as_deref(),
        Some("https://contoso.visualstudio.com/My%20Project/_git/fork-repo")
    );
}

#[test]
fn checkout_plan_fetches_the_fork_branch() {
    let t = FakeTransport::new().reply(200, fixture!("azure_pullrequests.json"));
    let list = prs(&t).unwrap();
    assert_eq!(
        hosting::checkout_plan(P::AzureDevOps, &list[2]).unwrap(),
        CheckoutPlan::FetchHead {
            source: "https://dev.azure.com/contoso/My%20Project/_git/fork-repo".into(),
            refspec: "refs/heads/feature".into(),
        }
    );
    assert_eq!(
        hosting::checkout_plan(P::AzureDevOps, &list[0]).unwrap(),
        CheckoutPlan::TrackBranch {
            branch: "topic".into()
        }
    );
}

#[test]
fn get_pull_request_reads_one() {
    let body = element(fixture!("azure_pullrequests.json"), 0, |_| {});
    let t = FakeTransport::new().reply(200, &body);
    let pr = hosting::get_pull_request(&t, &ado(), &tok(), 22).unwrap();
    assert_eq!((pr.number, pr.source_branch.as_str()), (22, "topic"));
    assert_eq!(
        t.requests()[0].url,
        format!("{REPO_API}/pullrequests/22?api-version=7.1")
    );
    let t = FakeTransport::new().reply(203, "<html>sign in</html>");
    assert_eq!(
        err(hosting::get_pull_request(&t, &ado(), &tok(), 22)),
        e(auth(SCOPE_CODE))
    );
}

#[test]
fn a_401_on_pull_requests_names_the_code_scope() {
    for status in [401, 203, 403] {
        let t = FakeTransport::new().reply(status, "{}");
        assert_eq!(err(prs(&t)), e(auth(SCOPE_CODE)), "{status}");
    }
    let t = FakeTransport::new().reply(404, "{}");
    assert_eq!(err(prs(&t)), e(GitError::HostingNotFound));
    let t = FakeTransport::new().reply(429, "{}");
    assert!(matches!(prs(&t), Err(GitError::HostingRateLimited { .. })));
}

// --- repository info ---

#[test]
fn repo_info_strips_refs_heads_and_defaults_issues_on() {
    let t = FakeTransport::new().reply(200, fixture!("azure_repository.json"));
    assert_eq!(
        hosting::repo_info(&t, &ado(), &tok()).unwrap(),
        HostedRepoInfo {
            default_branch: Some("main".into()),
            issues_enabled: true,
        }
    );
    assert_eq!(t.requests()[0].url, format!("{REPO_API}?api-version=7.1"));
    let t = FakeTransport::new().reply(200, r#"{"id":"x","name":"my repo"}"#);
    assert_eq!(
        hosting::repo_info(&t, &ado(), &tok()).unwrap(),
        HostedRepoInfo {
            default_branch: None,
            issues_enabled: true,
        }
    );
    let t = FakeTransport::new().reply(200, r#"{"defaultBranch":"main"}"#);
    assert_eq!(err(hosting::repo_info(&t, &ado(), &tok())), e(unexpected()));
    let t = FakeTransport::new().reply(401, "{}");
    assert_eq!(
        err(hosting::repo_info(&t, &ado(), &tok())),
        e(auth(SCOPE_CODE))
    );
}

// --- create ---

fn new_pr() -> NewPullRequest {
    NewPullRequest {
        title: "T".into(),
        body: "B".into(),
        source_branch: "feat".into(),
        target_branch: "main".into(),
    }
}

#[test]
fn create_pull_request_posts_ref_names() {
    let created = element(fixture!("azure_pullrequests.json"), 0, |_| {});
    let t = FakeTransport::new().reply(201, &created);
    let pr = hosting::create_pull_request(&t, &ado(), &tok(), &new_pr()).unwrap();
    assert_eq!(pr.number, 22);
    let req = &t.requests()[0];
    assert_eq!(req.method, Method::Post);
    assert_eq!(req.url, format!("{REPO_API}/pullrequests?api-version=7.1"));
    assert_eq!(header(req, "authorization"), Some("Basic OnQwaw=="));
    assert_eq!(header(req, "content-type"), Some("application/json"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(req.body.as_deref().unwrap()).unwrap(),
        json!({"sourceRefName":"refs/heads/feat","targetRefName":"refs/heads/main","title":"T","description":"B"})
    );

    let t = FakeTransport::new().reply(
        409,
        r#"{"$id":"1","innerException":null,"message":"TF401179: An active pull request for the source and target branch already exists.","typeName":"Microsoft.TeamFoundation.Git.Server.GitPullRequestExistsException, Microsoft.TeamFoundation.Git.Server","typeKey":"GitPullRequestExistsException","errorCode":0,"eventId":3000}"#,
    );
    match hosting::create_pull_request(&t, &ado(), &tok(), &new_pr()) {
        Err(GitError::HostingRejected { message }) => {
            assert!(message.starts_with("TF401179"), "{message}")
        }
        other => panic!("{other:?}"),
    }
    for status in [401, 203] {
        let t = FakeTransport::new().reply(status, "{}");
        assert_eq!(
            err(hosting::create_pull_request(&t, &ado(), &tok(), &new_pr())),
            e(auth(SCOPE_PR_CREATE)),
            "{status}"
        );
    }
}

// --- work items ---

const WIQL_BASE: &str = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed'";
const ORDER: &str = " ORDER BY [System.ChangedDate] DESC";
const FIELDS: &str =
    "fields=System.Title,System.WorkItemType,System.Tags,System.CreatedBy,System.ChangedDate";

fn wiql_query(req: &hosting::Request) -> String {
    let body: serde_json::Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    body["query"].as_str().unwrap().to_owned()
}
fn wiql_ids(ids: impl IntoIterator<Item = u64>) -> String {
    let items: Vec<String> = ids
        .into_iter()
        .map(|id| {
            format!(
                r#"{{"id":{id},"url":"https://dev.azure.com/contoso/_apis/wit/workItems/{id}"}}"#
            )
        })
        .collect();
    format!(
        r#"{{"queryType":"flat","queryResultType":"workItem","workItems":[{}]}}"#,
        items.join(",")
    )
}

#[test]
fn list_issues_runs_wiql_then_batch_get_in_wiql_order() {
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_wiql.json"))
        .reply(200, fixture!("azure_workitems.json"));
    let list = hosting::list_issues(&t, &ado(), &tok(), "  ", 1).unwrap();
    let reqs = t.requests();
    assert_eq!(reqs[0].method, Method::Post);
    assert_eq!(
        reqs[0].url,
        "https://dev.azure.com/contoso/My%20Project/_apis/wit/wiql?$top=50&api-version=7.1"
    );
    assert_eq!(header(&reqs[0], "authorization"), Some("Basic OnQwaw=="));
    assert_eq!(wiql_query(&reqs[0]), format!("{WIQL_BASE}{ORDER}"));
    assert_eq!(reqs[1].method, Method::Get);
    assert_eq!(
        reqs[1].url,
        format!(
            "https://dev.azure.com/contoso/My%20Project/_apis/wit/workitems?ids=300,299,17&{FIELDS}&errorPolicy=omit&api-version=7.1"
        )
    );
    assert_eq!(header(&reqs[1], "authorization"), Some("Basic OnQwaw=="));
    let r = ado();
    assert_eq!(
        list,
        vec![
            hosting::Issue {
                number: 300,
                title: "Sidebar flickers on resize".into(),
                author: "Alex Fork".into(),
                labels: vec!["Bug".into(), "ui".into(), "urgent".into()],
                updated_at: parse_timestamp("2026-10-20T11:59:59.997Z").unwrap(),
                web_url: work_item_web_url(&r, 300),
            },
            hosting::Issue {
                number: 299,
                title: "Write the release notes".into(),
                author: "Jason Harmon".into(),
                labels: vec!["Task".into()],
                updated_at: parse_timestamp("2026-10-19T16:45:00Z").unwrap(),
                web_url: work_item_web_url(&r, 299),
            },
            hosting::Issue {
                number: 17,
                title: "Users can sign in".into(),
                author: "Sam Lee".into(),
                labels: vec!["User Story".into()],
                updated_at: parse_timestamp("2026-10-10T09:00:00.25Z").unwrap(),
                web_url: work_item_web_url(&r, 17),
            },
        ]
    );
    assert_eq!(
        list[0].web_url,
        "https://dev.azure.com/contoso/My%20Project/_workitems/edit/300"
    );
}

#[test]
fn list_issues_escapes_the_title_literal() {
    let t = FakeTransport::new().reply(200, &wiql_ids([]));
    hosting::list_issues(&t, &ado(), &tok(), "it's \"quoted\"\\\n", 1).unwrap();
    let q = wiql_query(&t.requests()[0]);
    assert!(
        q.contains(" AND [System.Title] CONTAINS 'it''s \"quoted\"\\'"),
        "{q}"
    );
    assert_eq!(
        q,
        format!("{WIQL_BASE} AND [System.Title] CONTAINS 'it''s \"quoted\"\\'{ORDER}")
    );
    let t = FakeTransport::new().reply(200, &wiql_ids([]));
    hosting::list_issues(&t, &ado(), &tok(), "a\u{7}b\tc", 1).unwrap();
    assert_eq!(
        wiql_query(&t.requests()[0]),
        format!("{WIQL_BASE} AND [System.Title] CONTAINS 'abc'{ORDER}")
    );
    let t = FakeTransport::new().reply(200, &wiql_ids([]));
    hosting::list_issues(&t, &ado(), &tok(), "\u{7}", 1).unwrap();
    assert_eq!(wiql_query(&t.requests()[0]), format!("{WIQL_BASE}{ORDER}"));
}

#[test]
fn list_issues_pages_client_side() {
    let item = |id: u64| {
        element(fixture!("azure_workitems.json"), 1, |e| {
            e["id"] = json!(id);
        })
    };
    let t = FakeTransport::new()
        .reply(200, &wiql_ids(1..=60))
        .reply(200, &wrap((51..=60).map(item).collect()));
    let list = hosting::list_issues(&t, &ado(), &tok(), "", 2).unwrap();
    let reqs = t.requests();
    assert!(
        reqs[0].url.contains("/_apis/wit/wiql?$top=100&"),
        "{}",
        reqs[0].url
    );
    let ids: Vec<String> = (51..=60).map(|i| i.to_string()).collect();
    assert!(
        reqs[1].url.contains(&format!("?ids={}&", ids.join(","))),
        "{}",
        reqs[1].url
    );
    assert_eq!(
        list.iter().map(|i| i.number).collect::<Vec<_>>(),
        (51..=60).collect::<Vec<_>>()
    );

    let t = FakeTransport::new().reply(200, fixture!("azure_wiql.json"));
    assert_eq!(
        hosting::list_issues(&t, &ado(), &tok(), "", 2).unwrap(),
        vec![]
    );
    assert_eq!(t.requests().len(), 1);

    let t = FakeTransport::new().reply(200, &wiql_ids([]));
    hosting::list_issues(&t, &ado(), &tok(), "", 1000).unwrap();
    assert!(t.requests()[0].url.contains("$top=20000&"));
}

#[test]
fn a_work_item_deleted_after_the_query_is_dropped() {
    // With `errorPolicy=omit`, ADO answers a missing id with `null` in its place.
    let batch = wrap(vec![
        element(fixture!("azure_workitems.json"), 0, |_| {}),
        "null".to_owned(),
        element(fixture!("azure_workitems.json"), 2, |_| {}),
    ]);
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_wiql.json"))
        .reply(200, &batch);
    let list = hosting::list_issues(&t, &ado(), &tok(), "", 1).unwrap();
    assert_eq!(list.iter().map(|i| i.number).collect::<Vec<_>>(), [300, 17]);
}

#[test]
fn a_work_item_without_a_creator_or_with_a_bad_date() {
    let t = FakeTransport::new().reply(200, &wiql_ids([299])).reply(
        200,
        &wrap(vec![element(fixture!("azure_workitems.json"), 1, |e| {
            e["fields"]
                .as_object_mut()
                .unwrap()
                .remove("System.CreatedBy");
            e["fields"]["System.Tags"] = json!(" ;solo; ");
        })]),
    );
    let list = hosting::list_issues(&t, &ado(), &tok(), "", 1).unwrap();
    assert_eq!(list[0].author, "");
    assert_eq!(list[0].labels, vec!["Task".to_owned(), "solo".to_owned()]);

    let t = FakeTransport::new().reply(200, &wiql_ids([299])).reply(
        200,
        &wrap(vec![element(fixture!("azure_workitems.json"), 1, |e| {
            e["fields"]["System.ChangedDate"] = json!("soon");
        })]),
    );
    assert_eq!(
        err(hosting::list_issues(&t, &ado(), &tok(), "", 1)),
        e(unexpected())
    );
}

#[test]
fn list_issues_401_names_the_work_scope() {
    let t = FakeTransport::new().reply(401, "{}");
    assert_eq!(
        err(hosting::list_issues(&t, &ado(), &tok(), "", 1)),
        e(auth(SCOPE_WORK))
    );
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_wiql.json"))
        .reply(203, "<html>");
    assert_eq!(
        err(hosting::list_issues(&t, &ado(), &tok(), "", 1)),
        e(auth(SCOPE_WORK))
    );
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_wiql.json"))
        .reply(404, "{}");
    assert_eq!(
        err(hosting::list_issues(&t, &ado(), &tok(), "", 1)),
        e(GitError::HostingNotFound)
    );
}

// --- my repositories ---

fn my_repos(
    t: &FakeTransport,
    query: &str,
    page: u32,
) -> Result<hosting::HostedRepoPage, GitError> {
    hosting::list_my_repos(t, &account(), &tok(), query, page)
}

#[test]
fn list_my_repos_joins_projects_and_repositories() {
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, fixture!("azure_repositories.json"));
    let page = my_repos(&t, "", 1).unwrap();
    let reqs = t.requests();
    assert_eq!(
        reqs[0].url,
        "https://dev.azure.com/contoso/_apis/projects?$top=1000&api-version=7.1"
    );
    assert_eq!(
        reqs[1].url,
        "https://dev.azure.com/contoso/_apis/git/repositories?includeAllUrls=true&api-version=7.1"
    );
    for req in &reqs {
        assert_eq!(header(req, "authorization"), Some("Basic OnQwaw=="));
    }
    assert_eq!(
        page,
        hosting::HostedRepoPage {
            repos: vec![
                hosting::HostedRepo {
                    full_name: "My Project/my repo".into(),
                    name: "my repo".into(),
                    owner: "My Project".into(),
                    description: None,
                    private: true,
                    updated_at: parse_timestamp("2026-10-20T12:00:00.33Z").unwrap(),
                    https_url: "https://dev.azure.com/contoso/My%20Project/_git/my%20repo".into(),
                    ssh_url: Some("git@ssh.dev.azure.com:v3/contoso/My%20Project/my%20repo".into()),
                    web_url: "https://dev.azure.com/contoso/My%20Project/_git/my%20repo".into(),
                },
                hosting::HostedRepo {
                    full_name: "Open Source/widgets".into(),
                    name: "widgets".into(),
                    owner: "Open Source".into(),
                    description: None,
                    private: false,
                    updated_at: parse_timestamp("2026-09-01T08:00:00Z").unwrap(),
                    https_url: "https://dev.azure.com/contoso/Open%20Source/_git/widgets".into(),
                    ssh_url: Some("git@ssh.dev.azure.com:v3/contoso/Open%20Source/widgets".into()),
                    web_url: "https://dev.azure.com/contoso/Open%20Source/_git/widgets".into(),
                },
            ],
            has_more: false,
        }
    );
    assert!(page.repos.iter().all(|r| !r.https_url.contains("contoso@")));
}

#[test]
fn list_my_repos_drops_unknown_projects_and_unusable_urls_and_builds_missing_web_urls() {
    let repos = wrap(vec![
        element(fixture!("azure_repositories.json"), 0, |e| {
            e["project"]["id"] = json!("not-listed");
        }),
        element(fixture!("azure_repositories.json"), 0, |e| {
            e["name"] = json!("bad url");
            e["remoteUrl"] = json!("http://dev.azure.com/contoso/My%20Project/_git/bad");
        }),
        element(fixture!("azure_repositories.json"), 2, |e| {
            e["name"] = json!("no web");
            e.as_object_mut().unwrap().remove("webUrl");
            e.as_object_mut().unwrap().remove("isDisabled");
            e.as_object_mut().unwrap().remove("sshUrl");
        }),
    ]);
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, &repos);
    let page = my_repos(&t, "", 1).unwrap();
    assert_eq!(page.repos.len(), 1);
    assert_eq!(
        page.repos[0].web_url,
        "https://dev.azure.com/contoso/Open%20Source/_git/no%20web"
    );
    assert_eq!(page.repos[0].ssh_url, None);
}

#[test]
fn a_project_without_a_usable_time_lists_its_repositories_at_epoch_zero_last() {
    // ADO sends `0001-01-01T00:00:00` (no zone) on shallow project references.
    let projects = wrap(vec![
        element(fixture!("azure_projects.json"), 0, |e| {
            e["lastUpdateTime"] = json!("0001-01-01T00:00:00");
        }),
        element(fixture!("azure_projects.json"), 1, |_| {}),
    ]);
    let t = FakeTransport::new()
        .reply(200, &projects)
        .reply(200, fixture!("azure_repositories.json"));
    let page = my_repos(&t, "", 1).unwrap();
    assert_eq!(
        page.repos
            .iter()
            .map(|r| (r.name.as_str(), r.updated_at))
            .collect::<Vec<_>>(),
        [
            ("widgets", parse_timestamp("2026-09-01T08:00:00Z").unwrap()),
            ("my repo", 0),
        ]
    );

    let projects = wrap(vec![
        element(fixture!("azure_projects.json"), 0, |e| {
            e.as_object_mut().unwrap().remove("lastUpdateTime");
        }),
        element(fixture!("azure_projects.json"), 1, |_| {}),
    ]);
    let t = FakeTransport::new()
        .reply(200, &projects)
        .reply(200, fixture!("azure_repositories.json"));
    let page = my_repos(&t, "", 1).unwrap();
    assert_eq!(
        page.repos.last().map(|r| (r.name.as_str(), r.updated_at)),
        Some(("my repo", 0))
    );
}

#[test]
fn list_my_repos_filters_sorts_and_pages() {
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, fixture!("azure_repositories.json"));
    let page = my_repos(&t, " REPO ", 1).unwrap();
    assert_eq!(
        page.repos
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["my repo"]
    );

    let names: Vec<String> = (0..51).map(|i| format!("r{i:02}")).collect();
    let mut items: Vec<String> = names
        .iter()
        .map(|n| {
            element(fixture!("azure_repositories.json"), 0, |e| {
                e["name"] = json!(n);
                e["remoteUrl"] = json!(format!(
                    "https://dev.azure.com/contoso/My%20Project/_git/{n}"
                ));
            })
        })
        .collect();
    // An older project's repository sorts after every newer one whatever its name.
    items.push(element(fixture!("azure_repositories.json"), 2, |e| {
        e["name"] = json!("a-old");
    }));
    let body = wrap(items);
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, &body);
    let one = my_repos(&t, "", 1).unwrap();
    assert_eq!(one.repos.len(), 50);
    assert!(one.has_more);
    assert_eq!(one.repos[0].name, "r00");
    assert_eq!(one.repos[49].name, "r49");
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, &body);
    let two = my_repos(&t, "", 2).unwrap();
    assert_eq!(
        two.repos
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["r50", "a-old"]
    );
    assert!(!two.has_more);
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(200, &body);
    assert_eq!(my_repos(&t, "", 3).unwrap().repos, vec![]);
}

#[test]
fn list_my_repos_401_names_the_project_scope() {
    let t = FakeTransport::new().reply(401, "{}");
    assert_eq!(err(my_repos(&t, "", 1)), e(auth(SCOPE_PROJECT)));
    let t = FakeTransport::new()
        .reply(200, fixture!("azure_projects.json"))
        .reply(401, "{}");
    assert_eq!(err(my_repos(&t, "", 1)), e(auth(SCOPE_CODE)));
}

#[test]
fn web_url_builders_encode_segments_and_keep_the_host() {
    let r = repo(P::AzureDevOps, "dev.azure.com/Contoso", "A/B #1", "r?x");
    assert_eq!(
        pull_request_web_url(&r, 5),
        "https://dev.azure.com/Contoso/A%2FB%20%231/_git/r%3Fx/pullrequest/5"
    );
    assert_eq!(
        work_item_web_url(&r, 9),
        "https://dev.azure.com/Contoso/A%2FB%20%231/_workitems/edit/9"
    );
}
