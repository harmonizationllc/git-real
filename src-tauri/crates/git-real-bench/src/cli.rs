//! Hand-written argument parser (no clap): `Command`, `parse`, `USAGE`.

use std::fmt;
use std::path::PathBuf;

use crate::fixtures::FixtureSpec;

pub const DEFAULT_COMMITS: u32 = 100_000;
pub const DEFAULT_FILES: u32 = 10_000;
pub const DEFAULT_URL: &str = "https://github.com/qemu/qemu";

pub const USAGE: &str = "\
usage:
  git-real-bench prepare synthetic <dir> [--commits N] [--files M]
  git-real-bench prepare public-graph <dir> [--url URL] [--commits N]
  git-real-bench prepare public-worktree <dir> [--url URL]
  git-real-bench run <repo>... [--json <file>] [--summary <file>] [--no-assert]
  git-real-bench --help
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Prepare {
        dir: PathBuf,
        spec: FixtureSpec,
    },
    Run {
        repos: Vec<PathBuf>,
        json: Option<PathBuf>,
        summary: Option<PathBuf>,
        no_assert: bool,
    },
}

/// A usage mistake; the message names the offending argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Parses the arguments after the program name.
pub fn parse(args: &[String]) -> Result<Command, UsageError> {
    match args.first().map(String::as_str) {
        Some("--help") if args.len() == 1 => Ok(Command::Help),
        Some("prepare") => parse_prepare(&args[1..]),
        Some("run") => parse_run(&args[1..]),
        Some(other) => Err(UsageError(format!("unknown command {other}"))),
        None => Err(UsageError("missing command".to_string())),
    }
}

/// `<kind> <dir> [flags]`, flags anywhere after the kind.
fn parse_prepare(args: &[String]) -> Result<Command, UsageError> {
    let kind = args
        .first()
        .ok_or_else(|| UsageError("missing fixture kind".to_string()))?;
    let allowed: &[&str] = match kind.as_str() {
        "synthetic" => &["--commits", "--files"],
        "public-graph" => &["--url", "--commits"],
        "public-worktree" => &["--url"],
        other => return Err(UsageError(format!("unknown fixture kind {other}"))),
    };
    let mut dirs = Vec::new();
    let (mut commits, mut files, mut url) = (DEFAULT_COMMITS, DEFAULT_FILES, DEFAULT_URL);
    let mut rest = args[1..].iter();
    while let Some(arg) = rest.next() {
        if !arg.starts_with("--") {
            dirs.push(arg);
            continue;
        }
        if !allowed.contains(&arg.as_str()) {
            return Err(unknown_flag(arg));
        }
        let value = flag_value(arg, rest.next())?;
        match arg.as_str() {
            "--commits" => commits = count(arg, value)?,
            "--files" => files = count(arg, value)?,
            _ => url = value,
        }
    }
    let dir = match dirs.as_slice() {
        [dir] => PathBuf::from(dir),
        [] => return Err(UsageError("missing <dir>".to_string())),
        _ => return Err(UsageError("expected exactly one <dir>".to_string())),
    };
    let url = url.to_string();
    let spec = match kind.as_str() {
        "synthetic" => FixtureSpec::Synthetic { commits, files },
        "public-graph" => FixtureSpec::PublicGraph { url, commits },
        _ => FixtureSpec::PublicWorktree { url },
    };
    Ok(Command::Prepare { dir, spec })
}

/// `<repo>... [--json <file>] [--summary <file>] [--no-assert]`, flags anywhere.
fn parse_run(args: &[String]) -> Result<Command, UsageError> {
    let (mut repos, mut json, mut summary, mut no_assert) = (Vec::new(), None, None, false);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => json = Some(PathBuf::from(flag_value(arg, rest.next())?)),
            "--summary" => summary = Some(PathBuf::from(flag_value(arg, rest.next())?)),
            "--no-assert" => no_assert = true,
            flag if flag.starts_with("--") => return Err(unknown_flag(flag)),
            repo => repos.push(PathBuf::from(repo)),
        }
    }
    if repos.is_empty() {
        return Err(UsageError("missing <repo>".to_string()));
    }
    Ok(Command::Run {
        repos,
        json,
        summary,
        no_assert,
    })
}

fn unknown_flag(flag: &str) -> UsageError {
    UsageError(format!("unknown flag {flag}"))
}

fn flag_value<'a>(flag: &str, value: Option<&'a String>) -> Result<&'a str, UsageError> {
    value
        .map(String::as_str)
        .ok_or_else(|| UsageError(format!("{flag} needs a value")))
}

