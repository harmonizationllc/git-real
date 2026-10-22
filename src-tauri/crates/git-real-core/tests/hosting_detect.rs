//! Provider detection from a remote URL, host validation and the https host used for
//! account tokens (GR-13 spec §3.2, §4.3).

use git_real_core::GitError;
use git_real_core::hosting::provider::{detect, https_host, validate_host};
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
        [
            P::GitHub.git_username(),
            P::GitLab.git_username(),
            P::Bitbucket.git_username()
        ],
        ["x-access-token", "oauth2", "x-bitbucket-api-token-auth"]
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
