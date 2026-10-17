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
