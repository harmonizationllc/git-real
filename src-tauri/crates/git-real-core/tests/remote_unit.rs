use git_real_core::git_cli::locate_in;
use git_real_core::remote::progress_parser::{LineBuffer, parse_line, split_chunks};
use git_real_core::{Progress, ProgressPhase};

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

// --- parse_line: remaining phases and prefix handling ---

#[test]
fn parse_remote_prefixed_compressing() {
    let p = parse_line("remote: Compressing objects:  33% (1/3)        ").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Compressing));
    assert_eq!(p.percent, Some(33));
}

#[test]
fn parse_remote_prefixed_unknown_text_is_other_with_full_message() {
    let p = parse_line("remote: Enumerating objects: 5, done.").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
    assert_eq!(p.percent, None);
    assert_eq!(p.message, "remote: Enumerating objects: 5, done.");
}

#[test]
fn parse_remote_prefix_without_space_does_not_match_phase() {
    let p = parse_line("remote:Counting objects: 5% (1/20)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
    assert_eq!(p.percent, Some(5));
}

#[test]
fn parse_phase_is_matched_case_sensitively() {
    let p = parse_line("receiving objects: 5% (1/20)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
    assert_eq!(p.percent, Some(5));
}

#[test]
fn parse_phase_must_be_at_line_start() {
    let p = parse_line("note: Receiving objects: 5% (1/20)").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
}

#[test]
fn parse_phase_without_percent() {
    let p = parse_line("Resolving deltas: done").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Resolving));
    assert_eq!(p.percent, None);
}

#[test]
fn parse_message_is_trimmed_line() {
    let p = parse_line("  Receiving objects:  45% (9/20)  ").expect("some");
    assert_eq!(p.message, "Receiving objects:  45% (9/20)");
}

// --- parse_line: percent edge cases ---

#[test]
fn parse_percent_zero() {
    let p = parse_line("Receiving objects:   0% (0/20)").expect("some");
    assert_eq!(p.percent, Some(0));
}

#[test]
fn parse_percent_leading_spaces_single_digit() {
    let p = parse_line("Receiving objects:     7% (1/14)").expect("some");
    assert_eq!(p.percent, Some(7));
}

#[test]
fn parse_percent_above_100_is_clamped() {
    let p = parse_line("Receiving objects: 150% (3/2)").expect("some");
    assert_eq!(p.percent, Some(100));
}

#[test]
fn parse_percent_with_four_digits_uses_last_three_and_clamps() {
    let p = parse_line("Receiving objects: 1234%").expect("some");
    assert_eq!(p.percent, Some(100));
}

#[test]
fn parse_percent_with_four_digits_uses_last_three_digits() {
    let p = parse_line("Receiving objects: 1042%").expect("some");
    assert_eq!(p.percent, Some(42));
}

#[test]
fn parse_lone_percent_sign_is_none() {
    assert_eq!(parse_line("%").expect("some").percent, None);
}

#[test]
fn parse_percent_sign_after_space_is_none() {
    let p = parse_line("Receiving objects: 50 % done").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Receiving));
    assert_eq!(p.percent, None);
}

#[test]
fn parse_stray_percent_then_real_percent_uses_real_one() {
    let p = parse_line("Receiving objects: % then 30% (3/10)").expect("some");
    assert_eq!(p.percent, Some(30));
}

#[test]
fn parse_first_percent_wins() {
    let p = parse_line("Receiving objects:  10% (2/20), 99% of total").expect("some");
    assert_eq!(p.percent, Some(10));
}

#[test]
fn parse_percent_after_non_ascii_text() {
    let p = parse_line("Empfange Objekte: \u{e4}\u{f6} 45%").expect("some");
    assert!(matches!(p.phase, ProgressPhase::Other));
    assert_eq!(p.percent, Some(45));
}

// --- split_chunks / LineBuffer: more edge cases ---

#[test]
fn split_chunks_empty_input_is_empty() {
    assert!(split_chunks(b"").is_empty());
}

#[test]
fn split_chunks_without_terminator_returns_whole_input() {
    assert_eq!(split_chunks(b"abc"), vec!["abc"]);
}

#[test]
fn split_chunks_replaces_invalid_utf8() {
    assert_eq!(split_chunks(&[b'a', 0xFF, b'b']), vec!["a\u{fffd}b"]);
}

#[test]
fn line_buffer_finish_on_fresh_buffer_is_empty() {
    assert!(LineBuffer::default().finish().is_empty());
}

#[test]
fn line_buffer_joins_line_split_across_three_pushes() {
    let mut buf = LineBuffer::default();
    assert!(buf.push(b"Recei").is_empty());
    assert!(buf.push(b"ving obj").is_empty());
    assert_eq!(buf.push(b"ects: 1%\r"), vec!["Receiving objects: 1%"]);
}

#[test]
fn line_buffer_terminator_alone_completes_pending_line() {
    let mut buf = LineBuffer::default();
    assert!(buf.push(b"abc").is_empty());
    assert_eq!(buf.push(b"\r"), vec!["abc"]);
}

#[test]
fn line_buffer_crlf_split_across_pushes_yields_line_once() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"a\r"), vec!["a"]);
    assert!(buf.push(b"\n").is_empty());
    assert!(buf.finish().is_empty());
}

#[test]
fn line_buffer_complete_lines_and_tail_in_one_push() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"a\rb\rpart"), vec!["a", "b"]);
    assert_eq!(buf.push(b"ial\n"), vec!["partial"]);
}

