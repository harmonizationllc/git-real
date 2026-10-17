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
    RepoWatcher::start(dir, DEBOUNCE, move || {
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

    assert!(count.load(Ordering::SeqCst) >= 1);
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

    assert!(count.load(Ordering::SeqCst) >= 1);
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

    let result = RepoWatcher::start(&missing, DEBOUNCE, || {});

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
        ("/w/.git/objects/aa/bbcc", false),
        ("/w/.git/objects", false),
        ("/w/.git/index.lock", false),
        ("/w/.git/refs/heads/main.lock", false),
        ("/w/Cargo.lock", true),
        ("/w/sub/yarn.lock", true),
        ("/elsewhere/file.txt", true),
    ];
    let actual: Vec<(&str, bool)> = cases
        .iter()
        .map(|(p, _)| (*p, is_relevant(w, Path::new(p))))
        .collect();
    assert_eq!(actual, cases);
}

#[test]
fn is_relevant_allows_objects_directory_outside_dot_git() {
    assert!(is_relevant(
        Path::new("/w"),
        Path::new("/w/vendor/objects/a.txt")
    ));
}

#[test]
fn is_relevant_root_lock_file_is_relevant() {
    assert!(is_relevant(Path::new("/w"), Path::new("/w/Cargo.lock")));
}

#[test]
fn is_relevant_path_outside_workdir_is_relevant() {
    assert!(is_relevant(Path::new("/w"), Path::new("/other/x.lock")));
}
