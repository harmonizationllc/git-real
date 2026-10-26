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
    todo!()
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
