//! Integration tests for `RepoRegistry`.

mod common;

use git_real_core::RepoSession;
use git_real_lib::state::RepoRegistry;
use std::path::PathBuf;
use tempfile::TempDir;

fn session() -> (TempDir, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    let session = RepoSession::open(&path).expect("open fixture repo");
    (dir, session)
}

// register / get: ids start at 1 and increase; ids are never reused.
#[test]
fn registry_register_then_get() {
    let (_dir, s) = session();
    let expected = s.path().to_path_buf();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    assert_eq!((id, registry.get(id).is_some()), (1, true));
    let got = registry.get(id).unwrap();
    assert_eq!(got.lock().unwrap().path(), expected);
}

#[test]
fn registry_ids_are_unique_and_increasing() {
    let (_d1, s1) = session();
    let (_d2, s2) = session();
    let (_d3, s3) = session();
    let registry = RepoRegistry::default();
    let ids = [
        registry.register(s1),
        registry.register(s2),
        registry.register(s3),
    ];
    assert_eq!(ids, [1, 2, 3]);
}

#[test]
fn registry_ids_not_reused_after_remove() {
    let (_d1, s1) = session();
    let (_d2, s2) = session();
    let registry = RepoRegistry::default();
    let first = registry.register(s1);
    registry.remove(first);
    assert_eq!(registry.register(s2), 2);
}

#[test]
fn registry_get_unknown_is_none() {
    let registry = RepoRegistry::default();
    assert!(registry.get(1).is_none());
}

// remove
#[test]
fn registry_remove_twice() {
    let (_dir, s) = session();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    let results = (registry.remove(id), registry.remove(id));
    assert_eq!(results, (true, false));
}

#[test]
fn registry_get_is_none_after_remove() {
    let (_dir, s) = session();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    registry.remove(id);
    assert!(registry.get(id).is_none());
}

#[test]
fn registry_remove_unknown_is_false() {
    let registry = RepoRegistry::default();
    assert!(!registry.remove(7));
}

// find_by_path
#[test]
fn registry_find_by_path() {
    let (_dir, s) = session();
    let path = s.path().to_path_buf();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    assert_eq!(registry.find_by_path(&path), Some(id));
}

#[test]
fn registry_find_by_path_unknown_is_none() {
    let (_dir, s) = session();
    let registry = RepoRegistry::default();
    registry.register(s);
    assert_eq!(
        registry.find_by_path(&PathBuf::from("/definitely/not/registered")),
        None
    );
}

#[test]
fn registry_find_by_path_is_none_after_remove() {
    let (_dir, s) = session();
    let path = s.path().to_path_buf();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    registry.remove(id);
    assert_eq!(registry.find_by_path(&path), None);
}

// D4: find_by_path must not lock sessions. Holding the session guard on this
// thread would self-deadlock a naive implementation.
#[test]
fn registry_find_by_path_does_not_block_on_locked_session() {
    let (_dir, s) = session();
    let path = s.path().to_path_buf();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    let session = registry.get(id).unwrap();
    let _guard = session.lock().unwrap();
    assert_eq!(registry.find_by_path(&path), Some(id));
}
