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

pub mod diff;
pub mod encoding;
pub mod error;
pub mod ignore;
pub mod index_ops;
pub mod model;
mod paths;
pub mod progress;
pub mod recent;
pub mod remote;
pub mod repo;
pub mod status;

pub use error::GitError;
pub use ignore::gitignore_pattern;
pub use model::*;
pub use progress::ProgressSink;
pub use recent::RecentRepos;
pub use repo::RepoSession;
