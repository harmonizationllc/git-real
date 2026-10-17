use git_real_core::TextEncoding;
use git_real_core::encoding::{decode, detect_encoding};

fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_le_bytes).collect()
}
fn utf16be(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

#[test]
fn detects_boms() {
    let cases: [(&[u8], TextEncoding); 4] = [
        (
            &[0xFF, 0xFE, 0x00, 0x00, b'a', 0, 0, 0],
            TextEncoding::Utf32Le,
        ),
        (
            &[0x00, 0x00, 0xFE, 0xFF, 0, 0, 0, b'a'],
            TextEncoding::Utf32Be,
        ),
        (&[0xFF, 0xFE, b'a', 0], TextEncoding::Utf16Le),
        (&[0xFE, 0xFF, 0, b'a'], TextEncoding::Utf16Be),
    ];
    for (bytes, want) in cases {
        assert_eq!(detect_encoding(bytes), Some(want), "{bytes:?}");
    }
}

#[test]
fn detects_bomless_utf16_by_nul_pattern() {
    assert_eq!(
        detect_encoding(&utf16le("hello world\n")),
        Some(TextEncoding::Utf16Le)
    );
    assert_eq!(
        detect_encoding(&utf16be("hello world\n")),
        Some(TextEncoding::Utf16Be)
    );
}

#[test]
fn detects_utf8_without_nul() {
    assert_eq!(detect_encoding(b"plain ascii\n"), Some(TextEncoding::Utf8));
    assert_eq!(
        detect_encoding("héllo wörld ✓\n".as_bytes()),
        Some(TextEncoding::Utf8)
    );
    assert_eq!(
        detect_encoding(&[0xEF, 0xBB, 0xBF, b'x']),
        Some(TextEncoding::Utf8)
    );
}

#[test]
fn empty_is_utf8() {
    assert_eq!(detect_encoding(&[]), Some(TextEncoding::Utf8));
}

#[test]
fn rejects_binary_and_invalid_utf8() {
    assert_eq!(detect_encoding(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), None);
    assert_eq!(detect_encoding(&[0xC3, 0x28, b'a']), None); // invalid UTF-8, no NUL
    // Half the pairs have a zero high byte: below the 90 % threshold.
    assert_eq!(
        detect_encoding(&[b'a', 0, b'b', b'c', b'd', 0, b'e', b'f']),
        None
    );
    // A NUL-only head has no complete pair to vote with: not UTF-16.
    assert_eq!(detect_encoding(&[0x00]), None);
    assert_eq!(detect_encoding(&[0x00, 0x00, 0x00]), None);
}

#[test]
fn heuristic_looks_only_at_first_8192_bytes() {
    let mut bytes = utf16le(&"a".repeat(4096)); // exactly 8192 bytes of clean UTF-16 LE
    bytes.extend_from_slice(&[0xFF; 1000]);
    assert_eq!(detect_encoding(&bytes), Some(TextEncoding::Utf16Le));
}

#[test]
fn decode_strips_bom_and_transcodes() {
    let mut le = vec![0xFF, 0xFE];
    le.extend(utf16le("héllo\n"));
    assert_eq!(decode(&le, TextEncoding::Utf16Le), "héllo\n");
    let mut be = vec![0xFE, 0xFF];
    be.extend(utf16be("x"));
    assert_eq!(decode(&be, TextEncoding::Utf16Be), "x");
    assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'x'], TextEncoding::Utf8), "x");
    assert_eq!(
        decode(&[0xFF, 0xFE, 0, 0, b'a', 0, 0, 0], TextEncoding::Utf32Le),
        "a"
    );
    assert_eq!(
        decode(&[0, 0, 0xFE, 0xFF, 0, 0, 0, b'a'], TextEncoding::Utf32Be),
        "a"
    );
}

#[test]
fn decode_replaces_malformed_input() {
    assert_eq!(decode(&[b'a', 0, b'b'], TextEncoding::Utf16Le), "a\u{FFFD}");
    assert_eq!(
        decode(&[0x00, 0xD8, b'a', 0], TextEncoding::Utf16Le),
        "\u{FFFD}a"
    ); // lone surrogate
    assert_eq!(
        decode(&[0xFF, 0xFF, 0xFF, 0xFF], TextEncoding::Utf32Le),
        "\u{FFFD}"
    );
    assert_eq!(
        decode(&[b'a', 0, 0, 0, b'b'], TextEncoding::Utf32Le),
        "a\u{FFFD}"
    );
    assert_eq!(decode(&[0xC3, 0x28], TextEncoding::Utf8), "\u{FFFD}(");
}

