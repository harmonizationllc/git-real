//! Launching external tools: the editor (spawned detached) and the diff and
//! merge tools (run through `git difftool`/`git mergetool` with the user's
//! command as the `gitreal` tool).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
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

/// The command-line convention a user's editor command is written in.
///
/// Settings hold the editor command as one string, and the right way to split
/// it depends on the platform: POSIX shell quoting on Linux and macOS, the
/// MSVCRT / `CommandLineToArgvW` rules on Windows, where `\` is a path
/// separator rather than an escape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandSyntax {
    Posix,
    Windows,
}

impl CommandSyntax {
    /// The syntax of the host this binary was built for: [`CommandSyntax::Windows`]
    /// on Windows, [`CommandSyntax::Posix`] everywhere else. The native
    /// wrappers use it so callers never have to pick a syntax themselves.
    pub fn native() -> Self {
        if cfg!(windows) {
            CommandSyntax::Windows
        } else {
            CommandSyntax::Posix
        }
    }
}

/// Splits a command into argv under the host's [`CommandSyntax::native`]
/// rules. This is what the editor launch uses; [`split_command_with`]
/// documents the rules of each syntax.
pub fn split_command(cmd: &str) -> Result<Vec<String>, ToolError> {
    split_command_with(CommandSyntax::native(), cmd)
}

/// Splits a command into argv under an explicit `syntax`, so both rule sets
/// can be exercised on any host.
///
/// Under [`CommandSyntax::Posix`] a backslash escapes the next character
/// outside single quotes; inside single quotes nothing escapes; a trailing
/// lone backslash is literal.
///
/// Under [`CommandSyntax::Windows`] arguments are separated by spaces and
/// tabs; a double quote starts or ends a quoted span and is dropped; inside a
/// quoted span `""` is one literal quote (the CRT rule since 2008); backslashes
/// are literal unless a run of them is followed by a double quote, when `2n`
/// backslashes give `n` and the quote acts as a quote, and `2n+1` give `n`
/// and a literal `"`; single quotes are ordinary characters.
///
/// Under both, an explicit empty quoted argument (`""`) is kept, a blank
/// command is [`ToolError::EmptyCommand`] and an unterminated quote is
/// [`ToolError::UnterminatedQuote`] (Windows itself would close it silently;
/// the same mistake is reported the same way on every platform).
pub fn split_command_with(syntax: CommandSyntax, cmd: &str) -> Result<Vec<String>, ToolError> {
    match syntax {
        CommandSyntax::Posix => split_posix(cmd),
        CommandSyntax::Windows => split_windows(cmd),
    }
}

