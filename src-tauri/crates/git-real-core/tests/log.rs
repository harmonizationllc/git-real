//! Commit graph reads (GR-8): the cached walk, lane layout on real histories,
//! labels, pages, search, commit detail and reset. Git2 fixtures only; no git
//! CLI is needed.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{GitError, GraphEdge, LogSummary, RefKind, RefLabel, RepoSession, ResetMode};
use git2::{ObjectType, Oid, Repository, Signature};

fn open(path: &Path) -> RepoSession {
    RepoSession::open(path).expect("open session")
}

fn e(top: Option<u32>, bottom: Option<u32>) -> GraphEdge {
    GraphEdge { top, bottom }
}

fn label(kind: RefKind, name: &str, is_head: bool) -> RefLabel {
    RefLabel {
        kind,
        name: name.to_owned(),
        is_head,
    }
}

/// Repo with the initial commit plus `extra` more commits; returns the oids, oldest first.
fn linear(extra: usize) -> (tempfile::TempDir, PathBuf, Vec<Oid>) {
    let (dir, path) = common::temp_repo_with_commit();
    let mut oids = vec![
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    ];
    for i in 0..extra {
        oids.push(common::commit_file(
            &path,
            "file.txt",
            &format!("{i}\n"),
            &format!("commit {i}"),
        ));
    }
    (dir, path, oids)
}

/// Commits on HEAD with a chosen author and committer (a different file each time).
fn commit_as(
    path: &Path,
    file: &str,
    message: &str,
    author: (&str, &str),
    committer: (&str, &str),
) -> Oid {
    let repo = Repository::open(path).unwrap();
    std::fs::write(path.join(file), message).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(file)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let a = Signature::now(author.0, author.1).unwrap();
    let c = Signature::now(committer.0, committer.1).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &a, &c, message, &tree, &parents)
        .unwrap()
}

// --- summary and a single-row page on a fresh repo ---

#[test]
fn should_report_generation_one_and_one_lane_when_the_repo_has_one_commit() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    assert_eq!(
        s.log_summary().unwrap(),
        LogSummary {
            generation: 1,
            total: 1,
            max_lanes: 1,
            complete: true,
            refreshing: false
        }
    );
}

#[test]
fn should_label_the_head_branch_on_the_only_commit_when_the_repo_is_fresh() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let page = s.log_page(g, 0, 10).unwrap();
    assert_eq!(page.rows[0].refs, vec![label(RefKind::Branch, &head, true)]);
}

#[test]
fn should_place_the_only_commit_in_lane_zero_with_no_edges_and_no_parents() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let row = &s.log_page(g, 0, 10).unwrap().rows[0];
    assert_eq!((row.lane, &row.edges, &row.parents), (0, &vec![], &vec![]));
}

#[test]
fn should_expose_subject_author_and_time_when_a_row_is_read() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let row = &s.log_page(g, 0, 10).unwrap().rows[0];
    assert_eq!(
        (
            row.subject.as_str(),
            row.author_name.as_str(),
            row.author_email.as_str()
        ),
        ("initial commit", "Test User", "test@example.com")
    );
}

#[test]
fn should_report_a_positive_author_time_when_a_row_is_read() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(s.log_page(g, 0, 10).unwrap().rows[0].author_time > 0);
}

#[test]
fn should_expose_the_oid_as_forty_hex_characters_when_a_row_is_read() {
    let (_d, path, oids) = linear(0);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(
        s.log_page(g, 0, 10).unwrap().rows[0].oid,
        oids[0].to_string()
    );
}

#[test]
fn should_list_newest_first_and_link_parents_when_history_is_linear() {
    let (_d, path, oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    let got: Vec<(String, Vec<String>)> = rows
        .iter()
        .map(|r| (r.oid.clone(), r.parents.clone()))
        .collect();
    let expected = vec![
        (oids[2].to_string(), vec![oids[1].to_string()]),
        (oids[1].to_string(), vec![oids[0].to_string()]),
        (oids[0].to_string(), vec![]),
    ];
    assert_eq!(got, expected);
}

#[test]
fn should_keep_one_lane_when_history_is_linear() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    assert_eq!(s.log_summary().unwrap().max_lanes, 1);
}

// --- branch and merge fixture: lanes, edges, parents, labels ---

/// Temp dir, path, the (root, a, b, merge) oids, the rows and the summary.
type MergeRows = (
    tempfile::TempDir,
    PathBuf,
    (Oid, Oid, Oid, Oid),
    Vec<git_real_core::GraphRow>,
    LogSummary,
);

fn merge_rows() -> MergeRows {
    let (d, path, r, a, b, m) = common::merge_fixture();
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    (d, path, (r, a, b, m), rows, summary)
}

#[test]
fn should_order_the_merge_fixture_as_merge_then_newer_branch_then_older_then_root() {
    let (_d, _p, (r, a, b, m), rows, _) = merge_rows();
    let got: Vec<String> = rows.iter().map(|x| x.oid.clone()).collect();
    assert_eq!(
        got,
        [m, b, a, r]
            .iter()
            .map(|o| o.to_string())
            .collect::<Vec<_>>()
    );
}

#[test]
fn should_open_a_second_lane_on_the_merge_row() {
    let (_d, _p, _oids, rows, _) = merge_rows();
    assert_eq!(
        (rows[0].lane, rows[0].edges.clone()),
        (0, vec![e(None, Some(0)), e(None, Some(1))])
    );
}

#[test]
fn should_put_the_feature_commit_in_lane_one_with_a_pass_through_for_lane_zero() {
    let (_d, _p, _oids, rows, _) = merge_rows();
    assert_eq!(
        (rows[1].lane, rows[1].edges.clone()),
        (
            1,
            vec![e(None, Some(1)), e(Some(0), Some(0)), e(Some(1), None)]
        )
    );
}

#[test]
fn should_put_the_main_commit_in_lane_zero_with_the_feature_lane_running_past_it() {
    let (_d, _p, _oids, rows, _) = merge_rows();
    assert_eq!(
        (rows[2].lane, rows[2].edges.clone()),
        (
            0,
            vec![e(None, Some(0)), e(Some(0), None), e(Some(1), Some(1))]
        )
    );
}

