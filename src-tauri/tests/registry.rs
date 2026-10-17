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

// Coverage additions: a panic while a session lock is held must not break the registry.
#[test]
fn registry_survives_panic_while_session_lock_held() {
    let (_dir, s) = session();
    let path = s.path().to_path_buf();
    let registry = RepoRegistry::default();
    let id = registry.register(s);
    let session = registry.get(id).unwrap();
    let _ = std::thread::spawn(move || {
        let _guard = session.lock().unwrap();
        panic!("poison the session lock");
    })
    .join();
    assert_eq!(
        (
            registry.get(id).is_some(),
            registry.find_by_path(&path),
            registry.remove(id)
        ),
        (true, Some(id), true)
    );
}

#[test]
fn registry_concurrent_registers_yield_unique_ids() {
    let registry = std::sync::Arc::new(RepoRegistry::default());
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let registry = std::sync::Arc::clone(&registry);
            std::thread::spawn(move || {
                let (_dir, s) = session();
                (registry.register(s), _dir)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let mut ids: Vec<u64> = results.iter().map(|(id, _)| *id).collect();
    ids.sort();
    assert_eq!(ids, (1..=8).collect::<Vec<u64>>());
}

#[test]
fn registry_find_by_path_distinguishes_sessions() {
    let (_d1, s1) = session();
    let (_d2, s2) = session();
    let (p1, p2) = (s1.path().to_path_buf(), s2.path().to_path_buf());
    let registry = RepoRegistry::default();
    let (id1, id2) = (registry.register(s1), registry.register(s2));
    assert_eq!(
        (registry.find_by_path(&p1), registry.find_by_path(&p2)),
        (Some(id1), Some(id2))
    );
}

// register_or_find: atomic dedupe by canonical path (GR-4 Task 1).
#[test]
fn register_or_find_returns_existing_id_for_same_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    let first = RepoSession::open(&path).expect("open fixture repo");
    let second = RepoSession::open(&path).expect("open fixture repo again");
    let registry = RepoRegistry::default();
    let (first_id, _) = registry.register_or_find(first);
    assert_eq!(registry.register_or_find(second), (first_id, false));
}

#[test]
fn register_or_find_same_path_keeps_find_by_path_pointing_at_first_id() {
    let (_dir, path) = common::temp_repo_with_commit();
    let first = RepoSession::open(&path).expect("open fixture repo");
    let canonical = first.path().to_path_buf();
    let second = RepoSession::open(&path).expect("open fixture repo again");
    let registry = RepoRegistry::default();
    let (first_id, _) = registry.register_or_find(first);
    registry.register_or_find(second);
    assert_eq!(registry.find_by_path(&canonical), Some(first_id));
}

// A dedupe hit must not consume an id: insert A, dedupe A, insert B => B is 2.
#[test]
fn register_or_find_dedupe_hit_does_not_burn_an_id() {
    let (_dir_a, path_a) = common::temp_repo_with_commit();
    let (_dir_b, path_b) = common::temp_repo_with_commit();
    let registry = RepoRegistry::default();
    registry.register_or_find(RepoSession::open(&path_a).expect("open a"));
    registry.register_or_find(RepoSession::open(&path_a).expect("open a again"));
    let (id_b, inserted) = registry.register_or_find(RepoSession::open(&path_b).expect("open b"));
    assert_eq!((id_b, inserted), (2, true));
}

#[test]
fn register_or_find_distinct_paths_get_distinct_ids() {
    let (_d1, s1) = session();
    let (_d2, s2) = session();
    let registry = RepoRegistry::default();
    let (id1, _) = registry.register_or_find(s1);
    let (id2, inserted) = registry.register_or_find(s2);
    assert_eq!((id1, id2, inserted), (1, 2, true));
}

#[test]
fn register_or_find_inserts_new_path() {
    let (_dir, s) = session();
    let registry = RepoRegistry::default();
    let (id, inserted) = registry.register_or_find(s);
    assert_eq!((id, inserted, registry.get(id).is_some()), (1, true, true));
}

#[test]
fn register_or_find_is_atomic_under_concurrency() {
    let (_dir, path) = common::temp_repo_with_commit();
    let registry = RepoRegistry::default();
    let results: Vec<(u64, bool)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    let s = RepoSession::open(&path).expect("open fixture repo");
                    registry.register_or_find(s)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let first_id = results[0].0;
    let all_same = results.iter().all(|(id, _)| *id == first_id);
    let inserted = results.iter().filter(|(_, new)| *new).count();
    assert_eq!(
        (all_same, inserted, registry.get(first_id).is_some()),
        (true, 1, true)
    );
}

#[test]
fn register_or_find_leaves_single_entry_after_concurrent_calls() {
    let (_dir, path) = common::temp_repo_with_commit();
    let canonical = std::fs::canonicalize(&path).expect("canonicalize fixture");
    let registry = RepoRegistry::default();
    let ids: Vec<u64> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    let s = RepoSession::open(&path).expect("open fixture repo");
                    registry.register_or_find(s).0
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let removed = registry.remove(ids[0]);
    assert_eq!((removed, registry.find_by_path(&canonical)), (true, None));
}
