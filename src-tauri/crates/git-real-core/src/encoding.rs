//! Detection and decoding of UTF-16/UTF-32 text, which libgit2 flags as binary
//! because of its NUL bytes.

use crate::model::TextEncoding;

/// Bytes examined by the BOM-less UTF-16 heuristic.
const SNIFF_BYTES: usize = 8192;

/// Sniffs `bytes`: BOM first (UTF-32 before UTF-16, since `FF FE 00 00` starts
/// with the UTF-16 LE mark), then valid UTF-8 without NUL, then the NUL-pattern
/// heuristic. `None` means "not text we can decode". Empty input is UTF-8.
pub fn detect_encoding(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.is_empty() {
        return Some(TextEncoding::Utf8);
    }
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        return Some(TextEncoding::Utf32Le);
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return Some(TextEncoding::Utf32Be);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(TextEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(TextEncoding::Utf16Be);
    }
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if !head.contains(&0) {
        return std::str::from_utf8(bytes).ok().map(|_| TextEncoding::Utf8);
    }
    let (pairs, _) = head.as_chunks::<2>();
    let total = pairs.len();
    if total == 0 {
        // A lone NUL byte is not UTF-16.
        return None;
    }
    let (mut le, mut be) = (0usize, 0usize);
    for &[lo, hi] in pairs {
        if hi == 0 && lo != 0 {
            le += 1;
        } else if lo == 0 && hi != 0 {
            be += 1;
        }
    }
    if le * 10 >= total * 9 {
        Some(TextEncoding::Utf16Le)
    } else if be * 10 >= total * 9 {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    }
}

/// Transcodes `bytes` to a `String`, dropping a leading BOM and replacing
/// malformed sequences with U+FFFD. A partial trailing code unit becomes one U+FFFD.
pub fn decode(bytes: &[u8], encoding: TextEncoding) -> String {
    match encoding {
        TextEncoding::Utf8 => {
            String::from_utf8_lossy(strip_bom(bytes, &[0xEF, 0xBB, 0xBF])).into_owned()
        }
        TextEncoding::Utf16Le => decode_utf16(strip_bom(bytes, &[0xFF, 0xFE]), u16::from_le_bytes),
        TextEncoding::Utf16Be => decode_utf16(strip_bom(bytes, &[0xFE, 0xFF]), u16::from_be_bytes),
        TextEncoding::Utf32Le => decode_utf32(
            strip_bom(bytes, &[0xFF, 0xFE, 0x00, 0x00]),
            u32::from_le_bytes,
        ),
        TextEncoding::Utf32Be => decode_utf32(
            strip_bom(bytes, &[0x00, 0x00, 0xFE, 0xFF]),
            u32::from_be_bytes,
        ),
    }
}

fn strip_bom<'a>(bytes: &'a [u8], bom: &[u8]) -> &'a [u8] {
    bytes.strip_prefix(bom).unwrap_or(bytes)
}

fn decode_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let (units, rest) = bytes.as_chunks::<2>();
    let mut out: String = char::decode_utf16(units.iter().map(|&c| unit(c)))
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if !rest.is_empty() {
        out.push(char::REPLACEMENT_CHARACTER);
    }
    out
}

fn decode_utf32(bytes: &[u8], unit: fn([u8; 4]) -> u32) -> String {
    let (units, rest) = bytes.as_chunks::<4>();
    let mut out: String = units
        .iter()
        .map(|&c| char::from_u32(unit(c)).unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if !rest.is_empty() {
        out.push(char::REPLACEMENT_CHARACTER);
    }
    out
}