#[test]
fn should_join_both_lanes_at_the_root_of_the_merge_fixture() {
    let (_d, _p, _oids, rows, _) = merge_rows();
    assert_eq!(
        (rows[3].lane, rows[3].edges.clone()),
        (0, vec![e(Some(0), None), e(Some(1), None)])
    );
}

#[test]
fn should_report_two_lanes_and_four_rows_for_the_merge_fixture() {
    let (_d, _p, _oids, _rows, summary) = merge_rows();
    assert_eq!((summary.total, summary.max_lanes), (4, 2));
}

#[test]
fn should_list_both_parents_in_order_on_the_merge_row() {
    let (_d, _p, (_r, a, b, _m), rows, _) = merge_rows();
    assert_eq!(rows[0].parents, vec![a.to_string(), b.to_string()]);
}

#[test]
fn should_label_main_on_the_merge_and_feature_on_the_branch_tip() {
    let (_d, path, _oids, rows, _) = merge_rows();
    let head = common::head_branch_name(&path);
    assert_eq!(
        (rows[0].refs.clone(), rows[1].refs.clone()),
        (
            vec![label(RefKind::Branch, &head, true)],
            vec![label(RefKind::Branch, "feature", false)]
        )
    );
}

#[test]
fn should_leave_unlabelled_commits_with_no_refs() {
    let (_d, _p, _oids, rows, _) = merge_rows();
    assert!(rows[2].refs.is_empty() && rows[3].refs.is_empty());
}

// --- tags ---

#[test]
fn should_label_lightweight_and_annotated_tags_in_name_order() {
    let (_d, path, r, _a, _b, _m) = common::merge_fixture();
    common::tag_annotated(&path, "v2", r);
    common::tag_lightweight(&path, "v1", r);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(
        rows[3].refs,
        vec![
            label(RefKind::Tag, "v1", false),
            label(RefKind::Tag, "v2", false)
        ]
    );
}

#[test]
fn should_peel_an_annotated_tag_to_the_commit_it_points_at() {
    let (_d, path, r, _a, _b, _m) = common::merge_fixture();
    common::tag_annotated(&path, "v2", r);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(rows[3].refs, vec![label(RefKind::Tag, "v2", false)]);
}

#[test]
fn should_order_tags_after_branch_labels_on_the_same_commit() {
    let (_d, path, _r, _a, _b, m) = common::merge_fixture();
    common::tag_lightweight(&path, "v1", m);
    let head = common::head_branch_name(&path);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(
        rows[0].refs,
        vec![
            label(RefKind::Branch, &head, true),
            label(RefKind::Tag, "v1", false)
        ]
    );
}

#[test]
fn should_skip_a_tag_that_points_at_a_blob() {
    let (_d, path) = common::temp_repo_with_commit();
    let blob = Repository::open(&path).unwrap().blob(b"x").unwrap();
    common::tag_lightweight(&path, "blobtag", blob);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    assert!(summary.total == 1 && rows[0].refs.iter().all(|l| l.kind != RefKind::Tag));
}

#[test]
fn should_skip_a_tag_that_points_at_a_tree() {
    let (_d, path) = common::temp_repo_with_commit();
    let tree = {
        let repo = Repository::open(&path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        head.tree_id()
    };
    common::tag_lightweight(&path, "treetag", tree);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    assert!(summary.total == 1 && rows[0].refs.iter().all(|l| l.kind != RefKind::Tag));
}

// --- remotes ---

#[test]
fn should_label_the_remote_branch_and_skip_the_remote_head_symbolic_ref() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (_bd, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    Repository::open(&path)
        .unwrap()
        .reference_symbolic(
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{head}"),
            true,
            "test",
        )
        .unwrap();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(
        rows[0].refs,
        vec![
            label(RefKind::Branch, &head, true),
            label(RefKind::Remote, &format!("origin/{head}"), false)
        ]
    );
}

#[test]
fn should_list_remote_only_commits_when_no_local_branch_reaches_them() {
    let (_d, path) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&path);
    let (_bd, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head);
    common::branch_with_commit(&path, "feature", "f.txt", "f\n");
    common::push_branch(&path, "feature");
    common::fetch_remote(&path, "origin");
    Repository::open(&path)
        .unwrap()
        .find_branch("feature", git2::BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    let mut s = open(&path);
    assert_eq!(s.log_summary().unwrap().total, 2);
}

// --- detached HEAD ---

#[test]
fn should_add_a_head_label_first_when_head_is_detached() {
    let (_d, path, oids) = linear(1);
    let head = common::head_branch_name(&path);
    Repository::open(&path)
        .unwrap()
        .set_head_detached(oids[1])
        .unwrap();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(
        rows[0].refs,
        vec![
            label(RefKind::Head, "HEAD", true),
            label(RefKind::Branch, &head, false)
        ]
    );
}

#[test]
fn should_label_head_on_the_commit_it_is_detached_at_when_behind_the_branch() {
    let (_d, path, oids) = linear(1);
    Repository::open(&path)
        .unwrap()
        .set_head_detached(oids[0])
        .unwrap();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(rows[1].refs, vec![label(RefKind::Head, "HEAD", true)]);
}

// --- unborn HEAD ---

#[test]
fn should_report_no_rows_when_head_is_unborn() {
    let (_d, path) = common::temp_repo_unborn();
    let mut s = open(&path);
    assert_eq!(
        s.log_summary().unwrap(),
        LogSummary {
            generation: 1,
            total: 0,
            max_lanes: 0,
            complete: true,
            refreshing: false
        }
    );
}

#[test]
fn should_return_an_empty_page_when_head_is_unborn() {
    let (_d, path) = common::temp_repo_unborn();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(s.log_page(g, 0, 10).unwrap().rows.is_empty());
}

// Review focus 4: an unborn HEAD with a fetched remote must still list the remote's commits.
#[test]
fn should_list_remote_commits_when_head_is_unborn_but_a_remote_was_fetched() {
    let (_sd, source) = common::temp_repo_with_commit();
    let head = common::head_branch_name(&source);
    let (_bd, bare) = common::temp_bare_clone(&source);
    let (_d, path) = common::temp_repo_unborn();
    Repository::open(&path)
        .unwrap()
        .remote("origin", bare.to_str().unwrap())
        .unwrap();
    common::fetch_remote(&path, "origin");
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    assert_eq!(
        (summary.total, rows[0].refs.clone()),
        (
            1,
            vec![label(RefKind::Remote, &format!("origin/{head}"), false)]
        )
    );
}

// --- generation tracking ---

#[test]
fn should_keep_the_generation_when_nothing_changed() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let first = s.log_summary().unwrap().generation;
    assert_eq!(s.log_summary().unwrap().generation, first);
}

