//! Provider detection from a remote URL, host validation and the https host used for
//! account tokens (GR-13 spec §3.2, §4.3).

use git_real_core::GitError;
use git_real_core::hosting::provider::{
    account_origin_for, azure_org, detect, https_host, validate_host,
};
use git_real_core::hosting::{Provider as P, RepoRef};

fn r(provider: P, host: &str, namespace: &str, name: &str) -> Option<RepoRef> {
    Some(RepoRef {
        provider,
        host: host.into(),
        namespace: namespace.into(),
        name: name.into(),
    })
}

#[test]
fn detects_every_url_form_on_the_default_hosts() {
    let cases = [
        (
            "https://github.com/gorlox/test-repo.git",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "https://me:pw@GitHub.com/gorlox/test-repo/",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "http://github.com/gorlox/test-repo",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "git@github.com:gorlox/test-repo.git",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "ssh://git@github.com/gorlox/test-repo.git",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "ssh://git@ssh.github.com:443/gorlox/test-repo.git",
            r(P::GitHub, "github.com", "gorlox", "test-repo"),
        ),
        (
            "git+ssh://git@gitlab.com/group/sub/proj.git",
            r(P::GitLab, "gitlab.com", "group/sub", "proj"),
        ),
        (
            "ssh://git@altssh.gitlab.com:443/group/proj.git",
            r(P::GitLab, "gitlab.com", "group", "proj"),
        ),
        (
            "https://gitlab.com/a/b/c/d",
            r(P::GitLab, "gitlab.com", "a/b/c", "d"),
        ),
        (
            "git@bitbucket.org:ws/repo.git",
            r(P::Bitbucket, "bitbucket.org", "ws", "repo"),
        ),
        (
            "https://octo@bitbucket.org/ws/repo.git",
            r(P::Bitbucket, "bitbucket.org", "ws", "repo"),
        ),
    ];
    for (url, want) in cases {
        assert_eq!(detect(url, &[]), want, "{url}");
    }
}

#[test]
fn custom_hosts_come_first_and_keep_https_ports() {
    let custom = [
        (P::GitHub, "ghe.corp:8443".to_owned()),
        (P::GitLab, "git.corp".to_owned()),
    ];
    assert_eq!(
        detect("https://ghe.corp:8443/o/r.git", &custom),
        r(P::GitHub, "ghe.corp:8443", "o", "r")
    );
    assert_eq!(
        detect("git@git.corp:g/s/p.git", &custom),
        r(P::GitLab, "git.corp", "g/s", "p")
    );
    assert_eq!(
        detect("https://GIT.CORP/g/p", &custom),
        r(P::GitLab, "git.corp", "g", "p")
    );
    assert_eq!(
        detect("https://github.com:443/o/r", &[]),
        r(P::GitHub, "github.com", "o", "r")
    );
    // A custom entry for a default host wins over the default provider.
    assert_eq!(
        detect(
            "https://gitlab.com/o/r",
            &[(P::GitHub, "gitlab.com".into())]
        ),
        r(P::GitHub, "gitlab.com", "o", "r")
    );
}

#[test]
fn refuses_unhosted_and_malformed_urls() {
    for url in [
        "/srv/repo.git",
        "file:///srv/repo.git",
        "C:\\repos\\x",
        "C:/repos/x",
        "https://example.com/o/r",
        "https://github.com/o",
        "https://github.com/o/r/extra",
        "https://bitbucket.org/ws",
        "https://gitlab.com/solo",
        "https://github.com//r",
        "https://github.com/o/../r",
        "ftp://github.com/o/r",
        "",
        "github.com",
        "https://-bad.com/o/r",
    ] {
        assert_eq!(detect(url, &[]), None, "{url:?}");
    }
}

#[test]
fn web_url_is_https_host_namespace_name() {
    let repo = r(P::GitLab, "git.corp:8443", "g/s", "p").unwrap();
    assert_eq!(repo.web_url(), "https://git.corp:8443/g/s/p");
}

