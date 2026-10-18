# GR-6 Commit and Amend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A commit box under the Changes panel that commits or amends the staged changes through `git commit`, shows the configured author, warns past 72 subject characters, and signs whenever Git config says so.

**Architecture:** `git-real-core` gains a `commit` module: pure message split/join, config and HEAD reads through git2, and a shell-out to `git commit -F -` (the only writer, so hooks and signing behave exactly as on the command line). The Tauri app exposes three commands; the front end adds `src/features/commit/` with a per-repo draft store, a pure disabled-reason gate, query/mutation hooks and three components mounted in `RepoPane`.

**Tech Stack:** Rust 2024 + git2 0.20 (`default-features = false`), `std::process::Command`, Tauri 2, React 19 + TypeScript, TanStack Query 5, Zustand 5, Vitest + Testing Library + happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-17-gr6-commit-amend-design.md`

## Global Constraints

- Tests first, by the test role; the developer role never edits test files (CLAUDE.md).
- The only module importing `@tauri-apps/api/core` is `src/lib/ipc` (ESLint-enforced).
- `git2` stays `default-features = false`; no direct `tokio` dependency; blocking work runs through `run_blocking`; `git-real-core` has no Tauri dependency.
- Every commit shells out to `git commit`; git2 never creates a commit in product code (test fixtures may).
- Child process: `git -C <workdir> commit --cleanup=whitespace -F - [--amend]`, env `LC_ALL=C` and `GIT_TERMINAL_PROMPT=0`, message on stdin, stdout and stderr captured. No path arguments.
- No new dependency in Rust or the front end.
- Serde: every new enum and struct is `rename_all = "camelCase"`: `openPgp`, `x509`, `ssh`; error kinds `emptyMessage`, `nothingToCommit`, `commitFailed`.
- Constant: `SUBJECT_LIMIT = 72`.
- Copy (verbatim): labels "Subject", "Body"; placeholders "Summary of changes", "Optional longer description"; checkbox "Amend last commit"; button "Commit" / "Amend commit" / "Committing…"; hint "Keep the subject at 72 characters or fewer"; author fallback "Author not configured"; badges "Signs with GPG", "Signs with SSH", "Signs with X.509"; disabled reasons in order "Loading…", "Set user.name and user.email in your Git config", "Resolve conflicts before committing", "Stage changes to commit", "Enter a commit subject"; checkbox title "No commit to amend"; app-layer fallbacks "git commit failed with exit code N" / "git commit was terminated by a signal".
- Gates: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `npm test` at 100 % coverage for `src/`, `npm run lint` (ESLint + `prettier --check .`, which includes docs), `npm run typecheck`.

## Review Focus

1. A developer or CI machine whose global config has `commit.gpgsign=true`: core tests must not try to sign. Fixtures set repo-local `commit.gpgsign=false` (Task 2 `configure_identity`).
2. A `pre-commit` hook that fails before git reads stdin: the write to the child's stdin hits `EPIPE`. That must not mask the hook's stderr (Task 2 test `failing_pre_commit_hook_reports_hook_output`).
3. A body line starting with `#`: `--cleanup=whitespace` keeps it; `strip` would silently drop it (Task 1 join test, Task 2 test `commit_keeps_hash_lines_in_body`).
4. A subject containing a newline (pasted text reaches IPC as one string): `join` flattens it to spaces so git never sees a multi-line subject (Task 1 test `join_flattens_newlines_in_subject`).
5. Amend toggled on when HEAD is unborn (`headMessage` null): the checkbox is disabled, and even if the store is driven directly the typed text must survive (Task 4 test `setAmend with null head keeps the typed text`).

---

### Task 1: Core — commit model, pure message rules, new errors

**Files:**

- Create: `src-tauri/crates/git-real-core/src/model/commit.rs`
- Modify: `src-tauri/crates/git-real-core/src/model/mod.rs`
- Create: `src-tauri/crates/git-real-core/src/commit/mod.rs` (declares `pub mod message;` only; the `impl RepoSession` block arrives in Task 2)
- Create: `src-tauri/crates/git-real-core/src/commit/message.rs`
- Modify: `src-tauri/crates/git-real-core/src/error.rs`
- Modify: `src-tauri/crates/git-real-core/src/lib.rs`
- Test: `src-tauri/crates/git-real-core/tests/commit_message.rs`

**Interfaces:**

- Produces: `CommitMessage { subject: String, body: String }`, `SigningFormat { OpenPgp, X509, Ssh }`, `CommitConfig { name: Option<String>, email: Option<String>, signing: Option<SigningFormat> }`, `CommitOutcome { oid: String, summary: String }` (all re-exported from `git_real_core`); `git_real_core::commit::message::{split, join}`; `GitError::{EmptyMessage, NothingToCommit, CommitFailed { code, stdout, stderr }}`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/crates/git-real-core/tests/commit_message.rs
use git_real_core::commit::message::{join, split};
use git_real_core::{CommitConfig, CommitMessage, CommitOutcome, GitError, SigningFormat};

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.to_string(),
        body: body.to_string(),
    }
}

// --- split ---

#[test]
fn split_single_line_has_empty_body() {
    assert_eq!(split("initial commit\n"), msg("initial commit", ""));
}

#[test]
fn split_takes_first_line_as_subject_and_rest_as_body() {
    let m = split("Fix the thing\n\nIt was broken.\nNow it is not.\n");
    assert_eq!(m, msg("Fix the thing", "It was broken.\nNow it is not."));
}

#[test]
fn split_drops_leading_blank_lines_of_body_but_keeps_inner_ones() {
    let m = split("Subject\n\n\n  \nPara one\n\nPara two\n");
    assert_eq!(m.body, "Para one\n\nPara two");
}

#[test]
fn split_trims_subject_and_handles_crlf() {
    let m = split("  Subject with spaces  \r\n\r\nBody line\r\n");
    assert_eq!(m.subject, "Subject with spaces");
    assert_eq!(m.body, "Body line");
}

#[test]
fn split_keeps_hash_lines_in_body() {
    let m = split("Subject\n\n# not a comment\nreal line\n");
    assert_eq!(m.body, "# not a comment\nreal line");
}

#[test]
fn split_empty_string_is_empty_message() {
    assert_eq!(split(""), msg("", ""));
}

#[test]
fn split_multi_line_first_paragraph_puts_second_line_in_body() {
    // Git's subject is the first paragraph; the UI subject is one line.
    let m = split("Line one\nLine two\n\nBody\n");
    assert_eq!(m.subject, "Line one");
    assert_eq!(m.body, "Line two\n\nBody");
}

// --- join ---

#[test]
fn join_subject_only_ends_with_single_newline() {
    assert_eq!(join(&msg("Subject", "")), "Subject\n");
}

#[test]
fn join_whitespace_only_body_counts_as_empty() {
    assert_eq!(join(&msg("Subject", "  \n\n")), "Subject\n");
}

#[test]
fn join_separates_subject_and_body_with_blank_line() {
    assert_eq!(join(&msg("Subject", "Body")), "Subject\n\nBody\n");
}

#[test]
fn join_flattens_newlines_in_subject() {
    assert_eq!(join(&msg("Line one\nLine two\r\nThree", "")), "Line one Line two Three\n");
}

#[test]
fn join_trims_subject() {
    assert_eq!(join(&msg("  Subject  ", "")), "Subject\n");
}

#[test]
fn join_trims_body_edges_and_normalises_crlf() {
    assert_eq!(join(&msg("S", "\n\nfirst\r\nsecond  \n\n")), "S\n\nfirst\nsecond\n");
}

#[test]
fn join_keeps_hash_lines_and_inner_blank_lines() {
    assert_eq!(join(&msg("S", "# kept\n\nnext")), "S\n\n# kept\n\nnext\n");
}

#[test]
fn join_then_split_round_trips() {
    let original = msg("Subject", "Para one\n\nPara two");
    assert_eq!(split(&join(&original)), original);
}

#[test]
fn join_blank_subject_keeps_body_after_blank_lines() {
    // The caller (Task 2) treats this as EmptyMessage; join itself stays total.
    assert_eq!(join(&msg("   ", "body")), "\n\nbody\n");
}

// --- serde shapes ---

#[test]
fn commit_message_serializes_camel_case() {
    let json = serde_json::to_value(msg("s", "b")).unwrap();
    assert_eq!(json, serde_json::json!({ "subject": "s", "body": "b" }));
    let back: CommitMessage = serde_json::from_value(json).unwrap();
    assert_eq!(back, msg("s", "b"));
}

#[test]
fn signing_format_serializes_as_spec_names() {
    assert_eq!(serde_json::to_value(SigningFormat::OpenPgp).unwrap(), "openPgp");
    assert_eq!(serde_json::to_value(SigningFormat::X509).unwrap(), "x509");
    assert_eq!(serde_json::to_value(SigningFormat::Ssh).unwrap(), "ssh");
}

#[test]
fn commit_config_serializes_with_nulls() {
    let cfg = CommitConfig {
        name: None,
        email: Some("a@b.c".into()),
        signing: Some(SigningFormat::Ssh),
    };
    assert_eq!(
        serde_json::to_value(cfg).unwrap(),
        serde_json::json!({ "name": null, "email": "a@b.c", "signing": "ssh" })
    );
}

#[test]
fn commit_outcome_serializes_camel_case() {
    let out = CommitOutcome {
        oid: "abc".into(),
        summary: "s".into(),
    };
    assert_eq!(
        serde_json::to_value(out).unwrap(),
        serde_json::json!({ "oid": "abc", "summary": "s" })
    );
}

// --- errors ---

#[test]
fn new_error_variants_have_messages() {
    assert_eq!(GitError::EmptyMessage.to_string(), "the commit message has no subject");
    assert_eq!(GitError::NothingToCommit.to_string(), "nothing is staged to commit");
    let failed = GitError::CommitFailed {
        code: Some(1),
        stdout: String::new(),
        stderr: "hook says no".into(),
    };
    assert_eq!(failed.to_string(), "git commit failed (exit code Some(1)): hook says no");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri`): `cargo test -p git-real-core --test commit_message`
Expected: compile error, `unresolved import git_real_core::commit` / `CommitMessage`.

- [ ] **Step 3: Write the model and the pure functions**

```rust
// src-tauri/crates/git-real-core/src/model/commit.rs
//! Types for composing and recording a commit.

use serde::{Deserialize, Serialize};

/// A commit message as the UI edits it: one-line subject plus free-form body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub subject: String,
    pub body: String,
}

/// Git's `gpg.format` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SigningFormat {
    OpenPgp,
    X509,
    Ssh,
}

