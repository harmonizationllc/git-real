//! `git-real-core` is the pure Git domain for Git Real.
//!
//! This crate holds all Git business logic and knows nothing about Tauri, the
//! webview, or any transport layer; dependencies flow from the app into the
//! core, never the reverse. That isolation lets the domain compile and unit
//! test with a plain `cargo test`, keeping the TDD red/green cycle fast.
//!
//! The backend is deliberately hybrid: `git2` (libgit2) handles local reads
//! such as status, log, diff, and refs, while network, credential, and signing
//! operations shell out to the system `git` CLI. Network default features of
//! `git2` are disabled for this reason.

pub mod error;
pub mod model;
pub mod repo;

pub use error::GitError;
pub use model::*;
pub use repo::RepoSession;