#[test]
fn validate_host_defaults_lowercases_and_refuses() {
    assert_eq!(validate_host(P::GitHub, None).unwrap(), "github.com");
    assert_eq!(validate_host(P::GitLab, Some("  ")).unwrap(), "gitlab.com");
    assert_eq!(
        validate_host(P::GitHub, Some("GHE.Corp:8443")).unwrap(),
        "ghe.corp:8443"
    );
    assert_eq!(
        validate_host(P::Bitbucket, Some("bitbucket.org")).unwrap(),
        "bitbucket.org"
    );
    for (p, h) in [
        (P::Bitbucket, "bb.corp"),
        (P::GitHub, "https://ghe.corp"),
        (P::GitHub, "ghe.corp/x"),
        (P::GitHub, "-x.corp"),
        (P::GitHub, ".corp"),
        (P::GitHub, "ghe.corp:123456"),
        (P::GitHub, "ghe.corp:"),
        (P::GitLab, "a b"),
        (P::GitLab, "me@h"),
    ] {
        assert!(
            matches!(validate_host(p, Some(h)), Err(GitError::InvalidHostingHost(s)) if s == h),
            "{h}"
        );
    }
}

#[test]
fn provider_constants() {
    assert_eq!(P::GitHub.api_base("github.com"), "https://api.github.com");
    assert_eq!(
        P::GitHub.api_base("ghe.corp:8443"),
        "https://ghe.corp:8443/api/v3"
    );
    assert_eq!(
        P::GitLab.api_base("gitlab.com"),
        "https://gitlab.com/api/v4"
    );
    assert_eq!(
        P::Bitbucket.api_base("bitbucket.org"),
        "https://api.bitbucket.org/2.0"
    );
    assert_eq!(
        P::AzureDevOps.api_base("dev.azure.com/contoso"),
        "https://dev.azure.com/contoso"
    );
    assert_eq!(
        [
            P::GitHub.git_username(),
            P::GitLab.git_username(),
            P::Bitbucket.git_username(),
            P::AzureDevOps.git_username()
        ],
        [
            "x-access-token",
            "oauth2",
            "x-bitbucket-api-token-auth",
            "git-real"
        ]
    );
    assert_eq!(serde_json::to_value(P::GitLab).unwrap(), "gitlab");
    assert_eq!(
        serde_json::from_value::<P>("bitbucket".into()).unwrap(),
        P::Bitbucket
    );
}

#[test]
fn https_host_reads_only_https_urls() {
    assert_eq!(
        https_host("https://me:pw@GitHub.com/o/r.git").as_deref(),
        Some("github.com")
    );
    assert_eq!(
        https_host("https://ghe.corp:8443/o/r").as_deref(),
        Some("ghe.corp:8443")
    );
    assert_eq!(
        https_host("https://github.com:443/o/r").as_deref(),
        Some("github.com")
    );
    for url in [
        "http://github.com/o/r",
        "git@github.com:o/r",
        "/srv/x.git",
        "ssh://github.com/o/r",
    ] {
        assert_eq!(https_host(url), None, "{url}");
    }
}

// --- Azure DevOps (GR-41 spec §3.2, §3.5, §4.3) ---