/// What Git config says about the next commit's author and signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitConfig {
    /// `user.name`, `None` when unset or blank.
    pub name: Option<String>,
    /// `user.email`, `None` when unset or blank.
    pub email: Option<String>,
    /// `Some` when `commit.gpgsign` is true; the format follows `gpg.format`.
    pub signing: Option<SigningFormat>,
}

/// The commit that `git commit` produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    /// Full hex object id.
    pub oid: String,
    /// First line of the recorded message.
    pub summary: String,
}
```

```rust
// src-tauri/crates/git-real-core/src/model/mod.rs — add
mod commit;
pub use commit::{CommitConfig, CommitMessage, CommitOutcome, SigningFormat};
```

```rust
// src-tauri/crates/git-real-core/src/commit/mod.rs
//! Composing and recording commits.
//!
//! Message rules live in [`message`]; the commit itself goes through the
//! system `git` CLI so hooks and signing behave exactly as on the command
//! line (ADR 0001).

pub mod message;
```

```rust
// src-tauri/crates/git-real-core/src/commit/message.rs
//! Pure rules for turning a subject + body into one message and back.

use crate::model::CommitMessage;

/// Splits a raw message: the first line (trimmed) is the subject; the rest,
/// minus leading blank lines and trailing whitespace, is the body.
pub fn split(raw: &str) -> CommitMessage {
    let mut lines = raw.lines();
    let subject = lines.next().unwrap_or("").trim().to_string();
    let body = lines
        .skip_while(|line| line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string();
    CommitMessage { subject, body }
}

/// Joins a message for `git commit -F -`: `subject\n` or `subject\n\nbody\n`.
///
/// Line breaks inside the subject become spaces, CRLF in the body becomes LF,
/// and blank lines at either edge of the body are dropped. Lines starting
/// with `#` are kept; the caller passes `--cleanup=whitespace` so git keeps
/// them too.
pub fn join(message: &CommitMessage) -> String {
    let subject = message.subject.replace(['\r', '\n'], " ");
    let subject = subject.trim();
    let body = message.body.replace("\r\n", "\n");
    let body = body
        .lines()
        .skip_while(|line| line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let body = body.trim_end();
    if body.is_empty() {
        format!("{subject}\n")
    } else {
        format!("{subject}\n\n{body}\n")
    }
}
```

```rust
// src-tauri/crates/git-real-core/src/error.rs — add variants before `Io`
    #[error("the commit message has no subject")]
    EmptyMessage,
    #[error("nothing is staged to commit")]
    NothingToCommit,
    #[error("git commit failed (exit code {code:?}): {stderr}")]
    CommitFailed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
```

```rust
// src-tauri/crates/git-real-core/src/lib.rs — add `pub mod commit;` in alphabetical order
pub mod commit;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p git-real-core --test commit_message`
Expected: all PASS. Then `cargo clippy --workspace -- -D warnings` (the app crate's `From<GitError>` match is non-exhaustive now; Task 3 fixes it, so expect that one error until then and note it).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/git-real-core
git commit -m "feat(core): commit message model and pure split/join rules"
```

---

### Task 2: Core — `commit_config`, `head_message`, `commit` via the git CLI

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/commit/mod.rs`
- Create: `src-tauri/crates/git-real-core/src/commit/git_commit.rs`
- Test: `src-tauri/crates/git-real-core/tests/commit.rs`
- Modify: `src-tauri/crates/git-real-core/tests/common/mod.rs` (add `configure_identity`, `install_hook`)

**Interfaces:**

- Consumes: Task 1 types; `RepoSession::{repo, workdir}` (`pub(crate)`), `remote::git_cli::locate`, `common::fake_git`.
- Produces: `RepoSession::commit_config(&self) -> Result<CommitConfig, GitError>`, `RepoSession::head_message(&self) -> Result<Option<CommitMessage>, GitError>`, `RepoSession::commit(&self, message: &CommitMessage, amend: bool) -> Result<CommitOutcome, GitError>`, `commit::git_commit::run(git: &Path, workdir: &Path, message: &str, amend: bool) -> Result<(), GitError>`.

- [ ] **Step 1: Add fixtures**

```rust
// src-tauri/crates/git-real-core/tests/common/mod.rs — append

/// Sets a repo-local identity and turns signing off, so the developer's
/// global config (which may sign every commit) never reaches the test.
pub fn configure_identity(root: &Path) {
    let repo = Repository::open(root).expect("open repo");
    let mut config = repo.config().expect("config");
    config.set_str("user.name", "Test User").expect("set name");
    config
        .set_str("user.email", "test@example.com")
        .expect("set email");
    config.set_bool("commit.gpgsign", false).expect("set gpgsign");
}

/// Installs an executable `.git/hooks/<name>` with the given body.
#[cfg(unix)]
pub fn install_hook(root: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = root.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).expect("hooks dir");
    let path = hooks.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write hook");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}
```

- [ ] **Step 2: Write the failing tests**

```rust
// src-tauri/crates/git-real-core/tests/commit.rs
mod common;

use std::path::Path;

use git2::Repository;
use git_real_core::commit::git_commit;
use git_real_core::remote::git_cli;
use git_real_core::{CommitMessage, GitError, RepoSession, SigningFormat};

fn git_available() -> bool {
    if git_cli::locate().is_err() {
        eprintln!("skipping: git not on PATH");
        return false;
    }
    true
}

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.to_string(),
        body: body.to_string(),
    }
}

/// Repo with one commit, local identity, signing off.
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session)
}

fn head_oid(path: &Path) -> git2::Oid {
    Repository::open(path).unwrap().head().unwrap().target().unwrap()
}

fn head_raw_message(path: &Path) -> String {
    let repo = Repository::open(path).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.message().unwrap().to_string()
}

fn set_config(path: &Path, key: &str, value: &str) {
    Repository::open(path)
        .unwrap()
        .config()
        .unwrap()
        .set_str(key, value)
        .unwrap();
}

// --- commit_config ---

#[test]
fn commit_config_reads_identity_and_no_signing_by_default() {
    let (_d, _p, session) = fixture();
    let cfg = session.commit_config().unwrap();
    assert_eq!(cfg.name.as_deref(), Some("Test User"));
    assert_eq!(cfg.email.as_deref(), Some("test@example.com"));
    assert_eq!(cfg.signing, None);
}

#[test]
fn commit_config_blank_name_is_none() {
    let (_d, path, session) = fixture();
    set_config(&path, "user.name", "   ");
    assert_eq!(session.commit_config().unwrap().name, None);
}

#[test]
fn commit_config_reports_ssh_signing_when_gpgsign_true() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "true");
    set_config(&path, "gpg.format", "ssh");
    assert_eq!(session.commit_config().unwrap().signing, Some(SigningFormat::Ssh));
}

#[test]
fn commit_config_signing_defaults_to_openpgp_and_is_case_insensitive() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "true");
    assert_eq!(session.commit_config().unwrap().signing, Some(SigningFormat::OpenPgp));
    set_config(&path, "gpg.format", "X509");
    assert_eq!(session.commit_config().unwrap().signing, Some(SigningFormat::X509));
    set_config(&path, "gpg.format", "something-new");
    assert_eq!(session.commit_config().unwrap().signing, Some(SigningFormat::OpenPgp));
}

#[test]
fn commit_config_gpgsign_false_is_no_signing_even_with_format() {
    let (_d, path, session) = fixture();
    set_config(&path, "gpg.format", "ssh");
    assert_eq!(session.commit_config().unwrap().signing, None);
}

// --- head_message ---

#[test]
fn head_message_is_none_on_unborn_head() {
    let (_d, path) = common::temp_repo_unborn();
    let session = RepoSession::open(&path).unwrap();
    assert_eq!(session.head_message().unwrap(), None);
}

#[test]
fn head_message_splits_subject_and_body() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "a.txt", "a\n");
    common::commit_all(&path, "Subject here\n\nBody para\n\nSecond para\n");
    assert_eq!(
        session.head_message().unwrap(),
        Some(msg("Subject here", "Body para\n\nSecond para"))
    );
}

#[test]
fn head_message_with_invalid_utf8_is_lossy_not_panic() {
    let (_d, path, session) = fixture();
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = git2::Signature::now("T", "t@e.c").unwrap();
    let tree = head.tree().unwrap();
    // Build a commit whose message is the Latin-1 bytes "caf\xE9" (not UTF-8):
    // write the object buffer with a placeholder, patch the bytes, store it.
    let buf = repo
        .commit_create_buffer(&sig, &sig, "placeholder", &tree, &[&head])
        .unwrap();
    let mut raw: Vec<u8> = buf.to_vec();
    let pos = raw.windows(11).position(|w| w == b"placeholder").unwrap();
    raw.splice(pos..pos + 11, [b'c', b'a', b'f', 0xE9]);
    let oid = repo.odb().unwrap().write(git2::ObjectType::Commit, &raw).unwrap();
    repo.set_head_detached(oid).unwrap();
    let m = session.head_message().unwrap().unwrap();
    assert!(m.subject.starts_with("caf"));
}

// --- commit: happy paths (need the real git) ---

#[test]
fn commit_on_unborn_head_creates_root_commit() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_unborn();
    common::configure_identity(&path);
    common::write_file(&path, "a.txt", "a\n");
    common::stage(&path, "a.txt");
    let session = RepoSession::open(&path).unwrap();

    let out = session.commit(&msg("First", ""), false).unwrap();

    assert_eq!(out.summary, "First");
    assert_eq!(out.oid, head_oid(&path).to_string());
    assert_eq!(head_raw_message(&path), "First\n");
    let repo = Repository::open(&path).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 0);
}

#[test]
fn commit_records_subject_and_body_and_advances_head() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    let before = head_oid(&path);
    common::write_file(&path, "b.txt", "b\n");
    common::stage(&path, "b.txt");

    let out = session.commit(&msg("Add b", "Because.\n\nMore."), false).unwrap();

    let after = head_oid(&path);
    assert_ne!(before, after);
    assert_eq!(out.oid, after.to_string());
    assert_eq!(head_raw_message(&path), "Add b\n\nBecause.\n\nMore.\n");
    let repo = Repository::open(&path).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_id(0).unwrap(), before);
    // Index is clean afterwards: status sees nothing staged.
    assert!(session.status().unwrap().entries.is_empty());
}

#[test]
fn commit_keeps_hash_lines_in_body() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "c.txt", "c\n");
    common::stage(&path, "c.txt");

    session.commit(&msg("Hash", "# not a comment\nline"), false).unwrap();

    assert_eq!(head_raw_message(&path), "Hash\n\n# not a comment\nline\n");
}