#[test]
fn should_keep_the_generation_when_an_untracked_file_is_written() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let first = s.log_summary().unwrap().generation;
    common::write_file(&path, "untracked.txt", "x\n");
    assert_eq!(s.log_summary().unwrap().generation, first);
}

#[test]
fn should_bump_the_generation_when_a_commit_is_made() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    s.log_summary().unwrap();
    common::commit_file(&path, "b.txt", "b\n", "second");
    assert_eq!(s.log_summary().unwrap().generation, 2);
}

#[test]
fn should_include_the_new_commit_when_the_generation_was_bumped_by_a_commit() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    s.log_summary().unwrap();
    common::commit_file(&path, "b.txt", "b\n", "second");
    assert_eq!(s.log_summary().unwrap().total, 2);
}

#[test]
fn should_bump_the_generation_when_a_branch_is_created() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    s.log_summary().unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("x", &commit, false).unwrap();
    }
    assert_eq!(s.log_summary().unwrap().generation, 2);
}

#[test]
fn should_bump_the_generation_when_head_is_detached() {
    let (_d, path, oids) = linear(0);
    let mut s = open(&path);
    s.log_summary().unwrap();
    Repository::open(&path)
        .unwrap()
        .set_head_detached(oids[0])
        .unwrap();
    assert_eq!(s.log_summary().unwrap().generation, 2);
}

#[test]
fn should_bump_the_generation_when_a_tag_is_created() {
    let (_d, path, oids) = linear(0);
    let mut s = open(&path);
    s.log_summary().unwrap();
    common::tag_lightweight(&path, "v1", oids[0]);
    assert_eq!(s.log_summary().unwrap().generation, 2);
}

// --- page bounds ---

#[test]
fn should_return_the_remaining_rows_when_start_is_inside_the_range() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let page = s.log_page(g, 1, 10).unwrap();
    assert_eq!((page.start, page.rows.len()), (1, 2));
}

#[test]
fn should_return_an_empty_page_when_start_equals_the_total() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(s.log_page(g, 3, 10).unwrap().rows.is_empty());
}

#[test]
fn should_return_an_empty_page_when_start_is_far_past_the_end() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(s.log_page(g, u32::MAX, 10).unwrap().rows.is_empty());
}

#[test]
fn should_clamp_a_zero_count_to_one_row() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(s.log_page(g, 0, 0).unwrap().rows.len(), 1);
}

#[test]
fn should_clamp_a_huge_count_to_the_rows_available() {
    let (_d, path, _oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(s.log_page(g, 0, 5000).unwrap().rows.len(), 3);
}

#[test]
fn should_clamp_a_count_to_one_thousand_rows() {
    let (_d, path, _oids) = linear(1004);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(s.log_page(g, 0, 5000).unwrap().rows.len(), 1000);
}

#[test]
fn should_start_the_page_at_the_requested_row() {
    let (_d, path, oids) = linear(2);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(
        s.log_page(g, 2, 1).unwrap().rows[0].oid,
        oids[0].to_string()
    );
}

// --- stale generations ---

#[test]
fn should_reject_a_page_when_the_generation_is_newer_than_the_cache() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(matches!(
        s.log_page(g + 1, 0, 10).unwrap_err(),
        GitError::LogStale
    ));
}

#[test]
fn should_reject_a_page_when_the_generation_is_zero() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    s.log_summary().unwrap();
    assert!(matches!(
        s.log_page(0, 0, 10).unwrap_err(),
        GitError::LogStale
    ));
}

#[test]
fn should_reject_a_page_when_no_summary_was_ever_built() {
    let (_d, path) = common::temp_repo_with_commit();
    let s = open(&path);
    assert!(matches!(
        s.log_page(1, 0, 10).unwrap_err(),
        GitError::LogStale
    ));
}

#[test]
fn should_reject_an_old_generation_when_refs_changed_and_the_summary_was_rebuilt() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let old = s.log_summary().unwrap().generation;
    common::commit_file(&path, "b.txt", "b\n", "second");
    s.log_summary().unwrap();
    assert!(matches!(
        s.log_page(old, 0, 10).unwrap_err(),
        GitError::LogStale
    ));
}

#[test]
fn should_reject_a_search_when_the_generation_is_stale() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert!(matches!(
        s.search_log(g + 1, "x").unwrap_err(),
        GitError::LogStale
    ));
}

#[test]
fn should_reject_a_search_when_no_summary_was_ever_built() {
    let (_d, path) = common::temp_repo_with_commit();
    let s = open(&path);
    assert!(matches!(
        s.search_log(1, "x").unwrap_err(),
        GitError::LogStale
    ));
}

// --- search ---
// History (newest first): 0 "fix typo" by Bob, 1 "feat: Add parser" + body by
// Alice, 2 "initial commit" by Test User.

fn search_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, u64, Vec<Oid>) {
    let (d, path) = common::temp_repo_with_commit();
    let first = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let feat = commit_as(
        &path,
        "feat.txt",
        "feat: Add parser\n\nImplements the tokenizer",
        ("Alice", "alice@x.io"),
        ("Alice", "alice@x.io"),
    );
    let fix = commit_as(
        &path,
        "fix.txt",
        "fix typo",
        ("Bob", "bob@y.org"),
        ("Bob", "bob@y.org"),
    );
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    (d, path, s, g, vec![first, feat, fix])
}

#[test]
fn should_match_a_subject_case_insensitively() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "FEAT").unwrap(), vec![1]);
}

#[test]
fn should_match_an_author_email_case_insensitively() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "ALICE@X").unwrap(), vec![1]);
}

#[test]
fn should_match_an_author_name() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "bob").unwrap(), vec![0]);
}

#[test]
fn should_match_text_that_appears_only_in_the_body() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "tokenizer").unwrap(), vec![1]);
}

