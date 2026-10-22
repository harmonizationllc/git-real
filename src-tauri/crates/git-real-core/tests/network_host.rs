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

// Coverage audit: odd-but-plausible inputs.
#[test]
fn a_bare_ipv6_host_in_stderr_keeps_its_colons() {
    assert_eq!(
        from_stderr(
            "No ED25519 host key is known for 2001:db8::1 and you have requested strict checking.\n"
        )
        .as_deref(),
        Some("2001:db8::1")
    );
    assert_eq!(
        from_stderr("Host key for ::1 has changed and you have requested strict checking.\n")
            .as_deref(),
        Some("::1")
    );
}

#[test]
fn a_bracketed_ipv6_host_in_stderr_drops_brackets_and_port() {
    assert_eq!(
        from_stderr(
            "No ED25519 host key is known for [::1]:2222 and you have requested strict checking.\n"
        )
        .as_deref(),
        Some("::1")
    );
}

#[test]
fn an_ssh_url_with_an_ipv6_host_and_no_port_reads_the_literal() {
    assert_eq!(from_url("ssh://[::1]/x.git").as_deref(), Some("::1"));
    assert_eq!(
        from_url("ssh://git@[2001:db8::1]/x.git").as_deref(),
        Some("2001:db8::1")
    );
}

#[test]
fn an_unterminated_or_non_hex_ipv6_bracket_is_none() {
    for url in ["ssh://[::1/x.git", "ssh://[::g]/x.git", "ssh://[]/x.git"] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
}

#[test]
fn a_user_containing_an_at_sign_still_yields_the_host_after_the_last_at() {
    assert_eq!(
        from_url("ssh://us@er@host.test/x.git").as_deref(),
        Some("host.test")
    );
    assert_eq!(
        from_url("ssh://us@er@host.test:2222/x.git").as_deref(),
        Some("host.test")
    );
    assert_eq!(
        from_url("us@er@host.test:x.git").as_deref(),
        Some("host.test")
    );
    assert_eq!(
        from_stderr("us@er@host.test: Permission denied (publickey).\n").as_deref(),
        Some("host.test")
    );
}

#[test]
fn an_attacker_host_after_an_at_sign_in_the_user_part_cannot_hide_metacharacters() {
    // The user part is discarded; the host that remains is still validated.
    assert_eq!(from_url("ssh://host.test@evil;id/x.git"), None);
}

#[test]
fn host_case_and_a_trailing_dot_are_preserved_not_rewritten() {
    assert_eq!(
        from_url("ssh://GitHub.COM/x.git").as_deref(),
        Some("GitHub.COM")
    );
    assert_eq!(
        from_url("git@GitHub.com:me/x.git").as_deref(),
        Some("GitHub.com")
    );
    assert_eq!(
        from_url("ssh://github.com./x.git").as_deref(),
        Some("github.com.")
    );
    assert_eq!(
        from_stderr(
            "Host key for GITHUB.com. has changed and you have requested strict checking.\n"
        )
        .as_deref(),
        Some("GITHUB.com.")
    );
}

#[test]
fn a_scp_like_url_whose_host_part_is_a_path_is_none() {
    for url in ["/srv/a:b.git", "./a:b.git", "dir/host:x.git"] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
}

#[test]
fn a_host_that_would_read_as_an_ssh_option_is_none() {
    for url in [
        "-oProxyCommand=x:y.git",
        "ssh://-oProxyCommand=x/y.git",
        "git@-h.test:x.git",
    ] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
    assert_eq!(
        from_stderr("Host key for -h.test has changed and you have requested strict checking.\n"),
        None
    );
}

#[test]
fn an_empty_host_or_a_scheme_only_authority_is_none() {
    for url in [
        "ssh://git@/x.git",
        "git@:x.git",
        ":x.git",
        "ssh://:22/x.git",
    ] {
        assert_eq!(from_url(url), None, "{url:?}");
    }
}

#[test]
fn the_first_valid_host_line_in_stderr_wins_over_later_ones() {
    let text = "Host key for first.test has changed and you have requested strict checking.\nHost key for second.test has changed and you have requested strict checking.\n";
    assert_eq!(from_stderr(text).as_deref(), Some("first.test"));
}

#[test]
fn an_invalid_stderr_host_falls_back_to_the_single_url() {
    let text = "Host key for evil;id has changed and you have requested strict checking.\n";
    assert_eq!(
        ssh_host(text, &["git@real.test:x.git"]).as_deref(),
        Some("real.test")
    );
}