/// A positive count: `0` would leave nothing to build (and `c % files` undefined).
fn count(flag: &str, value: &str) -> Result<u32, UsageError> {
    match value.parse::<u32>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(UsageError(format!(
            "{flag} needs a positive number, got {value}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| p.to_string()).collect()
    }

    fn parse_ok(parts: &[&str]) -> Command {
        parse(&argv(parts)).expect("should parse")
    }

    // prepare: one parse per fixture kind, with defaults and with explicit values.
    #[test]
    fn parses_prepare_synthetic_with_defaults() {
        assert_eq!(
            parse_ok(&["prepare", "synthetic", "/tmp/x"]),
            Command::Prepare {
                dir: PathBuf::from("/tmp/x"),
                spec: FixtureSpec::Synthetic {
                    commits: 100_000,
                    files: 10_000
                },
            }
        );
    }

    #[test]
    fn parses_prepare_synthetic_with_sizes() {
        assert_eq!(
            parse_ok(&[
                "prepare",
                "synthetic",
                "d",
                "--commits",
                "30",
                "--files",
                "5"
            ]),
            Command::Prepare {
                dir: PathBuf::from("d"),
                spec: FixtureSpec::Synthetic {
                    commits: 30,
                    files: 5
                },
            }
        );
    }

    #[test]
    fn flags_may_precede_the_directory() {
        assert_eq!(
            parse_ok(&["prepare", "synthetic", "--commits", "30", "d"]),
            Command::Prepare {
                dir: PathBuf::from("d"),
                spec: FixtureSpec::Synthetic {
                    commits: 30,
                    files: 10_000
                },
            }
        );
    }

    #[test]
    fn parses_prepare_public_graph_with_defaults() {
        assert_eq!(
            parse_ok(&["prepare", "public-graph", "g"]),
            Command::Prepare {
                dir: PathBuf::from("g"),
                spec: FixtureSpec::PublicGraph {
                    url: "https://github.com/qemu/qemu".to_string(),
                    commits: 100_000
                },
            }
        );
    }

    #[test]
    fn parses_prepare_public_graph_with_url_and_commits() {
        assert_eq!(
            parse_ok(&[
                "prepare",
                "public-graph",
                "g",
                "--url",
                "file:///src.git",
                "--commits",
                "5"
            ]),
            Command::Prepare {
                dir: PathBuf::from("g"),
                spec: FixtureSpec::PublicGraph {
                    url: "file:///src.git".to_string(),
                    commits: 5
                },
            }
        );
    }

    #[test]
    fn parses_prepare_public_worktree() {
        assert_eq!(
            parse_ok(&["prepare", "public-worktree", "w", "--url", "file:///s.git"]),
            Command::Prepare {
                dir: PathBuf::from("w"),
                spec: FixtureSpec::PublicWorktree {
                    url: "file:///s.git".to_string()
                },
            }
        );
    }

    #[test]
    fn parses_prepare_public_worktree_with_default_url() {
        assert_eq!(
            parse_ok(&["prepare", "public-worktree", "w"]),
            Command::Prepare {
                dir: PathBuf::from("w"),
                spec: FixtureSpec::PublicWorktree {
                    url: "https://github.com/qemu/qemu".to_string()
                },
            }
        );
    }

    // run: operands, options, and defaults.
    #[test]
    fn parses_run_with_repos_json_summary_and_no_assert() {
        assert_eq!(
            parse_ok(&[
                "run",
                "a",
                "b",
                "--json",
                "out.json",
                "--summary",
                "sum.md",
                "--no-assert"
            ]),
            Command::Run {
                repos: vec![PathBuf::from("a"), PathBuf::from("b")],
                json: Some(PathBuf::from("out.json")),
                summary: Some(PathBuf::from("sum.md")),
                no_assert: true,
            }
        );
    }

    #[test]
    fn parses_run_with_only_a_repo() {
        assert_eq!(
            parse_ok(&["run", "a"]),
            Command::Run {
                repos: vec![PathBuf::from("a")],
                json: None,
                summary: None,
                no_assert: false,
            }
        );
    }

    #[test]
    fn run_accepts_flags_between_repos() {
        assert_eq!(
            parse_ok(&["run", "a", "--json", "j", "b", "--no-assert"]),
            Command::Run {
                repos: vec![PathBuf::from("a"), PathBuf::from("b")],
                json: Some(PathBuf::from("j")),
                summary: None,
                no_assert: true,
            }
        );
    }

    #[test]
    fn help_flag() {
        assert_eq!(parse_ok(&["--help"]), Command::Help);
    }

    // Usage errors.
    #[test]
    fn rejects_empty_arguments() {
        assert!(parse(&[]).is_err());
    }

    #[test]
    fn rejects_unknown_subcommand() {
        assert!(parse(&argv(&["frobnicate"])).is_err());
    }

    #[test]
    fn rejects_missing_dir() {
        assert!(parse(&argv(&["prepare", "synthetic"])).is_err());
    }

    #[test]
    fn rejects_missing_fixture_kind() {
        assert!(parse(&argv(&["prepare"])).is_err());
    }

    #[test]
    fn rejects_missing_repos() {
        assert!(parse(&argv(&["run"])).is_err());
    }

    #[test]
    fn rejects_flags_without_any_repo() {
        assert!(parse(&argv(&["run", "--json", "x.json"])).is_err());
    }

    #[test]
    fn rejects_unknown_flag() {
        assert!(parse(&argv(&["run", "a", "--bogus"])).is_err());
    }

    #[test]
    fn unknown_flag_is_named_in_the_message() {
        let err = parse(&argv(&["run", "a", "--bogus"])).unwrap_err();
        assert!(err.to_string().contains("--bogus"), "got {err}");
    }

    #[test]
    fn rejects_unknown_flag_on_prepare() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--bogus", "1"])).is_err());
    }

    #[test]
    fn rejects_a_flag_that_belongs_to_another_fixture_kind() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--url", "u"])).is_err());
    }

    #[test]
    fn rejects_unknown_fixture_kind() {
        assert!(parse(&argv(&["prepare", "bogus", "d"])).is_err());
    }

    #[test]
    fn rejects_non_numeric_commits() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--commits", "many"])).is_err());
    }

    #[test]
    fn rejects_negative_files() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--files", "-3"])).is_err());
    }

    #[test]
    fn rejects_a_flag_missing_its_value() {
        assert!(parse(&argv(&["run", "a", "--json"])).is_err());
    }

    #[test]
    fn rejects_a_commits_flag_missing_its_value() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--commits"])).is_err());
    }

    #[test]
    fn rejects_help_with_extra_arguments() {
        assert!(parse(&argv(&["--help", "run"])).is_err());
    }

    #[test]
    fn rejects_two_directories() {
        let err = parse(&argv(&["prepare", "synthetic", "a", "b"])).unwrap_err();
        assert_eq!(err.to_string(), "expected exactly one <dir>");
    }

    #[test]
    fn rejects_a_zero_commit_count() {
        let err = parse(&argv(&["prepare", "synthetic", "d", "--commits", "0"])).unwrap_err();
        assert_eq!(err.to_string(), "--commits needs a positive number, got 0");
    }

    #[test]
    fn rejects_a_zero_file_count() {
        let err = parse(&argv(&["prepare", "synthetic", "d", "--files", "0"])).unwrap_err();
        assert_eq!(err.to_string(), "--files needs a positive number, got 0");
    }

    #[test]
    fn rejects_a_zero_public_graph_commit_count() {
        assert!(parse(&argv(&["prepare", "public-graph", "d", "--commits", "0"])).is_err());
    }

    #[test]
    fn rejects_a_non_numeric_file_count() {
        assert!(parse(&argv(&["prepare", "synthetic", "d", "--files", "many"])).is_err());
    }

    #[test]
    fn rejects_a_count_beyond_u32() {
        assert!(
            parse(&argv(&[
                "prepare",
                "synthetic",
                "d",
                "--commits",
                "4294967296"
            ]))
            .is_err()
        );
    }

    #[test]
    fn rejects_commits_on_public_worktree() {
        let err = parse(&argv(&[
            "prepare",
            "public-worktree",
            "d",
            "--commits",
            "5",
        ]))
        .unwrap_err();
        assert_eq!(err.to_string(), "unknown flag --commits");
    }

    #[test]
    fn rejects_files_on_public_graph() {
        assert!(parse(&argv(&["prepare", "public-graph", "d", "--files", "5"])).is_err());
    }

    #[test]
    fn rejects_a_url_flag_missing_its_value() {
        let err = parse(&argv(&["prepare", "public-worktree", "d", "--url"])).unwrap_err();
        assert_eq!(err.to_string(), "--url needs a value");
    }

    #[test]
    fn rejects_a_summary_flag_missing_its_value() {
        let err = parse(&argv(&["run", "a", "--summary"])).unwrap_err();
        assert_eq!(err.to_string(), "--summary needs a value");
    }

    #[test]
    fn rejects_a_prepare_flag_on_run() {
        assert!(parse(&argv(&["run", "a", "--commits", "5"])).is_err());
    }

    #[test]
    fn rejects_run_with_only_flags_and_no_repo() {
        let err = parse(&argv(&["run", "--no-assert", "--json", "o.json"])).unwrap_err();
        assert_eq!(err.to_string(), "missing <repo>");
    }

    #[test]
    fn rejects_prepare_without_a_kind() {
        let err = parse(&argv(&["prepare"])).unwrap_err();
        assert_eq!(err.to_string(), "missing fixture kind");
    }

    // USAGE documents the whole surface.
    #[test]
    fn usage_text_lists_every_subcommand() {
        for needle in [
            "prepare synthetic <dir> [--commits N] [--files M]",
            "prepare public-graph <dir> [--url URL] [--commits N]",
            "prepare public-worktree <dir> [--url URL]",
            "run <repo>... [--json <file>] [--summary <file>] [--no-assert]",
            "--help",
        ] {
            assert!(USAGE.contains(needle), "USAGE lacks {needle:?}");
        }
    }

    #[test]
    fn defaults_are_the_documented_ones() {
        assert_eq!(
            (DEFAULT_COMMITS, DEFAULT_FILES, DEFAULT_URL),
            (100_000, 10_000, "https://github.com/qemu/qemu")
        );
    }
}