#[test]
fn should_match_a_seven_character_hash_prefix() {
    let (_d, _p, s, g, o) = search_fixture();
    assert_eq!(s.search_log(g, &o[1].to_string()[..7]).unwrap(), vec![1]);
}

#[test]
fn should_match_an_uppercase_hash_prefix() {
    let (_d, _p, s, g, o) = search_fixture();
    let q = o[0].to_string()[..8].to_uppercase();
    assert_eq!(s.search_log(g, &q).unwrap(), vec![2]);
}

#[test]
fn should_match_a_full_forty_character_hash() {
    let (_d, _p, s, g, o) = search_fixture();
    assert_eq!(s.search_log(g, &o[2].to_string()).unwrap(), vec![0]);
}

#[test]
fn should_trim_whitespace_around_the_query() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "   feat  ").unwrap(), vec![1]);
}

#[test]
fn should_return_no_matches_when_the_query_is_blank() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert!(s.search_log(g, "   ").unwrap().is_empty());
}

#[test]
fn should_return_no_matches_when_the_query_is_empty() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert!(s.search_log(g, "").unwrap().is_empty());
}

#[test]
fn should_return_no_matches_when_nothing_contains_the_query() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert!(s.search_log(g, "zzz").unwrap().is_empty());
}

#[test]
fn should_return_indices_ascending_when_several_rows_match() {
    let (_d, _p, s, g, _o) = search_fixture();
    assert_eq!(s.search_log(g, "@").unwrap(), vec![0, 1, 2]);
}

#[test]
fn should_not_match_a_hash_longer_than_forty_characters() {
    let (_d, _p, s, g, o) = search_fixture();
    let q = format!("{}0", o[0]);
    assert!(s.search_log(g, &q).unwrap().is_empty());
}

// A query of fewer than four hex characters is text, never a hash prefix. The
// only commit's text holds no hex digit, so a three-character prefix cannot
// match anything but the hash.
fn text_free_of_hex() -> (tempfile::TempDir, RepoSession, u64, Oid) {
    let (d, path) = common::temp_repo_unborn();
    let oid = commit_as(
        &path,
        "zzz.txt",
        "zzz",
        ("Zzz", "zzz@zzz.zzz"),
        ("Zzz", "zzz@zzz.zzz"),
    );
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    (d, s, g, oid)
}

#[test]
fn should_not_match_a_hash_prefix_shorter_than_four_characters() {
    let (_d, s, g, oid) = text_free_of_hex();
    assert!(s.search_log(g, &oid.to_string()[..3]).unwrap().is_empty());
}

#[test]
fn should_match_a_hash_prefix_of_exactly_four_characters() {
    let (_d, s, g, oid) = text_free_of_hex();
    assert_eq!(s.search_log(g, &oid.to_string()[..4]).unwrap(), vec![0]);
}

// --- commit detail ---

#[test]
fn should_report_both_parents_and_the_subject_of_a_merge() {
    let (_d, path, _r, a, b, m) = common::merge_fixture();
    let detail = open(&path).commit_detail(&m.to_string()).unwrap();
    assert_eq!(
        (
            detail.oid,
            detail.parents,
            detail.message.subject.as_str(),
            detail.message.body.as_str()
        ),
        (
            m.to_string(),
            vec![a.to_string(), b.to_string()],
            "merge",
            ""
        )
    );
}

#[test]
fn should_report_author_and_committer_separately_when_they_differ() {
    let (_d, path) = common::temp_repo_with_commit();
    let oid = commit_as(
        &path,
        "x.txt",
        "subject line\n\nthe body",
        ("Alice", "alice@x.io"),
        ("Carol", "carol@z.net"),
    );
    let detail = open(&path).commit_detail(&oid.to_string()).unwrap();
    assert_eq!(
        (
            detail.author.name.as_str(),
            detail.author.email.as_str(),
            detail.committer.name.as_str(),
            detail.committer.email.as_str()
        ),
        ("Alice", "alice@x.io", "Carol", "carol@z.net")
    );
}

#[test]
fn should_split_the_message_into_subject_and_body() {
    let (_d, path) = common::temp_repo_with_commit();
    let oid = commit_as(
        &path,
        "x.txt",
        "subject line\n\nthe body",
        ("Alice", "alice@x.io"),
        ("Alice", "alice@x.io"),
    );
    let detail = open(&path).commit_detail(&oid.to_string()).unwrap();
    assert_eq!(
        (
            detail.message.subject.as_str(),
            detail.message.body.as_str()
        ),
        ("subject line", "the body")
    );
}

#[test]
fn should_report_signature_times_in_unix_seconds() {
    let (_d, path, r, _a, _b, _m) = common::merge_fixture();
    let detail = open(&path).commit_detail(&r.to_string()).unwrap();
    assert_eq!(
        (detail.author.time, detail.committer.time),
        (common::FIXTURE_TIME, common::FIXTURE_TIME)
    );
}

#[test]
fn should_report_no_parents_for_a_root_commit() {
    let (_d, path, r, _a, _b, _m) = common::merge_fixture();
    assert!(
        open(&path)
            .commit_detail(&r.to_string())
            .unwrap()
            .parents
            .is_empty()
    );
}

#[test]
fn should_reject_a_well_formed_oid_that_does_not_exist() {
    let (_d, path) = common::temp_repo_with_commit();
    let input = "deadbeef".repeat(5);
    let err = open(&path).commit_detail(&input).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(s) if s == input));
}

#[test]
fn should_reject_text_that_is_not_hex() {
    let (_d, path) = common::temp_repo_with_commit();
    let err = open(&path).commit_detail("nothex").unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(s) if s == "nothex"));
}

