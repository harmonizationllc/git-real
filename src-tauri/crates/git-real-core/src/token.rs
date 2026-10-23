//! A personal access token, kept out of `Debug` text and errors. Neutral ground shared by
//! the hosting domain and remote authentication.

use std::fmt;

use crate::error::GitError;

const MAX_TOKEN_BYTES: usize = 4096;

/// A personal access token. No `Display`, no serde: it leaves only through
/// [`Token::expose_secret`].
#[derive(Clone)]
pub struct Token(String);

impl Token {
    /// `InvalidToken` unless `s` is non-empty, at most 4096 bytes, and free of line breaks
    /// and NUL.
    pub fn new(s: &str) -> Result<Self, GitError> {
        if s.is_empty() || s.len() > MAX_TOKEN_BYTES || s.contains(['\n', '\r', '\0']) {
            return Err(GitError::InvalidToken);
        }
        Ok(Self(s.to_owned()))
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Token").field(&"***").finish()
    }
}