#[test]
fn line_buffer_does_not_re_emit_lines_already_returned() {
    let mut buf = LineBuffer::default();
    assert_eq!(buf.push(b"a\r"), vec!["a"]);
    assert_eq!(buf.push(b"b\r"), vec!["b"]);
}

#[test]
fn line_buffer_keeps_three_byte_char_split_across_three_pushes() {
    // U+20AC EURO SIGN is E2 82 AC.
    let mut buf = LineBuffer::default();
    assert!(buf.push(&[0xE2]).is_empty());
    assert!(buf.push(&[0x82]).is_empty());
    assert_eq!(buf.push(&[0xAC, b'\r']), vec!["\u{20ac}"]);
}

#[test]
fn line_buffer_finish_decodes_split_multibyte_tail() {
    let mut buf = LineBuffer::default();
    buf.push(&[b'x', 0xC3]);
    buf.push(&[0xA4]);
    assert_eq!(buf.finish(), vec!["x\u{e4}"]);
}

// --- locate_in: directory, ordering and mixed-entry branches ---

#[test]
fn locate_in_ignores_directory_named_git() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("git")).unwrap();
    #[cfg(windows)]
    std::fs::create_dir(dir.path().join("git.exe")).unwrap();

    assert_eq!(locate_in(dir.path()), None);
}

#[test]
fn locate_in_skips_nonexistent_absolute_dir() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("git"), "").unwrap();
    #[cfg(windows)]
    std::fs::write(dir.path().join("git.exe"), "").unwrap();
    let path =
        std::env::join_paths([dir.path().join("missing"), dir.path().to_path_buf()]).unwrap();

    assert!(locate_in(path).is_some());
}

#[test]
fn locate_in_returns_first_match_in_path_order() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    for dir in [&first, &second] {
        std::fs::write(dir.path().join("git"), "").unwrap();
        #[cfg(windows)]
        std::fs::write(dir.path().join("git.exe"), "").unwrap();
    }
    let path = std::env::join_paths([first.path(), second.path()]).unwrap();

    let found = locate_in(path).expect("found");

    assert!(found.starts_with(first.path()));
}

#[test]
fn locate_in_falls_through_dir_without_git_to_later_dir() {
    let empty = tempfile::tempdir().unwrap();
    let with_git = tempfile::tempdir().unwrap();
    std::fs::write(with_git.path().join("git"), "").unwrap();
    #[cfg(windows)]
    std::fs::write(with_git.path().join("git.exe"), "").unwrap();
    let path = std::env::join_paths([empty.path(), with_git.path()]).unwrap();

    assert!(locate_in(path).expect("found").starts_with(with_git.path()));
}

#[test]
fn locate_in_skips_directory_named_git_and_uses_later_file() {
    let bad = tempfile::tempdir().unwrap();
    let good = tempfile::tempdir().unwrap();
    std::fs::create_dir(bad.path().join("git")).unwrap();
    #[cfg(windows)]
    std::fs::create_dir(bad.path().join("git.exe")).unwrap();
    std::fs::write(good.path().join("git"), "").unwrap();
    #[cfg(windows)]
    std::fs::write(good.path().join("git.exe"), "").unwrap();
    let path = std::env::join_paths([bad.path(), good.path()]).unwrap();

    assert!(locate_in(path).expect("found").starts_with(good.path()));
}

#[test]
fn locate_in_skips_relative_and_empty_entries_before_absolute_match() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("git"), "").unwrap();
    #[cfg(windows)]
    std::fs::write(dir.path().join("git.exe"), "").unwrap();
    let path = std::env::join_paths([
        std::path::PathBuf::from(""),
        std::path::PathBuf::from("relative"),
        dir.path().to_path_buf(),
    ])
    .unwrap();

    assert!(locate_in(path).expect("found").starts_with(dir.path()));
}

// --- serde: wire format consumed by the front end ---

#[test]
fn progress_serializes_camel_case_with_null_percent() {
    let p = Progress {
        phase: ProgressPhase::CheckingOut,
        percent: None,
        message: "Updating files".to_owned(),
    };

    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        serde_json::json!({"phase": "checkingOut", "percent": null, "message": "Updating files"})
    );
}

#[test]
fn progress_serializes_numeric_percent() {
    let p = Progress {
        phase: ProgressPhase::Receiving,
        percent: Some(45),
        message: "m".to_owned(),
    };

    assert_eq!(serde_json::to_value(&p).unwrap()["percent"], 45);
}

#[test]
fn progress_phase_wire_names_are_camel_case() {
    let cases = [
        (ProgressPhase::Counting, "counting"),
        (ProgressPhase::Compressing, "compressing"),
        (ProgressPhase::Receiving, "receiving"),
        (ProgressPhase::Resolving, "resolving"),
        (ProgressPhase::CheckingOut, "checkingOut"),
        (ProgressPhase::Other, "other"),
    ];
    for (phase, name) in cases {
        assert_eq!(serde_json::to_value(phase).unwrap(), name);
    }
}

#[test]
fn progress_round_trips_through_json() {
    let p = Progress {
        phase: ProgressPhase::Resolving,
        percent: Some(30),
        message: "Resolving deltas:  30% (3/10)".to_owned(),
    };

    let back: Progress = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();

    assert_eq!(back, p);
}

#[test]
fn progress_rejects_snake_case_phase() {
    let json = r#"{"phase":"checking_out","percent":null,"message":""}"#;
    assert!(serde_json::from_str::<Progress>(json).is_err());
}
