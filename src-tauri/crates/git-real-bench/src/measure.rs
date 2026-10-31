//! One cold measurement of a repository, in the spec's order (§3.4).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use git_real_core::RepoSession;
use serde::Serialize;

use crate::git::BenchError;
use crate::rss;

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
    pub first_summary_ms: u128,
    pub first_page_ms: u128,
    pub open_to_first_page_ms: u128,
    pub graph_complete_ms: u128,
    pub rss_after_build_mb: Option<u64>,
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
    let span = Instant::now();

    let started = Instant::now();
    let mut session = RepoSession::open(path)
        .map_err(|e| BenchError::new(format!("cannot open {}: {e}", path.display())))?;
    let open_ms = elapsed_ms(started);

    // The first summary with rows (or a complete empty graph), as the
    // front end's poll would see it.
    let started = Instant::now();
    let first = loop {
        let summary = session.log_summary().map_err(bench_error)?;
        if summary.total > 0 || summary.complete {
            break summary;
        }
        std::thread::sleep(Duration::from_millis(SUMMARY_POLL_MS));
    };
    let first_summary_ms = elapsed_ms(started);

    let started = Instant::now();
    serialized_page(&session, first.generation, 0)?;
    let first_page_ms = elapsed_ms(started);
    let open_to_first_page_ms = elapsed_ms(span);

    let summary = session.log_summary_complete().map_err(bench_error)?;
    let graph_complete_ms = elapsed_ms(span);
    let rss_after_build_mb = rss::current_rss_mb();

    let rss_before_paging_mb = rss::current_rss_mb();
    let started = Instant::now();
    let mut start = 0;
    while start < summary.total {
        serialized_page(&session, summary.generation, start)?;
        start += PAGE_SIZE;
    }
    let page_all_ms = elapsed_ms(started);
    let rss_after_paging_mb = rss::current_rss_mb();
    let rss_growth_mb = rss_after_paging_mb
        .zip(rss_before_paging_mb)
        .map(|(after, before)| after.saturating_sub(before));

    let (status_ms, status_entries, files) = if session.summary().is_bare {
        (None, None, None)
    } else {
        let started = Instant::now();
        let status = session.status().map_err(bench_error)?;
        let status_ms = elapsed_ms(started);
        let files = git2::Repository::open(path)
            .and_then(|repo| repo.index())
            .map_err(bench_error)?
            .len();
        (Some(status_ms), Some(status.entries.len()), Some(files))
    };

    let started = Instant::now();
    session.log_summary().map_err(bench_error)?;
    let graph_refresh_ms = elapsed_ms(started);

    Ok(Measurement {
        label: label.to_string(),
        path: path.to_path_buf(),
        commits: summary.total,
        files,
        max_lanes: summary.max_lanes,
        open_ms,
        first_summary_ms,
        first_page_ms,
        open_to_first_page_ms,
        graph_complete_ms,
        rss_after_build_mb,
        page_all_ms,
        rss_before_paging_mb,
        rss_after_paging_mb,
        rss_growth_mb,
        status_ms,
        status_entries,
        graph_refresh_ms,
        violations: Vec::new(),
    })
}

/// Milliseconds between `log_summary` polls while waiting for the first rows.
const SUMMARY_POLL_MS: u64 = 5;

/// Rows per `log_page` call, the graph panel's page size.
const PAGE_SIZE: u32 = 500;

/// One page fetched and serialized to JSON, as the IPC layer would send it.
fn serialized_page(session: &RepoSession, generation: u64, start: u32) -> Result<(), BenchError> {
    let page = session
        .log_page(generation, start, PAGE_SIZE)
        .map_err(bench_error)?;
    serde_json::to_vec(&page).map_err(bench_error)?;
    Ok(())
}

fn elapsed_ms(since: Instant) -> u128 {
    since.elapsed().as_millis()
}

fn bench_error(e: impl std::fmt::Display) -> BenchError {
    BenchError::new(e.to_string())
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
    fn graph_complete_is_at_least_open_to_first_page() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        assert!(m.graph_complete_ms >= m.open_to_first_page_ms);
    }

    #[test]
    fn rss_after_build_is_present_on_linux() {
        if !git_available() || rss::current_rss_mb().is_none() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        assert!(measure(&dir, "s").unwrap().rss_after_build_mb.is_some());
    }

    #[test]
    fn first_summary_is_before_first_page() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = build_synthetic(tmp.path(), "s", 40, 8);
        let m = measure(&dir, "s").unwrap();
        assert!(m.first_summary_ms <= m.open_to_first_page_ms);
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
        assert!(m.graph_refresh_ms <= m.graph_complete_ms.max(1_000));
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
