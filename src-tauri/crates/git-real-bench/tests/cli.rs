//! End-to-end: the built `git-real-bench` binary on a tiny synthetic fixture.

use std::path::Path;
use std::process::{Command, Output};

/// Same opt-out as git-real-core's test helper.
const SKIP_GIT_TESTS_ENV: &str = "GIT_REAL_SKIP_GIT_TESTS";

fn git_available() -> bool {
    let found = git_real_core::git_cli::locate().is_ok();
    if found {
        return true;
    }
    if std::env::var(SKIP_GIT_TESTS_ENV).ok().as_deref() == Some("1") {
        eprintln!("skipping: git not on PATH ({SKIP_GIT_TESTS_ENV}=1)");
        return false;
    }
    panic!("git not on PATH: install git, or set {SKIP_GIT_TESTS_ENV}=1 to skip the git CLI tests");
}

fn bench(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_git-real-bench"))
        .args(args)
        .output()
        .expect("spawn git-real-bench")
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap()
}

// --help and usage errors.
#[test]
fn help_exits_zero() {
    let out = bench(&["--help"]);
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn help_prints_usage_to_stdout() {
    let out = bench(&["--help"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains("git-real-bench run <repo>..."));
}

#[test]
fn usage_error_exits_two() {
    let out = bench(&["run"]);
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn usage_error_prints_usage_to_stderr() {
    let out = bench(&["frobnicate"]);
    assert!(String::from_utf8_lossy(&out.stderr).contains("git-real-bench prepare synthetic"));
}

// run on something that is not a repository.
#[test]
fn run_on_non_repo_exits_three() {
    let tmp = tempfile::tempdir().unwrap();
    let out = bench(&["run", path_str(tmp.path())]);
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn run_on_non_repo_reports_cannot_open_on_stderr() {
    let tmp = tempfile::tempdir().unwrap();
    let out = bench(&["run", path_str(tmp.path())]);
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("error: cannot open "));
}

// prepare then run: the whole pipeline on 30 commits and 5 files.
#[test]
fn prepare_then_run_writes_json_and_summary_and_exits_zero() {
    if !git_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let fixture = tmp.path().join("bench-synthetic");
    let json = tmp.path().join("bench-results.json");
    let summary = tmp.path().join("summary.md");

    let prepared = bench(&[
        "prepare",
        "synthetic",
        path_str(&fixture),
        "--commits",
        "30",
        "--files",
        "5",
    ]);
    assert_eq!(
        prepared.status.code(),
        Some(0),
        "prepare failed: {prepared:?}"
    );

    let ran = bench(&[
        "run",
        path_str(&fixture),
        "--json",
        path_str(&json),
        "--summary",
        path_str(&summary),
    ]);
    assert_eq!(ran.status.code(), Some(0), "run failed: {ran:?}");

    let report: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
    assert_eq!(
        (
            report["version"].as_u64(),
            report["results"][0]["commits"].as_u64(),
            report["passed"].as_bool(),
        ),
        (Some(1), Some(30), Some(true))
    );
    assert!(
        std::fs::read_to_string(&summary)
            .unwrap()
            .contains("### Git Real benchmarks")
    );
}

#[test]
fn run_prints_the_table_and_pass_on_stdout() {
    if !git_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let fixture = tmp.path().join("bench-synthetic");
    bench(&[
        "prepare",
        "synthetic",
        path_str(&fixture),
        "--commits",
        "30",
        "--files",
        "5",
    ]);
    let ran = bench(&["run", path_str(&fixture)]);
    let stdout = String::from_utf8_lossy(&ran.stdout);
    assert_eq!(stdout.lines().last(), Some("PASS"), "stdout was {stdout:?}");
}

#[test]
fn prepare_twice_reports_cached() {
    if !git_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let fixture = tmp.path().join("bench-synthetic");
    let args = [
        "prepare",
        "synthetic",
        path_str(&fixture),
        "--commits",
        "30",
        "--files",
        "5",
    ];
    bench(&args);
    let again = bench(&args);
    assert!(String::from_utf8_lossy(&again.stdout).contains("(cached)"));
}
