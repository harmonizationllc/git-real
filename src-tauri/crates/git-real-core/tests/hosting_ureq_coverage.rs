//! More of `UreqTransport` against local one-shot servers: 5xx statuses stay responses, header
//! names are lower-cased, request headers arrive, an undecodable body is `HostingUnreachable`,
//! and a redirect to another origin never carries the `Authorization` header.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use git_real_core::GitError;
use git_real_core::hosting::ureq_transport::UreqTransport;
use git_real_core::hosting::{Method, Request, Transport};

/// Serves one connection with the raw `reply` bytes and returns the raw request text.
fn serve_once(reply: Vec<u8>) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        sock.write_all(&reply).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    (url, handle)
}

fn get(url: String, headers: &[(&str, &str)]) -> Request {
    Request {
        method: Method::Get,
        url,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: None,
    }
}

#[test]
fn a_5xx_status_is_a_response_not_an_error() {
    let (base, server) = serve_once(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy"
            .to_vec(),
    );
    let resp = UreqTransport::new().send(&get(base, &[])).unwrap();
    server.join().unwrap();
    assert_eq!((resp.status, resp.body.as_str()), (503, "busy"));
}

#[test]
fn response_header_names_are_lower_cased_and_repeats_are_kept() {
    let (base, server) = serve_once(
        b"HTTP/1.1 200 OK\r\nX-RateLimit-Reset: 99\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
    );
    let resp = UreqTransport::new().send(&get(base, &[])).unwrap();
    server.join().unwrap();
    assert!(
        resp.headers
            .iter()
            .all(|(k, _)| k == &k.to_ascii_lowercase()),
        "{:?}",
        resp.headers
    );
    assert_eq!(resp.header("x-ratelimit-reset"), Some("99"));
    assert_eq!(
        resp.headers
            .iter()
            .filter(|(k, _)| k == "set-cookie")
            .count(),
        2
    );
}

#[test]
fn every_request_header_is_sent_and_a_get_has_no_body() {
    let (base, server) =
        serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec());
    let req = get(
        format!("{base}/a?b=1"),
        &[
            ("Authorization", "Bearer t"),
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
        ],
    );
    UreqTransport::new().send(&req).unwrap();
    let seen = server.join().unwrap().to_ascii_lowercase();
    assert!(seen.starts_with("get /a?b=1 http/1.1"), "{seen}");
    for line in [
        "authorization: bearer t",
        "accept: application/vnd.github+json",
        "x-github-api-version: 2022-11-28",
    ] {
        assert!(seen.contains(line), "{line} missing in {seen}");
    }
    assert!(!seen.contains("content-length: 1"), "{seen}");
}

#[test]
fn a_post_without_a_body_sends_an_empty_one() {
    let (base, server) =
        serve_once(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec());
    let req = Request {
        method: Method::Post,
        url: format!("{base}/x"),
        headers: vec![],
        body: None,
    };
    let resp = UreqTransport::new().send(&req).unwrap();
    let seen = server.join().unwrap();
    assert_eq!((resp.status, resp.body.as_str()), (204, ""));
    assert!(seen.starts_with("POST /x HTTP/1.1"), "{seen}");
}

#[test]
fn a_connection_cut_mid_body_is_unreachable() {
    let (base, server) = serve_once(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
    );
    let err = UreqTransport::new().send(&get(base, &[])).unwrap_err();
    server.join().unwrap();
    assert!(
        matches!(err, GitError::HostingUnreachable { .. }),
        "{err:?}"
    );
}

#[test]
fn a_garbage_reply_is_unreachable() {
    let (base, server) = serve_once(b"not http at all\r\n\r\n".to_vec());
    let err = UreqTransport::new().send(&get(base, &[])).unwrap_err();
    server.join().unwrap();
    assert!(
        matches!(err, GitError::HostingUnreachable { .. }),
        "{err:?}"
    );
}

#[test]
fn an_authorization_header_is_not_forwarded_to_another_origin_on_redirect() {
    // The target is another port (another origin) on the same machine.
    let (target, target_server) =
        serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec());
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: {target}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (base, origin_server) = serve_once(redirect.into_bytes());

    let resp = UreqTransport::new()
        .send(&get(
            format!("{base}/user"),
            &[("Authorization", "Bearer SECRET-TOKEN")],
        ))
        .unwrap();

    let first = origin_server.join().unwrap().to_ascii_lowercase();
    assert!(
        first.contains("authorization: bearer secret-token"),
        "{first}"
    );
    // Either the redirect was not followed (a 302 response) or it was followed without the
    // token; the token must not reach the other origin in any case.
    if resp.status == 200 {
        let second = target_server.join().unwrap().to_ascii_lowercase();
        assert!(second.starts_with("get /stolen"), "{second}");
        assert!(!second.contains("secret-token"), "{second}");
        assert!(!second.contains("authorization"), "{second}");
    } else {
        assert_eq!(resp.status, 302);
    }
}
