//! Matching one stored row against a search query.

use git2::{Oid, Repository};

use super::shared::Row;

/// True when `query` (already trimmed and lowercased, never empty) is a 4 to
/// 40 character hex prefix of the oid, or appears in the author name or email,
/// the subject, or the full message. The message is only read from the object
/// database when nothing cheaper matched.
pub(crate) fn matches(repo: &Repository, row: &Row, query: &str) -> bool {
    let is_hex = (4..=40).contains(&query.len()) && query.bytes().all(|b| b.is_ascii_hexdigit());
    if is_hex && hex_starts_with(row.oid, query.as_bytes()) {
        return true;
    }
    if row.author.name.to_lowercase().contains(query)
        || row.author.email.to_lowercase().contains(query)
        || row.subject.to_lowercase().contains(query)
    {
        return true;
    }
    repo.find_commit(row.oid).is_ok_and(|commit| {
        String::from_utf8_lossy(commit.message_bytes())
            .to_lowercase()
            .contains(query)
    })
}

/// True when the lowercase hex of `oid` starts with `prefix`, formatted on
/// the stack rather than into a string per row.
fn hex_starts_with(oid: Oid, prefix: &[u8]) -> bool {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut hex = [0u8; 40];
    for (pair, byte) in hex.as_chunks_mut::<2>().0.iter_mut().zip(oid.as_bytes()) {
        pair[0] = DIGITS[usize::from(byte >> 4)];
        pair[1] = DIGITS[usize::from(byte & 0x0f)];
    }
    hex.starts_with(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_prefix_compares_against_the_lowercase_hex() {
        let oid = Oid::from_str("0a1b2c3d4e5f60718293a4b5c6d7e8f901234567").unwrap();
        assert!(hex_starts_with(oid, b"0a1b"));
        assert!(hex_starts_with(oid, oid.to_string().as_bytes()));
        assert!(!hex_starts_with(oid, b"a1b2"));
        assert!(!hex_starts_with(oid, b"0A1B"));
    }
}
