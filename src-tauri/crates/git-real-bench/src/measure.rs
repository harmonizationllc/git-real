//! One cold measurement of a repository, in the spec's order (§3.4).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::BenchError;

/// Everything measured for one repository. Serializes camelCase; `None` is `null`.
/// Durations are whole milliseconds. `violations` holds the rendered
/// `<label>: <metric> <value> exceeds <budget>` messages (filled by the caller
/// from `budgets::evaluate`; `measure` leaves it empty).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub label: String,
    pub path: PathBuf,
    pub commits: u32,
    pub files: Option<usize>,
    pub max_lanes: u32,
    pub open_ms: u128,
    pub graph_build_ms: u128,
    pub first_page_ms: u128,
    pub open_to_first_page_ms: u128,
    pub page_all_ms: u128,
    pub rss_before_paging_mb: Option<u64>,
    pub rss_after_paging_mb: Option<u64>,
    pub rss_growth_mb: Option<u64>,
    pub status_ms: Option<u128>,
    pub status_entries: Option<usize>,
    pub graph_refresh_ms: u128,
    pub violations: Vec<String>,
}

/// Measures `path`; failure to open is `cannot open <path>: <err>`.
pub fn measure(path: &Path, label: &str) -> Result<Measurement, BenchError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{build_bare_graph, build_synthetic, git_available};

    // A worktree fixture: every field is measured and consistent with the fixture.
    #[test]
    fn measures_every_field_on_a_worktree_fixture() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "bench-synthetic", 40, 8);
        let m = measure(&dir, "bench-synthetic").unwrap();
        assert_eq!(
            (m.label.as_str(), m.commits, m.files),
            ("bench-synthetic", 40, Some(8))
        );
    }

    #[test]
    fn status_entries_count_modified_and_untracked_files() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        // min(100, 8) modified files + 100 untracked files
        assert_eq!(m.status_entries, Some(108));
    }

    #[test]
    fn status_time_is_present_on_a_worktree_fixture() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        assert!(measure(&dir, "s").unwrap().status_ms.is_some());
    }

    #[test]
    fn open_to_first_page_is_one_span_covering_the_graph_build() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        assert!(m.open_to_first_page_ms >= m.graph_build_ms);
    }

    #[test]
    fn max_lanes_is_at_least_one() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        assert!(measure(&dir, "s").unwrap().max_lanes >= 1);
    }

    #[test]
    fn violations_start_empty() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        assert!(measure(&dir, "s").unwrap().violations.is_empty());
    }

    // A bare fixture has no working tree: status and files are unavailable.
    #[test]
    fn bare_fixture_has_null_status_files_and_entries() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_bare_graph(tmp.path(), "g", 12);
        let m = measure(&dir, "g").unwrap();
        assert_eq!((m.status_ms, m.status_entries, m.files), (None, None, None));
    }

    #[test]
    fn bare_fixture_still_counts_commits() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_bare_graph(tmp.path(), "g", 12);
        assert_eq!(measure(&dir, "g").unwrap().commits, 12);
    }

    // The second log_summary (cache hit) is measured after the build.
    #[test]
    fn graph_refresh_is_measured_after_build() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        assert!(m.graph_refresh_ms <= m.graph_build_ms.max(1_000));
    }

    // RSS bookkeeping.
    #[test]
    fn rss_growth_is_never_negative() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        let expected = m
            .rss_after_paging_mb
            .zip(m.rss_before_paging_mb)
            .map(|(after, before)| after.saturating_sub(before));
        assert_eq!(m.rss_growth_mb, expected);
    }

    // Errors: a path that is not a repository.
    #[test]
    fn cannot_open_error_names_the_path() {
        let tmp = tempfile::tempdir().unwrap();
        let err = measure(tmp.path(), "nope").unwrap_err().to_string();
        assert!(
            err.starts_with(&format!("cannot open {}: ", tmp.path().display())),
            "got {err:?}"
        );
    }

    #[test]
    fn missing_path_is_a_cannot_open_error() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("absent");
        let err = measure(&missing, "absent").unwrap_err().to_string();
        assert!(err.starts_with("cannot open "), "got {err:?}");
    }
}