#[test]
fn detects_every_azure_url_form() {
    let want = r(
        P::AzureDevOps,
        "dev.azure.com/contoso",
        "My Project",
        "my repo",
    );
    for url in [
        "https://dev.azure.com/contoso/My%20Project/_git/my%20repo",
        "https://contoso@dev.azure.com/contoso/My%20Project/_git/my%20repo.git",
        "https://dev.azure.com/contoso/My%20Project/_git/my%20repo/",
        "https://contoso.visualstudio.com/My%20Project/_git/my%20repo",
        "https://contoso.visualstudio.com/DefaultCollection/My%20Project/_git/my%20repo",
        "git@ssh.dev.azure.com:v3/contoso/My%20Project/my%20repo",
        "ssh://git@ssh.dev.azure.com/v3/contoso/My%20Project/my%20repo",
        "contoso@vs-ssh.visualstudio.com:v3/contoso/My%20Project/my%20repo",
    ] {
        assert_eq!(detect(url, &[]), want, "{url}");
    }
    assert_eq!(
        detect("https://dev.azure.com/contoso/_git/shared", &[]),
        r(P::AzureDevOps, "dev.azure.com/contoso", "shared", "shared")
    );
    assert_eq!(
        detect("https://contoso.visualstudio.com/_git/shared", &[]),
        r(P::AzureDevOps, "dev.azure.com/contoso", "shared", "shared")
    );
    assert_eq!(
        detect("https://dev.azure.com/Contoso/p/_git/r", &[]),
        r(P::AzureDevOps, "dev.azure.com/Contoso", "p", "r")
    );
    // Decoded names may hold the punctuation ADO allows.
    assert_eq!(
        detect(
            "https://dev.azure.com/contoso/R%26D%20(2026)/_git/caf%C3%A9",
            &[]
        ),
        r(
            P::AzureDevOps,
            "dev.azure.com/contoso",
            "R&D (2026)",
            "café"
        )
    );
}

#[test]
fn rejects_azure_shapes_that_are_not_repositories() {
    for url in [
        "https://dev.azure.com/contoso/p/r",
        "https://dev.azure.com/contoso/p/_git/r/extra",
        "https://dev.azure.com/contoso/a/b/_git/r",
        "https://dev.azure.com:8443/contoso/p/_git/r",
        "https://dev.azure.com:443/contoso/p/_git/r",
        "ssh://git@ssh.dev.azure.com:2222/v3/contoso/p/r",
        "ssh://git@ssh.dev.azure.com:22/v3/contoso/p/r",
        "https://contoso.visualstudio.com/p/r",
        "https://contoso.visualstudio.com/DefaultCollection/p/r",
        "https://dev.azure.com/contoso//_git/r",
        "https://dev.azure.com/contoso/p/_git/%a\u{e9}",
        "https://dev.azure.com/contoso/p/_git/%4",
        "git@ssh.dev.azure.com:v3/contoso/r",
        "git@ssh.dev.azure.com:v3/contoso/p/r/x",
        "git@ssh.dev.azure.com:v2/contoso/p/r",
        "https://dev.azure.com/contoso/p/_git/%2",
        "https://dev.azure.com/contoso/p/_git/%zz",
        "https://dev.azure.com/contoso/p/_git/%FF",
        "https://dev.azure.com/contoso/p/_git/a%2Fb",
        "https://dev.azure.com/contoso/p/_git/a%5Cb",
        "https://dev.azure.com/contoso/p/_git/a%25b",
        "https://dev.azure.com/contoso/p/_git/a%00b",
        "https://dev.azure.com/contoso/p/_git/a%0Ab",
        "https://dev.azure.com/contoso/../_git/r",
        "https://dev.azure.com/contoso/./_git/r",
        "https://dev.azure.com/contoso/p/_git/",
        "https://dev.azure.com/-bad/p/_git/r",
        "https://dev.azure.com/a.b/p/_git/r",
        "https://dev.azure.com/",
        "https://a.b.visualstudio.com/p/_git/r",
        "https://visualstudio.com/p/_git/r",
        "git@ssh.dev.azure.com:v3/con_toso/p/r",
    ] {
        assert_eq!(detect(url, &[]), None, "{url:?}");
    }
    // No custom host makes a generic-shaped URL an Azure DevOps repository.
    assert_eq!(
        detect(
            "https://ado.corp/o/r",
            &[(P::AzureDevOps, "ado.corp".into())]
        ),
        None
    );
}

