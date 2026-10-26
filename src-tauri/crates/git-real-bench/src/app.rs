//! Dispatch and exit-code mapping: 0 ok, 1 budget exceeded, 2 usage, 3 error.

use std::io::Write;
use std::path::Path;

use crate::git::BenchError;
use crate::measure::Measurement;

/// Runs the program for `args` (after the program name); returns the exit code.
/// Measures with `measure::measure`.
pub fn run(args: &[String], out: &mut impl Write, err: &mut impl Write) -> i32 {
    todo!()
}

/// `run` with the measurer injected so tests can hand in canned measurements.
/// `measurer(path, label)`; the label is the repository directory's file name.
pub fn run_with(
    args: &[String],
    out: &mut impl Write,
    err: &mut impl Write,
    measurer: &dyn Fn(&Path, &str) -> Result<Measurement, BenchError>,
) -> i32 {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::USAGE;
    use crate::test_support::{git_available, sample_measurement};
    use std::cell::RefCell;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| p.to_string()).collect()
    }

    struct Outcome {
        code: i32,
        out: String,
        err: String,
    }

    fn drive(
        args: &[String],
        measurer: &dyn Fn(&Path, &str) -> Result<Measurement, BenchError>,
    ) -> Outcome {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(args, &mut out, &mut err, measurer);
        Outcome {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn fine(_: &Path, label: &str) -> Result<Measurement, BenchError> {
        Ok(sample_measurement(label))
    }

    fn over_budget(_: &Path, label: &str) -> Result<Measurement, BenchError> {
        let mut m = sample_measurement(label);
        m.open_to_first_page_ms = 3_412;
        Ok(m)
    }

    // --help and usage errors.
    #[test]
    fn help_exits_0_and_prints_usage_to_stdout() {
        let o = drive(&argv(&["--help"]), &fine);
        assert_eq!((o.code, o.out.as_str(), o.err.as_str()), (0, USAGE, ""));
    }

    #[test]
    fn bad_args_exit_2_and_print_usage_to_stderr() {
        let o = drive(&argv(&["run"]), &fine);
        assert_eq!(o.code, 2);
        assert!(o.err.contains(USAGE), "stderr was {:?}", o.err);
    }

    #[test]
    fn bad_args_print_nothing_to_stdout() {
        let o = drive(&argv(&["run", "a", "--bogus"]), &fine);
        assert_eq!(o.out, "");
    }

    #[test]
    fn run_public_entry_point_dispatches_help() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&argv(&["--help"]), &mut out, &mut err);
        assert_eq!(code, 0);
    }

    // run on a path that is not a repository uses the real measurer.
    #[test]
    fn run_on_non_repository_exits_3_with_cannot_open() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().display().to_string();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&argv(&["run", &path]), &mut out, &mut err);
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 3);
        assert!(
            err.starts_with(&format!("error: cannot open {path}: ")),
            "stderr was {err:?}"
        );
    }

    #[test]
    fn run_on_non_repository_writes_no_report_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().display().to_string();
        let json = tmp.path().join("out.json");
        let (mut out, mut err) = (Vec::new(), Vec::new());
        run(
            &argv(&["run", &path, "--json", &json.display().to_string()]),
            &mut out,
            &mut err,
        );
        assert!(!json.exists());
    }

    #[test]
    fn measurement_error_is_reported_as_error_prefix_and_exits_3() {
        let o = drive(&argv(&["run", "a"]), &|_, _| {
            Err(BenchError::new("cannot open a: boom"))
        });
        assert_eq!(
            (o.code, o.err.as_str()),
            (3, "error: cannot open a: boom\n")
        );
    }

    // Success, violation, and --no-assert.
    #[test]
    fn run_within_budget_exits_0_and_prints_pass() {
        let o = drive(&argv(&["run", "/x/synthetic"]), &fine);
        assert_eq!(o.code, 0);
        assert_eq!(o.out.lines().last(), Some("PASS"));
    }

    #[test]
    fn run_labels_each_repo_by_directory_name() {
        let seen = RefCell::new(Vec::new());
        let measurer = |_: &Path, label: &str| {
            seen.borrow_mut().push(label.to_string());
            Ok(sample_measurement(label))
        };
        drive(&argv(&["run", "/x/synthetic", "/y/qemu-graph"]), &measurer);
        assert_eq!(*seen.borrow(), vec!["synthetic", "qemu-graph"]);
    }

    #[test]
    fn run_passes_the_repository_path_to_the_measurer() {
        let seen = RefCell::new(Vec::new());
        let measurer = |p: &Path, label: &str| {
            seen.borrow_mut().push(p.to_path_buf());
            Ok(sample_measurement(label))
        };
        drive(&argv(&["run", "/x/synthetic"]), &measurer);
        assert_eq!(*seen.borrow(), vec![Path::new("/x/synthetic")]);
    }

    #[test]
    fn run_with_violation_exits_1() {
        let o = drive(&argv(&["run", "/x/synthetic"]), &over_budget);
        assert_eq!(o.code, 1);
    }

    #[test]
    fn violation_is_listed_after_fail_on_stdout() {
        let o = drive(&argv(&["run", "/x/synthetic"]), &over_budget);
        let lines: Vec<&str> = o.out.lines().collect();
        assert_eq!(
            &lines[lines.len() - 2..],
            ["FAIL", "synthetic: openToFirstPageMs 3412 exceeds 3000"]
        );
    }

    #[test]
    fn no_assert_exits_0_with_violation() {
        let o = drive(&argv(&["run", "/x/synthetic", "--no-assert"]), &over_budget);
        assert_eq!(o.code, 0);
        assert_eq!(o.out.lines().last(), Some("INFO"));
    }

    // Report files.
    #[test]
    fn json_report_is_written_and_parses() {
        let tmp = tempfile::tempdir().unwrap();
        let json = tmp.path().join("out.json");
        let o = drive(
            &argv(&["run", "/x/synthetic", "--json", &json.display().to_string()]),
            &fine,
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
        assert_eq!(
            (o.code, v["version"].as_u64(), v["passed"].as_bool()),
            (0, Some(1), Some(true))
        );
    }

    #[test]
    fn json_passed_is_false_under_no_assert_with_a_violation() {
        let tmp = tempfile::tempdir().unwrap();
        let json = tmp.path().join("out.json");
        drive(
            &argv(&[
                "run",
                "/x/synthetic",
                "--no-assert",
                "--json",
                &json.display().to_string(),
            ]),
            &over_budget,
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
        assert_eq!(v["passed"].as_bool(), Some(false));
    }

    #[test]
    fn json_records_the_violation_message() {
        let tmp = tempfile::tempdir().unwrap();
        let json = tmp.path().join("out.json");
        drive(
            &argv(&["run", "/x/synthetic", "--json", &json.display().to_string()]),
            &over_budget,
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
        assert_eq!(
            v["results"][0]["violations"][0].as_str(),
            Some("synthetic: openToFirstPageMs 3412 exceeds 3000")
        );
    }

    #[test]
    fn summary_is_appended_to_existing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let summary = tmp.path().join("summary.md");
        std::fs::write(&summary, "earlier step\n").unwrap();
        drive(
            &argv(&[
                "run",
                "/x/synthetic",
                "--summary",
                &summary.display().to_string(),
            ]),
            &fine,
        );
        let text = std::fs::read_to_string(&summary).unwrap();
        assert!(
            text.starts_with("earlier step\n") && text.contains("### Git Real benchmarks"),
            "got {text:?}"
        );
    }

    #[test]
    fn unwritable_json_path_exits_3_after_table() {
        let tmp = tempfile::tempdir().unwrap();
        let json = tmp.path().join("missing-dir").join("out.json");
        let o = drive(
            &argv(&["run", "/x/synthetic", "--json", &json.display().to_string()]),
            &fine,
        );
        assert_eq!(o.code, 3);
        assert!(o.out.contains("budgets:"), "table must be printed first");
    }

    #[test]
    fn unwritable_json_path_is_named_in_the_error() {
        let tmp = tempfile::tempdir().unwrap();
        let json = tmp.path().join("missing-dir").join("out.json");
        let o = drive(
            &argv(&["run", "/x/synthetic", "--json", &json.display().to_string()]),
            &fine,
        );
        assert!(
            o.err
                .starts_with(&format!("error: cannot write {}: ", json.display())),
            "stderr was {:?}",
            o.err
        );
    }

    #[test]
    fn unwritable_summary_path_exits_3() {
        let tmp = tempfile::tempdir().unwrap();
        let summary = tmp.path().join("missing-dir").join("s.md");
        let o = drive(
            &argv(&[
                "run",
                "/x/synthetic",
                "--summary",
                &summary.display().to_string(),
            ]),
            &fine,
        );
        assert_eq!(o.code, 3);
    }

    // prepare is dispatched to fixtures.
    #[test]
    fn prepare_synthetic_exits_0_and_reports_ready() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx").display().to_string();
        let o = drive(
            &argv(&[
                "prepare",
                "synthetic",
                &dir,
                "--commits",
                "30",
                "--files",
                "5",
            ]),
            &fine,
        );
        assert_eq!((o.code, o.out), (0, format!("fixture ready: {dir}\n")));
    }

    #[test]
    fn prepare_synthetic_twice_reports_cached() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx").display().to_string();
        let args = argv(&[
            "prepare",
            "synthetic",
            &dir,
            "--commits",
            "30",
            "--files",
            "5",
        ]);
        drive(&args, &fine);
        let o = drive(&args, &fine);
        assert_eq!(o.out, format!("fixture ready: {dir} (cached)\n"));
    }

    #[test]
    fn prepare_on_a_foreign_directory_exits_3_with_error_prefix() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mine");
        std::fs::create_dir(&dir).unwrap();
        let d = dir.display().to_string();
        let o = drive(&argv(&["prepare", "synthetic", &d]), &fine);
        assert_eq!(o.code, 3);
        assert!(
            o.err.starts_with(&format!(
                "error: {d} exists but is not a matching fixture; "
            )),
            "stderr was {:?}",
            o.err
        );
    }
}
