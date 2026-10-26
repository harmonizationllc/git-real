//! Fixture generation (`prepare`): the synthetic fast-import stream, public
//! clones, and the sibling `<dir>.fixture.json` marker (§3.3).

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git::{BenchError, run_git, run_git_with_input};

/// What `prepare` builds, with the parameters that identify a cached fixture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixtureSpec {
    Synthetic { commits: u32, files: u32 },
    PublicGraph { url: String, commits: u32 },
    PublicWorktree { url: String },
}

/// Marker `kind`: serializes as `synthetic`, `publicGraph`, `publicWorktree`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FixtureKind {
    Synthetic,
    PublicGraph,
    PublicWorktree,
}

/// The sibling `<dir>.fixture.json`: `{ "version": 1, "kind", "params", "head" }`.
/// `params` is `{commits, files}`, `{url, commits}` or `{url}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub version: u32,
    pub kind: FixtureKind,
    pub params: serde_json::Value,
    pub head: String,
}

pub const MARKER_VERSION: u32 = 1;

impl Marker {
    /// A version 1 marker for `spec` recording `head`.
    pub fn new(spec: &FixtureSpec, head: &str) -> Marker {
        let (kind, params) = match spec {
            FixtureSpec::Synthetic { commits, files } => (
                FixtureKind::Synthetic,
                serde_json::json!({ "commits": commits, "files": files }),
            ),
            FixtureSpec::PublicGraph { url, commits } => (
                FixtureKind::PublicGraph,
                serde_json::json!({ "url": url, "commits": commits }),
            ),
            FixtureSpec::PublicWorktree { url } => (
                FixtureKind::PublicWorktree,
                serde_json::json!({ "url": url }),
            ),
        };
        Marker {
            version: MARKER_VERSION,
            kind,
            params,
            head: head.to_string(),
        }
    }

    /// True when `kind` and `params` equal those of `spec` (`head` is ignored).
    pub fn matches(&self, spec: &FixtureSpec) -> bool {
        let expected = Marker::new(spec, "");
        (self.kind, &self.params) == (expected.kind, &expected.params)
    }
}

/// `<dir>.fixture.json` next to `dir` (not inside it).
pub fn marker_path(dir: &Path) -> PathBuf {
    match (dir.parent(), dir.file_name()) {
        (Some(parent), Some(name)) => {
            let mut file = name.to_os_string();
            file.push(".fixture.json");
            parent.join(file)
        }
        _ => {
            let mut path = dir.as_os_str().to_os_string();
            path.push(".fixture.json");
            PathBuf::from(path)
        }
    }
}

