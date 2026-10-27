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

pub mod commit;
pub mod content;
pub mod diff;
pub mod encoding;
pub mod error;
pub mod git_cli;
mod git_ops;
pub mod history;
pub mod hosting;
pub mod ignore;
pub mod index_ops;
pub mod log;
pub mod merge;
pub mod model;
pub mod paths;
pub mod progress;
pub mod recent;
pub mod refs;
pub mod remote;
pub mod repo;
mod revision;
pub mod settings;
pub mod stash;
pub mod status;
pub mod token;
pub mod tools;
pub mod update;

pub use error::GitError;
pub use ignore::gitignore_pattern;
pub use model::*;
pub use progress::ProgressSink;
pub use recent::RecentRepos;
pub use remote::auth::Credentials;
pub use repo::RepoSession;
pub use settings::{SETTINGS_VERSION, Settings, SettingsError, SettingsFile, SettingsPatch};
pub use tools::{
    DiffRange, EMPTY_TREE, ExternalDiffScope, ToolError, open_external_diff, open_external_merge,
    open_in_editor, split_command,
};
pub use update::{UpdateInfo, Version};