#[test]
fn should_reject_an_empty_oid() {
    let (_d, path) = common::temp_repo_with_commit();
    let err = open(&path).commit_detail("").unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn should_reject_the_oid_of_a_tree() {
    let (_d, path) = common::temp_repo_with_commit();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel(ObjectType::Tree)
        .unwrap()
        .id();
    let err = open(&path).commit_detail(&tree.to_string()).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

// --- reset_to_commit ---

const V1: &str = "# fixture\n";
const V2: &str = "# two\n";

/// Returns (dir, path, session, first commit, second commit); README holds V2.
fn reset_fixture() -> (tempfile::TempDir, PathBuf, RepoSession, Oid, Oid) {
    let (d, path) = common::temp_repo_with_commit();
    let first = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    let second = common::commit_file(&path, "README.md", V2, "second");
    let s = open(&path);
    (d, path, s, first, second)
}

fn blob_of(content: &str) -> Oid {
    Oid::hash_object(ObjectType::Blob, content.as_bytes()).unwrap()
}

fn index_blob(path: &Path) -> Oid {
    let repo = Repository::open(path).unwrap();
    let index = repo.index().unwrap();
    index.get_path(Path::new("README.md"), 0).unwrap().id
}

fn head_target(path: &Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

#[test]
fn should_move_head_and_keep_index_and_worktree_when_resetting_soft() {
    let (_d, path, s, first, _second) = reset_fixture();
    s.reset_to_commit(&first.to_string(), ResetMode::Soft)
        .unwrap();
    assert_eq!(
        (
            head_target(&path),
            index_blob(&path),
            std::fs::read_to_string(path.join("README.md")).unwrap()
        ),
        (first, blob_of(V2), V2.to_owned())
    );
}

#[test]
fn should_reset_the_index_and_keep_the_worktree_when_resetting_mixed() {
    let (_d, path, s, first, _second) = reset_fixture();
    s.reset_to_commit(&first.to_string(), ResetMode::Mixed)
        .unwrap();
    assert_eq!(
        (
            head_target(&path),
            index_blob(&path),
            std::fs::read_to_string(path.join("README.md")).unwrap()
        ),
        (first, blob_of(V1), V2.to_owned())
    );
}

#[test]
fn should_restore_index_and_worktree_when_resetting_hard() {
    let (_d, path, s, first, _second) = reset_fixture();
    s.reset_to_commit(&first.to_string(), ResetMode::Hard)
        .unwrap();
    assert_eq!(
        (
            head_target(&path),
            index_blob(&path),
            std::fs::read_to_string(path.join("README.md")).unwrap()
        ),
        (first, blob_of(V1), V1.to_owned())
    );
}

#[test]
fn should_discard_uncommitted_edits_when_resetting_hard_to_the_current_commit() {
    let (_d, path, s, _first, second) = reset_fixture();
    std::fs::write(path.join("README.md"), "dirty\n").unwrap();
    s.reset_to_commit(&second.to_string(), ResetMode::Hard)
        .unwrap();
    assert_eq!(std::fs::read_to_string(path.join("README.md")).unwrap(), V2);
}

#[test]
fn should_move_the_branch_and_keep_head_symbolic_when_resetting() {
    let (_d, path, s, first, _second) = reset_fixture();
    let branch = common::head_branch_name(&path);
    s.reset_to_commit(&first.to_string(), ResetMode::Mixed)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let tip = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .target()
        .unwrap();
    assert_eq!(tip, first);
}

#[test]
fn should_rebuild_the_graph_with_a_new_generation_after_a_reset() {
    let (_d, _path, mut s, first, _second) = reset_fixture();
    s.log_summary().unwrap();
    s.reset_to_commit(&first.to_string(), ResetMode::Mixed)
        .unwrap();
    let summary = s.log_summary().unwrap();
    // The reset commit's child is no longer reachable from any ref.
    assert_eq!((summary.generation, summary.total), (2, 1));
}

#[test]
fn should_reject_a_reset_to_an_unknown_oid() {
    let (_d, _path, s, _first, _second) = reset_fixture();
    let input = "0".repeat(40);
    let err = s.reset_to_commit(&input, ResetMode::Hard).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(x) if x == input));
}

#[test]
fn should_leave_head_and_worktree_alone_when_the_reset_target_is_unknown() {
    let (_d, path, s, _first, second) = reset_fixture();
    let _ = s.reset_to_commit(&"0".repeat(40), ResetMode::Hard);
    assert_eq!(
        (
            head_target(&path),
            std::fs::read_to_string(path.join("README.md")).unwrap()
        ),
        (second, V2.to_owned())
    );
}

#[test]
fn should_reject_a_reset_to_malformed_text() {
    let (_d, _path, s, _first, _second) = reset_fixture();
    assert!(matches!(
        s.reset_to_commit("--hard", ResetMode::Soft).unwrap_err(),
        GitError::CommitNotFound(_)
    ));
}

#[test]
fn should_reject_a_reset_to_a_tree_oid() {
    let (_d, path, s, _first, _second) = reset_fixture();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .tree_id();
    assert!(matches!(
        s.reset_to_commit(&tree.to_string(), ResetMode::Soft)
            .unwrap_err(),
        GitError::CommitNotFound(_)
    ));
}

// --- coverage audit: generation tracking beyond commits and tags ---

#[test]
fn should_bump_the_generation_when_head_switches_to_another_branch_at_the_same_commit() {
    let (_d, path, _oids) = linear(0);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &commit, false).unwrap();
    }
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    Repository::open(&path)
        .unwrap()
        .set_head("refs/heads/other")
        .unwrap();
    let again = s.log_summary().unwrap();
    let rows = s.log_page(again.generation, 0, 10).unwrap().rows;
    let head: Vec<_> = rows[0].refs.iter().filter(|l| l.is_head).collect();
    assert_eq!(
        (again.generation, head.len(), head[0].name.as_str()),
        (g + 1, 1, "other")
    );
}

