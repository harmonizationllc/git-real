//! Integration tests for the debounced repository file watcher.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use git_real_lib::watcher::{RepoWatcher, is_relevant};

const DEBOUNCE: Duration = Duration::from_millis(100);

fn counter() -> Arc<AtomicUsize> {
    Arc::new(AtomicUsize::new(0))
}

fn start(dir: &Path, count: &Arc<AtomicUsize>) -> RepoWatcher {
    let count = Arc::clone(count);
    RepoWatcher::start(dir, None, DEBOUNCE, move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
    .expect("start watcher")
}

/// Polls until the counter reaches `target` or one second passes.
fn wait_for(count: &AtomicUsize, target: usize) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while count.load(Ordering::SeqCst) < target && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn settle() {
    std::thread::sleep(Duration::from_millis(400));
}

fn write_burst(dir: &Path, prefix: &str) {
    for i in 0..5 {
        std::fs::write(dir.join(format!("{prefix}{i}.txt")), "x").expect("write file");
    }
}

fn dir_with_git_objects() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("create temp dir");
    std::fs::create_dir_all(dir.path().join(".git/objects/aa")).expect("create .git/objects/aa");
    dir
}

// Debounce: a burst of writes collapses into a single notification.
#[test]
fn watcher_emits_once_for_burst() {
    let dir = tempfile::tempdir().unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    write_burst(dir.path(), "f");
    wait_for(&count, 1);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn watcher_emits_again_after_quiet_period() {
    let dir = tempfile::tempdir().unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    write_burst(dir.path(), "a");
    wait_for(&count, 1);
    std::thread::sleep(Duration::from_millis(300));
    write_burst(dir.path(), "b");
    wait_for(&count, 2);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[test]
fn watcher_emits_for_change_in_nested_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src/deep")).unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join("src/deep/mod.rs"), "x").unwrap();
    wait_for(&count, 1);

    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// Noise filtering: object-store writes and lock files never notify.
#[test]
fn watcher_ignores_git_objects() {
    let dir = dir_with_git_objects();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join(".git/objects/aa/bbcc"), "x").unwrap();
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn watcher_ignores_lock_files() {
    let dir = dir_with_git_objects();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join(".git/index.lock"), "x").unwrap();
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn watcher_emits_for_git_index_change() {
    let dir = dir_with_git_objects();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join(".git/index"), "x").unwrap();
    wait_for(&count, 1);

    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// git updates the index by renaming index.lock onto index.
#[test]
fn watcher_emits_exactly_once_when_index_lock_renamed_onto_index() {
    let dir = dir_with_git_objects();
    std::fs::write(dir.path().join(".git/index.lock"), "x").unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::rename(
        dir.path().join(".git/index.lock"),
        dir.path().join(".git/index"),
    )
    .unwrap();
    wait_for(&count, 1);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// Lock files are ignored only under .git; a root Cargo.lock is a real change.
#[test]
fn watcher_emits_for_root_lock_file() {
    let dir = tempfile::tempdir().unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join("Cargo.lock"), "x").unwrap();
    wait_for(&count, 1);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// Dropping inside the debounce window cancels the pending notification.
#[test]
fn watcher_drop_while_pending_emits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let count = counter();
    let watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    drop(watcher);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

// Lifecycle: dropping the watcher stops notifications; a bad root is an error.
#[test]
fn watcher_stops_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let count = counter();
    let watcher = start(dir.path(), &count);
    drop(watcher);
    let before = count.load(Ordering::SeqCst);

    write_burst(dir.path(), "late");
    settle();

    assert_eq!(count.load(Ordering::SeqCst), before);
}

#[test]
fn watcher_start_fails_for_missing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");

    let result = RepoWatcher::start(&missing, None, DEBOUNCE, || {});

    assert!(result.is_err());
}

// is_relevant: pure path classification relative to the workdir.
#[test]
fn is_relevant_rules() {
    let w = Path::new("/w");
    let cases = [
        ("/w/src/a.rs", true),
        ("/w/README.md", true),
        ("/w/.git/index", true),
        ("/w/.git/HEAD", true),
        ("/w/.git/refs/heads/main", true),
        ("/w/.git/refs/stash", true),
        ("/w/.git/logs/refs/stash", true),
        ("/w/.git/objects/aa/bbcc", false),
        ("/w/.git/objects", false),
        ("/w/.git/worktrees", true),
        ("/w/.git/worktrees/a", false),
        ("/w/.git/worktrees/a/HEAD", true),
        ("/w/.git/index.lock", false),
        ("/w/.git/refs/heads/main.lock", false),
        ("/w/Cargo.lock", true),
        ("/w/sub/yarn.lock", true),
        ("/elsewhere/file.txt", true),
    ];
    let actual: Vec<(&str, bool)> = cases
        .iter()
        .map(|(p, _)| (*p, is_relevant(w, None, Path::new(p))))
        .collect();
    assert_eq!(actual, cases);
}

// Windows reports a Modify for the parent directory whose last-write time
// changed (creating `.git/index.lock` touches `.git`); the child event is
// classified on its own, so the directory itself is noise.
#[test]
fn is_relevant_ignores_the_dot_git_directory_itself() {
    let w = Path::new("/w");
    assert!(!is_relevant(w, None, &w.join(".git")));
    assert!(is_relevant(w, None, &w.join(".git/HEAD")));
    assert!(is_relevant(w, None, &w.join(".git/refs/heads/main")));
    assert!(is_relevant(w, None, &w.join("src/a.rs")));
    assert!(is_relevant(w, None, w));
}

#[test]
fn is_relevant_ignores_the_extra_root_itself() {
    let w = Path::new("/w");
    let e = Path::new("/common/.git");
    assert!(!is_relevant(w, Some(e), e));
    assert!(is_relevant(w, Some(e), &e.join("HEAD")));
    assert!(is_relevant(w, Some(e), &e.join("refs/heads/main")));
}

#[test]
fn is_relevant_allows_objects_directory_outside_dot_git() {
    assert!(is_relevant(
        Path::new("/w"),
        None,
        Path::new("/w/vendor/objects/a.txt")
    ));
}

#[test]
fn is_relevant_root_lock_file_is_relevant() {
    assert!(is_relevant(
        Path::new("/w"),
        None,
        Path::new("/w/Cargo.lock")
    ));
}

#[test]
fn is_relevant_path_outside_workdir_is_relevant() {
    assert!(is_relevant(
        Path::new("/w"),
        None,
        Path::new("/other/x.lock")
    ));
}

// Coverage audit additions.
#[test]
fn is_relevant_nested_dot_git_and_lookalike_names() {
    let w = Path::new("/w");
    let cases = [
        // Only the top-level .git is special; a nested one (submodule, vendored repo) is not.
        ("/w/sub/.git/objects/aa/bb", true),
        ("/w/sub/.git/index.lock", true),
        // Matching is by path component, not string prefix.
        ("/w/.gitignore", true),
        ("/w/.github/workflows/ci.yml", true),
        ("/w/.github/deps.lock", true),
        ("/w/.git/objects-extra/x", true),
        ("/w/.git/objects/pack/pack-1.pack", false),
        // Only the `lock` extension counts.
        ("/w/.git/index.lock.bak", true),
        ("/w/.git/lockfile", true),
        ("/w/.git/packed-refs.lock", false),
        ("/w/.git/HEAD.lock", false),
        // The workdir itself.
        ("/w", true),
    ];
    let actual: Vec<(&str, bool)> = cases
        .iter()
        .map(|(p, _)| (*p, is_relevant(w, None, Path::new(p))))
        .collect();
    assert_eq!(actual, cases);
}

#[test]
fn watcher_ignores_read_only_access() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    let _ = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
    let _ = std::fs::read_dir(dir.path().join("sub")).unwrap().count();
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn watcher_ignored_write_then_relevant_write_emits_once() {
    let dir = dir_with_git_objects();
    let count = counter();
    let _watcher = start(dir.path(), &count);

    std::fs::write(dir.path().join(".git/objects/aa/bbcc"), "x").unwrap();
    std::fs::write(dir.path().join("real.txt"), "x").unwrap();
    wait_for(&count, 1);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// An ignored event inside the quiet window still restarts it, so a trickle of noise
// delays the notification instead of firing mid-burst.
#[test]
fn watcher_noise_during_pending_window_postpones_notification() {
    let dir = dir_with_git_objects();
    let count = counter();
    let c = Arc::clone(&count);
    let _watcher = RepoWatcher::start(dir.path(), None, Duration::from_millis(400), move || {
        c.fetch_add(1, Ordering::SeqCst);
    })
    .expect("start watcher");

    std::fs::write(dir.path().join("real.txt"), "x").unwrap();
    for i in 0..8 {
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(dir.path().join(format!(".git/objects/aa/n{i}")), "x").unwrap();
    }
    let during = count.load(Ordering::SeqCst);
    wait_for_long(&count, 1);

    assert_eq!((during, count.load(Ordering::SeqCst)), (0, 1));
}

fn wait_for_long(count: &AtomicUsize, target: usize) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while count.load(Ordering::SeqCst) < target && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

// A plain file as the root is accepted (inotify watches files too) and reports edits to it.
#[test]
fn watcher_start_on_a_file_watches_that_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("plain.txt");
    std::fs::write(&file, "x").unwrap();
    let count = counter();
    let _watcher = start(&file, &count);

    std::fs::write(&file, "changed").unwrap();
    wait_for(&count, 1);

    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// GR-39: a linked worktree's common dir is watched as a second root.
#[test]
fn is_relevant_extra_root_rules() {
    let w = Path::new("/w");
    let extra = Some(Path::new("/c"));
    let cases = [
        ("/c/HEAD", true),
        ("/c/refs/heads/main", true),
        ("/c/worktrees/a/HEAD", true),
        ("/c/worktrees/a", false),
        ("/c/worktrees", true),
        ("/c/objects/aa/bb", false),
        ("/c/index.lock", false),
        ("/c/refs/heads/main.lock", false),
        ("/elsewhere/x", true),
        // The workdir rules still apply under the workdir.
        ("/w/.git/objects/aa/bb", false),
        ("/w/src/a.rs", true),
    ];
    let actual: Vec<(&str, bool)> = cases
        .iter()
        .map(|(p, _)| (*p, is_relevant(w, extra, Path::new(p))))
        .collect();
    assert_eq!(actual, cases);
}

fn start_with_extra(dir: &Path, extra: &Path, count: &Arc<AtomicUsize>) -> RepoWatcher {
    let count = Arc::clone(count);
    RepoWatcher::start(dir, Some(extra), DEBOUNCE, move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
    .expect("start watcher")
}

#[test]
fn start_with_extra_root_fires_for_a_change_there() {
    let dir = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    let count = counter();
    let _watcher = start_with_extra(dir.path(), extra.path(), &count);

    std::fs::write(extra.path().join("HEAD"), "x").unwrap();
    wait_for(&count, 1);
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn start_with_extra_root_ignores_objects_there() {
    let dir = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(extra.path().join("objects/aa")).unwrap();
    let count = counter();
    let _watcher = start_with_extra(dir.path(), extra.path(), &count);

    std::fs::write(extra.path().join("objects/aa/bbcc"), "x").unwrap();
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn start_with_extra_root_ignores_lock_files_in_a_worktree_gitdir() {
    let dir = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(extra.path().join("worktrees/a")).unwrap();
    settle();
    let count = counter();
    let _watcher = start_with_extra(dir.path(), extra.path(), &count);

    std::fs::write(extra.path().join("worktrees/a/index.lock"), "x").unwrap();
    settle();

    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn start_with_a_missing_extra_root_still_watches_the_workdir() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let missing = elsewhere.path().join("does-not-exist");
    let count = counter();
    let _watcher = start_with_extra(dir.path(), &missing, &count);

    std::fs::write(dir.path().join("f.txt"), "x").unwrap();
    wait_for(&count, 1);

    assert_eq!(count.load(Ordering::SeqCst), 1);
}
