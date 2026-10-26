//! Launching external tools: the editor (spawned detached) and the diff and
//! merge tools (run through `git difftool`/`git mergetool` with the user's
//! command as the `gitreal` tool).

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;
use thiserror::Error;

use crate::error::GitError;
use crate::git_cli;
use crate::repo::RepoSession;

/// git's empty-tree object id, used as the "parent" of a root commit so a diff
/// shows the whole commit.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// A failure launching or running an external tool.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ToolError {
    #[error("the command is empty")]
    EmptyCommand,
    #[error("the command has an unterminated quote")]
    UnterminatedQuote,
    // `cause` rather than `source`: thiserror reserves a field named `source`
    // for the error source, which must implement `Error` (a `String` cannot).
    #[error("Couldn't start {program}: {cause}")]
    Spawn { program: String, cause: String },
    #[error("{message}")]
    Failed {
        verb: &'static str,
        code: Option<i32>,
        message: String,
    },
}

/// The diff a caller asked for, as chosen in the UI (wire shape, serde tagged).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExternalDiffScope {
    Unstaged,
    Staged,
    Commit { oid: String },
}

/// A resolved diff range: a commit scope has had its first parent looked up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffRange {
    Unstaged,
    Staged,
    Commit { parent: Option<String>, oid: String },
}

impl ExternalDiffScope {
    /// Resolves the scope against `session`, looking up a commit's first parent.
    pub fn resolve(&self, session: &RepoSession) -> Result<DiffRange, GitError> {
        match self {
            ExternalDiffScope::Unstaged => Ok(DiffRange::Unstaged),
            ExternalDiffScope::Staged => Ok(DiffRange::Staged),
            ExternalDiffScope::Commit { oid } => {
                let parent = session.first_parent_oid(oid)?;
                Ok(DiffRange::Commit {
                    parent,
                    oid: oid.clone(),
                })
            }
        }
    }
}

/// Splits a shell-style command into argv.
///
/// A backslash escapes the next character outside single quotes; inside single
/// quotes nothing escapes; an explicit empty quoted argument (`""`) is kept; a
/// trailing lone backslash is literal. A blank command is [`ToolError::EmptyCommand`]
/// and an unterminated quote is [`ToolError::UnterminatedQuote`].
pub fn split_command(cmd: &str) -> Result<Vec<String>, ToolError> {
    #[derive(PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }

    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut quote = Quote::None;
    let mut escaped = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            has_token = true;
            continue;
        }
        match quote {
            Quote::None => match c {
                '\\' => {
                    if chars.peek().is_none() {
                        current.push('\\');
                        has_token = true;
                    } else {
                        escaped = true;
                    }
                }
                '\'' => {
                    quote = Quote::Single;
                    has_token = true;
                }
                '"' => {
                    quote = Quote::Double;
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        args.push(std::mem::take(&mut current));
                        has_token = false;
                    }
                }
                c => {
                    current.push(c);
                    has_token = true;
                }
            },
            Quote::Single => match c {
                '\'' => quote = Quote::None,
                c => current.push(c),
            },
            Quote::Double => match c {
                '"' => quote = Quote::None,
                '\\' if chars.peek().is_some() => escaped = true,
                c => current.push(c),
            },
        }
    }

    if quote != Quote::None {
        return Err(ToolError::UnterminatedQuote);
    }
    if has_token {
        args.push(current);
    }
    if args.is_empty() {
        return Err(ToolError::EmptyCommand);
    }
    Ok(args)
}

/// Spawns an editor detached, appending `path` to the parsed command. When
/// `cwd` is given the editor runs in that directory, so a relative `path`
/// resolves against it; otherwise the editor inherits this process's directory.
pub fn open_in_editor(cmd: &str, path: &Path, cwd: Option<&Path>) -> Result<(), ToolError> {
    let argv = split_command(cmd)?;
    let program = argv[0].clone();
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    // The child is dropped without waiting: the editor outlives this call.
    command.spawn().map_err(|e| ToolError::Spawn {
        program,
        cause: e.to_string(),
    })?;
    Ok(())
}

/// Runs `git difftool` with the user's command as the `gitreal` tool.
pub fn open_external_diff(
    git: &Path,
    repo_path: &Path,
    cmd: &str,
    path: &str,
    range: &DiffRange,
) -> Result<(), ToolError> {
    let mut command = git_cli::command(git);
    command.current_dir(repo_path).env("PWD", repo_path);
    command
        .arg("-c")
        .arg(format!("difftool.gitreal.cmd={cmd}"))
        .arg("-c")
        .arg("difftool.prompt=false")
        .arg("difftool")
        .arg("--tool=gitreal");
    match range {
        DiffRange::Unstaged => {}
        DiffRange::Staged => {
            command.arg("--cached");
        }
        DiffRange::Commit { parent, oid } => {
            let parent = parent.clone().unwrap_or_else(|| EMPTY_TREE.to_owned());
            command.arg(parent).arg(oid);
        }
    }
    command.arg("--").arg(path);
    run_git_tool(&mut command, "difftool")
}

/// Runs `git mergetool` with the user's command as the `gitreal` tool.
pub fn open_external_merge(
    git: &Path,
    repo_path: &Path,
    cmd: &str,
    path: &str,
) -> Result<(), ToolError> {
    let mut command = git_cli::command(git);
    command.current_dir(repo_path).env("PWD", repo_path);
    command
        .arg("-c")
        .arg(format!("mergetool.gitreal.cmd={cmd}"))
        .arg("-c")
        .arg("mergetool.gitreal.trustExitCode=true")
        .arg("-c")
        .arg("mergetool.prompt=false")
        .arg("-c")
        .arg("mergetool.keepBackup=false")
        .arg("mergetool")
        .arg("--tool=gitreal")
        .arg("--")
        .arg(path);
    run_git_tool(&mut command, "mergetool")
}

/// Runs `command` to completion, mapping a spawn failure or a non-zero exit to
/// a [`ToolError`]. The failure message is the last non-blank stderr line, else
/// a line naming the exit code or signal.
fn run_git_tool(command: &mut Command, verb: &'static str) -> Result<(), ToolError> {
    let output = git_cli::capture(command).map_err(|e| ToolError::Spawn {
        program: "git".to_owned(),
        cause: e.to_string(),
    })?;
    if output.status.success() {
        return Ok(());
    }
    let code = output.status.code();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr.lines().rev().find(|line| !line.trim().is_empty());
    let message = match last {
        Some(line) => line.trim().to_owned(),
        None => match code {
            Some(c) => format!("git {verb} failed with exit code {c}"),
            None => format!("git {verb} was terminated by a signal"),
        },
    };
    Err(ToolError::Failed {
        verb,
        code,
        message,
    })
}