#[test]
fn should_bump_the_generation_when_a_branch_is_deleted() {
    let (_d, path, _oids) = linear(0);
    {
        let repo = Repository::open(&path).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("x", &commit, false).unwrap();
    }
    let mut s = open(&path);
    s.log_summary().unwrap();
    Repository::open(&path)
        .unwrap()
        .find_branch("x", git2::BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();
    assert_eq!(s.log_summary().unwrap().generation, 2);
}

#[test]
fn should_bump_the_generation_when_a_tag_is_deleted() {
    let (_d, path, oids) = linear(0);
    common::tag_lightweight(&path, "v1", oids[0]);
    let mut s = open(&path);
    s.log_summary().unwrap();
    Repository::open(&path).unwrap().tag_delete("v1").unwrap();
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert!(g == 2 && rows[0].refs.iter().all(|l| l.kind != RefKind::Tag));
}

#[test]
fn should_bump_the_generation_when_a_branch_moves_to_another_commit() {
    let (_d, path, oids) = linear(1);
    {
        let repo = Repository::open(&path).unwrap();
        repo.branch("x", &repo.find_commit(oids[1]).unwrap(), false)
            .unwrap();
    }
    let mut s = open(&path);
    s.log_summary().unwrap();
    Repository::open(&path)
        .unwrap()
        .reference("refs/heads/x", oids[0], true, "move")
        .unwrap();
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    assert_eq!(
        (g, rows[1].refs.iter().any(|l| l.name == "x")),
        (2, true),
        "x must now label the older commit"
    );
}

#[test]
fn should_keep_the_generation_when_the_index_changes() {
    let (_d, path) = common::temp_repo_with_commit();
    let mut s = open(&path);
    let first = s.log_summary().unwrap().generation;
    common::write_file(&path, "staged.txt", "x\n");
    common::stage(&path, "staged.txt");
    assert_eq!(s.log_summary().unwrap().generation, first);
}

#[test]
fn should_keep_the_previous_cache_and_retry_when_a_rebuild_fails() {
    let (_d, path, oids) = linear(1);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    // A branch pointing at an object that does not exist makes the walk fail.
    std::fs::write(
        path.join(".git/refs/heads/broken"),
        format!("{}\n", "ab".repeat(20)),
    )
    .unwrap();
    let failed = s.log_summary();
    // The old pages stay readable, and the rebuild is attempted again.
    let old_page = s.log_page(g, 0, 10);
    let retried = s.log_summary();
    assert!(
        failed.is_err() && retried.is_err() && old_page.unwrap().rows.len() == oids.len(),
        "failed={failed:?} retried={retried:?}"
    );
}

// --- coverage audit: walk contents and labels ---

#[test]
fn should_list_a_commit_once_when_several_refs_reach_it() {
    let (_d, path, oids) = linear(1);
    {
        let repo = Repository::open(&path).unwrap();
        let tip = repo.find_commit(oids[1]).unwrap();
        repo.branch("a", &tip, false).unwrap();
        repo.branch("b", &tip, false).unwrap();
    }
    common::tag_lightweight(&path, "v1", oids[1]);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    assert_eq!(
        (summary.total, summary.max_lanes, rows[0].refs.len()),
        (2, 1, 4)
    );
}

#[test]
fn should_list_a_commit_reachable_only_from_a_tag() {
    let (_d, path, oids) = linear(0);
    let only_tagged = {
        let repo = Repository::open(&path).unwrap();
        let base = repo.find_commit(oids[0]).unwrap();
        let sig = Signature::now("T", "t@x.io").unwrap();
        repo.commit(
            None,
            &sig,
            &sig,
            "only on a tag",
            &base.tree().unwrap(),
            &[&base],
        )
        .unwrap()
    };
    common::tag_lightweight(&path, "lonely", only_tagged);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let rows = s.log_page(summary.generation, 0, 10).unwrap().rows;
    assert_eq!(
        (
            summary.total,
            rows[0].subject.as_str(),
            rows[0].refs.clone()
        ),
        (
            2,
            "only on a tag",
            vec![label(RefKind::Tag, "lonely", false)]
        )
    );
}

#[test]
fn should_peel_a_tag_of_a_tag_to_the_commit() {
    let (_d, path, oids) = linear(0);
    common::tag_annotated(&path, "inner", oids[0]);
    {
        let repo = Repository::open(&path).unwrap();
        let inner = repo.find_reference("refs/tags/inner").unwrap();
        let inner_obj = repo.find_object(inner.target().unwrap(), None).unwrap();
        let sig = Signature::now("T", "t@x.io").unwrap();
        repo.tag("outer", &inner_obj, &sig, "again", false).unwrap();
    }
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = s.log_page(g, 0, 10).unwrap().rows;
    let tags: Vec<_> = rows[0]
        .refs
        .iter()
        .filter(|l| l.kind == RefKind::Tag)
        .map(|l| l.name.as_str())
        .collect();
    assert_eq!(tags, ["inner", "outer"]);
}

#[test]
fn should_put_the_head_branch_first_even_when_it_sorts_after_other_branches() {
    let (_d, path, oids) = linear(0);
    {
        let repo = Repository::open(&path).unwrap();
        let c = repo.find_commit(oids[0]).unwrap();
        repo.branch("aaa", &c, false).unwrap();
        repo.branch("zzz", &c, false).unwrap();
    }
    Repository::open(&path)
        .unwrap()
        .set_head("refs/heads/zzz")
        .unwrap();
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let branches: Vec<(String, bool)> = s.log_page(g, 0, 1).unwrap().rows[0]
        .refs
        .iter()
        .filter(|l| l.kind == RefKind::Branch)
        .map(|l| (l.name.clone(), l.is_head))
        .collect();
    let mut rest: Vec<String> = branches[1..].iter().map(|b| b.0.clone()).collect();
    let sorted = {
        let mut r = rest.clone();
        r.sort();
        r
    };
    rest.dedup();
    assert_eq!(
        (branches[0].clone(), branches[1..].iter().any(|b| b.1), rest),
        (("zzz".to_owned(), true), false, sorted)
    );
}

// --- coverage audit: pages ---

#[test]
fn should_concatenate_consecutive_pages_into_the_whole_graph() {
    let (_d, path, _oids) = linear(4);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let whole = s.log_page(g, 0, 100).unwrap().rows;
    let mut stitched = Vec::new();
    for start in [0, 2, 4] {
        let page = s.log_page(g, start, 2).unwrap();
        assert_eq!(page.start, start);
        stitched.extend(page.rows);
    }
    assert_eq!(stitched, whole);
}

#[test]
fn should_return_an_empty_page_when_start_and_count_are_at_the_numeric_limit() {
    let (_d, path, _oids) = linear(1);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let page = s.log_page(g, u32::MAX, u32::MAX).unwrap();
    assert_eq!((page.start, page.rows.len()), (u32::MAX, 0));
}

// --- coverage audit: search ---

#[test]
fn should_not_match_hex_text_from_the_middle_of_a_hash() {
    let (_d, _p, s, g, oids) = search_fixture();
    let middle = &oids[1].to_string()[1..9];
    assert_eq!(s.search_log(g, middle).unwrap(), Vec::<u32>::new());
}

#[test]
fn should_match_hex_looking_text_in_the_author_name_when_it_is_not_a_hash_prefix() {
    let (_d, path) = common::temp_repo_with_commit();
    commit_as(
        &path,
        "x.txt",
        "plain subject",
        ("Dead Beef", "db@x.io"),
        ("Dead Beef", "db@x.io"),
    );
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(s.search_log(g, "dead").unwrap(), vec![0]);
}

#[test]
fn should_match_hex_looking_text_that_appears_only_in_the_body() {
    let (_d, path) = common::temp_repo_with_commit();
    commit_as(
        &path,
        "x.txt",
        "plain subject\n\nsee also cafe0042 for context",
        ("A", "a@x.io"),
        ("A", "a@x.io"),
    );
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(s.search_log(g, "cafe0042").unwrap(), vec![0]);
}

#[test]
fn should_treat_regex_characters_in_the_query_literally() {
    let (_d, _p, s, g, _oids) = search_fixture();
    assert_eq!(
        (
            s.search_log(g, "fix.typo").unwrap(),
            s.search_log(g, "f*x").unwrap(),
            s.search_log(g, "(").unwrap()
        ),
        (vec![], vec![], vec![])
    );
}

#[test]
fn should_match_the_whole_message_when_the_query_spans_subject_and_body() {
    let (_d, _p, s, g, _oids) = search_fixture();
    assert_eq!(
        s.search_log(g, "add parser\n\nimplements").unwrap(),
        vec![1]
    );
}

#[test]
fn should_match_non_ascii_text_case_insensitively() {
    let (_d, path) = common::temp_repo_with_commit();
    commit_as(
        &path,
        "x.txt",
        "Überarbeitung des Parsers",
        ("Zoë", "zoe@x.io"),
        ("Zoë", "zoe@x.io"),
    );
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    assert_eq!(
        (
            s.search_log(g, "überarbeitung").unwrap(),
            s.search_log(g, "ZOË").unwrap()
        ),
        (vec![0], vec![0])
    );
}

#[test]
fn should_match_a_full_hash_given_in_uppercase() {
    let (_d, _p, s, g, oids) = search_fixture();
    let full = oids[2].to_string().to_uppercase();
    assert_eq!(s.search_log(g, &full).unwrap(), vec![0]);
}

// --- coverage audit: commit_detail ---

#[test]
fn should_reject_an_oid_of_thirty_nine_or_forty_one_hex_characters() {
    let (_d, path) = common::temp_repo_with_commit();
    let full = head_target(&path).to_string();
    let s = open(&path);
    let short = &full[..39];
    let long = format!("{full}0");
    assert!(matches!(s.commit_detail(short), Err(GitError::CommitNotFound(x)) if x == short));
    assert!(matches!(s.commit_detail(&long), Err(GitError::CommitNotFound(x)) if x == long));
}

#[test]
fn should_reject_an_abbreviated_hash_of_an_existing_commit() {
    let (_d, path) = common::temp_repo_with_commit();
    let full = head_target(&path).to_string();
    let err = open(&path).commit_detail(&full[..7]).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn should_reject_an_oid_padded_with_whitespace() {
    let (_d, path) = common::temp_repo_with_commit();
    let padded = format!(" {}", &head_target(&path).to_string()[..39]);
    assert_eq!(padded.len(), 40);
    let err = open(&path).commit_detail(&padded).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn should_reject_forty_bytes_of_non_ascii_text() {
    let (_d, path) = common::temp_repo_with_commit();
    let input = "é".repeat(20);
    assert_eq!(input.len(), 40);
    let err = open(&path).commit_detail(&input).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(s) if s == input));
}

#[test]
fn should_accept_an_uppercase_oid_and_report_it_in_lowercase() {
    let (_d, path) = common::temp_repo_with_commit();
    let lower = head_target(&path).to_string();
    let detail = open(&path).commit_detail(&lower.to_uppercase()).unwrap();
    assert_eq!(detail.oid, lower);
}

#[test]
fn should_reject_the_oid_of_a_blob() {
    let (_d, path) = common::temp_repo_with_commit();
    let blob = Repository::open(&path).unwrap().blob(b"x").unwrap();
    let err = open(&path).commit_detail(&blob.to_string()).unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn should_reject_the_oid_of_an_annotated_tag_object() {
    let (_d, path, oids) = linear(0);
    common::tag_annotated(&path, "v1", oids[0]);
    let tag_object = Repository::open(&path)
        .unwrap()
        .find_reference("refs/tags/v1")
        .unwrap()
        .target()
        .unwrap();
    assert_ne!(tag_object, oids[0]);
    let err = open(&path)
        .commit_detail(&tag_object.to_string())
        .unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)));
}