#[test]
fn amend_replaces_message_and_keeps_parent() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "d.txt", "d\n");
    common::stage(&path, "d.txt");
    session.commit(&msg("Typo", ""), false).unwrap();
    let repo = Repository::open(&path).unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap().parent_id(0).unwrap();

    let out = session.commit(&msg("Fixed", "body"), true).unwrap();

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.id().to_string(), out.oid);
    assert_eq!(head.parent_id(0).unwrap(), parent);
    assert_eq!(head_raw_message(&path), "Fixed\n\nbody\n");
}

#[test]
fn amend_with_nothing_staged_is_allowed() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    let before = head_oid(&path);

    let out = session.commit(&msg("initial commit, reworded", ""), true).unwrap();

    assert_ne!(out.oid, before.to_string());
    assert_eq!(head_raw_message(&path), "initial commit, reworded\n");
}

#[test]
fn amend_includes_newly_staged_changes() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::write_file(&path, "e.txt", "e\n");
    common::stage(&path, "e.txt");

    session.commit(&msg("initial commit", ""), true).unwrap();

    let repo = Repository::open(&path).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    assert!(tree.get_name("e.txt").is_some());
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 0);
}

// --- commit: pre-checks (no git needed) ---

#[test]
fn commit_with_blank_subject_is_empty_message() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "f.txt", "f\n");
    common::stage(&path, "f.txt");
    let err = session.commit(&msg("  \n", "body"), false).unwrap_err();
    assert!(matches!(err, GitError::EmptyMessage), "{err:?}");
}

#[test]
fn commit_with_nothing_staged_is_nothing_to_commit() {
    let (_d, path, session) = fixture();
    common::write_file(&path, "README.md", "# changed but unstaged\n");
    let err = session.commit(&msg("Subject", ""), false).unwrap_err();
    assert!(matches!(err, GitError::NothingToCommit), "{err:?}");
}

#[test]
fn commit_on_unborn_head_with_empty_index_is_nothing_to_commit() {
    let (_d, path) = common::temp_repo_unborn();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    let err = session.commit(&msg("Subject", ""), false).unwrap_err();
    assert!(matches!(err, GitError::NothingToCommit), "{err:?}");
}

#[test]
fn empty_message_check_runs_before_staged_check() {
    let (_d, _p, session) = fixture();
    let err = session.commit(&msg("", ""), false).unwrap_err();
    assert!(matches!(err, GitError::EmptyMessage), "{err:?}");
}

// --- commit: failures from git ---

#[cfg(unix)]
#[test]
fn failing_pre_commit_hook_reports_hook_output() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    common::install_hook(&path, "pre-commit", "echo 'hook says no' >&2\nexit 1");
    common::write_file(&path, "g.txt", "g\n");
    common::stage(&path, "g.txt");
    let before = head_oid(&path);

    // A large body so the stdin write would block or EPIPE if git exits first.
    let body = "x".repeat(200_000);
    let err = session.commit(&msg("Blocked", &body), false).unwrap_err();

    match err {
        GitError::CommitFailed { code, stderr, .. } => {
            assert_eq!(code, Some(1));
            assert!(stderr.contains("hook says no"), "{stderr}");
        }
        other => panic!("expected CommitFailed, got {other:?}"),
    }
    assert_eq!(head_oid(&path), before);
}

#[test]
fn commit_with_conflicts_fails_through_git() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_with_conflict();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    let err = session.commit(&msg("Merge", ""), false).unwrap_err();
    match err {
        GitError::CommitFailed { stderr, .. } => {
            assert!(stderr.to_lowercase().contains("unmerged"), "{stderr}")
        }
        other => panic!("expected CommitFailed, got {other:?}"),
    }
}

#[test]
fn commit_on_bare_repo_is_not_a_repository() {
    let (_src_dir, src) = common::temp_repo_with_commit();
    let (_bare_dir, bare) = common::temp_bare_clone(&src);
    let session = RepoSession::open(&bare).unwrap();
    let err = session.commit(&msg("S", ""), true).unwrap_err();
    assert!(matches!(err, GitError::NotARepository(_)), "{err:?}");
}

// --- git_commit::run with a scripted git ---

#[cfg(unix)]
#[test]
fn run_passes_expected_args_env_and_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let script = r#"
out="$(dirname "$0")"
printf '%s\n' "$@" > "$out/args"
cat > "$out/stdin"
printf '%s|%s\n' "$LC_ALL" "$GIT_TERMINAL_PROMPT" > "$out/env"
exit 0
"#;
    let git = common::fake_git(dir.path(), script);
    let workdir = dir.path().join("wd");
    std::fs::create_dir_all(&workdir).unwrap();

    git_commit::run(&git, &workdir, "Subject\n\nBody\n", false).unwrap();

    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    let expected = format!(
        "-C\n{}\ncommit\n--cleanup=whitespace\n-F\n-\n",
        workdir.display()
    );
    assert_eq!(args, expected);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("stdin")).unwrap(),
        "Subject\n\nBody\n"
    );
    assert_eq!(std::fs::read_to_string(dir.path().join("env")).unwrap(), "C|0\n");
}

#[cfg(unix)]
#[test]
fn run_appends_amend_flag() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"; cat >/dev/null; exit 0",
    );
    git_commit::run(&git, dir.path(), "S\n", true).unwrap();
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert!(args.ends_with("-F\n-\n--amend\n"), "{args}");
}

#[cfg(unix)]
#[test]
fn run_failure_carries_code_stdout_and_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(
        dir.path(),
        "cat >/dev/null; echo 'to stdout'; echo 'to stderr' >&2; exit 3",
    );
    let err = git_commit::run(&git, dir.path(), "S\n", false).unwrap_err();
    match err {
        GitError::CommitFailed {
            code,
            stdout,
            stderr,
        } => {
            assert_eq!(code, Some(3));
            assert_eq!(stdout, "to stdout\n");
            assert_eq!(stderr, "to stderr\n");
        }
        other => panic!("{other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn run_exit_without_reading_stdin_is_not_an_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(dir.path(), "echo 'refused' >&2; exit 1");
    let big = "y".repeat(500_000);
    let err = git_commit::run(&git, dir.path(), &big, false).unwrap_err();
    assert!(
        matches!(err, GitError::CommitFailed { code: Some(1), .. }),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn run_signal_killed_child_has_no_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let git = common::fake_git(dir.path(), "cat >/dev/null; kill -9 $$");
    let err = git_commit::run(&git, dir.path(), "S\n", false).unwrap_err();
    assert!(matches!(err, GitError::CommitFailed { code: None, .. }), "{err:?}");
}

#[test]
fn run_with_missing_git_is_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let err = git_commit::run(&dir.path().join("no-git"), dir.path(), "S\n", false).unwrap_err();
    assert!(matches!(err, GitError::Io(_)), "{err:?}");
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p git-real-core --test commit`
Expected: compile errors, `no method named commit_config`, `unresolved import git_real_core::commit::git_commit`.

- [ ] **Step 4: Implement**

```rust
// src-tauri/crates/git-real-core/src/commit/git_commit.rs
//! Recording a commit through the system `git` CLI.

use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::GitError;

/// Runs `git -C <workdir> commit --cleanup=whitespace -F - [--amend]` with
/// `message` on stdin. Hooks, signing and identity fallback are git's.
pub fn run(git: &Path, workdir: &Path, message: &str, amend: bool) -> Result<(), GitError> {
    let mut cmd = Command::new(git);
    cmd.arg("-C")
        .arg(workdir)
        .args(["commit", "--cleanup=whitespace", "-F", "-"]);
    if amend {
        cmd.arg("--amend");
    }
    let mut child = cmd
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("child stdin was not captured"))?;
        // Git exits before reading the message when a pre-commit hook fails;
        // the resulting EPIPE is not the error worth reporting.
        match stdin.write_all(message.as_bytes()) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.into());
            }
        }
    } // stdin dropped here: git sees EOF

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(GitError::CommitFailed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}
```

```rust
// src-tauri/crates/git-real-core/src/commit/mod.rs — full file
//! Composing and recording commits.
//!
//! Message rules live in [`message`]; the commit itself goes through the
//! system `git` CLI so hooks and signing behave exactly as on the command
//! line (ADR 0001). git2 handles the reads around it.

pub mod git_commit;
pub mod message;

use git2::{Config, ErrorCode};

use crate::error::GitError;
use crate::model::{CommitConfig, CommitMessage, CommitOutcome, SigningFormat};
use crate::remote::git_cli;
use crate::repo::RepoSession;

impl RepoSession {
    /// Author identity and signing settings the next commit will use.
    pub fn commit_config(&self) -> Result<CommitConfig, GitError> {
        let config = self.repo().config()?.snapshot()?;
        let name = optional_string(&config, "user.name")?;
        let email = optional_string(&config, "user.email")?;
        let sign = match config.get_bool("commit.gpgsign") {
            Ok(v) => v,
            Err(e) if e.code() == ErrorCode::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        let signing = if sign {
            Some(signing_format(
                optional_string(&config, "gpg.format")?.as_deref(),
            ))
        } else {
            None
        };
        Ok(CommitConfig {
            name,
            email,
            signing,
        })
    }

    /// HEAD's message split for the editor; `None` when HEAD is unborn.
    pub fn head_message(&self) -> Result<Option<CommitMessage>, GitError> {
        match self.repo().head() {
            Ok(head) => {
                let commit = head.peel_to_commit()?;
                let raw = String::from_utf8_lossy(commit.message_bytes());
                Ok(Some(message::split(&raw)))
            }
            Err(e) if is_unborn(&e) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Commits the index (or amends HEAD) through `git commit`.
    pub fn commit(
        &self,
        message: &CommitMessage,
        amend: bool,
    ) -> Result<CommitOutcome, GitError> {
        let raw = message::join(message);
        if raw.trim().is_empty() || raw.starts_with('\n') {
            return Err(GitError::EmptyMessage);
        }
        if !amend && !self.has_staged_changes()? {
            return Err(GitError::NothingToCommit);
        }
        let workdir = self.workdir()?;
        let git = git_cli::locate()?;
        git_commit::run(&git, workdir, &raw, amend)?;
        let head = self.repo().head()?.peel_to_commit()?;
        Ok(CommitOutcome {
            oid: head.id().to_string(),
            summary: head.summary().unwrap_or_default().to_string(),
        })
    }

    /// True when the index differs from HEAD's tree (or holds anything on an
    /// unborn branch). `diff_tree_to_index` with `None` reloads the on-disk
    /// index, so writes by the git CLI are seen.
    fn has_staged_changes(&self) -> Result<bool, GitError> {
        let repo = self.repo();
        let head_tree = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(e) if is_unborn(&e) => None,
            Err(e) => return Err(e.into()),
        };
        let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, None)?;
        Ok(diff.deltas().len() > 0)
    }
}

fn is_unborn(e: &git2::Error) -> bool {
    matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound)
}

