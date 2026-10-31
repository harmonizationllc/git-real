//! The streamed commit graph (GR-27): a background builder publishes sealed
//! chunks of a provisional walk, then the final topological order.
//!
//! Tests that must observe a provisional state retry on a fresh session when
//! the build finished before they could look, so none depends on timing.

mod common;

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use git_real_core::{GitError, GraphEdge, LogSummary, RepoSession};
use git2::{Oid, Repository};

/// Attempts at catching a provisional state before giving up.
const ATTEMPTS: usize = 50;

fn open(path: &Path) -> RepoSession {
    RepoSession::open(path).expect("open session")
}

fn e(top: Option<u32>, bottom: Option<u32>) -> GraphEdge {
    GraphEdge { top, bottom }
}

fn head_target(path: &Path) -> Option<Oid> {
    Repository::open(path).ok()?.head().ok()?.target()
}

/// `n` linear commits on HEAD, the i-th (0-based, oldest first) committed at
/// `FIXTURE_TIME + time_of(i)`. Returns their oids, oldest first.
fn chain_with(path: &Path, n: usize, time_of: impl Fn(usize) -> i64) -> Vec<Oid> {
    let mut parent = head_target(path);
    let mut oids = Vec::with_capacity(n);
    for i in 0..n {
        let at = common::signature_at(time_of(i));
        let parents: Vec<Oid> = parent.into_iter().collect();
        let oid = common::commit_tree_at(
            path,
            Some("HEAD"),
            &[("f.txt", "x\n")],
            &format!("commit {i}"),
            &parents,
            &at,
            &at,
        );
        oids.push(oid);
        parent = Some(oid);
    }
    oids
}

/// `n` linear commits on HEAD one second apart from `start_time`.
fn chain(path: &Path, n: usize, start_time: i64) -> Vec<Oid> {
    chain_with(path, n, |i| start_time + i as i64)
}

fn repo_with_chain(n: usize) -> (tempfile::TempDir, std::path::PathBuf, Vec<Oid>) {
    let (dir, path) = common::temp_repo_unborn();
    let oids = chain(&path, n, 0);
    (dir, path, oids)
}

fn zero(s: &mut RepoSession) -> LogSummary {
    s.log_summary_within(Duration::ZERO).expect("summary")
}

/// Opens fresh sessions on `path` and polls each until `probe` returns a
/// value for an incomplete summary; a session whose build completes first is
/// discarded and the next attempt starts a new build.
fn catch_incomplete<T>(
    path: &Path,
    mut probe: impl FnMut(&mut RepoSession, &LogSummary) -> Option<T>,
) -> (RepoSession, T) {
    for _ in 0..ATTEMPTS {
        let mut s = open(path);
        loop {
            let summary = zero(&mut s);
            if summary.complete {
                break;
            }
            if let Some(found) = probe(&mut s, &summary) {
                return (s, found);
            }
        }
    }
    panic!("no provisional state observed in {ATTEMPTS} builds");
}

fn page_oids(s: &RepoSession, g: u64, total: u32) -> Vec<String> {
    let mut oids = Vec::new();
    let mut start = 0;
    while start < total {
        let page = s.log_page(g, start, 1000).unwrap();
        start += page.rows.len() as u32;
        oids.extend(page.rows.into_iter().map(|r| r.oid));
    }
    oids
}

#[test]
fn should_answer_complete_within_the_window_on_a_small_repo() {
    let (_d, path, _oids) = repo_with_chain(20);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    assert_eq!(
        (summary.complete, summary.refreshing, summary.total),
        (true, false, 20)
    );
}

#[test]
fn should_report_zero_rows_complete_when_head_is_unborn() {
    let (_d, path) = common::temp_repo_unborn();
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    assert_eq!((summary.total, summary.complete), (0, true));
}

#[test]
fn should_stream_sealed_chunks_before_the_build_completes() {
    let (_d, path, _oids) = repo_with_chain(1200);
    for _ in 0..ATTEMPTS {
        let mut s = open(&path);
        let mut recorded = vec![zero(&mut s)];
        if recorded[0].complete {
            continue;
        }
        while !recorded.last().unwrap().complete {
            recorded.push(zero(&mut s));
        }
        let first = recorded[0].clone();
        let done = recorded.last().unwrap().clone();
        for pair in recorded.windows(2) {
            assert!(pair[1].total >= pair[0].total, "{recorded:?}");
        }
        for incomplete in &recorded[..recorded.len() - 1] {
            assert_eq!(incomplete.total % 500, 0, "{recorded:?}");
            assert_eq!(incomplete.generation, first.generation);
        }
        assert_eq!(
            (done.total, done.generation, done.refreshing),
            (1200, first.generation + 1, false)
        );
        return;
    }
    panic!("the first summary was complete in every attempt");
}

