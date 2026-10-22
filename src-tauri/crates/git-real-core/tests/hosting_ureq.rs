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

/// Like `serve_once`, with a raw byte reply.
fn serve_bytes(reply: Vec<u8>) -> (String, thread::JoinHandle<String>) {
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
        sock.write_all(&reply).unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    });
    (url, handle)
}

fn get_req(url: String, headers: &[(&str, &str)]) -> Request {
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

// The status is what the caller maps to an error; an undecodable body must not hide it.
#[test]
fn a_non_utf8_body_keeps_its_status() {
    let mut reply =
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\nConnection: close\r\n\r\n".to_vec();
    reply.extend_from_slice(&[0xff, 0xfe, 0x41]);
    let (base, server) = serve_bytes(reply);

    let resp = UreqTransport::new().send(&get_req(base, &[])).unwrap();

    server.join().unwrap();
    assert_eq!(resp.status, 404);
    assert!(resp.body.contains('A'), "{:?}", resp.body);
}

// The token goes to its own host; a redirect inside the same origin keeps it.
#[test]
fn a_redirect_to_the_same_host_keeps_the_authorization_header() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let mut seen = Vec::new();
        for reply in [
            format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{addr}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned(),
        ] {
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
            sock.write_all(reply.as_bytes()).unwrap();
            seen.push(String::from_utf8_lossy(&buf).to_ascii_lowercase());
        }
        seen
    });

    let resp = UreqTransport::new()
        .send(&get_req(
            format!("http://{addr}/start"),
            &[("Authorization", "Bearer t0k")],
        ))
        .unwrap();

    let seen = server.join().unwrap();
    assert_eq!(resp.status, 200);
    assert!(seen[1].starts_with("get /next"), "{}", seen[1]);
    assert!(seen[1].contains("authorization: bearer t0k"), "{}", seen[1]);
}
