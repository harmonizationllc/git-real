//! Integration tests for `RecentStore`.

mod common;

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use git_real_core::{RecentEntry, RecentRepos};
use git_real_lib::recent_store::RecentStore;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn tmp_of(path: &std::path::Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

// load: missing, corrupt, wrong-shape and unreadable files all yield an empty store.
#[test]
fn store_load_missing_file_is_empty() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    assert!(RecentStore::load(path).entries().is_empty());
}

#[test]
fn store_load_missing_file_does_not_create_it() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let _ = RecentStore::load(path.clone());
    assert!(!path.exists());
}

#[test]
fn load_tolerates_corrupt_file() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    fs::write(&path, "{not json").unwrap();
    assert!(RecentStore::load(path).entries().is_empty());
}

#[test]
fn corrupt_file_is_overwritten_with_valid_json_on_next_touch() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    fs::write(&path, "{not json").unwrap();
    RecentStore::load(path.clone()).touch(p("/repo/a"), "a".into());
    let parsed: RecentRepos = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(parsed.entries().len(), 1);
}

#[test]
fn load_tolerates_wrong_shape() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    fs::write(&path, "[]").unwrap();
    assert!(RecentStore::load(path).entries().is_empty());
}

#[test]
fn load_tolerates_unreadable_path() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        RecentStore::load(dir.path().to_path_buf())
            .entries()
            .is_empty()
    );
}

// touch: persists, returns the updated list, stamps unix seconds.
#[test]
fn store_touch_persists_and_reloads() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path.clone());
    store.touch(p("/repo/a"), "a".into());
    drop(store);
    let reloaded = RecentStore::load(path).entries();
    assert_eq!(
        reloaded
            .iter()
            .map(|e| (e.path.clone(), e.name.clone()))
            .collect::<Vec<_>>(),
        vec![(p("/repo/a"), "a".to_string())]
    );
}

#[test]
fn store_touch_stamps_last_opened_in_unix_seconds() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path);
    let before = now_secs();
    let entries = store.touch(p("/repo/a"), "a".into());
    let after = now_secs();
    assert!((before..=after).contains(&entries[0].last_opened));
}

#[test]
fn store_touch_returns_updated_list() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path);
    let returned: Vec<RecentEntry> = store.touch(p("/repo/a"), "a".into());
    assert_eq!(returned, store.entries());
}

#[test]
fn store_save_creates_missing_parent_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a").join("b").join("recent-repos.json");
    RecentStore::load(path.clone()).touch(p("/repo/a"), "a".into());
    assert_eq!(RecentStore::load(path).entries().len(), 1);
}

// remove: persists; unknown path is a no-op.
#[test]
fn store_remove_persists() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path.clone());
    store.touch(p("/repo/a"), "a".into());
    store.touch(p("/repo/b"), "b".into());
    store.remove(&p("/repo/a"));
    let paths: Vec<PathBuf> = RecentStore::load(path)
        .entries()
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, vec![p("/repo/b")]);
}

#[test]
fn store_remove_returns_remaining_entries() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path);
    store.touch(p("/repo/a"), "a".into());
    store.touch(p("/repo/b"), "b".into());
    let returned = store.remove(&p("/repo/a"));
    assert_eq!(returned, store.entries());
}

#[test]
fn store_remove_unknown_path_is_noop() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path);
    let before = store.touch(p("/repo/a"), "a".into());
    assert_eq!(store.remove(&p("/repo/zzz")), before);
}

// File format and atomic write.
#[test]
fn save_writes_pretty_json_with_entries_key() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    RecentStore::load(path.clone()).touch(p("/repo/a"), "a".into());
    let text = fs::read_to_string(&path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(value["entries"].is_array() && text.contains('\n'));
}

#[test]
fn save_leaves_no_tmp_file() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    RecentStore::load(path.clone()).touch(p("/repo/a"), "a".into());
    assert!(!tmp_of(&path).exists());
}

// Save failures are logged and ignored: the in-memory list still updates.
#[test]
fn touch_survives_unwritable_location() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    fs::write(&blocker, "x").unwrap();
    let store = RecentStore::load(blocker.join("recent.json"));
    let returned = store.touch(p("/repo/a"), "a".into());
    assert_eq!(returned, store.entries());
}

#[test]
fn touch_keeps_entry_in_memory_when_location_is_unwritable() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    fs::write(&blocker, "x").unwrap();
    let store = RecentStore::load(blocker.join("recent.json"));
    store.touch(p("/repo/a"), "a".into());
    assert_eq!(store.entries().len(), 1);
}

#[test]
fn touch_survives_rename_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recent.json");
    fs::create_dir_all(path.join("child")).unwrap();
    let store = RecentStore::load(path);
    assert_eq!(store.touch(p("/repo/a"), "a".into()).len(), 1);
}

#[test]
fn rename_failure_cleans_up_tmp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recent.json");
    fs::create_dir_all(path.join("child")).unwrap();
    RecentStore::load(path.clone()).touch(p("/repo/a"), "a".into());
    assert!(!tmp_of(&path).exists());
}

// Coverage additions: empty file, non-UTF-8 save failure, concurrency, file state after failures.
#[test]
fn load_tolerates_empty_file() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    fs::write(&path, "").unwrap();
    assert!(RecentStore::load(path).entries().is_empty());
}

#[test]
fn touch_with_unwritable_location_creates_no_files() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("file");
    fs::write(&blocker, "x").unwrap();
    RecentStore::load(blocker.join("recent.json")).touch(p("/repo/a"), "a".into());
    assert_eq!(fs::read_to_string(&blocker).unwrap(), "x");
}

#[cfg(unix)]
#[test]
fn touch_with_non_utf8_path_logs_and_keeps_entry_in_memory() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path.clone());
    let bad = PathBuf::from(OsStr::from_bytes(b"/repo/\xff\xfe"));
    let returned = store.touch(bad.clone(), "bad".into());
    assert_eq!(
        (
            returned[0].path.clone(),
            path.exists(),
            tmp_of(&path).exists()
        ),
        (bad, false, false)
    );
}

#[cfg(unix)]
#[test]
fn failed_save_leaves_previous_file_intact() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = RecentStore::load(path.clone());
    store.touch(p("/repo/a"), "a".into());
    let before = fs::read_to_string(&path).unwrap();
    store.touch(
        PathBuf::from(OsStr::from_bytes(b"/repo/\xff")),
        "bad".into(),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

#[test]
fn concurrent_touches_leave_consistent_file() {
    let (_dir, path) = common::temp_file_path("recent-repos.json");
    let store = std::sync::Arc::new(RecentStore::load(path.clone()));
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let store = std::sync::Arc::clone(&store);
            std::thread::spawn(move || {
                store.touch(PathBuf::from(format!("/repo/{i}")), format!("r{i}"));
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let mut on_disk: Vec<PathBuf> = RecentStore::load(path)
        .entries()
        .into_iter()
        .map(|e| e.path)
        .collect();
    let mut in_memory: Vec<PathBuf> = store.entries().into_iter().map(|e| e.path).collect();
    on_disk.sort();
    in_memory.sort();
    assert_eq!((on_disk.len(), on_disk), (8, in_memory));
}
