//! The SSH host behind a host-key or publickey failure, for a hint the user copies into a
//! terminal (`ssh -T git@<host>`). Every candidate is validated strictly, so nothing but a plain
//! host name or IPv6 literal ever reaches that command.

/// The host named in git's `stderr`, or else the host of the only URL involved; `None` when
/// neither yields a valid SSH host.
pub fn ssh_host(stderr: &str, urls: &[&str]) -> Option<String> {
    stderr
        .lines()
        .find_map(host_in_line)
        .or_else(|| match urls {
            [url] => url_host(url),
            _ => None,
        })
}

/// OpenSSH's `No <TYPE> host key is known for <host> and …`, `Host key for <host> has changed`
/// and `<user>@<host>: Permission denied (publickey…`.
fn host_in_line(line: &str) -> Option<String> {
    let candidate = if let Some((_, rest)) = line.split_once(" host key is known for ") {
        rest.split_once(" and ")?.0
    } else if let Some(rest) = line.strip_prefix("Host key for ") {
        rest.split_once(" has changed")?.0
    } else {
        let (who, _) = line.split_once(": Permission denied (publickey")?;
        who.rsplit_once('@').map_or(who, |(_, host)| host)
    };
    valid(strip_port(candidate))
}

/// The host of an `ssh://` / `git+ssh://` URL or an scp-like `[user@]host:path`.
/// A Windows drive path (`C:\repo`, `C:/repo`) is a local path, not an scp-like URL.
fn url_host(url: &str) -> Option<String> {
    let host = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "ssh" | "git+ssh") {
            return None;
        }
        let authority = rest.split('/').next().unwrap_or_default();
        strip_port(strip_user(authority))
    } else {
        if is_drive_path(url) {
            return None;
        }
        let (host, _) = url.split_once(':')?;
        if host.contains('/') {
            return None;
        }
        strip_user(host)
    };
    valid(host)
}

fn is_drive_path(url: &str) -> bool {
    matches!(url.as_bytes(), [l, b':', b'\\' | b'/', ..] if l.is_ascii_alphabetic())
}

fn strip_user(authority: &str) -> &str {
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

/// `[host]:port` or `[v6]` → the bracketed part; `host:port` → `host`.
fn strip_port(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split_once(']').map_or("", |(inner, _)| inner);
    }
    if host.bytes().filter(|&b| b == b':').count() > 1 {
        return host; // a bare IPv6 literal from stderr
    }
    host.split_once(':').map_or(host, |(h, _)| h)
}

/// A DNS-style name (`[A-Za-z0-9.-]+`, not starting with `-`) or an IPv6 literal of hex digits
/// and colons.
fn valid(host: &str) -> Option<String> {
    let name = host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let v6 = host.contains(':') && host.bytes().all(|b| b.is_ascii_hexdigit() || b == b':');
    (!host.is_empty() && !host.starts_with('-') && (name || v6)).then(|| host.to_owned())
}