#[test]
fn should_land_as_one_generation_when_provisional_was_never_observed() {
    let (_d, path, _oids) = repo_with_chain(1200);
    let mut s = open(&path);
    let summary = s.log_summary_complete().unwrap();
    assert_eq!(
        summary,
        LogSummary {
            generation: 1,
            total: 1200,
            max_lanes: 1,
            complete: true,
            refreshing: false
        }
    );
}

#[test]
fn should_serve_a_full_page_from_an_incomplete_generation() {
    let (_d, path, oids) = repo_with_chain(1200);
    let tip = oids.last().unwrap().to_string();
    let (_s, rows) = catch_incomplete(&path, |s, summary| {
        if summary.total < 500 {
            return None;
        }
        // The final state may land between the two calls: then try again.
        s.log_page(summary.generation, 0, 500).ok().map(|p| p.rows)
    });
    assert_eq!((rows.len(), rows[0].oid.as_str()), (500, tip.as_str()));
}

#[test]
fn should_reject_a_page_beyond_the_sealed_rows_with_an_empty_page() {
    let (_d, path, _oids) = repo_with_chain(1200);
    let (_s, rows) = catch_incomplete(&path, |s, summary| {
        if summary.total < 500 {
            return None;
        }
        let page = s.log_page(summary.generation, summary.total, 10).ok()?;
        // Only meaningful when nothing was sealed or finished in between.
        let after = zero(s);
        (after.generation == summary.generation && !after.complete && after.total == summary.total)
            .then_some(page.rows)
    });
    assert!(rows.is_empty());
}

#[test]
fn should_final_order_put_child_before_parent_when_dates_are_skewed() {
    let (_d, path) = common::temp_repo_unborn();
    let oids = chain_with(&path, 3, |i| [0, 100, 50][i]);
    let (r, a, b) = (oids[0], oids[1], oids[2]);
    let mut s = open(&path);
    let summary = s.log_summary_complete().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    let got: Vec<&str> = rows.iter().map(|r| r.oid.as_str()).collect();
    assert_eq!(
        got,
        [b.to_string(), a.to_string(), r.to_string()]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        (rows[1].lane, rows[1].edges.clone()),
        (0, vec![e(None, Some(0)), e(Some(0), None)])
    );
}

/// The parent of a skewed commit is also a branch tip, so the time-ordered
/// walk reaches it (and emits it) before the child.
#[test]
fn should_draw_no_edge_to_an_already_emitted_parent_in_the_provisional_layout() {
    let (_d, path) = common::temp_repo_unborn();
    // Commit 599 (600th from the tip) is dated 100 s older than its parent 598.
    let oids = chain_with(&path, 1200, |i| if i == 599 { 498 } else { i as i64 });
    let (parent, child) = (oids[598], oids[599]);
    Repository::open(&path)
        .unwrap()
        .reference("refs/heads/side", parent, false, "side")
        .unwrap();
    let (mut s, rows) = catch_incomplete(&path, |s, summary| {
        if summary.total < 1000 {
            return None;
        }
        let g = summary.generation;
        let mut rows = s.log_page(g, 0, 500).ok()?.rows;
        rows.extend(s.log_page(g, 500, 500).ok()?.rows);
        Some(rows)
    });
    let c = rows
        .iter()
        .position(|r| r.oid == child.to_string())
        .unwrap();
    let p = rows
        .iter()
        .position(|r| r.oid == parent.to_string())
        .unwrap();
    assert!(p < c, "parent {p} must come before child {c}");
    assert_eq!(rows[c].parents, vec![parent.to_string()]);
    assert!(
        rows[c].edges.iter().all(|edge| edge.top.is_some()),
        "no line may leave the child's dot: {:?}",
        rows[c].edges
    );

    let done = s.log_summary_complete().unwrap();
    let order = page_oids(&s, done.generation, done.total);
    let c = order.iter().position(|o| *o == child.to_string()).unwrap();
    assert_eq!(order[c + 1], parent.to_string());
}

