//! Matching one cached row against a search query.

use git2::Repository;

use super::cache::CachedRow;

/// True when `query` (already trimmed and lowercased, never empty) is a 4 to
/// 40 character hex prefix of the oid, or appears in the author name or email,
/// the subject, or the full message. The message is only read from the object
/// database when nothing cheaper matched.
pub(crate) fn matches(repo: &Repository, row: &CachedRow, query: &str) -> bool {
    let is_hex = (4..=40).contains(&query.len()) && query.bytes().all(|b| b.is_ascii_hexdigit());
    if is_hex && row.oid.to_string().starts_with(query) {
        return true;
    }
    if row.author_name.to_lowercase().contains(query)
        || row.author_email.to_lowercase().contains(query)
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