/// A string config value, with "unset" and "blank" both reported as `None`.
fn optional_string(config: &Config, key: &str) -> Result<Option<String>, GitError> {
    match config.get_string(key) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Maps `gpg.format` like git does: unknown or unset means OpenPGP.
fn signing_format(value: Option<&str>) -> SigningFormat {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("ssh") => SigningFormat::Ssh,
        Some("x509") => SigningFormat::X509,
        _ => SigningFormat::OpenPgp,
    }
}
```

Note on `EmptyMessage`: `join` of a blank subject yields `"\n"` or `"\n\nbody\n"`, so "starts with a newline" is exactly "no subject". Keep that comment in the code.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p git-real-core --test commit --test commit_message` then `cargo test -p git-real-core` (the whole crate; the status/index tests must stay green).
Expected: all PASS; tests that need git print "skipping" only where git is absent.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/git-real-core
git commit -m "feat(core): commit, amend, author config and HEAD message via git CLI"
```

---

### Task 3: Tauri app — error kinds and `commit` commands

**Files:**

- Modify: `src-tauri/src/error.rs`
- Create: `src-tauri/src/commands/commit.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod commit;`)
- Modify: `src-tauri/src/lib.rs` (register the three commands)
- Test: `src-tauri/tests/commit_commands.rs`
- Modify: `src-tauri/tests/error.rs` (mapping tests for the new kinds)
- Modify: `src-tauri/tests/common/mod.rs` (add `configure_identity`, same body as Task 2's core helper)

**Interfaces:**

- Consumes: `RepoSession::{commit_config, head_message, commit}`, `with_session`, `run_blocking`, `RepoRegistry`.
- Produces: Tauri commands `get_commit_config(id) -> CommitConfig`, `get_head_message(id) -> Option<CommitMessage>`, `commit(id, message: CommitMessage, amend: bool) -> CommitOutcome`; `AppErrorKind::{EmptyMessage, NothingToCommit, CommitFailed}`; `pub fn get_commit_config_inner`, `get_head_message_inner`, `commit_inner` on `(&RepoRegistry, RepoId, …)`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/tests/commit_commands.rs
//! Integration tests for the commit command `*_inner` functions.

mod common;

use git_real_core::{CommitMessage, RepoSession, SigningFormat};
use git_real_lib::commands::commit::{commit_inner, get_commit_config_inner, get_head_message_inner};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use tempfile::TempDir;

fn open_fixture() -> (TempDir, std::path::PathBuf, RepoRegistry, RepoId) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).expect("open"));
    (dir, path, reg, id)
}

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.into(),
        body: body.into(),
    }
}

#[test]
fn get_commit_config_inner_reads_identity() {
    let (_d, _p, reg, id) = open_fixture();
    let cfg = get_commit_config_inner(&reg, id).unwrap();
    assert_eq!(cfg.name.as_deref(), Some("Test User"));
    assert_eq!(cfg.email.as_deref(), Some("test@example.com"));
    assert_eq!(cfg.signing, None);
}

#[test]
fn get_commit_config_inner_reports_signing() {
    let (_d, path, reg, id) = open_fixture();
    let repo = git2::Repository::open(&path).unwrap();
    let mut c = repo.config().unwrap();
    c.set_bool("commit.gpgsign", true).unwrap();
    c.set_str("gpg.format", "ssh").unwrap();
    assert_eq!(
        get_commit_config_inner(&reg, id).unwrap().signing,
        Some(SigningFormat::Ssh)
    );
}

#[test]
fn get_head_message_inner_returns_split_message() {
    let (_d, _p, reg, id) = open_fixture();
    assert_eq!(
        get_head_message_inner(&reg, id).unwrap(),
        Some(msg("initial commit", ""))
    );
}

#[test]
fn get_head_message_inner_is_none_for_unborn() {
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(dir.path()).unwrap());
    assert_eq!(get_head_message_inner(&reg, id).unwrap(), None);
}

#[test]
fn commit_inner_nothing_staged_maps_to_nothing_to_commit() {
    let (_d, _p, reg, id) = open_fixture();
    let err = commit_inner(&reg, id, &msg("S", ""), false).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NothingToCommit);
    assert_eq!(err.message, "nothing is staged to commit");
}

#[test]
fn commit_inner_blank_subject_maps_to_empty_message() {
    let (_d, _p, reg, id) = open_fixture();
    let err = commit_inner(&reg, id, &msg(" ", "b"), true).unwrap_err();
    assert_eq!(err.kind, AppErrorKind::EmptyMessage);
}

#[test]
fn commit_inner_commits_and_returns_outcome() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id) = open_fixture();
    std::fs::write(path.join("n.txt"), "n\n").unwrap();
    let repo = git2::Repository::open(&path).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("n.txt")).unwrap();
    index.write().unwrap();

    let out = commit_inner(&reg, id, &msg("Add n", "body"), false).unwrap();

    assert_eq!(out.summary, "Add n");
    assert_eq!(out.oid, repo.head().unwrap().target().unwrap().to_string());
}

#[test]
fn commit_inner_amend_rewords_head() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id) = open_fixture();
    let out = commit_inner(&reg, id, &msg("Reworded", ""), true).unwrap();
    assert_eq!(out.summary, "Reworded");
    assert_eq!(get_head_message_inner(&reg, id).unwrap(), Some(msg("Reworded", "")));
}

#[test]
fn commit_commands_unknown_repo() {
    let reg = RepoRegistry::default();
    assert_eq!(get_commit_config_inner(&reg, 99).unwrap_err().kind, AppErrorKind::UnknownRepo);
    assert_eq!(get_head_message_inner(&reg, 99).unwrap_err().kind, AppErrorKind::UnknownRepo);
    assert_eq!(
        commit_inner(&reg, 99, &msg("S", ""), false).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
}
```

```rust
// src-tauri/tests/error.rs — append (keep the file's existing imports; add
// `use git_real_core::GitError;` and `use git_real_lib::error::{AppError, AppErrorKind};` if missing)

#[test]
fn empty_message_and_nothing_to_commit_map_to_their_kinds() {
    assert_eq!(AppError::from(GitError::EmptyMessage).kind, AppErrorKind::EmptyMessage);
    assert_eq!(
        AppError::from(GitError::NothingToCommit).kind,
        AppErrorKind::NothingToCommit
    );
}

#[test]
fn commit_failed_message_prefers_stderr() {
    let err = AppError::from(GitError::CommitFailed {
        code: Some(1),
        stdout: "On branch main\n".into(),
        stderr: "hook says no\nsecond line\n".into(),
    });
    assert_eq!(err.kind, AppErrorKind::CommitFailed);
    assert_eq!(err.message, "hook says no\nsecond line");
}

#[test]
fn commit_failed_message_falls_back_to_stdout() {
    let err = AppError::from(GitError::CommitFailed {
        code: Some(1),
        stdout: "  nothing to commit, working tree clean \n".into(),
        stderr: "  \n".into(),
    });
    assert_eq!(err.message, "nothing to commit, working tree clean");
}

#[test]
fn commit_failed_message_falls_back_to_exit_code_or_signal() {
    let code = AppError::from(GitError::CommitFailed {
        code: Some(128),
        stdout: String::new(),
        stderr: String::new(),
    });
    assert_eq!(code.message, "git commit failed with exit code 128");
    let signal = AppError::from(GitError::CommitFailed {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
    });
    assert_eq!(signal.message, "git commit was terminated by a signal");
}

#[test]
fn new_kinds_serialize_camel_case() {
    assert_eq!(serde_json::to_value(AppErrorKind::EmptyMessage).unwrap(), "emptyMessage");
    assert_eq!(serde_json::to_value(AppErrorKind::NothingToCommit).unwrap(), "nothingToCommit");
    assert_eq!(serde_json::to_value(AppErrorKind::CommitFailed).unwrap(), "commitFailed");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri`): `cargo test --test commit_commands --test error`
Expected: compile errors (`commands::commit` missing, non-exhaustive match in `error.rs`, unknown variants).

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/error.rs — add to AppErrorKind (after TooLarge)
    EmptyMessage,
    NothingToCommit,
    CommitFailed,

// in From<GitError>::from, kind match:
            GitError::EmptyMessage => AppErrorKind::EmptyMessage,
            GitError::NothingToCommit => AppErrorKind::NothingToCommit,
            GitError::CommitFailed { .. } => AppErrorKind::CommitFailed,
// message match:
            GitError::CommitFailed { code, stdout, stderr } => {
                commit_failure_message(*code, stdout, stderr)
            }

/// Hook and git output is what the user needs to read, so it is kept whole:
/// stderr first, then stdout, then a generic exit-status line.
fn commit_failure_message(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match code {
        Some(c) => format!("git commit failed with exit code {c}"),
        None => "git commit was terminated by a signal".to_string(),
    }
}
```

```rust
// src-tauri/src/commands/commit.rs
//! Commit commands: author config, HEAD message, commit and amend.

use std::sync::Arc;

use git_real_core::{CommitConfig, CommitMessage, CommitOutcome};
use tauri::State;

use super::{run_blocking, with_session};
use crate::error::AppError;
use crate::state::{RepoId, RepoRegistry};

pub fn get_commit_config_inner(reg: &RepoRegistry, id: RepoId) -> Result<CommitConfig, AppError> {
    with_session(reg, id, |s| s.commit_config())
}

pub fn get_head_message_inner(
    reg: &RepoRegistry,
    id: RepoId,
) -> Result<Option<CommitMessage>, AppError> {
    with_session(reg, id, |s| s.head_message())
}

pub fn commit_inner(
    reg: &RepoRegistry,
    id: RepoId,
    message: &CommitMessage,
    amend: bool,
) -> Result<CommitOutcome, AppError> {
    with_session(reg, id, |s| s.commit(message, amend))
}

#[tauri::command]
pub async fn get_commit_config(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<CommitConfig, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_commit_config_inner(&reg, id)).await
}

#[tauri::command]
pub async fn get_head_message(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
) -> Result<Option<CommitMessage>, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || get_head_message_inner(&reg, id)).await
}