#[test]
fn should_restart_streaming_when_refs_change_during_the_first_build() {
    let (_d, path, _oids) = repo_with_chain(1200);
    let mut s = open(&path);
    zero(&mut s);
    let newest = chain(&path, 1, 5000)[0];
    let done = loop {
        let summary = zero(&mut s);
        if summary.complete && !summary.refreshing {
            break summary;
        }
    };
    let rows = s.log_page(done.generation, 0, 1).unwrap().rows;
    assert_eq!(
        (done.total, rows[0].oid.clone()),
        (1201, newest.to_string())
    );
}

#[test]
fn should_keep_serving_the_complete_generation_while_a_rebuild_runs() {
    let (_d, path, _oids) = repo_with_chain(1200);
    for attempt in 0..ATTEMPTS {
        let mut s = open(&path);
        let g1 = s.log_summary_complete().unwrap();
        chain(&path, 1, 5000 + attempt as i64);
        let during = zero(&mut s);
        // The rebuild finishing before these two reads makes the attempt void.
        let Ok(page) = s.log_page(g1.generation, 0, 1) else {
            continue;
        };
        if !during.refreshing {
            continue;
        }
        assert_eq!(
            (during.generation, during.complete, during.total),
            (g1.generation, true, g1.total)
        );
        assert_eq!(page.rows.len(), 1);
        let after = s.log_summary_complete().unwrap();
        assert_eq!(
            (after.generation, after.total, after.refreshing),
            (g1.generation + 1, g1.total + 1, false)
        );
        return;
    }
    panic!("the rebuild always finished before it could be observed");
}

#[test]
fn should_join_the_builder_when_the_session_is_dropped_mid_build() {
    let (dir, path, _oids) = repo_with_chain(1200);
    let mut s = open(&path);
    zero(&mut s);
    drop(s);
    dir.close().expect("temp dir removed");
}

#[test]
fn should_return_a_build_error_once_and_retry() {
    let (_d, path) = common::temp_repo_unborn();
    let oids = chain(&path, 2, 0);
    let hex = oids[0].to_string();
    std::fs::remove_file(path.join(".git/objects").join(&hex[..2]).join(&hex[2..]))
        .expect("delete the root commit's object");
    let mut s = open(&path);
    let first = s.log_summary_complete();
    let second = s.log_summary_complete();
    assert!(
        matches!(first, Err(GitError::Git2(_))) && matches!(second, Err(GitError::Git2(_))),
        "first={first:?} second={second:?}"
    );
}

#[test]
fn should_list_every_reachable_commit_once_from_several_tips() {
    let (_d, path, _r, a, _b, _m) = common::merge_fixture();
    let at = common::signature_at(40);
    let side = common::commit_tree_at(
        &path,
        Some("refs/heads/side"),
        &[("s.txt", "s\n")],
        "on side",
        &[a],
        &at,
        &at,
    );
    common::tag_lightweight(&path, "v-side", side);
    let mut s = open(&path);
    let done = s.log_summary_complete().unwrap();
    let oids = page_oids(&s, done.generation, done.total);
    let unique: HashSet<&String> = oids.iter().collect();
    assert_eq!((done.total, oids.len(), unique.len()), (5, 5, 5));
}

#[test]
fn should_place_tips_from_tags_remotes_and_head_in_the_tips_list() {
    let (_d, path) = common::temp_repo_unborn();
    let base = chain(&path, 2, 0);
    let at = common::signature_at(10);
    let only_tagged = |message: &str| {
        common::commit_tree_at(
            &path,
            None,
            &[("t.txt", message)],
            message,
            &[base[1]],
            &at,
            &at,
        )
    };
    let mut s = open(&path);
    assert_eq!(s.log_summary_complete().unwrap().total, 2);

    common::tag_lightweight(&path, "light", only_tagged("light"));
    assert_eq!(s.log_summary_complete().unwrap().total, 3);

    common::tag_annotated(&path, "annotated", only_tagged("annotated"));
    assert_eq!(s.log_summary_complete().unwrap().total, 4);

    let (_sd, source) = common::temp_repo_with_commit();
    let (_bd, bare) = common::temp_bare_clone(&source);
    Repository::open(&path)
        .unwrap()
        .remote("origin", bare.to_str().unwrap())
        .unwrap();
    common::fetch_remote(&path, "origin");
    assert_eq!(s.log_summary_complete().unwrap().total, 5);
}