#[test]
fn enums_serialize_camel_case() {
    assert_eq!(
        serde_json::to_string(&TextEncoding::Utf16Le).unwrap(),
        "\"utf16Le\""
    );
    assert_eq!(
        serde_json::to_string(&TextEncoding::Utf32Be).unwrap(),
        "\"utf32Be\""
    );
    assert_eq!(
        serde_json::to_string(&git_real_core::DiffSide::Old).unwrap(),
        "\"old\""
    );
    let side: git_real_core::DiffSide = serde_json::from_str("\"new\"").unwrap();
    assert_eq!(side, git_real_core::DiffSide::New);
}

fn utf32le(s: &str) -> Vec<u8> {
    s.chars().flat_map(|c| (c as u32).to_le_bytes()).collect()
}

#[test]
fn bomless_utf32_is_not_detected() {
    // Only half of the 2-byte pairs have a zero high byte, so the UTF-16
    // heuristic must not claim UTF-32 text.
    assert_eq!(detect_encoding(&utf32le("hello world\n")), None);
    let be: Vec<u8> = "hello world\n"
        .chars()
        .flat_map(|c| (c as u32).to_be_bytes())
        .collect();
    assert_eq!(detect_encoding(&be), None);
}

#[test]
fn utf16_heuristic_threshold_is_ninety_percent() {
    // 10 pairs, nine of them (lo, 0): exactly 90 % -> little endian.
    let mut le = vec![];
    for _ in 0..9 {
        le.extend_from_slice(&[b'a', 0]);
    }
    le.extend_from_slice(b"ab");
    assert_eq!(detect_encoding(&le), Some(TextEncoding::Utf16Le));
    // Eight of ten: below the threshold.
    let mut low = vec![];
    for _ in 0..8 {
        low.extend_from_slice(&[b'a', 0]);
    }
    low.extend_from_slice(b"abcd");
    assert_eq!(detect_encoding(&low), None);
    // The same on the big-endian side.
    let mut be = vec![];
    for _ in 0..9 {
        be.extend_from_slice(&[0, b'a']);
    }
    be.extend_from_slice(b"ab");
    assert_eq!(detect_encoding(&be), Some(TextEncoding::Utf16Be));
}

#[test]
fn nul_pairs_do_not_vote_for_either_endianness() {
    // (0, 0) pairs count for neither side, so all-NUL padding is not UTF-16.
    assert_eq!(detect_encoding(&[0, 0, 0, 0, 0, 0, 0, 0]), None);
    // Mixed endianness splits the votes.
    assert_eq!(detect_encoding(&[b'a', 0, 0, b'a', b'b', 0, 0, b'b']), None);
}

#[test]
fn bomless_utf16_with_odd_trailing_byte_is_still_detected() {
    let mut bytes = utf16le(&"a".repeat(20));
    bytes.push(b'z');
    assert_eq!(detect_encoding(&bytes), Some(TextEncoding::Utf16Le));
}

#[test]
fn bomless_utf16_heuristic_reads_only_the_head_even_if_the_tail_is_wild() {
    let mut bytes = utf16le(&"a".repeat(4096));
    bytes.extend(std::iter::repeat_n(0x80u8, 4096)); // invalid UTF-8 beyond the window
    assert_eq!(detect_encoding(&bytes), Some(TextEncoding::Utf16Le));
}

#[test]
fn nul_beyond_the_sniff_window_is_still_valid_utf8() {
    // The NUL scan covers only the first 8192 bytes; the whole buffer must
    // still validate as UTF-8, which it does.
    let mut bytes = vec![b'a'; 8192];
    bytes.push(0);
    assert_eq!(detect_encoding(&bytes), Some(TextEncoding::Utf8));
    // Invalid UTF-8 beyond the window disqualifies the buffer.
    let mut bad = vec![b'a'; 8192];
    bad.push(0xC3);
    assert_eq!(detect_encoding(&bad), None);
}

