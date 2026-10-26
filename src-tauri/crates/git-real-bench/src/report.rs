//! The stdout table, the Markdown job summary and the JSON record (§3.6).

use serde::Serialize;

use crate::budgets;
use crate::measure::Measurement;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    /// `std::env::consts::OS`.
    pub os: String,
    /// `available_parallelism()`, `1` on error.
    pub cpus: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budgets {
    pub open_to_first_page_ms: u128,
    pub status_ms: u128,
    pub paging_rss_growth_mb: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Always `1`.
    pub version: u32,
    pub host: Host,
    pub budgets: Budgets,
    pub results: Vec<Measurement>,
    /// True when no result has a violation; independent of `--no-assert`.
    pub passed: bool,
}

pub const REPORT_VERSION: u32 = 1;

const HEADER: [&str; 6] = [
    "fixture",
    "commits",
    "files",
    "open→first page",
    "status",
    "paging RSS growth",
];

/// Minimum column widths of the stdout table (spec §3.6); a longer cell widens its column.
const MIN_WIDTHS: [usize; 6] = [15, 7, 8, 16, 9, 17];

impl Host {
    fn current() -> Host {
        Host {
            os: std::env::consts::OS.to_string(),
            cpus: std::thread::available_parallelism().map_or(1, usize::from),
        }
    }
}

impl Budgets {
    const CURRENT: Budgets = Budgets {
        open_to_first_page_ms: budgets::OPEN_TO_FIRST_PAGE_MS,
        status_ms: budgets::STATUS_MS,
        paging_rss_growth_mb: budgets::PAGING_RSS_GROWTH_MB,
    };

    fn line(&self) -> String {
        format!(
            "budgets: open→first page {} ms, status {} ms, paging RSS growth {} MB",
            self.open_to_first_page_ms, self.status_ms, self.paging_rss_growth_mb
        )
    }
}

impl Report {
    /// Builds the report: host from the environment, the budget constants, and
    /// `passed` from the results' `violations`.
    pub fn new(results: Vec<Measurement>) -> Report {
        let passed = results.iter().all(|m| m.violations.is_empty());
        Report {
            version: REPORT_VERSION,
            host: Host::current(),
            budgets: Budgets::CURRENT,
            results,
            passed,
        }
    }

    /// The `--json` document.
    pub fn to_json(&self) -> String {
        let mut json = serde_json::to_string_pretty(self).expect("a report always serializes");
        json.push('\n');
        json
    }

    /// The stdout text: header, one row per result, the `budgets:` line, then the
    /// trailer (`PASS`; `FAIL` plus one line per violation; `INFO` under `no_assert`).
    pub fn text_table(&self, no_assert: bool) -> String {
        let header = HEADER.map(String::from);
        let rows: Vec<[String; 6]> = self.results.iter().map(cells).collect();
        let mut widths = MIN_WIDTHS;
        for row in std::iter::once(&header).chain(&rows) {
            for (width, cell) in widths.iter_mut().zip(row) {
                *width = (*width).max(cell.chars().count());
            }
        }
        let mut text = String::new();
        for row in std::iter::once(&header).chain(&rows) {
            text.push_str(&table_line(row, &widths));
        }
        text.push_str(&self.budgets.line());
        text.push('\n');
        if no_assert {
            text.push_str("INFO\n");
        } else if self.passed {
            text.push_str("PASS\n");
        } else {
            text.push_str("FAIL\n");
            for violation in self.results.iter().flat_map(|m| &m.violations) {
                text.push_str(violation);
                text.push('\n');
            }
        }
        text
    }

