//! Test-only helpers shared by the unit tests of every module.

use std::path::{Path, PathBuf};

use crate::fixtures::{self, FixtureSpec};
use crate::measure::Measurement;

/// Opt-out for machines without git, shared with git-real-core's tests.
pub const SKIP_GIT_TESTS_ENV: &str = "GIT_REAL_SKIP_GIT_TESTS";

/// True when git is on PATH; panics without git unless the opt-out is set.
pub fn git_available() -> bool {
    git_available_with(
        git_real_core::git_cli::locate().is_ok(),
        std::env::var(SKIP_GIT_TESTS_ENV).ok().as_deref(),
    )
}

pub fn git_available_with(found: bool, opt_out: Option<&str>) -> bool {
    if found {
        return true;
    }
    if opt_out == Some("1") {
        eprintln!("skipping: git not on PATH ({SKIP_GIT_TESTS_ENV}=1)");
        return false;
    }
    panic!("git not on PATH: install git, or set {SKIP_GIT_TESTS_ENV}=1 to skip the git CLI tests");
}

/// A within-budget measurement with every field present:
/// 100000 commits, 10000 files, 461 ms open to first page, 47 ms status, 0 MB growth.
pub fn sample_measurement(label: &str) -> Measurement {
    Measurement {
        label: label.to_string(),
        path: PathBuf::from(format!("/bench/{label}")),
        commits: 100_000,
        files: Some(10_000),
        max_lanes: 2,
        open_ms: 0,
        graph_build_ms: 460,
        first_page_ms: 0,
        open_to_first_page_ms: 461,
        page_all_ms: 20,
        rss_before_paging_mb: Some(168),
        rss_after_paging_mb: Some(168),
        rss_growth_mb: Some(0),
        status_ms: Some(47),
        status_entries: Some(200),
        graph_refresh_ms: 7,
        violations: vec![],
    }
}

/// Builds a bare repository at `path` with `commits` linear commits on `main`
/// (file `a.txt`, one commit a minute from 1600000000) and returns its `file://`
/// URL plus the commit ids oldest first.
pub fn make_source_repo(path: &Path, commits: usize) -> (String, Vec<git2::Oid>) {
    let repo = git2::Repository::init_bare(path).unwrap();
    repo.set_head("refs/heads/main").unwrap();
    let mut oids = Vec::new();
    let mut parent: Option<git2::Commit> = None;
    for i in 0..commits {
        let blob = repo.blob(format!("v{i}\n").as_bytes()).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("a.txt", blob, 0o100644).unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let time = git2::Time::new(1_600_000_000 + 60 * i as i64, 0);
        let sig = git2::Signature::new("Src", "src@example.com", &time).unwrap();
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        let oid = repo
            .commit(
                Some("refs/heads/main"),
                &sig,
                &sig,
                &format!("c{i}"),
                &tree,
                &parents,
            )
            .unwrap();
        parent = Some(repo.find_commit(oid).unwrap());
        oids.push(oid);
    }
    (format!("file://{}", path.display()), oids)
}

/// Prepares a synthetic fixture named `name` under `parent` and returns its path.
pub fn build_synthetic(parent: &Path, name: &str, commits: u32, files: u32) -> PathBuf {
    let dir = parent.join(name);
    let spec = FixtureSpec::Synthetic { commits, files };
    fixtures::prepare(&dir, &spec, &mut Vec::new()).expect("prepare synthetic");
    dir
}

/// Prepares a bare `public-graph` fixture from a fresh local source with `source_commits`.
pub fn build_bare_graph(parent: &Path, name: &str, source_commits: usize) -> PathBuf {
    let (url, _) = make_source_repo(&parent.join(format!("{name}-source.git")), source_commits);
    let dir = parent.join(name);
    let spec = FixtureSpec::PublicGraph {
        url,
        commits: source_commits as u32,
    };
    fixtures::prepare(&dir, &spec, &mut Vec::new()).expect("prepare public-graph");
    dir
}