/// Runs `git commit` (hooks included) on the blocking pool while holding the
/// session lock, so no other operation touches that repository meanwhile.
#[tauri::command]
pub async fn commit(
    reg: State<'_, Arc<RepoRegistry>>,
    id: RepoId,
    message: CommitMessage,
    amend: bool,
) -> Result<CommitOutcome, AppError> {
    let reg = Arc::clone(reg.inner());
    run_blocking(move || commit_inner(&reg, id, &message, amend)).await
}
```

```rust
// src-tauri/src/commands/mod.rs — add
pub mod commit;

// src-tauri/src/lib.rs — add to generate_handler! after add_to_gitignore
            commands::commit::get_commit_config,
            commands::commit::get_head_message,
            commands::commit::commit,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace` and `cargo clippy --workspace -- -D warnings`
Expected: all PASS, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(app): commit, head message and commit config commands"
```

---

### Task 4: Front end foundations — IPC seam, keys, draft store, limit, gate

**Files:**

- Modify: `src/lib/ipc/types.ts`
- Modify: `src/lib/ipc/errors.ts`
- Modify: `src/lib/ipc/commands.ts`
- Modify: `src/lib/query/keys.ts`
- Create: `src/lib/store/commitDraft.ts`
- Create: `src/features/commit/SUBJECT_LIMIT.ts`
- Create: `src/features/commit/commitGate.ts`
- Test: `src/lib/ipc/commands.test.ts` (append), `src/lib/ipc/errors.test.ts` (append), `src/lib/ipc/types.test.ts` (append if it pins kinds), `src/lib/query/keys.test.ts` (append), `src/lib/store/commitDraft.test.ts`, `src/features/commit/commitGate.test.ts`

**Interfaces:**

- Produces:

```ts
// types.ts
export interface CommitMessage {
  subject: string;
  body: string;
}
export type SigningFormat = "openPgp" | "x509" | "ssh";
export interface CommitConfig {
  name: string | null;
  email: string | null;
  signing: SigningFormat | null;
}
export interface CommitOutcome {
  oid: string;
  summary: string;
}
// AppErrorKind += "emptyMessage" | "nothingToCommit" | "commitFailed"
// commands.ts
export function getCommitConfig(id: RepoId): Promise<CommitConfig>;
export function getHeadMessage(id: RepoId): Promise<CommitMessage | null>;
export function commit(id: RepoId, message: CommitMessage, amend: boolean): Promise<CommitOutcome>;
// keys.ts
commitConfig: (id) => ["repo", id, "commitConfig"];
headMessage: (id) => ["repo", id, "headMessage"];
// commitDraft.ts
export interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  stash: { subject: string; body: string } | null;
}
export const EMPTY_DRAFT: CommitDraft;
export const useCommitDraft: UseBoundStore<StoreApi<CommitDraftState>>; // drafts, setSubject, setBody, setAmend, clear
// SUBJECT_LIMIT.ts
export const SUBJECT_LIMIT = 72;
// commitGate.ts
export interface CommitGateInput {
  amend: boolean;
  subject: string;
  status: WorkingTreeStatus | undefined;
  config: CommitConfig | undefined;
}
export function commitDisabledReason(input: CommitGateInput): string | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/ipc/commands.test.ts — append inside the existing describe structure (the file
// already mocks "@tauri-apps/api/core" and imports `invoke`)
describe("commit commands", () => {
  it("getCommitConfig invokes get_commit_config with the id", async () => {
    const cfg = { name: "A", email: "a@b.c", signing: null };
    vi.mocked(invoke).mockResolvedValue(cfg);
    await expect(getCommitConfig(3)).resolves.toEqual(cfg);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_commit_config", { id: 3 });
  });

  it("getHeadMessage invokes get_head_message and passes null through", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(getHeadMessage(3)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_head_message", { id: 3 });
  });

  it("commit invokes commit with id, message and amend", async () => {
    const out = { oid: "abc", summary: "S" };
    vi.mocked(invoke).mockResolvedValue(out);
    await expect(commit(3, { subject: "S", body: "B" }, true)).resolves.toEqual(out);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("commit", {
      id: 3,
      message: { subject: "S", body: "B" },
      amend: true,
    });
  });
});
```

```ts
// src/lib/ipc/errors.test.ts — append
it.each(["emptyMessage", "nothingToCommit", "commitFailed"] as const)(
  "isAppError accepts kind %s",
  (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  },
);
```

```ts
// src/lib/query/keys.test.ts — append
it("commitConfig and headMessage keys sit under the repo prefix", () => {
  expect(queryKeys.commitConfig(4)).toEqual(["repo", 4, "commitConfig"]);
  expect(queryKeys.headMessage(4)).toEqual(["repo", 4, "headMessage"]);
  expect(queryKeys.commitConfig(4).slice(0, 2)).toEqual(queryKeys.repo(4));
  expect(queryKeys.headMessage(4).slice(0, 2)).toEqual(queryKeys.repo(4));
});
```

```ts
// src/lib/store/commitDraft.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DRAFT, useCommitDraft } from "./commitDraft";

const head = { subject: "Head subject", body: "Head body" };

beforeEach(() => {
  useCommitDraft.setState({ drafts: {} });
});

describe("commitDraft store", () => {
  it("returns EMPTY_DRAFT for an unknown repo, by reference", () => {
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    expect(EMPTY_DRAFT).toEqual({ subject: "", body: "", amend: false, stash: null });
  });

  it("setSubject and setBody update one repo only", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "One");
    s.setBody(1, "Body one");
    s.setSubject(2, "Two");
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "One", body: "Body one" });
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "Two", body: "" });
  });

  it("setAmend on stashes the typed text and prefills from head", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setBody(1, "typed body");
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Head subject",
      body: "Head body",
      amend: true,
      stash: { subject: "typed", body: "typed body" },
    });
  });

  it("setAmend off restores the stash and clears it", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, head);
    s.setSubject(1, "edited head");
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "typed",
      body: "",
      amend: false,
      stash: null,
    });
  });

  it("setAmend on twice does not overwrite the stash", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, head);
    s.setSubject(1, "edited");
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[1].stash).toEqual({ subject: "typed", body: "" });
    expect(useCommitDraft.getState().drafts[1].subject).toBe("edited");
  });

  it("setAmend with null head keeps the typed text", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "typed", amend: true });
  });

  it("setAmend off with no stash keeps the current text", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "typed",
      amend: false,
      stash: null,
    });
  });

  it("clear removes the repo's draft and leaves others", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "a");
    s.setSubject(2, "b");
    s.clear(1);
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "b" });
  });

  it("clear on an unknown repo is a no-op that keeps state identity", () => {
    const before = useCommitDraft.getState();
    before.clear(9);
    expect(useCommitDraft.getState().drafts).toBe(before.drafts);
  });
});
```

```ts
// src/features/commit/commitGate.test.ts
import { describe, expect, it } from "vitest";
import type { CommitConfig, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { commitDisabledReason } from "./commitGate";

const entry = (over: Partial<StatusEntry>): StatusEntry => ({
  path: "a.txt",
  oldPath: null,
  index: null,
  worktree: null,
  conflicted: false,
  ...over,
});
const status = (entries: StatusEntry[]): WorkingTreeStatus => ({ entries, headUnborn: false });
const config: CommitConfig = { name: "A", email: "a@b.c", signing: null };
const staged = status([entry({ index: "modified" })]);

describe("commitDisabledReason", () => {
  it("is Loading… while status or config is missing", () => {
    expect(commitDisabledReason({ amend: false, subject: "s", status: undefined, config })).toBe(
      "Loading…",
    );
    expect(
      commitDisabledReason({ amend: false, subject: "s", status: staged, config: undefined }),
    ).toBe("Loading…");
  });

  it("requires name and email", () => {
    const reason = "Set user.name and user.email in your Git config";
    expect(
      commitDisabledReason({
        amend: false,
        subject: "s",
        status: staged,
        config: { ...config, name: null },
      }),
    ).toBe(reason);
    expect(
      commitDisabledReason({
        amend: false,
        subject: "s",
        status: staged,
        config: { ...config, email: null },
      }),
    ).toBe(reason);
  });

  it("conflicts win over staged changes", () => {
    const s = status([entry({ conflicted: true }), entry({ path: "b", index: "added" })]);
    expect(commitDisabledReason({ amend: false, subject: "s", status: s, config })).toBe(
      "Resolve conflicts before committing",
    );
  });

  it("needs staged changes unless amending", () => {
    const unstaged = status([entry({ worktree: "modified" })]);
    expect(commitDisabledReason({ amend: false, subject: "s", status: unstaged, config })).toBe(
      "Stage changes to commit",
    );
    expect(
      commitDisabledReason({ amend: true, subject: "s", status: unstaged, config }),
    ).toBeNull();
  });

  it("needs a non-blank subject", () => {
    expect(commitDisabledReason({ amend: false, subject: "   ", status: staged, config })).toBe(
      "Enter a commit subject",
    );
  });

  it("returns null when everything is in place", () => {
    expect(
      commitDisabledReason({ amend: false, subject: "ok", status: staged, config }),
    ).toBeNull();
  });

  it("checks identity before conflicts and conflicts before staging", () => {
    const s = status([entry({ conflicted: true })]);
    expect(
      commitDisabledReason({
        amend: false,
        subject: "",
        status: s,
        config: { ...config, name: null },
      }),
    ).toBe("Set user.name and user.email in your Git config");
    expect(commitDisabledReason({ amend: false, subject: "", status: s, config })).toBe(
      "Resolve conflicts before committing",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib src/features/commit`
Expected: FAIL — missing exports `getCommitConfig`, `commitDraft`, `commitGate`, type errors on the new kinds.

- [ ] **Step 3: Implement**

```ts
// src/lib/ipc/types.ts — append after HunkAction
export interface CommitMessage {
  subject: string;
  body: string;
}

export type SigningFormat = "openPgp" | "x509" | "ssh";

export interface CommitConfig {
  name: string | null;
  email: string | null;
  /** Non-null when `commit.gpgsign` is true. */
  signing: SigningFormat | null;
}

export interface CommitOutcome {
  /** Full hex object id. */
  oid: string;
  summary: string;
}

// AppErrorKind union: add
  | "emptyMessage"
  | "nothingToCommit"
  | "commitFailed";
```

```ts
// src/lib/ipc/errors.ts — KINDS: add
  emptyMessage: true,
  nothingToCommit: true,
  commitFailed: true,
```