    /// The `--summary` block: `### Git Real benchmarks`, a Markdown table with a
    /// `result` column (`pass` / `fail`; `info` for a violating row under `no_assert`).
    pub fn markdown(&self, no_assert: bool) -> String {
        let mut md = String::from("### Git Real benchmarks\n\n");
        md.push_str(&format!("| {} | result |\n", HEADER.join(" | ")));
        md.push_str("| --- | ---: | ---: | ---: | ---: | ---: | --- |\n");
        for m in &self.results {
            let result = match (m.violations.is_empty(), no_assert) {
                (true, _) => "pass",
                (false, true) => "info",
                (false, false) => "fail",
            };
            md.push_str(&format!("| {} | {result} |\n", cells(m).join(" | ")));
        }
        md.push('\n');
        md.push_str(&self.budgets.line());
        md.push('\n');
        md
    }
}

/// One table row: label, commits, files, open→first page, status, RSS growth;
/// `-` for an unavailable value.
fn cells(m: &Measurement) -> [String; 6] {
    [
        m.label.clone(),
        m.commits.to_string(),
        or_dash(m.files, |n| n.to_string()),
        format!("{} ms", m.open_to_first_page_ms),
        or_dash(m.status_ms, |n| format!("{n} ms")),
        or_dash(m.rss_growth_mb, |n| format!("{n} MB")),
    ]
}

fn or_dash<T>(value: Option<T>, show: impl Fn(T) -> String) -> String {
    value.map_or_else(|| "-".to_string(), show)
}

