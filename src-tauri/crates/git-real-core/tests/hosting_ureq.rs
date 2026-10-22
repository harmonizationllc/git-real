//! UreqTransport against a one-shot local HTTP server on 127.0.0.1 (spec §7: one smoke test
//! of the real adapter; no provider is contacted).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use git_real_core::GitError;
use git_real_core::hosting::ureq_transport::UreqTransport;
use git_real_core::hosting::{Method, Request, Transport};

/// Serves one connection with `reply` and returns the raw request text.
fn serve_once(reply: &'static str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut chunk).unwrap();
            buf.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        if let Some(len) = text.lines().find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(|v| v.trim().parse::<usize>().unwrap())
        }) {
            let have = buf.len() - (text.find("\r\n\r\n").unwrap() + 4);
            let mut rest = vec![0u8; len - have];
            sock.read_exact(&mut rest).unwrap();
            buf.extend_from_slice(&rest);
        }
        sock.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    (url, handle)
}

#[test]
fn a_get_returns_status_headers_and_body_without_treating_4xx_as_an_error() {
    let (base, server) = serve_once(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nX-RateLimit-Remaining: 7\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    let req = Request {
        method: Method::Get,
        url: format!("{base}/user"),
        headers: vec![("Authorization".into(), "Bearer t0k".into())],
        body: None,
    };
    let resp = UreqTransport::new().send(&req).unwrap();
    assert_eq!(
        (
            resp.status,
            resp.body.as_str(),
            resp.header("x-ratelimit-remaining")
        ),
        (401, "{}", Some("7"))
    );
    let seen = server.join().unwrap().to_ascii_lowercase();
    assert!(seen.starts_with("get /user http/1.1"), "{seen}");
    assert!(
        seen.contains("authorization: bearer t0k") && seen.contains("user-agent: git-real/"),
        "{seen}"
    );
}

#[test]
fn a_post_sends_its_body() {
    let (base, server) =
        serve_once("HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    let req = Request {
        method: Method::Post,
        url: format!("{base}/x"),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: Some(r#"{"a":1}"#.into()),
    };
    assert_eq!(UreqTransport::new().send(&req).unwrap().status, 201);
    let seen = server.join().unwrap();
    assert!(
        seen.starts_with("POST /x HTTP/1.1") && seen.ends_with(r#"{"a":1}"#),
        "{seen}"
    );
}

#[test]
fn a_refused_connection_is_unreachable() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port(); // dropped: closed
    let req = Request {
        method: Method::Get,
        url: format!("http://127.0.0.1:{port}/"),
        headers: vec![],
        body: None,
    };
    assert!(matches!(
        UreqTransport::new().send(&req),
        Err(GitError::HostingUnreachable { .. })
    ));
}