```ts
// src/lib/ipc/commands.ts — add imports CommitConfig, CommitMessage, CommitOutcome; append
export function getCommitConfig(id: RepoId): Promise<CommitConfig> {
  return invoke<CommitConfig>("get_commit_config", { id });
}

/** HEAD's message split into subject and body; null when HEAD is unborn. */
export function getHeadMessage(id: RepoId): Promise<CommitMessage | null> {
  return invoke<CommitMessage | null>("get_head_message", { id });
}

/** Commits the index through `git commit`; `amend` rewrites HEAD instead. */
export function commit(id: RepoId, message: CommitMessage, amend: boolean): Promise<CommitOutcome> {
  return invoke<CommitOutcome>("commit", { id, message, amend });
}
```

```ts
// src/lib/query/keys.ts — add inside queryKeys
  commitConfig: (id: RepoId) => ["repo", id, "commitConfig"] as const,
  headMessage: (id: RepoId) => ["repo", id, "headMessage"] as const,
```

```ts
// src/lib/store/commitDraft.ts
import { create } from "zustand";
import type { CommitMessage, RepoId } from "../ipc";

export interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  /** What was typed before amend was turned on; restored when it is turned off. */
  stash: { subject: string; body: string } | null;
}

export const EMPTY_DRAFT: CommitDraft = { subject: "", body: "", amend: false, stash: null };

interface CommitDraftState {
  drafts: Record<RepoId, CommitDraft>;
  setSubject(repoId: RepoId, subject: string): void;
  setBody(repoId: RepoId, body: string): void;
  /** Turning amend on stashes the draft and loads `head`; turning it off restores the stash. */
  setAmend(repoId: RepoId, on: boolean, head: CommitMessage | null): void;
  clear(repoId: RepoId): void;
}

function toggleAmend(draft: CommitDraft, on: boolean, head: CommitMessage | null): CommitDraft {
  if (on === draft.amend) return { ...draft, amend: on };
  if (on) {
    const stash = { subject: draft.subject, body: draft.body };
    return head === null
      ? { ...draft, amend: true, stash }
      : { subject: head.subject, body: head.body, amend: true, stash };
  }
  const restored = draft.stash ?? { subject: draft.subject, body: draft.body };
  return { ...restored, amend: false, stash: null };
}

/** Per-repository commit drafts; in memory only, since repo ids are per launch. */
export const useCommitDraft = create<CommitDraftState>()((set) => {
  const update = (repoId: RepoId, fn: (draft: CommitDraft) => CommitDraft) =>
    set((state) => ({
      drafts: { ...state.drafts, [repoId]: fn(state.drafts[repoId] ?? EMPTY_DRAFT) },
    }));
  return {
    drafts: {},
    setSubject: (repoId, subject) => update(repoId, (d) => ({ ...d, subject })),
    setBody: (repoId, body) => update(repoId, (d) => ({ ...d, body })),
    setAmend: (repoId, on, head) => update(repoId, (d) => toggleAmend(d, on, head)),
    clear: (repoId) =>
      set((state) => {
        if (!(repoId in state.drafts)) return state;
        const drafts = { ...state.drafts };
        delete drafts[repoId];
        return { drafts };
      }),
  };
});
```

```ts
// src/features/commit/SUBJECT_LIMIT.ts
/** Conventional subject length; the editor warns past it but never blocks. */
export const SUBJECT_LIMIT = 72;
```

```ts
// src/features/commit/commitGate.ts
import type { CommitConfig, WorkingTreeStatus } from "../../lib/ipc";

export interface CommitGateInput {
  amend: boolean;
  subject: string;
  status: WorkingTreeStatus | undefined;
  config: CommitConfig | undefined;
}

/** Why the Commit button is disabled, first match wins; null means it is enabled. */
export function commitDisabledReason({
  amend,
  subject,
  status,
  config,
}: CommitGateInput): string | null {
  if (status === undefined || config === undefined) return "Loading…";
  if (config.name === null || config.email === null) {
    return "Set user.name and user.email in your Git config";
  }
  if (status.entries.some((e) => e.conflicted)) return "Resolve conflicts before committing";
  if (!amend && !status.entries.some((e) => e.index !== null)) return "Stage changes to commit";
  if (subject.trim() === "") return "Enter a commit subject";
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib src/features/commit` then `npm run typecheck` and `npm run lint`.
Expected: PASS, no type or lint errors (run `npx prettier --write` on touched files if needed).

- [ ] **Step 5: Commit**

```bash
git add src/lib src/features/commit
git commit -m "feat(ui): commit IPC seam, draft store and disabled-reason gate"
```

---

### Task 5: Front end — hooks, `AuthorLine`, `MessageEditor`, `CommitBox`, `RepoPane` integration

**Files:**

- Create: `src/features/commit/useCommitConfig.ts`
- Create: `src/features/commit/useHeadMessage.ts`
- Create: `src/features/commit/useCommit.ts`
- Create: `src/features/commit/AuthorLine.tsx`, `AuthorLine.module.css`
- Create: `src/features/commit/MessageEditor.tsx`, `MessageEditor.module.css`
- Create: `src/features/commit/CommitBox.tsx`, `CommitBox.module.css`
- Modify: `src/app/RepoPane.tsx`, `src/app/RepoPane.module.css` (add `.sidebar`)
- Modify: `src/features/worktree/ChangesPanel.module.css` (remove `border-right` from `.root`, add `flex: 1`)
- Modify: `src/app/App.tsx` (`useCommitDraft.getState().clear(id)` in `closeRepoTab`)
- Modify: `src/styles/tokens.css` (add `--color-warning`, `--color-on-accent` to both themes)
- Delete: `src/features/commit/.gitkeep`
- Test: `useCommitConfig.test.tsx`, `useHeadMessage.test.tsx`, `useCommit.test.tsx`, `AuthorLine.test.tsx`, `MessageEditor.test.tsx`, `CommitBox.test.tsx` (all in `src/features/commit/`); modify `src/app/RepoPane.test.tsx` and `src/app/App.test.tsx` (mock `getCommitConfig`, `getHeadMessage`; add the box assertions and the clear-on-close assertion)

**Interfaces:**

- Consumes: Task 4 exports; `useStatus(repoId)` from `src/features/worktree/useStatus`; `RepoError` from `src/features/repo/RepoError`; `renderWithProviders`/`renderHookWithProviders`.
- Produces:

```ts
export function useCommitConfig(repoId: RepoId): {
  config: CommitConfig | undefined;
  error: AppError | null;
};
export function useHeadMessage(repoId: RepoId): {
  head: CommitMessage | null | undefined;
  error: AppError | null;
};
export interface UseCommit {
  commit(message: CommitMessage, amend: boolean): void;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}
export function useCommit(repoId: RepoId): UseCommit;
export function AuthorLine({ config }: { config: CommitConfig | undefined }): JSX.Element;
export interface MessageEditorProps {
  subject: string;
  body: string;
  disabled: boolean;
  onSubjectChange(v: string): void;
  onBodyChange(v: string): void;
  onSubmit(): void;
}
export function MessageEditor(props: MessageEditorProps): JSX.Element;
export function CommitBox({ repoId }: { repoId: RepoId }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/features/commit/useCommitConfig.test.tsx
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitConfig } from "../../lib/ipc";
import type { AppError, CommitConfig } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommitConfig } from "./useCommitConfig";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommitConfig: vi.fn(),
}));

const cfg: CommitConfig = { name: "A", email: "a@b.c", signing: "ssh" };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useCommitConfig", () => {
  it("exposes the config from getCommitConfig", async () => {
    vi.mocked(getCommitConfig).mockResolvedValue(cfg);
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    expect(result.current.config).toBeUndefined();
    await waitFor(() => expect(result.current.config).toEqual(cfg));
    expect(getCommitConfig).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exposes a rejected AppError and no config", async () => {
    const err: AppError = { kind: "git", message: "bad config" };
    vi.mocked(getCommitConfig).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
    expect(result.current.config).toBeUndefined();
  });

  it("wraps a non-AppError rejection as io", async () => {
    vi.mocked(getCommitConfig).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });
});
```

```tsx
// src/features/commit/useHeadMessage.test.tsx
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadMessage } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useHeadMessage } from "./useHeadMessage";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getHeadMessage: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useHeadMessage", () => {
  it("is undefined while loading, then the message", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue({ subject: "S", body: "B" });
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    expect(result.current.head).toBeUndefined();
    await waitFor(() => expect(result.current.head).toEqual({ subject: "S", body: "B" }));
  });

  it("distinguishes null (unborn HEAD) from undefined (loading)", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue(null);
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    await waitFor(() => expect(result.current.head).toBeNull());
  });

  it("exposes a rejected AppError", async () => {
    const err: AppError = { kind: "unknownRepo", message: "gone" };
    vi.mocked(getHeadMessage).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });
});
```

```tsx
// src/features/commit/useCommit.test.tsx
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commit } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommit } from "./useCommit";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
  useCommitDraft.getState().setSubject(1, "typed");
});

describe("useCommit", () => {
  it("calls commit with repo id, message and amend", async () => {
    vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "B" }, true));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(commit).toHaveBeenCalledExactlyOnceWith(1, { subject: "S", body: "B" }, true);
  });

  it("clears the draft and invalidates the repo prefix on success", async () => {
    vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
    const { result, queryClient } = renderHookWithProviders(() => useCommit(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(useCommitDraft.getState().drafts[1]).toBeUndefined());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repo(1) });
  });

  it("keeps the draft, exposes the error and still invalidates on failure", async () => {
    const err: AppError = { kind: "commitFailed", message: "hook says no" };
    vi.mocked(commit).mockRejectedValue(err);
    const { result, queryClient } = renderHookWithProviders(() => useCommit(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.error).toEqual(err));
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "typed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repo(1) });
  });

  it("wraps a non-AppError rejection as io and clearError resets it", async () => {
    vi.mocked(commit).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("reports pending while the commit runs", async () => {
    let resolve: (v: { oid: string; summary: string }) => void = () => undefined;
    vi.mocked(commit).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.pending).toBe(true));
    act(() => resolve({ oid: "a", summary: "S" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
```

```tsx
// src/features/commit/AuthorLine.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorLine } from "./AuthorLine";

describe("AuthorLine", () => {
  it("shows name and email", () => {
    render(<AuthorLine config={{ name: "Ada", email: "ada@x.org", signing: null }} />);
    expect(screen.getByText("Ada <ada@x.org>")).toBeInTheDocument();
    expect(screen.queryByText(/Signs with/)).toBeNull();
  });

  it("shows the fallback when name or email is missing", () => {
    render(<AuthorLine config={{ name: "Ada", email: null, signing: null }} />);
    expect(screen.getByText("Author not configured")).toBeInTheDocument();
  });

  it("shows nothing identifying while config is loading", () => {
    render(<AuthorLine config={undefined} />);
    expect(screen.queryByText("Author not configured")).toBeNull();
    expect(screen.queryByText(/</)).toBeNull();
  });

  it.each([
    ["openPgp", "Signs with GPG"],
    ["ssh", "Signs with SSH"],
    ["x509", "Signs with X.509"],
  ] as const)("shows the %s signing badge", (signing, label) => {
    render(<AuthorLine config={{ name: "Ada", email: "a@b.c", signing }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
```