#[test]
fn utf16_bom_wins_over_a_later_nul_free_body() {
    assert_eq!(
        detect_encoding(&[0xFF, 0xFE]),
        Some(TextEncoding::Utf16Le),
        "BOM alone"
    );
    assert_eq!(detect_encoding(&[0xFE, 0xFF]), Some(TextEncoding::Utf16Be));
    // FF FE 00 00 is a UTF-32 LE BOM, never UTF-16 LE followed by U+0000.
    assert_eq!(
        detect_encoding(&[0xFF, 0xFE, 0x00, 0x00]),
        Some(TextEncoding::Utf32Le)
    );
}

#[test]
fn decode_handles_bomless_input_and_surrogate_pairs() {
    assert_eq!(decode(&utf16le("héllo"), TextEncoding::Utf16Le), "héllo");
    assert_eq!(decode(&utf16be("héllo"), TextEncoding::Utf16Be), "héllo");
    assert_eq!(decode(&utf16le("a😀b"), TextEncoding::Utf16Le), "a😀b");
    assert_eq!(decode(&utf16be("a😀b"), TextEncoding::Utf16Be), "a😀b");
    assert_eq!(decode(&utf32le("a😀b"), TextEncoding::Utf32Le), "a😀b");
    assert_eq!(decode(b"plain", TextEncoding::Utf8), "plain");
    assert_eq!(decode(&[], TextEncoding::Utf16Le), "");
    assert_eq!(decode(&[], TextEncoding::Utf32Be), "");
}

#[test]
fn decode_only_strips_a_single_leading_bom() {
    assert_eq!(
        decode(&[0xFF, 0xFE, 0xFF, 0xFE, b'a', 0], TextEncoding::Utf16Le),
        "\u{FEFF}a"
    );
    // A BOM-looking prefix of the wrong width is not stripped for UTF-8.
    assert_eq!(
        decode(&[0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF], TextEncoding::Utf8),
        "\u{FEFF}"
    );
}

#[test]
fn decode_replaces_out_of_range_and_surrogate_utf32() {
    assert_eq!(
        decode(&0x0011_0000u32.to_le_bytes(), TextEncoding::Utf32Le),
        "\u{FFFD}"
    );
    assert_eq!(
        decode(&0xD800u32.to_be_bytes(), TextEncoding::Utf32Be),
        "\u{FFFD}"
    );
}

#[test]
fn decode_replaces_lone_low_surrogate_and_truncated_pair() {
    assert_eq!(
        decode(&[0x00, 0xDC, b'a', 0], TextEncoding::Utf16Le),
        "\u{FFFD}a"
    );
    // High surrogate at end of input.
    assert_eq!(
        decode(&[b'a', 0, 0x3D, 0xD8], TextEncoding::Utf16Le),
        "a\u{FFFD}"
    );
}

#[test]
fn enums_round_trip_through_json_for_every_variant() {
    use git_real_core::{DiffScope, DiffSide};
    let encodings = [
        (TextEncoding::Utf8, "\"utf8\""),
        (TextEncoding::Utf16Le, "\"utf16Le\""),
        (TextEncoding::Utf16Be, "\"utf16Be\""),
        (TextEncoding::Utf32Le, "\"utf32Le\""),
        (TextEncoding::Utf32Be, "\"utf32Be\""),
    ];
    for (value, json) in encodings {
        assert_eq!(serde_json::to_string(&value).unwrap(), json);
        assert_eq!(serde_json::from_str::<TextEncoding>(json).unwrap(), value);
    }
    for (value, json) in [(DiffSide::Old, "\"old\""), (DiffSide::New, "\"new\"")] {
        assert_eq!(serde_json::to_string(&value).unwrap(), json);
        assert_eq!(serde_json::from_str::<DiffSide>(json).unwrap(), value);
    }
    for (value, json) in [
        (DiffScope::Staged, "\"staged\""),
        (DiffScope::Unstaged, "\"unstaged\""),
    ] {
        assert_eq!(serde_json::to_string(&value).unwrap(), json);
        assert_eq!(serde_json::from_str::<DiffScope>(json).unwrap(), value);
    }
}

#[test]
fn enums_reject_unknown_and_wrongly_cased_names() {
    for bad in [
        "\"utf16LE\"",
        "\"UTF8\"",
        "\"utf_16_le\"",
        "\"latin1\"",
        "\"\"",
        "null",
    ] {
        assert!(serde_json::from_str::<TextEncoding>(bad).is_err(), "{bad}");
    }
    for bad in ["\"Old\"", "\"both\"", "0"] {
        assert!(
            serde_json::from_str::<git_real_core::DiffSide>(bad).is_err(),
            "{bad}"
        );
    }
}