/// The label left-aligned, every other cell right-aligned; header and rows share it.
fn table_line(cells: &[String; 6], widths: &[usize; 6]) -> String {
    let [label, rest @ ..] = cells;
    let mut line = format!("{label:<width$}", width = widths[0]);
    for (cell, width) in rest.iter().zip(&widths[1..]) {
        line.push_str(&format!(" {cell:>width$}"));
    }
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::sample_measurement;

    fn two_rows() -> Report {
        let synthetic = sample_measurement("synthetic");
        let mut qemu = sample_measurement("qemu-graph");
        qemu.commits = 99_912;
        qemu.files = None;
        qemu.status_ms = None;
        qemu.status_entries = None;
        qemu.open_to_first_page_ms = 1_204;
        qemu.rss_growth_mb = Some(1);
        Report::new(vec![synthetic, qemu])
    }

    fn failing() -> Report {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 3_412;
        m.violations = vec!["synthetic: openToFirstPageMs 3412 exceeds 3000".to_string()];
        Report::new(vec![m])
    }

    fn json(report: &Report) -> serde_json::Value {
        serde_json::from_str(&report.to_json()).expect("valid json")
    }

    /// Char offset just past the `n`th (0-based) whitespace-separated token.
    fn token_end(line: &str, n: usize) -> usize {
        let mut seen = 0;
        let mut in_token = false;
        for (i, c) in line.chars().enumerate() {
            if c.is_whitespace() {
                if in_token {
                    if seen == n {
                        return i;
                    }
                    seen += 1;
                    in_token = false;
                }
            } else {
                in_token = true;
            }
        }
        line.chars().count()
    }

    // Report::new
    #[test]
    fn new_is_passed_without_violations() {
        assert!(two_rows().passed);
    }

    #[test]
    fn new_is_not_passed_with_a_violation() {
        assert!(!failing().passed);
    }

    // JSON record
    #[test]
    fn json_has_version_budgets_results_and_passed() {
        let v = json(&two_rows());
        assert_eq!(
            (
                v["version"].as_u64(),
                v["budgets"]["openToFirstPageMs"].as_u64(),
                v["budgets"]["statusMs"].as_u64(),
                v["budgets"]["pagingRssGrowthMb"].as_u64(),
                v["results"].as_array().map(Vec::len),
                v["passed"].as_bool(),
            ),
            (
                Some(1),
                Some(3000),
                Some(500),
                Some(64),
                Some(2),
                Some(true)
            )
        );
    }

    #[test]
    fn json_host_names_the_os_and_cpu_count() {
        let v = json(&two_rows());
        assert_eq!(
            (
                v["host"]["os"].as_str(),
                v["host"]["cpus"].as_u64().map(|c| c >= 1)
            ),
            (Some(std::env::consts::OS), Some(true))
        );
    }

    #[test]
    fn json_result_keys_are_exactly_the_camel_case_set() {
        let v = json(&two_rows());
        let mut keys: Vec<&str> = v["results"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = vec![
            "label",
            "path",
            "commits",
            "files",
            "maxLanes",
            "openMs",
            "graphBuildMs",
            "firstPageMs",
            "openToFirstPageMs",
            "pageAllMs",
            "rssBeforePagingMb",
            "rssAfterPagingMb",
            "rssGrowthMb",
            "statusMs",
            "statusEntries",
            "graphRefreshMs",
            "violations",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
    }

    #[test]
    fn json_result_values_round_trip() {
        let v = json(&two_rows());
        assert_eq!(
            (
                v["results"][0]["label"].as_str(),
                v["results"][0]["commits"].as_u64(),
                v["results"][0]["files"].as_u64(),
                v["results"][0]["openToFirstPageMs"].as_u64(),
                v["results"][0]["statusMs"].as_u64(),
            ),
            (
                Some("synthetic"),
                Some(100_000),
                Some(10_000),
                Some(461),
                Some(47)
            )
        );
    }

    #[test]
    fn json_uses_null_for_unavailable_values() {
        let v = json(&two_rows());
        let row = &v["results"][1];
        let nulls = ["files", "statusMs", "statusEntries"]
            .iter()
            .all(|k| row.get(*k) == Some(&serde_json::Value::Null));
        assert!(nulls, "row was {row}");
    }

    #[test]
    fn json_uses_null_for_unavailable_rss() {
        let mut m = sample_measurement("x");
        m.rss_before_paging_mb = None;
        m.rss_after_paging_mb = None;
        m.rss_growth_mb = None;
        let v = json(&Report::new(vec![m]));
        let row = &v["results"][0];
        let nulls = ["rssBeforePagingMb", "rssAfterPagingMb", "rssGrowthMb"]
            .iter()
            .all(|k| row.get(*k) == Some(&serde_json::Value::Null));
        assert!(nulls, "row was {row}");
    }

    #[test]
    fn json_carries_violation_messages() {
        let v = json(&failing());
        assert_eq!(
            v["results"][0]["violations"][0].as_str(),
            Some("synthetic: openToFirstPageMs 3412 exceeds 3000")
        );
    }

    #[test]
    fn passed_is_false_with_violations_even_under_no_assert() {
        let report = failing();
        let _ = report.text_table(true);
        assert_eq!(json(&report)["passed"].as_bool(), Some(false));
    }

    // Text table
    #[test]
    fn text_header_names_the_columns_in_order() {
        let text = two_rows().text_table(false);
        let header: Vec<&str> = text.lines().next().unwrap().split_whitespace().collect();
        assert_eq!(
            header,
            vec![
                "fixture",
                "commits",
                "files",
                "open→first",
                "page",
                "status",
                "paging",
                "RSS",
                "growth"
            ]
        );
    }

    #[test]
    fn text_table_shows_values_with_units() {
        let text = two_rows().text_table(false);
        let row: Vec<&str> = text.lines().nth(1).unwrap().split_whitespace().collect();
        assert_eq!(
            row,
            vec![
                "synthetic",
                "100000",
                "10000",
                "461",
                "ms",
                "47",
                "ms",
                "0",
                "MB"
            ]
        );
    }

    #[test]
    fn text_table_shows_dash_for_null() {
        let text = two_rows().text_table(false);
        let row: Vec<&str> = text.lines().nth(2).unwrap().split_whitespace().collect();
        assert_eq!(
            row,
            vec!["qemu-graph", "99912", "-", "1204", "ms", "-", "1", "MB"]
        );
    }

    #[test]
    fn text_table_shows_dash_for_unavailable_rss_growth() {
        let mut m = sample_measurement("x");
        m.rss_growth_mb = None;
        let text = Report::new(vec![m]).text_table(false);
        let last_token = text
            .lines()
            .nth(1)
            .unwrap()
            .split_whitespace()
            .last()
            .unwrap();
        assert_eq!(last_token, "-");
    }

    #[test]
    fn text_table_aligns_two_rows() {
        let text = two_rows().text_table(false);
        let lines: Vec<&str> = text.lines().collect();
        // the commits column is right-aligned: its numbers end where the header does
        assert_eq!(
            (token_end(lines[1], 1), token_end(lines[2], 1)),
            (token_end(lines[0], 1), token_end(lines[0], 1))
        );
    }

    #[test]
    fn text_table_aligns_the_files_column() {
        let mut wide = sample_measurement("a-much-longer-label");
        wide.files = Some(7);
        let text = Report::new(vec![sample_measurement("s"), wide]).text_table(false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(token_end(lines[1], 2), token_end(lines[2], 2));
    }

    #[test]
    fn text_budgets_line_is_exact() {
        let text = two_rows().text_table(false);
        assert_eq!(
            text.lines().nth(3),
            Some("budgets: open→first page 3000 ms, status 500 ms, paging RSS growth 64 MB")
        );
    }

    #[test]
    fn text_ends_with_pass() {
        let text = two_rows().text_table(false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!((lines.len(), lines[4]), (5, "PASS"));
    }

    #[test]
    fn text_ends_with_fail_and_violation_lines() {
        let text = failing().text_table(false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            &lines[lines.len() - 2..],
            ["FAIL", "synthetic: openToFirstPageMs 3412 exceeds 3000"]
        );
    }

    #[test]
    fn text_ends_with_info_under_no_assert() {
        let text = failing().text_table(true);
        assert_eq!(text.lines().last(), Some("INFO"));
    }

    #[test]
    fn text_has_no_fail_line_under_no_assert() {
        let text = failing().text_table(true);
        assert!(!text.lines().any(|l| l == "FAIL"));
    }

    #[test]
    fn text_ends_with_info_under_no_assert_even_without_violations() {
        assert_eq!(two_rows().text_table(true).lines().last(), Some("INFO"));
    }

    // Markdown summary
    #[test]
    fn markdown_summary_has_heading_and_result_column() {
        let md = two_rows().markdown(false);
        let mut lines = md.lines();
        assert_eq!(
            (lines.next(), lines.find(|l| l.starts_with('|'))),
            (
                Some("### Git Real benchmarks"),
                Some(
                    "| fixture | commits | files | open→first page | status | paging RSS growth | result |"
                )
            )
        );
    }

    #[test]
    fn markdown_has_a_separator_row() {
        let md = two_rows().markdown(false);
        assert!(md.lines().any(|l| l.starts_with("| ---")), "got {md}");
    }

    #[test]
    fn markdown_row_shows_values_and_pass() {
        let md = two_rows().markdown(false);
        assert!(
            md.lines()
                .any(|l| l == "| synthetic | 100000 | 10000 | 461 ms | 47 ms | 0 MB | pass |"),
            "got {md}"
        );
    }

    #[test]
    fn markdown_row_shows_dash_for_null() {
        let md = two_rows().markdown(false);
        assert!(
            md.lines()
                .any(|l| l == "| qemu-graph | 99912 | - | 1204 ms | - | 1 MB | pass |"),
            "got {md}"
        );
    }

    #[test]
    fn markdown_marks_a_violating_row_fail() {
        let md = failing().markdown(false);
        assert!(md.lines().any(|l| l.ends_with("| fail |")), "got {md}");
    }

    #[test]
    fn markdown_marks_a_violating_row_info_under_no_assert() {
        let md = failing().markdown(true);
        assert!(md.lines().any(|l| l.ends_with("| info |")), "got {md}");
    }

    #[test]
    fn markdown_ends_with_a_newline() {
        assert!(two_rows().markdown(false).ends_with('\n'));
    }
}