```tsx
// src/features/commit/MessageEditor.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageEditor } from "./MessageEditor";

function setup(over: Partial<React.ComponentProps<typeof MessageEditor>> = {}) {
  const props = {
    subject: "",
    body: "",
    disabled: false,
    onSubjectChange: vi.fn(),
    onBodyChange: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<MessageEditor {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("MessageEditor", () => {
  it("renders labelled subject and body with placeholders", () => {
    setup();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("placeholder", "Summary of changes");
    expect(screen.getByLabelText("Body")).toHaveAttribute(
      "placeholder",
      "Optional longer description",
    );
  });

  it("forwards typing to the change handlers", async () => {
    const { user, onSubjectChange, onBodyChange } = setup();
    await user.type(screen.getByLabelText("Subject"), "a");
    await user.type(screen.getByLabelText("Body"), "b");
    expect(onSubjectChange).toHaveBeenCalledWith("a");
    expect(onBodyChange).toHaveBeenCalledWith("b");
  });

  it("shows the counter and no hint at the limit", () => {
    setup({ subject: "x".repeat(72) });
    expect(screen.getByText("72/72")).toBeInTheDocument();
    expect(screen.queryByText("Keep the subject at 72 characters or fewer")).toBeNull();
  });

  it("shows the hint past the limit and links it to the input", () => {
    setup({ subject: "x".repeat(73) });
    const hint = screen.getByText("Keep the subject at 72 characters or fewer");
    expect(screen.getByText("73/72")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("aria-describedby", hint.id);
  });

  it("Enter in the subject moves focus to the body without submitting", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Body")).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter submits from either field", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("Meta+Enter also submits", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("disables both fields when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText("Subject")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
  });
});
```

```tsx
// src/features/commit/CommitBox.test.tsx
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commit, getCommitConfig, getHeadMessage, getStatus, onRepoChanged } from "../../lib/ipc";
import type { CommitConfig, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CommitBox } from "./CommitBox";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
  getCommitConfig: vi.fn(),
  getHeadMessage: vi.fn(),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const entry = (over: Partial<StatusEntry>): StatusEntry => ({
  path: "a.txt",
  oldPath: null,
  index: null,
  worktree: null,
  conflicted: false,
  ...over,
});
const staged: WorkingTreeStatus = { entries: [entry({ index: "modified" })], headUnborn: false };
const clean: WorkingTreeStatus = { entries: [], headUnborn: false };
const config: CommitConfig = { name: "Ada", email: "ada@x.org", signing: null };

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue(staged);
  vi.mocked(getCommitConfig).mockResolvedValue(config);
  vi.mocked(getHeadMessage).mockResolvedValue({ subject: "Head subject", body: "Head body" });
  vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
});

const button = () => screen.getByRole("button", { name: /Commit|Amend commit|Committing…/ });

describe("CommitBox", () => {
  it("renders as a region named Commit with the author line", async () => {
    renderWithProviders(<CommitBox repoId={1} />);
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
    expect(await screen.findByText("Ada <ada@x.org>")).toBeInTheDocument();
  });

  it("is disabled with Loading… before data arrives", () => {
    vi.mocked(getStatus).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CommitBox repoId={1} />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute("title", "Loading…");
  });

  it("is disabled with Stage changes to commit when nothing is staged", async () => {
    vi.mocked(getStatus).mockResolvedValue(clean);
    renderWithProviders(<CommitBox repoId={1} />);
    await waitFor(() => expect(button()).toHaveAttribute("title", "Stage changes to commit"));
  });

  it("is disabled with Enter a commit subject when staged but empty", async () => {
    renderWithProviders(<CommitBox repoId={1} />);
    await waitFor(() => expect(button()).toHaveAttribute("title", "Enter a commit subject"));
  });

  it("commits with the typed subject and body, then clears the editor", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "Add thing");
    await user.type(screen.getByLabelText("Body"), "Why.");
    await waitFor(() => expect(button()).toBeEnabled());
    expect(button()).not.toHaveAttribute("title");
    await user.click(button());
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      1,
      { subject: "Add thing", body: "Why." },
      false,
    );
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue(""));
    expect(screen.getByLabelText("Body")).toHaveValue("");
  });

  it("Ctrl+Enter commits when enabled and does nothing when disabled", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(commit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("amend prefills from HEAD, relabels the button, and sends amend: true", async () => {
    vi.mocked(getStatus).mockResolvedValue(clean);
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeEnabled());
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("Head subject");
    expect(screen.getByLabelText("Body")).toHaveValue("Head body");
    expect(screen.getByRole("button", { name: "Amend commit" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Amend commit" }));
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      1,
      { subject: "Head subject", body: "Head body" },
      true,
    );
    await waitFor(() => expect(amend).not.toBeChecked());
  });

  it("unchecking amend restores what was typed", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "mine");
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeEnabled());
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("Head subject");
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("mine");
  });

  it("disables the amend checkbox with No commit to amend on an unborn HEAD", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue(null);
    renderWithProviders(<CommitBox repoId={1} />);
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeDisabled());
    expect(amend).toHaveAttribute("title", "No commit to amend");
  });

  it("disables everything and says Committing… while pending", async () => {
    let resolve: (v: { oid: string; summary: string }) => void = () => undefined;
    vi.mocked(commit).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
    expect(screen.getByLabelText("Subject")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Amend last commit" })).toBeDisabled();
    resolve({ oid: "a", summary: "S" });
    await waitFor(() => expect(screen.getByLabelText("Subject")).toBeEnabled());
  });

  it("shows a multi-line failure with Dismiss and keeps the draft", async () => {
    vi.mocked(commit).mockRejectedValue({ kind: "commitFailed", message: "hook says no\nline 2" });
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("hook says no");
    expect(alert).toHaveTextContent("line 2");
    expect(screen.getByLabelText("Subject")).toHaveValue("S");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a config load failure as an alert", async () => {
    vi.mocked(getCommitConfig).mockRejectedValue({ kind: "git", message: "config broken" });
    renderWithProviders(<CommitBox repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("config broken");
  });

  it("shows the identity reason when the author is not configured", async () => {
    vi.mocked(getCommitConfig).mockResolvedValue({ ...config, email: null });
    renderWithProviders(<CommitBox repoId={1} />);
    expect(await screen.findByText("Author not configured")).toBeInTheDocument();
    expect(button()).toHaveAttribute("title", "Set user.name and user.email in your Git config");
  });

  it("keeps drafts per repository", async () => {
    const { user, unmount } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "one");
    unmount();
    renderWithProviders(<CommitBox repoId={2} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("");
    expect(useCommitDraft.getState().drafts[1]?.subject).toBe("one");
  });
});
```

```tsx
// src/app/RepoPane.test.tsx — add `getCommitConfig: vi.fn(), getHeadMessage: vi.fn()` to the
// vi.mock factory; in beforeEach:
//   vi.mocked(getCommitConfig).mockResolvedValue({ name: "A", email: "a@b.c", signing: null });
//   vi.mocked(getHeadMessage).mockResolvedValue(null);
// and append:
it("should render the commit box below the changes panel in the sidebar", async () => {
  renderWithProviders(<RepoPane tab={tab(1)} />);
  const changes = await screen.findByRole("region", { name: "Changes" });
  const commitBox = screen.getByRole("region", { name: "Commit" });
  expect(changes.parentElement).toBe(commitBox.parentElement);
  expect(
    changes.compareDocumentPosition(commitBox) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
```

```tsx
// src/app/App.test.tsx — add `getCommitConfig: vi.fn(), getHeadMessage: vi.fn()` to the
// vi.mock factory and resolve them in beforeEach like RepoPane.test.tsx; import
// `useCommitDraft` and reset it with `useCommitDraft.setState({ drafts: {} })` in beforeEach.
// Append next to "closing a tab clears that repo's workspace selection", using the file's
// existing `renderApp` and `repo` helpers:
it("closing a tab clears that repo's commit draft and keeps the others", async () => {
  useCommitDraft.getState().setSubject(1, "alpha draft");
  useCommitDraft.getState().setSubject(2, "beta draft");
  const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
  await user.click(screen.getByRole("button", { name: "Close alpha" }));
  expect(useCommitDraft.getState().drafts).not.toHaveProperty("1");
  expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "beta draft" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/commit src/app`
Expected: FAIL — modules not found; RepoPane has no region named "Commit".

- [ ] **Step 3: Implement**

```ts
// src/features/commit/useCommitConfig.ts
import { useQuery } from "@tanstack/react-query";
import { getCommitConfig, toAppError } from "../../lib/ipc";
import type { AppError, CommitConfig, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseCommitConfig {
  config: CommitConfig | undefined;
  error: AppError | null;
}

/** Author identity and signing from Git config; refetches on focus to catch ~/.gitconfig edits. */
export function useCommitConfig(repoId: RepoId): UseCommitConfig {
  const query = useQuery<CommitConfig, AppError>({
    queryKey: queryKeys.commitConfig(repoId),
    queryFn: () =>
      getCommitConfig(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });
  return { config: query.data, error: query.error ?? null };
}
```

```ts
// src/features/commit/useHeadMessage.ts
import { useQuery } from "@tanstack/react-query";
import { getHeadMessage, toAppError } from "../../lib/ipc";
import type { AppError, CommitMessage, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseHeadMessage {
  /** undefined while loading; null when HEAD is unborn. */
  head: CommitMessage | null | undefined;
  error: AppError | null;
}

export function useHeadMessage(repoId: RepoId): UseHeadMessage {
  const query = useQuery<CommitMessage | null, AppError>({
    queryKey: queryKeys.headMessage(repoId),
    queryFn: () =>
      getHeadMessage(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });
  return { head: query.data, error: query.error ?? null };
}
```

