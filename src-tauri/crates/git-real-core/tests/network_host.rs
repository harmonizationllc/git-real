//! GR-12 follow-up W4: the SSH host named in a host-key or publickey failure, from git's stderr
//! first and otherwise from the URL of the single remote involved. The host ends up in a command
//! the user copies, so it is validated strictly.

use git_real_core::remote::host::ssh_host;

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("fixtures/network_stderr/", $name))
    };
}

fn from_stderr(stderr: &str) -> Option<String> {
    ssh_host(stderr, &[])
}

fn from_url(url: &str) -> Option<String> {
    ssh_host("", &[url])
}

#[test]
fn reads_the_host_of_an_unknown_host_key_fixture() {
    assert_eq!(
        from_stderr(fixture!("ssh_host_key.txt")).as_deref(),
        Some("github.com")
    );
}

#[test]
fn reads_the_host_of_a_no_host_key_is_known_line_for_any_key_type() {
    for key in ["RSA", "ECDSA", "ED25519"] {
        let text = format!(
            "No {key} host key is known for git.example.org and you have requested strict checking.\nHost key verification failed.\n"
        );
        assert_eq!(
            from_stderr(&text).as_deref(),
            Some("git.example.org"),
            "{key}"
        );
    }
}

#[test]
fn reads_the_host_of_a_changed_host_key_line() {
    assert_eq!(
        from_stderr(
            "Host key for github.com has changed and you have requested strict checking.\n"
        )
        .as_deref(),
        Some("github.com")
    );
}

#[test]
fn strips_brackets_and_port_from_a_stderr_host() {
    assert_eq!(
        from_stderr("No ED25519 host key is known for [git.example.org]:2222 and you have requested strict checking.\n").as_deref(),
        Some("git.example.org")
    );
    assert_eq!(
        from_stderr(
            "Host key for [h.test]:2200 has changed and you have requested strict checking.\n"
        )
        .as_deref(),
        Some("h.test")
    );
}

// C6: a publickey failure names the host as `<user>@<host>: Permission denied (publickey`.
#[test]
fn reads_the_host_of_a_publickey_failure_fixture() {
    assert_eq!(
        from_stderr(fixture!("ssh_publickey.txt")).as_deref(),
        Some("github.com")
    );
}

#[test]
fn reads_the_host_of_a_publickey_line_with_gssapi_methods() {
    assert_eq!(
        from_stderr("me@h.test: Permission denied (publickey,gssapi-keyex).\n").as_deref(),
        Some("h.test")
    );
}

#[test]
fn stderr_is_none_when_it_names_no_host() {
    assert_eq!(from_stderr(""), None);
    assert_eq!(from_stderr("Host key verification failed.\n"), None);
    assert_eq!(from_stderr(fixture!("https_dns.txt")), None);
}

#[test]
fn stderr_wins_over_the_url() {
    let text =
        "No ED25519 host key is known for stderr.test and you have requested strict checking.\n";
    assert_eq!(
        ssh_host(text, &["git@url.test:me/x.git"]).as_deref(),
        Some("stderr.test")
    );
}

#[test]
fn reads_scp_style_urls_with_and_without_a_user() {
    assert_eq!(
        from_url("git@github.com:me/x.git").as_deref(),
        Some("github.com")
    );
    assert_eq!(
        from_url("github.com:me/x.git").as_deref(),
        Some("github.com")
    );
}

#[test]
fn reads_ssh_urls_with_user_port_and_ipv6() {
    assert_eq!(
        from_url("ssh://git@github.com/me/x.git").as_deref(),
        Some("github.com")
    );
    assert_eq!(
        from_url("ssh://git@git.example.org:2222/me/x.git").as_deref(),
        Some("git.example.org")
    );
    assert_eq!(from_url("ssh://h.test/x.git").as_deref(), Some("h.test"));
    assert_eq!(
        from_url("git+ssh://git@h.test/x.git").as_deref(),
        Some("h.test")
    );
    assert_eq!(
        from_url("ssh://git@[::1]:2222/x.git").as_deref(),
        Some("::1")
    );
}

#[test]
fn the_url_fallback_needs_exactly_one_url() {
    let urls = ["git@one.test:me/x.git", "git@two.test:me/x.git"];
    assert_eq!(ssh_host("", &urls), None);
    assert_eq!(ssh_host("", &[]), None);
    assert_eq!(ssh_host("", &urls[..1]).as_deref(), Some("one.test"));
}

#[test]
fn non_ssh_urls_have_no_host() {
    for url in [
        "https://github.com/me/x.git",
        "http://127.0.0.1:8080/r.git",
        "/srv/bare.git",
        "./rel/path.git",
        "file:///srv/x.git",
        "",
        "ssh://",
    ] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
}

// C5: anything that is not a plain host name or IPv6 literal is refused, never quoted.
#[test]
fn a_host_with_shell_metacharacters_is_none() {
    for url in [
        "git@evil;rm -rf ~:x.git",
        "git@a b:x.git",
        "git@$(touch x):x.git",
        "ssh://git@`id`/x.git",
        "ssh://git@h.test;id/x.git",
        "ssh://git@h|t/x.git",
    ] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
}

#[test]
fn a_stderr_host_with_shell_metacharacters_is_none() {
    for host in ["evil;id", "a b", "$(id)", "h`id`", "h&t"] {
        let text = format!(
            "No ED25519 host key is known for {host} and you have requested strict checking.\n"
        );
        assert_eq!(from_stderr(&text), None, "{host:?}");
    }
    assert_eq!(
        from_stderr("evil;id: Permission denied (publickey).\n"),
        None
    );
}