#[test]
fn should_report_an_empty_body_when_the_message_is_one_line() {
    let (_d, path) = common::temp_repo_with_commit();
    let oid = commit_as(
        &path,
        "x.txt",
        "only a subject",
        ("A", "a@x.io"),
        ("A", "a@x.io"),
    );
    let detail = open(&path).commit_detail(&oid.to_string()).unwrap();
    assert_eq!(
        (
            detail.message.subject.as_str(),
            detail.message.body.as_str()
        ),
        ("only a subject", "")
    );
}

#[test]
fn should_replace_invalid_utf8_in_the_message_and_signature_instead_of_failing() {
    let (_d, path) = common::temp_repo_with_commit();
    let oid = {
        let repo = Repository::open(&path).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = parent.tree().unwrap();
        let mut raw = Vec::new();
        raw.extend_from_slice(format!("tree {}\nparent {}\n", tree.id(), parent.id()).as_bytes());
        raw.extend_from_slice(b"author Zo\xe9 <z@x.io> 1700000000 +0000\n");
        raw.extend_from_slice(b"committer Zo\xe9 <z@x.io> 1700000000 +0000\n\nbad \xe9 byte\n");
        let odb = repo.odb().unwrap();
        let id = odb.write(git2::ObjectType::Commit, &raw).unwrap();
        repo.reference("refs/heads/latin1", id, true, "t").unwrap();
        id
    };
    let mut s = open(&path);
    let detail = s.commit_detail(&oid.to_string()).unwrap();
    let g = s.log_summary().unwrap().generation;
    let row = s.log_page(g, 0, 1).unwrap().rows.remove(0);
    assert_eq!(
        (
            detail.message.subject.contains('\u{fffd}'),
            detail.author.name.contains('\u{fffd}'),
            row.author_name.contains('\u{fffd}')
        ),
        (true, true, true)
    );
}