```ts
// src/features/commit/useCommit.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commit as commitCommand, toAppError } from "../../lib/ipc";
import type { AppError, CommitMessage, CommitOutcome, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useCommitDraft } from "../../lib/store/commitDraft";

export interface UseCommit {
  /** Fire-and-forget: failures surface through `error`, never as rejections. */
  commit(message: CommitMessage, amend: boolean): void;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

export function useCommit(repoId: RepoId): UseCommit {
  const queryClient = useQueryClient();
  const mutation = useMutation<CommitOutcome, AppError, { message: CommitMessage; amend: boolean }>(
    {
      mutationFn: ({ message, amend }) =>
        commitCommand(repoId, message, amend).catch((e: unknown) => {
          throw toAppError(e);
        }),
      onSuccess: () => useCommitDraft.getState().clear(repoId),
      // Runs on failure too: a hook may have changed files before refusing.
      onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
    },
  );
  const { mutate, reset } = mutation;
  return {
    commit: (message, amend) => mutate({ message, amend }),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: reset,
  };
}
```

```tsx
// src/features/commit/AuthorLine.tsx
import type { CommitConfig, SigningFormat } from "../../lib/ipc";
import styles from "./AuthorLine.module.css";

const BADGE: Record<SigningFormat, string> = {
  openPgp: "Signs with GPG",
  ssh: "Signs with SSH",
  x509: "Signs with X.509",
};

export function AuthorLine({ config }: { config: CommitConfig | undefined }): React.JSX.Element {
  if (config === undefined) return <p className={styles.root} aria-busy="true" />;
  const identity =
    config.name !== null && config.email !== null
      ? `${config.name} <${config.email}>`
      : "Author not configured";
  return (
    <p className={styles.root}>
      <span className={styles.identity}>{identity}</span>
      {config.signing !== null && <span className={styles.badge}>{BADGE[config.signing]}</span>}
    </p>
  );
}
```

```css
/* src/features/commit/AuthorLine.module.css */
.root {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  min-height: 1.2em;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.identity {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 0.7rem;
}
```

```tsx
// src/features/commit/MessageEditor.tsx
import { useId, useRef } from "react";
import { SUBJECT_LIMIT } from "./SUBJECT_LIMIT";
import styles from "./MessageEditor.module.css";

export interface MessageEditorProps {
  subject: string;
  body: string;
  disabled: boolean;
  onSubjectChange(value: string): void;
  onBodyChange(value: string): void;
  /** Ctrl+Enter or Cmd+Enter in either field. The parent decides whether a commit may run. */
  onSubmit(): void;
}

const isSubmitKey = (e: React.KeyboardEvent): boolean =>
  e.key === "Enter" && (e.ctrlKey || e.metaKey);

export function MessageEditor(props: MessageEditorProps): React.JSX.Element {
  const { subject, body, disabled, onSubjectChange, onBodyChange, onSubmit } = props;
  const subjectId = useId();
  const bodyId = useId();
  const hintId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const over = subject.length > SUBJECT_LIMIT;

  const onSubjectKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitKey(e)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "Enter") {
      e.preventDefault();
      bodyRef.current?.focus();
    }
  };
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitKey(e)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.subjectRow}>
        <label htmlFor={subjectId} className={styles.label}>
          Subject
        </label>
        <span className={over ? styles.counterOver : styles.counter} aria-hidden="true">
          {subject.length}/{SUBJECT_LIMIT}
        </span>
      </div>
      <input
        id={subjectId}
        className={styles.subject}
        type="text"
        value={subject}
        placeholder="Summary of changes"
        disabled={disabled}
        aria-describedby={over ? hintId : undefined}
        onChange={(e) => onSubjectChange(e.target.value)}
        onKeyDown={onSubjectKeyDown}
      />
      {over && (
        <p id={hintId} className={styles.hint}>
          Keep the subject at {SUBJECT_LIMIT} characters or fewer
        </p>
      )}
      <label htmlFor={bodyId} className={styles.label}>
        Body
      </label>
      <textarea
        id={bodyId}
        ref={bodyRef}
        className={styles.body}
        value={body}
        placeholder="Optional longer description"
        rows={4}
        disabled={disabled}
        onChange={(e) => onBodyChange(e.target.value)}
        onKeyDown={onBodyKeyDown}
      />
    </div>
  );
}
```

```css
/* src/features/commit/MessageEditor.module.css */
.root {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.subjectRow {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.counter,
.counterOver {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
.counterOver {
  color: var(--color-warning, #c8871a);
}
.hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-warning, #c8871a);
}
.subject,
.body {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface, transparent);
  color: var(--color-text);
  font: inherit;
}
.body {
  resize: vertical;
  min-height: 4em;
}
```

`src/styles/tokens.css` has no `--color-warning` or `--color-on-accent`; add them to both themes (light: `--color-warning: #9a6700; --color-on-accent: #ffffff;`, dark: `--color-warning: #d29922; --color-on-accent: #ffffff;`) and drop the CSS fallbacks above once they exist.

```tsx
// src/features/commit/CommitBox.tsx
import type { RepoId } from "../../lib/ipc";
import { EMPTY_DRAFT, useCommitDraft } from "../../lib/store/commitDraft";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { AuthorLine } from "./AuthorLine";
import { commitDisabledReason } from "./commitGate";
import styles from "./CommitBox.module.css";
import { MessageEditor } from "./MessageEditor";
import { useCommit } from "./useCommit";
import { useCommitConfig } from "./useCommitConfig";
import { useHeadMessage } from "./useHeadMessage";

export function CommitBox({ repoId }: { repoId: RepoId }): React.JSX.Element {
  const draft = useCommitDraft((s) => s.drafts[repoId] ?? EMPTY_DRAFT);
  const { setSubject, setBody, setAmend } = useCommitDraft.getState();
  const { status } = useStatus(repoId);
  const { config, error: configError } = useCommitConfig(repoId);
  const { head } = useHeadMessage(repoId);
  const { commit, pending, error, clearError } = useCommit(repoId);

  const reason = commitDisabledReason({
    amend: draft.amend,
    subject: draft.subject,
    status,
    config,
  });
  const canCommit = reason === null && !pending;
  const submit = () => {
    if (canCommit) commit({ subject: draft.subject, body: draft.body }, draft.amend);
  };
  const canAmend = head !== null && head !== undefined;

  return (
    <section aria-label="Commit" className={styles.root}>
      <AuthorLine config={config} />
      <MessageEditor
        subject={draft.subject}
        body={draft.body}
        disabled={pending}
        onSubjectChange={(v) => setSubject(repoId, v)}
        onBodyChange={(v) => setBody(repoId, v)}
        onSubmit={submit}
      />
      <div className={styles.actions}>
        <label className={styles.amend} title={canAmend ? undefined : "No commit to amend"}>
          <input
            type="checkbox"
            checked={draft.amend}
            disabled={pending || !canAmend}
            title={canAmend ? undefined : "No commit to amend"}
            onChange={(e) => setAmend(repoId, e.target.checked, head ?? null)}
          />
          Amend last commit
        </label>
        <button
          type="button"
          className={styles.button}
          disabled={!canCommit}
          title={pending ? undefined : (reason ?? undefined)}
          onClick={submit}
        >
          {pending ? "Committing…" : draft.amend ? "Amend commit" : "Commit"}
        </button>
      </div>
      {error && <RepoError error={error} path={null} onDismiss={clearError} />}
      {configError && !error && (
        <RepoError error={configError} path={null} onDismiss={() => undefined} />
      )}
    </section>
  );
}
```

Notes for the developer: `useCommitDraft.getState()` for the actions is fine because zustand actions are stable; selecting `drafts[repoId] ?? EMPTY_DRAFT` keeps renders cheap because `EMPTY_DRAFT` is one object. The config error's Dismiss is a no-op by design: the query owns that error and will retry on focus; if the tester's test expects it to disappear, replace the no-op with hiding it in local state.

```css
/* src/features/commit/CommitBox.module.css */
.root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text);
}
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.amend {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
}
.button {
  padding: 6px 14px;
  border: none;
  border-radius: 4px;
  background: var(--color-accent);
  color: var(--color-on-accent, #fff);
  font: inherit;
  cursor: pointer;
}
.button:disabled {
  opacity: 0.5;
  cursor: default;
}
.root :global([role="alert"]) p {
  white-space: pre-wrap;
}
```

(If CSS Modules `:global` is awkward here, add `white-space: pre-wrap` to `.message` in `RepoError.module.css` instead; it is harmless for the other callers.)

```tsx
// src/app/RepoPane.tsx — body becomes
<div className={styles.body}>
  {/* Keyed so selection, menu, dialog, draft and mutation state never leak across tabs. */}
  <div className={styles.sidebar}>
    <ChangesPanel key={tab.id} repoId={tab.id} />
    <CommitBox key={`commit-${tab.id}`} repoId={tab.id} />
  </div>
  <section aria-label="Detail" className={styles.detail}>
    <DetailPane key={tab.id} repoId={tab.id} />
  </section>
</div>
```

```css
/* src/app/RepoPane.module.css — add */
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--color-border);
}

/* src/features/worktree/ChangesPanel.module.css — .root: remove border-right, add */
flex: 1;
```

```ts
// src/app/App.tsx — closeRepoTab: add after useWorkspace clear
useCommitDraft.getState().clear(id);
```

- [ ] **Step 4: Run the tests and all gates**

Run: `npm test`, `npm run test:coverage` (100 % for `src/`), `npm run typecheck`, `npm run lint`.
Expected: all green. Fix formatting with `npm run format` if prettier complains.

- [ ] **Step 5: Commit**

```bash
git rm -q src/features/commit/.gitkeep
git add src/features/commit src/app src/features/worktree/ChangesPanel.module.css src/styles
git commit -m "feat(ui): commit box with author line, amend and subject warning"
```

---

## Execution: batched agent cycles

Per the GR-5 arrangement (fixed per-cycle overhead dominates cost), run the five tasks as **two cycles**, each with the mandatory architect + tdd-tester → developer → coverage + code-reviewer → architect sign-off sequence:

| Cycle | Tasks | Deliverable                                                                 |
| ----- | ----- | --------------------------------------------------------------------------- |
| A     | 1–3   | Rust: core commit module and Tauri commands, `cargo test --workspace` green |
| B     | 4–5   | Front end: seam, store, gate, hooks, components, `npm test` at 100 %        |

About 10 agent dispatches in total (5 per cycle, plus a developer re-dispatch if a reviewer blocks). Models as before: architect and developer on opus, tester, coverage and reviewer on sonnet. Agent output goes to files under the session scratchpad, not the main context.

## After the last task

1. Final verification gate on the branch: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `npm test`, `npm run test:coverage`, `npm run lint`, `npm run typecheck`.
2. Architect sign-off on the merged branch.
3. Acceptance walk from the spec's Definition of Done (§6) in the running app, including the SSH-signed commit and the failing `pre-commit` hook.
4. Merge `feature/gr-6-commit-amend` into `main` with `--no-ff`; transition Jira GR-6 to Done with the walk results.