/// `None` when the marker is missing or is not valid marker JSON.
pub fn read_marker(dir: &Path) -> Option<Marker> {
    let text = fs::read_to_string(marker_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_marker(dir: &Path, marker: &Marker) -> Result<(), BenchError> {
    let path = marker_path(dir);
    let mut json = serde_json::to_string_pretty(marker).expect("a marker always serializes");
    json.push('\n');
    fs::write(&path, json)
        .map_err(|e| BenchError::new(format!("cannot write {}: {e}", path.display())))
}

/// Topics start every `TOPIC_EVERY` indices, have `TOPIC_LEN` commits, and are
/// merged `MERGE_AFTER` indices after they start; every `KEEP_EVERY`th is kept unmerged.
const TOPIC_EVERY: u32 = 40;
const TOPIC_LEN: u32 = 5;
const MERGE_AFTER: u32 = 20;
const KEEP_EVERY: u32 = 10;
/// A lightweight tag on the main tip every `TAG_EVERY` indices.
const TAG_EVERY: u32 = 2_000;
/// The dirty working-tree step touches at most this many tracked files and adds
/// this many untracked ones.
const DIRTY_FILES: u32 = 100;
const EPOCH: u64 = 1_600_000_000;

/// `dir<i/100:03>/sub<(i/10)%10>/file<i:05>.txt`
fn file_path(i: u32) -> String {
    format!("dir{:03}/sub{}/file{i:05}.txt", i / 100, (i / 10) % 10)
}

/// The header of commit `c` (its mark is `:c`), message included.
fn commit_header(out: &mut impl Write, branch: &str, c: u32, message: &str) -> io::Result<()> {
    let when = EPOCH + 60 * u64::from(c - 1);
    let who = "Bench <bench@example.com>";
    write!(
        out,
        "commit {branch}\nmark :{c}\nauthor {who} {when} +0000\ncommitter {who} {when} +0000\ndata {}\n{message}\n",
        message.len()
    )
}

fn inline_file(out: &mut impl Write, i: u32, content: &str) -> io::Result<()> {
    write!(
        out,
        "M 100644 inline {}\ndata {}\n{content}",
        file_path(i),
        content.len()
    )
}

/// The deterministic `git fast-import` stream for the synthetic history (§3.3),
/// ending with `done`. Does not include the dirty working-tree step.
pub fn fast_import_stream(commits: u32, files: u32, out: &mut impl Write) -> std::io::Result<()> {
    commit_header(out, "refs/heads/main", 1, "initial tree")?;
    for i in 0..files {
        inline_file(out, i, &format!("file {i}\n"))?;
    }
    let mut main_tip = 1;
    // Topics started but not yet merged, as (topic number, tip mark), oldest first.
    let mut open: Vec<(u32, u32)> = Vec::new();
    for c in 2..=commits {
        if c.is_multiple_of(TAG_EVERY) {
            writeln!(
                out,
                "reset refs/tags/v0.{}\nfrom :{main_tip}",
                c / TAG_EVERY
            )?;
        }
        let t = c / TOPIC_EVERY;
        let k = c % TOPIC_EVERY;
        if t > 0 && k < TOPIC_LEN {
            let parent = if k == 0 { main_tip } else { c - 1 };
            commit_header(
                out,
                "refs/heads/scratch",
                c,
                &format!("topic-{t} change {}", k + 1),
            )?;
            writeln!(out, "from :{parent}")?;
            inline_file(out, c % files, &format!("topic {c}\n"))?;
            match open.last_mut() {
                Some((open_t, tip)) if *open_t == t => *tip = c,
                _ => open.push((t, c)),
            }
            continue;
        }
        let merging = open
            .iter()
            .find(|(open_t, _)| k == MERGE_AFTER && *open_t == t && !t.is_multiple_of(KEEP_EVERY))
            .copied();
        commit_header(
            out,
            "refs/heads/main",
            c,
            &match merging {
                Some((t, _)) => format!("Merge topic-{t}"),
                None => format!("commit {c}"),
            },
        )?;
        writeln!(out, "from :{main_tip}")?;
        match merging {
            Some((_, tip)) => {
                writeln!(out, "merge :{tip}")?;
                open.retain(|(open_t, _)| *open_t != t);
            }
            None => inline_file(out, c % files, &format!("{c}\n"))?,
        }
        main_tip = c;
    }
    // Every topic still unmerged (every 10th, and any cut off by `commits`) keeps
    // its own ref, so no generated commit becomes unreachable.
    for (t, tip) in open {
        writeln!(out, "reset refs/heads/topic-{t}\nfrom :{tip}")?;
    }
    writeln!(out, "done")
}

/// Builds the fixture in `dir`, or prints `fixture ready: <dir> (cached)` when a
/// matching marker exists; prints `fixture ready: <dir>` after a fresh build. Never
/// deletes a directory it did not create in this call.
pub fn prepare(dir: &Path, spec: &FixtureSpec, out: &mut impl Write) -> Result<(), BenchError> {
    if dir.exists() {
        return match read_marker(dir) {
            Some(marker) if marker.version == MARKER_VERSION && marker.matches(spec) => say(
                out,
                format_args!("fixture ready: {} (cached)", dir.display()),
            ),
            _ => Err(BenchError::new(format!(
                "{} exists but is not a matching fixture; remove it or choose another directory",
                dir.display()
            ))),
        };
    }
    // `dir` did not exist, so whatever is there after a failure was created here.
    let head = build(dir, spec).inspect_err(|_| {
        if dir.exists() {
            let _ = fs::remove_dir_all(dir);
        }
    })?;
    write_marker(dir, &Marker::new(spec, &head))?;
    say(out, format_args!("fixture ready: {}", dir.display()))
}

fn say(out: &mut impl Write, line: fmt::Arguments<'_>) -> Result<(), BenchError> {
    writeln!(out, "{line}").map_err(|e| BenchError::new(e.to_string()))
}

/// Builds `dir` and returns the oid its HEAD points at.
fn build(dir: &Path, spec: &FixtureSpec) -> Result<String, BenchError> {
    let dir_arg = dir
        .to_str()
        .ok_or_else(|| BenchError::new(format!("{} is not valid UTF-8", dir.display())))?;
    let here = Path::new(".");
    match spec {
        FixtureSpec::Synthetic { commits, files } => {
            run_git(&["init", "-q", dir_arg], here)?;
            let mut stream = Vec::new();
            fast_import_stream(*commits, *files, &mut stream).map_err(io_error)?;
            run_git_with_input(&["fast-import", "--quiet"], dir, &stream)?;
            run_git(&["update-ref", "-d", "refs/heads/scratch"], dir)?;
            run_git(&["checkout", "-q", "main"], dir)?;
            make_dirty(dir, *files).map_err(io_error)?;
            head(dir)
        }
        FixtureSpec::PublicGraph { url, commits } => {
            run_git(
                &[
                    "clone",
                    "--quiet",
                    "--bare",
                    "--single-branch",
                    "--filter=tree:0",
                    url,
                    dir_arg,
                ],
                here,
            )?;
            trim_to_oldest(dir, *commits)
        }
        FixtureSpec::PublicWorktree { url } => {
            run_git(
                &[
                    "clone",
                    "--quiet",
                    "--depth",
                    "1",
                    "--single-branch",
                    url,
                    dir_arg,
                ],
                here,
            )?;
            head(dir)
        }
    }
}

/// Points HEAD at `refs/heads/bench` on the `commits`-th oldest commit in date
/// order (the tip when the history is shorter) and deletes every other ref.
fn trim_to_oldest(dir: &Path, commits: u32) -> Result<String, BenchError> {
    let revs = run_git(&["rev-list", "--date-order", "--reverse", "HEAD"], dir)?;
    let lines: Vec<&str> = revs.lines().collect();
    let wanted = usize::try_from(commits)
        .unwrap_or(usize::MAX)
        .min(lines.len());
    let oid = lines
        .get(wanted.saturating_sub(1))
        .ok_or_else(|| BenchError::new(format!("{} has no commits", dir.display())))?
        .to_string();
    run_git(&["update-ref", "refs/heads/bench", &oid], dir)?;
    run_git(&["symbolic-ref", "HEAD", "refs/heads/bench"], dir)?;
    let refs = run_git(&["for-each-ref", "--format=%(refname)"], dir)?;
    let deletes: String = refs
        .lines()
        .filter(|r| *r != "refs/heads/bench")
        .map(|r| format!("delete {r}\n"))
        .collect();
    if !deletes.is_empty() {
        run_git_with_input(&["update-ref", "--stdin"], dir, deletes.as_bytes())?;
    }
    Ok(oid)
}

/// Appends `dirty\n` to the first `min(100, files)` files and adds 100 untracked
/// `dir001/sub1/new<i>.txt`.
fn make_dirty(dir: &Path, files: u32) -> io::Result<()> {
    for i in 0..files.min(DIRTY_FILES) {
        OpenOptions::new()
            .append(true)
            .open(dir.join(file_path(i)))?
            .write_all(b"dirty\n")?;
    }
    let untracked = dir.join("dir001/sub1");
    fs::create_dir_all(&untracked)?;
    for i in 0..DIRTY_FILES {
        fs::write(untracked.join(format!("new{i}.txt")), "new\n")?;
    }
    Ok(())
}

fn head(dir: &Path) -> Result<String, BenchError> {
    Ok(run_git(&["rev-parse", "HEAD"], dir)?.trim().to_string())
}

fn io_error(e: io::Error) -> BenchError {
    BenchError::new(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git_available, make_source_repo};

    fn stream(commits: u32, files: u32) -> String {
        let mut buf = Vec::new();
        fast_import_stream(commits, files, &mut buf).expect("stream");
        String::from_utf8(buf).expect("utf-8 stream")
    }

    fn synthetic(commits: u32, files: u32) -> FixtureSpec {
        FixtureSpec::Synthetic { commits, files }
    }

    fn ready(dir: &Path, spec: &FixtureSpec) -> String {
        let mut out = Vec::new();
        prepare(dir, spec, &mut out).expect("prepare");
        String::from_utf8(out).unwrap()
    }

    fn all_refs(repo: &git2::Repository) -> Vec<String> {
        let mut names: Vec<String> = repo
            .references()
            .unwrap()
            .map(|r| r.unwrap().name().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    fn count_from_head(repo: &git2::Repository) -> usize {
        let mut walk = repo.revwalk().unwrap();
        walk.push_head().unwrap();
        walk.count()
    }

    // Synthetic stream: the first commit creates the whole tree.
    #[test]
    fn stream_starts_with_initial_tree_commit_on_main() {
        let s = stream(50, 7);
        assert!(
            s.starts_with("commit refs/heads/main\n"),
            "got {:?}",
            &s[..40]
        );
    }

    #[test]
    fn stream_uses_the_fixed_identity_and_epoch() {
        let s = stream(50, 7);
        assert!(
            s.contains("author Bench <bench@example.com> 1600000000 +0000\n")
                && s.contains("committer Bench <bench@example.com> 1600000000 +0000\n"),
            "identity lines missing"
        );
    }

    #[test]
    fn stream_second_commit_is_one_minute_later() {
        let s = stream(50, 7);
        assert!(s.contains("author Bench <bench@example.com> 1600000060 +0000\n"));
    }

    #[test]
    fn stream_initial_commit_has_the_initial_tree_message() {
        let s = stream(50, 7);
        assert!(s.contains("initial tree"));
    }

    #[test]
    fn stream_initial_commit_adds_every_file_at_the_spec_paths() {
        let s = stream(50, 7);
        let first_block = s.split("\ncommit ").next().unwrap();
        let paths: Vec<&str> = first_block
            .lines()
            .filter_map(|l| l.strip_prefix("M 100644 inline "))
            .collect();
        let expected: Vec<String> = (0..7)
            .map(|i| format!("dir000/sub0/file{i:05}.txt"))
            .collect();
        assert_eq!(paths, expected);
    }

    #[test]
    fn stream_path_format_rolls_dir_and_sub_numbers() {
        let s = stream(5, 120);
        assert!(
            s.contains("M 100644 inline dir001/sub0/file00105.txt\n")
                && s.contains("M 100644 inline dir000/sub9/file00099.txt\n")
                && s.contains("M 100644 inline dir001/sub1/file00119.txt\n"),
            "path format wrong"
        );
    }

    #[test]
    fn stream_initial_files_hold_file_i_content() {
        let s = stream(50, 7);
        assert!(s.contains("data 7\nfile 0\n"));
    }

    // Plain main commits touch file c % files with content "c\n".
    #[test]
    fn stream_touches_file_c_mod_files() {
        let s = stream(50, 7);
        let at = s.find("\ncommit 8\n").expect("commit 8 message");
        let rest = &s[at..];
        let m = rest.find("M 100644 inline ").expect("file change");
        let after = &rest[m + "M 100644 inline ".len()..];
        let line_end = after.find('\n').unwrap();
        assert_eq!(
            (
                &after[..line_end],
                after[line_end + 1..].starts_with("data 2\n8\n")
            ),
            ("dir000/sub0/file00001.txt", true)
        );
    }

    #[test]
    fn stream_has_exactly_the_requested_number_of_commits() {
        let s = stream(100, 7);
        let n = s.lines().filter(|l| l.starts_with("commit refs/")).count();
        assert_eq!(n, 100);
    }

    // Topics: a 5-commit branch every 40th index, merged 20 indices later.
    #[test]
    fn stream_topic_cadence_and_merge() {
        let s = stream(100, 7);
        let scratch = s.find("refs/heads/scratch").expect("scratch ref");
        let merge = s.find("Merge topic-1").expect("merge commit");
        assert!(scratch < merge);
    }

    #[test]
    fn stream_topic_has_five_commits_with_numbered_messages() {
        let s = stream(100, 7);
        let all = (1..=5).all(|k| s.contains(&format!("topic-1 change {k}")));
        assert!(all && !s.contains("topic-1 change 6"));
    }

    #[test]
    fn stream_merge_commit_names_its_second_parent() {
        let s = stream(100, 7);
        let at = s.find("Merge topic-1").unwrap();
        let block = &s[at..];
        let end = block.find("\ncommit ").unwrap_or(block.len());
        assert!(block[..end].contains("\nmerge "), "no merge line");
    }

    #[test]
    fn stream_merges_each_topic_once() {
        let s = stream(100, 7);
        assert_eq!(s.matches("Merge topic-1\n").count(), 1);
    }

    #[test]
    fn stream_topics_branch_from_the_main_tip() {
        let s = stream(100, 7);
        assert!(s.contains("\nfrom "));
    }

    #[test]
    fn stream_topic_commits_touch_files_with_topic_content() {
        let s = stream(100, 7);
        assert!(s.contains("\ntopic "), "no topic content");
    }

    #[test]
    fn stream_without_a_full_topic_cadence_has_no_scratch_branch() {
        let s = stream(30, 7);
        assert!(!s.contains("refs/heads/scratch"));
    }

    #[test]
    fn every_tenth_topic_kept_as_branch_ref() {
        let s = stream(500, 7);
        assert!(s.contains("reset refs/heads/topic-10\n"));
    }

    #[test]
    fn the_kept_topic_is_not_merged() {
        let s = stream(500, 7);
        assert!(s.contains("Merge topic-9\n") && !s.contains("Merge topic-10\n"));
    }

    #[test]
    fn other_topics_are_not_kept_as_branch_refs() {
        let s = stream(500, 7);
        assert!(!s.contains("refs/heads/topic-9\n"));
    }

    #[test]
    fn no_topic_ref_before_the_tenth_topic() {
        let s = stream(100, 7);
        assert!(!s.contains("refs/heads/topic-"));
    }

    // Tags: lightweight v0.<c/2000> every 2,000th index.
    #[test]
    fn tags_every_2000_main_commits() {
        let s = stream(4100, 7);
        assert!(
            s.contains("refs/tags/v0.1\n")
                && s.contains("refs/tags/v0.2\n")
                && !s.contains("refs/tags/v0.3"),
            "tags wrong"
        );
    }

    #[test]
    fn no_tags_before_the_first_2000() {
        let s = stream(100, 7);
        assert!(!s.contains("refs/tags/"));
    }

    #[test]
    fn stream_ends_with_done() {
        assert!(stream(50, 7).ends_with("done\n"));
    }

    #[test]
    fn stream_is_deterministic() {
        assert_eq!(stream(150, 9), stream(150, 9));
    }

    #[test]
    fn stream_differs_when_sizes_differ() {
        assert_ne!(stream(150, 9), stream(150, 10));
    }

    // Markers.
    #[test]
    fn marker_path_is_a_sibling_of_the_directory() {
        assert_eq!(
            marker_path(Path::new("/t/bench")),
            PathBuf::from("/t/bench.fixture.json")
        );
    }

    #[test]
    fn marker_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        let marker = Marker::new(&synthetic(30, 5), "abc123");
        write_marker(&dir, &marker).unwrap();
        assert_eq!(read_marker(&dir), Some(marker));
    }

    #[test]
    fn marker_is_written_next_to_the_directory_not_inside() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        write_marker(&dir, &Marker::new(&synthetic(30, 5), "abc")).unwrap();
        assert!(tmp.path().join("fx.fixture.json").is_file());
    }

    #[test]
    fn read_marker_is_none_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_marker(&tmp.path().join("fx")), None);
    }

    #[test]
    fn read_marker_is_none_for_garbage() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        std::fs::write(marker_path(&dir), "not json").unwrap();
        assert_eq!(read_marker(&dir), None);
    }

    #[test]
    fn marker_new_serializes_the_spec_shape() {
        let v = serde_json::to_value(Marker::new(&synthetic(30, 5), "abc")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "version": 1,
                "kind": "synthetic",
                "params": { "commits": 30, "files": 5 },
                "head": "abc"
            })
        );
    }

    #[test]
    fn public_graph_marker_params_are_url_and_commits() {
        let spec = FixtureSpec::PublicGraph {
            url: "file:///s.git".to_string(),
            commits: 5,
        };
        let v = serde_json::to_value(Marker::new(&spec, "abc")).unwrap();
        assert_eq!(
            (v["kind"].clone(), v["params"].clone()),
            (
                serde_json::json!("publicGraph"),
                serde_json::json!({ "url": "file:///s.git", "commits": 5 })
            )
        );
    }

    #[test]
    fn public_worktree_marker_params_are_the_url() {
        let spec = FixtureSpec::PublicWorktree {
            url: "file:///s.git".to_string(),
        };
        let v = serde_json::to_value(Marker::new(&spec, "abc")).unwrap();
        assert_eq!(
            (v["kind"].clone(), v["params"].clone()),
            (
                serde_json::json!("publicWorktree"),
                serde_json::json!({ "url": "file:///s.git" })
            )
        );
    }

    #[test]
    fn marker_kind_names_are_camel_case() {
        let names: Vec<String> = [
            FixtureKind::Synthetic,
            FixtureKind::PublicGraph,
            FixtureKind::PublicWorktree,
        ]
        .iter()
        .map(|k| {
            serde_json::to_value(k)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
        assert_eq!(names, ["synthetic", "publicGraph", "publicWorktree"]);
    }

    #[test]
    fn marker_matches_the_same_spec() {
        assert!(Marker::new(&synthetic(30, 5), "abc").matches(&synthetic(30, 5)));
    }

    #[test]
    fn marker_matches_regardless_of_head() {
        assert!(Marker::new(&synthetic(30, 5), "other").matches(&synthetic(30, 5)));
    }

    #[test]
    fn marker_mismatch_on_different_params() {
        assert!(!Marker::new(&synthetic(30, 5), "abc").matches(&synthetic(31, 5)));
    }

    #[test]
    fn marker_mismatch_on_different_files() {
        assert!(!Marker::new(&synthetic(30, 5), "abc").matches(&synthetic(30, 6)));
    }

    #[test]
    fn marker_mismatch_on_different_kind() {
        let worktree = FixtureSpec::PublicWorktree {
            url: "u".to_string(),
        };
        assert!(!Marker::new(&synthetic(30, 5), "abc").matches(&worktree));
    }

    #[test]
    fn marker_mismatch_on_different_url() {
        let a = FixtureSpec::PublicWorktree {
            url: "a".to_string(),
        };
        let b = FixtureSpec::PublicWorktree {
            url: "b".to_string(),
        };
        assert!(!Marker::new(&a, "abc").matches(&b));
    }

    // prepare synthetic (needs git).
    #[test]
    fn prepare_synthetic_builds_the_repository() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(repo.index().unwrap().len(), 12);
    }

    #[test]
    fn prepare_synthetic_has_every_commit_reachable_below_the_topic_cadence() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(36, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        let mut walk = repo.revwalk().unwrap();
        walk.push_glob("refs/*").unwrap();
        assert_eq!(walk.count(), 36);
    }

    #[test]
    fn prepare_synthetic_checks_out_main() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
    }

    #[test]
    fn prepare_synthetic_leaves_no_scratch_topic_or_tag_refs_at_60_commits() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        let odd: Vec<String> = all_refs(&repo)
            .into_iter()
            .filter(|n| {
                n == "refs/heads/scratch"
                    || n.starts_with("refs/heads/topic-")
                    || n.starts_with("refs/tags/")
            })
            .collect();
        assert!(odd.is_empty(), "unexpected refs {odd:?}");
    }

    #[test]
    fn prepare_synthetic_dirty_step_scales_to_min_100_files() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        // 12 modified (min(100, files)) + 100 untracked
        assert_eq!(repo.statuses(Some(&mut opts)).unwrap().len(), 112);
    }

    #[test]
    fn prepare_synthetic_creates_untracked_new_files_under_dir001() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        assert_eq!(
            std::fs::read_to_string(dir.join("dir001/sub1/new99.txt")).ok(),
            Some("new\n".to_string())
        );
    }

    #[test]
    fn prepare_synthetic_appends_dirty_to_modified_files() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let text = std::fs::read_to_string(dir.join("dir000/sub0/file00000.txt")).unwrap();
        assert!(text.ends_with("dirty\n"), "got {text:?}");
    }

    #[test]
    fn prepare_synthetic_records_the_main_tip_in_the_marker() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(60, 12));
        let repo = git2::Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().target().unwrap().to_string();
        assert_eq!(read_marker(&dir).map(|m| m.head), Some(head));
    }

    #[test]
    fn prepare_synthetic_is_deterministic_across_directories() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        ready(&a, &synthetic(60, 12));
        ready(&b, &synthetic(60, 12));
        assert_eq!(
            read_marker(&a).map(|m| m.head),
            read_marker(&b).map(|m| m.head)
        );
    }

    #[test]
    fn prepare_synthetic_first_run_does_not_say_cached() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        let first = ready(&dir, &synthetic(30, 5));
        assert!(
            first.contains(&format!("fixture ready: {}", dir.display()))
                && !first.contains("(cached)"),
            "got {first:?}"
        );
    }

    #[test]
    fn prepare_synthetic_twice_is_cached() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(30, 5));
        let second = ready(&dir, &synthetic(30, 5));
        assert_eq!(
            second,
            format!("fixture ready: {} (cached)\n", dir.display())
        );
    }

    #[test]
    fn prepare_cached_run_leaves_the_directory_untouched() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(30, 5));
        std::fs::write(dir.join("sentinel"), "x").unwrap();
        ready(&dir, &synthetic(30, 5));
        assert!(dir.join("sentinel").is_file());
    }

    #[test]
    fn prepare_refuses_foreign_directory() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mine");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("precious.txt"), "keep").unwrap();
        let err = prepare(&dir, &synthetic(30, 5), &mut Vec::new())
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            format!(
                "{} exists but is not a matching fixture; remove it or choose another directory",
                dir.display()
            )
        );
    }

    #[test]
    fn prepare_refuses_foreign_directory_without_deleting_anything() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mine");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("precious.txt"), "keep").unwrap();
        let _ = prepare(&dir, &synthetic(30, 5), &mut Vec::new());
        assert!(dir.join("precious.txt").is_file());
    }

    #[test]
    fn prepare_refuses_when_the_params_differ_and_keeps_the_fixture() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fx");
        ready(&dir, &synthetic(30, 5));
        let err = prepare(&dir, &synthetic(31, 5), &mut Vec::new());
        assert!(
            err.is_err() && git2::Repository::open(&dir).is_ok(),
            "must refuse and keep the old fixture"
        );
    }

    // prepare public-graph against a local bare source (never the network).
    #[test]
    fn prepare_public_graph_trims_local_history() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 5 });
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(count_from_head(&repo), 5);
    }

    #[test]
    fn public_graph_trim_leaves_only_the_bench_ref() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 5 });
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(all_refs(&repo), vec!["refs/heads/bench".to_string()]);
    }

    #[test]
    fn public_graph_trim_points_head_at_the_bench_branch() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 5 });
        let repo = git2::Repository::open(&dir).unwrap();
        let target = repo
            .find_reference("HEAD")
            .unwrap()
            .symbolic_target()
            .map(String::from);
        assert_eq!(target, Some("refs/heads/bench".to_string()));
    }

    #[test]
    fn public_graph_marker_records_the_fifth_oldest_commit() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, oids) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 5 });
        assert_eq!(read_marker(&dir).map(|m| m.head), Some(oids[4].to_string()));
    }

    #[test]
    fn prepare_public_graph_without_trim_when_short() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 50 });
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(count_from_head(&repo), 12);
    }

    #[test]
    fn public_graph_marker_records_the_real_tip_when_short() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, oids) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        ready(&dir, &FixtureSpec::PublicGraph { url, commits: 50 });
        assert_eq!(
            read_marker(&dir).map(|m| m.head),
            Some(oids[11].to_string())
        );
    }

    #[test]
    fn prepare_public_graph_twice_is_cached() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("g");
        let spec = FixtureSpec::PublicGraph { url, commits: 5 };
        ready(&dir, &spec);
        assert!(ready(&dir, &spec).ends_with("(cached)\n"));
    }

    // prepare public-worktree: a depth-1 clone with files checked out.
    #[test]
    fn prepare_public_worktree_clones_depth_1() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("w");
        ready(&dir, &FixtureSpec::PublicWorktree { url });
        let repo = git2::Repository::open(&dir).unwrap();
        assert_eq!(count_from_head(&repo), 1);
    }

    #[test]
    fn public_worktree_has_the_files_checked_out() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("w");
        ready(&dir, &FixtureSpec::PublicWorktree { url });
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).ok(),
            Some("v11\n".to_string())
        );
    }

    #[test]
    fn public_worktree_marker_records_the_tip() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (url, oids) = make_source_repo(&tmp.path().join("src.git"), 12);
        let dir = tmp.path().join("w");
        ready(&dir, &FixtureSpec::PublicWorktree { url });
        assert_eq!(
            read_marker(&dir).map(|m| (m.kind, m.head)),
            Some((FixtureKind::PublicWorktree, oids[11].to_string()))
        );
    }

    // A failed git step reports its arguments and cleans up only what it created.
    #[test]
    fn failed_clone_removes_partial_dir_and_reports_args() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("w");
        let spec = FixtureSpec::PublicWorktree {
            url: format!("file://{}", tmp.path().join("no-such-source.git").display()),
        };
        let err = prepare(&dir, &spec, &mut Vec::new())
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("git clone ") && err.contains(" failed: ") && !dir.exists(),
            "got {err:?}, dir exists: {}",
            dir.exists()
        );
    }

    #[test]
    fn failed_clone_leaves_no_marker() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("g");
        let spec = FixtureSpec::PublicGraph {
            url: format!("file://{}", tmp.path().join("no-such-source.git").display()),
            commits: 5,
        };
        let _ = prepare(&dir, &spec, &mut Vec::new());
        assert!(!marker_path(&dir).exists());
    }
}