// --- coverage audit: reset_to_commit ---

#[test]
fn should_move_a_detached_head_without_touching_any_branch_when_resetting() {
    let (_d, path, s, first, second) = reset_fixture();
    let head = common::head_branch_name(&path);
    Repository::open(&path)
        .unwrap()
        .set_head_detached(second)
        .unwrap();
    s.reset_to_commit(&first.to_string(), ResetMode::Hard)
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    assert_eq!(
        (
            repo.head_detached().unwrap(),
            head_target(&path),
            repo.find_branch(&head, git2::BranchType::Local)
                .unwrap()
                .get()
                .target()
        ),
        (true, first, Some(second))
    );
}

#[test]
fn should_move_head_forward_to_a_descendant_when_resetting() {
    let (_d, path, s, first, second) = reset_fixture();
    s.reset_to_commit(&first.to_string(), ResetMode::Hard)
        .unwrap();
    s.reset_to_commit(&second.to_string(), ResetMode::Hard)
        .unwrap();
    assert_eq!(
        (head_target(&path), index_blob(&path)),
        (second, blob_of(V2))
    );
}

#[test]
fn should_keep_untracked_files_when_resetting_hard() {
    let (_d, path, s, first, _second) = reset_fixture();
    common::write_file(&path, "untracked.txt", "keep me\n");
    s.reset_to_commit(&first.to_string(), ResetMode::Hard)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(path.join("untracked.txt")).unwrap(),
        "keep me\n"
    );
}

#[test]
fn should_reset_to_a_merge_commit_and_expose_its_two_parents() {
    let (_d, path, _r, _a, b, m) = common::merge_fixture();
    let s = open(&path);
    s.reset_to_commit(&b.to_string(), ResetMode::Soft).unwrap();
    s.reset_to_commit(&m.to_string(), ResetMode::Hard).unwrap();
    assert_eq!(
        (
            head_target(&path),
            s.commit_detail(&m.to_string()).unwrap().parents.len()
        ),
        (m, 2)
    );
}

#[test]
fn should_reject_a_reset_to_an_abbreviated_hash_and_leave_head_alone() {
    let (_d, path, s, first, second) = reset_fixture();
    let err = s
        .reset_to_commit(&first.to_string()[..7], ResetMode::Hard)
        .unwrap_err();
    assert!(matches!(err, GitError::CommitNotFound(_)) && head_target(&path) == second);
}

// --- coverage audit: wire format the UI depends on ---

#[test]
fn should_deserialize_reset_modes_from_lowercase_names() {
    let parse = |s: &str| serde_json::from_str::<ResetMode>(&format!("\"{s}\""));
    assert_eq!(
        (
            parse("soft").unwrap(),
            parse("mixed").unwrap(),
            parse("hard").unwrap()
        ),
        (ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard)
    );
}

#[test]
fn should_reject_unknown_or_capitalised_reset_modes() {
    let parse = |s: &str| serde_json::from_str::<ResetMode>(&format!("\"{s}\""));
    assert!(parse("Hard").is_err() && parse("keep").is_err() && parse("").is_err());
}

#[test]
fn should_serialize_log_types_with_camel_case_keys_and_ref_kinds() {
    let (_d, path, oids) = linear(0);
    common::tag_lightweight(&path, "v1", oids[0]);
    let mut s = open(&path);
    let summary = s.log_summary().unwrap();
    let page = s.log_page(summary.generation, 0, 1).unwrap();
    let json = serde_json::to_value(&page).unwrap();
    let row = &json["rows"][0];
    let mut row_keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    row_keys.sort();
    assert_eq!(
        (
            serde_json::to_value(&summary).unwrap(),
            json["start"].clone(),
            row_keys,
            row["refs"][0]["kind"].clone(),
            row["refs"][1]["kind"].clone(),
            row["refs"][1]["isHead"].clone(),
            row["edges"].clone()
        ),
        (
            serde_json::json!({
                "generation": 1,
                "total": 1,
                "maxLanes": 1,
                "complete": true,
                "refreshing": false
            }),
            serde_json::json!(0),
            vec![
                "authorEmail",
                "authorName",
                "authorTime",
                "edges",
                "lane",
                "oid",
                "parents",
                "refs",
                "subject"
            ],
            serde_json::json!("branch"),
            serde_json::json!("tag"),
            serde_json::json!(false),
            serde_json::json!([])
        )
    );
}

#[test]
fn should_serialize_edges_with_null_ends_and_commit_detail_in_camel_case() {
    let (_d, path, oids) = linear(1);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let rows = serde_json::to_value(s.log_page(g, 0, 2).unwrap()).unwrap();
    let detail = serde_json::to_value(s.commit_detail(&oids[1].to_string()).unwrap()).unwrap();
    assert_eq!(
        (
            rows["rows"][0]["edges"].clone(),
            detail["committer"]["time"].is_i64(),
            detail["message"]["subject"].clone()
        ),
        (
            serde_json::json!([{"top": null, "bottom": 0}]),
            true,
            serde_json::json!("commit 0")
        )
    );
}

#[test]
fn should_serialize_oids_and_parents_as_forty_character_hex_strings() {
    let (_d, path, oids) = linear(1);
    let mut s = open(&path);
    let g = s.log_summary().unwrap().generation;
    let page = serde_json::to_value(s.log_page(g, 0, 2).unwrap()).unwrap();
    let detail = serde_json::to_value(s.commit_detail(&oids[1].to_string()).unwrap()).unwrap();
    assert_eq!(
        (
            page["rows"][0]["oid"].clone(),
            page["rows"][0]["parents"].clone(),
            detail["oid"].clone(),
            detail["parents"].clone()
        ),
        (
            serde_json::json!(oids[1].to_string()),
            serde_json::json!([oids[0].to_string()]),
            serde_json::json!(oids[1].to_string()),
            serde_json::json!([oids[0].to_string()])
        )
    );
}