/// The POSIX-shell splitter behind [`split_command_with`].
fn split_posix(cmd: &str) -> Result<Vec<String>, ToolError> {
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

/// The Windows (MSVCRT) splitter behind [`split_command_with`].
fn split_windows(cmd: &str) -> Result<Vec<String>, ToolError> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut in_quotes = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut run = 1;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    run += 1;
                }
                has_token = true;
                if chars.peek() == Some(&'"') {
                    current.extend(std::iter::repeat_n('\\', run / 2));
                    if run % 2 == 1 {
                        // An odd run escapes the quote: it is a literal `"`.
                        chars.next();
                        current.push('"');
                    }
                    // After an even run the quote is left for the next
                    // iteration, where it opens or closes a quoted span.
                } else {
                    current.extend(std::iter::repeat_n('\\', run));
                }
            }
            '"' => {
                has_token = true;
                if in_quotes && chars.peek() == Some(&'"') {
                    // `""` inside a quoted span is one literal quote.
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ' ' | '\t' if !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }

    if in_quotes {
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

/// The `PATHEXT` Windows uses when the variable is unset or empty.
pub const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Windows' `CREATE_NO_WINDOW` process creation flag: a console program
/// started from the GUI gets no console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The environment program resolution reads: `PATH` and `PATHEXT`.
///
/// It is a value rather than a read of the process environment so tests can
/// hand [`open_in_editor_with`] and [`resolve_program`] a synthetic Windows
/// `PATH` on any host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolEnv {
    pub path: OsString,
    pub pathext: OsString,
}

impl ToolEnv {
    /// Reads `PATH` and `PATHEXT` from this process's environment, each empty
    /// when unset. This is what the native [`open_in_editor`] uses.
    pub fn from_process() -> Self {
        ToolEnv {
            path: std::env::var_os("PATH").unwrap_or_default(),
            pathext: std::env::var_os("PATHEXT").unwrap_or_default(),
        }
    }
}

/// Finds the file Windows would run for `program`, using `env`'s `PATH` and
/// `PATHEXT`, and `is_file` to test each candidate.
///
/// The standard library's `Command` finds only `.exe` files on `PATH`, and
/// runs a `.cmd`/`.bat` launcher (VS Code's `code` is `code.cmd`) only when
/// handed its full name, so the editor launch resolves the name first.
///
/// The candidates for `program` are the name as given, only when its last
/// component already has an extension (a `.` after the last separator that is
/// not the component's first character), then the name with each `PATHEXT`
/// extension appended, in order. A bare name is never probed as given: a
/// standard VS Code install puts an extensionless `sh` script `code` beside
/// `code.cmd`, `CreateProcess` cannot run the script, and `cmd.exe` would
/// pick `code.cmd`.
///
/// A `program` containing `\` or `/` or starting with a drive prefix is not
/// searched on `PATH`: its candidates are probed where it points. Otherwise
/// each Windows-absolute `PATH` entry (`X:\`, `X:/` or `\\`; empty and
/// relative entries are skipped) is tried in order, probing
/// `dir\<candidate>` for each candidate. The first file found wins.
/// Extensions are used as written after trimming; an empty `PATHEXT` means
/// [`DEFAULT_PATHEXT`]. `PATH` is split on `;` and candidates are joined with
/// `\` here rather than by the host, so this behaves the same on every OS.
/// `None` means nothing matched.
pub fn resolve_program(
    program: &str,
    env: &ToolEnv,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let pathext = env.pathext.to_string_lossy();
    let pathext = if pathext.trim().is_empty() {
        DEFAULT_PATHEXT
    } else {
        pathext.as_ref()
    };
    let exts: Vec<&str> = pathext
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    let name = program.rsplit(['\\', '/']).next().unwrap_or(program);
    let has_ext = name.rfind('.').is_some_and(|dot| dot > 0);

    let probe = |base: &str| -> Option<PathBuf> {
        if has_ext && is_file(Path::new(base)) {
            return Some(PathBuf::from(base));
        }
        exts.iter()
            .map(|ext| format!("{base}{ext}"))
            .find(|candidate| is_file(Path::new(candidate)))
            .map(PathBuf::from)
    };

    if program.contains(['\\', '/']) || has_drive_prefix(program) {
        return probe(program);
    }
    let path = env.path.to_string_lossy();
    path.split(';')
        .filter(|dir| is_windows_absolute(dir))
        .find_map(|dir| {
            if dir.ends_with(['\\', '/']) {
                probe(&format!("{dir}{program}"))
            } else {
                probe(&format!("{dir}\\{program}"))
            }
        })
}

/// `X:` at the start of `s`, for an ASCII letter `X`.
fn has_drive_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// A Windows-absolute path: `X:\`, `X:/` or a `\\` UNC prefix.
fn is_windows_absolute(s: &str) -> bool {
    s.starts_with(r"\\")
        || (has_drive_prefix(s) && matches!(s.as_bytes().get(2), Some(b'\\' | b'/')))
}

/// Spawns an editor detached, appending `path` to the parsed command. When
/// `cwd` is given the editor runs in that directory, so a relative `path`
/// resolves against it; otherwise the editor inherits this process's directory.
///
/// Uses the host's [`CommandSyntax::native`] and the real `PATH`/`PATHEXT`;
/// [`open_in_editor_with`] is the same launch with both supplied.
pub fn open_in_editor(cmd: &str, path: &Path, cwd: Option<&Path>) -> Result<(), ToolError> {
    open_in_editor_with(
        CommandSyntax::native(),
        &ToolEnv::from_process(),
        cmd,
        path,
        cwd,
    )
}

/// [`open_in_editor`] with the command syntax and environment supplied, so
/// the Windows route can be exercised on any host.
///
/// The command is split under `syntax`. Under [`CommandSyntax::Windows`] the
/// program is resolved with [`resolve_program`] first, so a `.cmd` launcher
/// such as VS Code's `code` is found, and a program that resolves to nothing
/// is [`ToolError::Spawn`] with the cause "not found on PATH". Under
/// [`CommandSyntax::Posix`] `env` is ignored and the OS searches `PATH`. On
/// Windows the editor is spawned with `CREATE_NO_WINDOW`, so a console
/// launcher does not flash a console window.
pub fn open_in_editor_with(
    syntax: CommandSyntax,
    env: &ToolEnv,
    cmd: &str,
    path: &Path,
    cwd: Option<&Path>,
) -> Result<(), ToolError> {
    let argv = split_command_with(syntax, cmd)?;
    let program = argv[0].clone();
    let executable = match syntax {
        CommandSyntax::Posix => PathBuf::from(&program),
        CommandSyntax::Windows => {
            resolve_program(&program, env, Path::is_file).ok_or_else(|| ToolError::Spawn {
                program: program.clone(),
                cause: "not found on PATH".to_owned(),
            })?
        }
    };
    let mut command = Command::new(executable);
    command
        .args(&argv[1..])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
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