#[test]
fn azure_web_url_uses_git_marker_and_encoding() {
    let repo = r(
        P::AzureDevOps,
        "dev.azure.com/contoso",
        "My Project",
        "my repo",
    )
    .unwrap();
    assert_eq!(
        repo.web_url(),
        "https://dev.azure.com/contoso/My%20Project/_git/my%20repo"
    );
}

#[test]
fn validate_host_for_azure_takes_a_name_or_an_organization_url() {
    for input in [
        "contoso",
        " contoso ",
        "https://dev.azure.com/contoso",
        "HTTPS://Dev.Azure.com/contoso/",
        "https://contoso@dev.azure.com/contoso/My%20Project/_git/r",
        "https://dev.azure.com/contoso/My%20Project/_git/r",
        "dev.azure.com/contoso",
        "https://contoso.visualstudio.com/",
        "https://contoso.visualstudio.com/DefaultCollection/p/_git/r",
        "contoso.visualstudio.com",
    ] {
        assert_eq!(
            validate_host(P::AzureDevOps, Some(input)).unwrap(),
            "dev.azure.com/contoso",
            "{input:?}"
        );
    }
    assert_eq!(
        validate_host(P::AzureDevOps, Some("Contoso-2")).unwrap(),
        "dev.azure.com/Contoso-2"
    );
    assert!(matches!(
        validate_host(P::AzureDevOps, None),
        Err(GitError::InvalidHostingHost(s)) if s.is_empty()
    ));
    for input in [
        "",
        "  ",
        "-bad",
        "has space",
        "https://github.com/contoso",
        "dev.azure.com",
        "https://dev.azure.com",
        "https://dev.azure.com/",
        "contoso/",
        "a.b.visualstudio.com",
        "http://dev.azure.com/contoso",
        "con_toso",
    ] {
        assert!(
            matches!(
                validate_host(P::AzureDevOps, Some(input)),
                Err(GitError::InvalidHostingHost(s)) if s == input
            ),
            "{input:?}"
        );
    }
    assert_eq!(azure_org("contoso").as_deref(), Some("contoso"));
    assert_eq!(azure_org("https://github.com/contoso"), None);
}

#[test]
fn account_origin_for_matches_hosts_and_organizations() {
    let cases: [(&str, &str, Option<&str>); 14] = [
        (
            "github.com",
            "https://GitHub.com/o/r",
            Some("https://github.com"),
        ),
        ("github.com", "git@github.com:o/r", None),
        ("github.com", "https://gitlab.com/o/r", None),
        (
            "ghe.corp:8443",
            "https://ghe.corp:8443/o/r",
            Some("https://ghe.corp:8443"),
        ),
        (
            "dev.azure.com/contoso",
            "https://contoso@dev.azure.com/Contoso/p/_git/r",
            Some("https://dev.azure.com"),
        ),
        (
            "dev.azure.com/contoso",
            "https://dev.azure.com/other/p/_git/r",
            None,
        ),
        (
            "dev.azure.com/contoso",
            "https://dev.azure.com/contosox/p/_git/r",
            None,
        ),
        (
            "dev.azure.com/contoso",
            "https://contoso.visualstudio.com/p/_git/r",
            Some("https://contoso.visualstudio.com"),
        ),
        (
            "dev.azure.com/contoso",
            "https://other.visualstudio.com/p/_git/r",
            None,
        ),
        ("dev.azure.com/contoso", "https://dev.azure.com", None),
        (
            "dev.azure.com/contoso",
            "https://dev.azure.com:8443/contoso/p/_git/r",
            None,
        ),
        (
            "dev.azure.com/contoso",
            "git@ssh.dev.azure.com:v3/contoso/p/r",
            None,
        ),
        (
            "dev.azure.com/contoso",
            "https://evil.example/contoso/p/_git/r",
            None,
        ),
        ("example.com/contoso", "https://example.com/contoso/p", None),
    ];
    for (host, url, want) in cases {
        assert_eq!(
            account_origin_for(host, url).as_deref(),
            want,
            "{host} {url}"
        );
    }
}
