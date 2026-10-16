use git_real_core::ProgressPhase;
use git_real_core::remote::git_cli::locate_in;
use git_real_core::remote::progress_parser::{LineBuffer, parse_line, split_chunks};

// --- parse_line: phase and percent detection ---

#[test]
fn parse_counting() {
    let p = parse_line("Counting objects: 100% (5/5), done.").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Counting));
    assert_eq!(p.percent, Some(100));
}

#[test]
fn parse_compressing() {
    let p = parse_line("Compressing objects:  60% (3/5)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Compressing));
    assert_eq!(p.percent, Some(60));
}

#[test]
fn parse_receiving() {
    let p = parse_line("Receiving objects:  45% (9/20)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Receiving));
    assert_eq!(p.percent, Some(45));
}

#[test]
fn parse_resolving() {
    let p = parse_line("Resolving deltas:  30% (3/10)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Resolving));
    assert_eq!(p.percent, Some(30));
}

#[test]
fn parse_updating_files_is_checking_out() {
    let p = parse_line("Updating files:  12% (3/25)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::CheckingOut));
    assert_eq!(p.percent, Some(12));
}

// --- parse_line: unrecognised and empty input ---

#[test]
fn parse_line_without_percent() {
    let input = "  Cloning into 'x'...  ";
    let p = parse_line(input).expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
    assert_eq!(p.percent, None);
    assert_eq!(p.message, input.trim());
}

#[test]
fn parse_empty_line_is_none() {
    assert!(parse_line("").is_none());
    assert!(parse_line("   ").is_none());
}

// --- split_chunks: git separates progress updates with carriage returns ---

#[test]
fn split_chunks_on_cr_and_lf() {
    assert_eq!(split_chunks(b"a\rb\nc"), vec!["a", "b", "c"]);
    assert!(split_chunks(b"\r\n").is_empty());
}

// --- locate_in: PATH search for the git executable ---

#[test]
fn locate_in_empty_path_is_none() {
    assert_eq!(locate_in(""), None);
}

#[test]
fn locate_in_finds_fake_git() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("git"), "").unwrap();
    #[cfg(windows)]
    std::fs::write(dir.path().join("git.exe"), "").unwrap();

    let found = locate_in(dir.path().to_str().unwrap());

    #[cfg(not(windows))]
    assert_eq!(found, Some(dir.path().join("git")));
    #[cfg(windows)]
    assert!(found.is_some());
}

#[test]
fn locate_in_skips_empty_and_relative_entries() {
    let path = std::env::join_paths(["", "relative/dir"]).unwrap();
    assert_eq!(locate_in(path), None);
}

// --- parse_line: server-side progress carries a "remote: " prefix ---

#[test]
fn parse_remote_prefixed_counting() {
    let p = parse_line("remote: Counting objects: 100% (5/5), done.   ").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Counting));
    assert_eq!(p.percent, Some(100));
    assert_eq!(p.message, "remote: Counting objects: 100% (5/5), done.");
}

// --- LineBuffer: carry-over of partial lines across reads ---

#[test]
fn line_buffer_joins_line_split_across_pushes() {
    let mut buf = LineBuffer::default();
    assert!(buf.push(b"Receiving obj").is_empty());
    assert_eq!(
        buf.push(b"ects:  45% (9/20)\r"),
        vec!["Receiving objects:  45% (9/20)"]
    );
}

#[test]
fn line_buffer_terminates_on_cr_and_lf() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"a\rb\nc\r"), vec!["a", "b", "c"]);
}

#[test]
fn line_buffer_drops_empty_segments() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"\r\n\r\na\r\n"), vec!["a"]);
}

#[test]
fn line_buffer_finish_flushes_unterminated_tail() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"a\rtail"), vec!["a"]);
    assert_eq!(buf.finish(), vec!["tail"]);
}

#[test]
fn line_buffer_finish_is_empty_when_fully_terminated() {
    let mut buf = LineBuffer::default();
    buf.push(b"a\n");
    assert!(buf.finish().is_empty());
}

#[test]
fn line_buffer_keeps_multibyte_char_split_across_pushes() {
    let mut buf = LineBuffer::default();
    assert!(buf.push(&[0xC3]).is_empty());
    assert_eq!(buf.push(&[0xA4, b'\n']), vec!["\u{e4}"]);
}
