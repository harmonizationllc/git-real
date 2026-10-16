use std::path::{Path, PathBuf};

use git_real_core::recent::MAX_ENTRIES;
use git_real_core::{RecentEntry, RecentRepos};
use serde_json::json;

fn p(name: &str) -> PathBuf {
    PathBuf::from(format!("/r/{name}"))
}

fn touch(repos: &mut RecentRepos, name: &str, now: u64) {
    repos.touch(p(name), name.to_string(), now);
}

fn paths(repos: &RecentRepos) -> Vec<PathBuf> {
    repos.entries().iter().map(|e| e.path.clone()).collect()
}

fn entry(name: &str, now: u64) -> RecentEntry {
    RecentEntry {
        path: p(name),
        name: name.to_string(),
        last_opened: now,
    }
}

// --- defaults and constants ---

#[test]
fn default_is_empty() {
    assert!(RecentRepos::default().entries().is_empty());
}

#[test]
fn max_entries_is_twenty() {
    assert_eq!(MAX_ENTRIES, 20);
}

// --- touch: insertion and ordering ---

#[test]
fn touch_inserts_at_front() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    touch(&mut repos, "b", 2);
    assert_eq!(repos.entries(), &[entry("b", 2), entry("a", 1)]);
}

#[test]
fn touch_existing_moves_to_front_and_updates_time() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    touch(&mut repos, "b", 2);
    touch(&mut repos, "a", 3);
    assert_eq!(repos.entries(), &[entry("a", 3), entry("b", 2)]);
}

#[test]
fn touch_same_path_twice_keeps_one_entry_with_new_name() {
    let mut repos = RecentRepos::default();
    repos.touch(p("a"), "old".to_string(), 1);
    repos.touch(p("a"), "new".to_string(), 2);
    let expected = RecentEntry {
        path: p("a"),
        name: "new".to_string(),
        last_opened: 2,
    };
    assert_eq!(repos.entries(), &[expected]);
}

#[test]
fn touch_orders_by_call_not_by_timestamp() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 10);
    touch(&mut repos, "b", 5);
    assert_eq!(paths(&repos), vec![p("b"), p("a")]);
}

#[test]
fn touch_treats_trailing_slash_as_same_path() {
    let mut repos = RecentRepos::default();
    repos.touch(PathBuf::from("/r/a"), "a".to_string(), 1);
    repos.touch(PathBuf::from("/r/a/"), "a".to_string(), 2);
    assert_eq!(repos.entries().len(), 1);
}

#[test]
fn touch_does_not_canonicalize_dot_dot_paths() {
    let mut repos = RecentRepos::default();
    repos.touch(PathBuf::from("/r/a"), "a".to_string(), 1);
    repos.touch(PathBuf::from("/r/../r/a"), "a".to_string(), 2);
    assert_eq!(repos.entries().len(), 2);
}

// --- touch: capacity ---

#[test]
fn touch_caps_at_max_entries() {
    let mut repos = RecentRepos::default();
    for i in 0..25u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    assert_eq!(repos.entries().len(), MAX_ENTRIES);
}

#[test]
fn touch_over_cap_drops_the_oldest_five() {
    let mut repos = RecentRepos::default();
    for i in 0..25u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    let kept = paths(&repos);
    let dropped: Vec<PathBuf> = (0..5).map(|i| p(&format!("repo{i}"))).collect();
    assert!(dropped.iter().all(|d| !kept.contains(d)));
}

#[test]
fn touch_over_cap_keeps_newest_at_front() {
    let mut repos = RecentRepos::default();
    for i in 0..25u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    assert_eq!(repos.entries()[0].path, p("repo24"));
}

#[test]
fn touch_at_exactly_max_entries_evicts_nothing() {
    let mut repos = RecentRepos::default();
    for i in 0..MAX_ENTRIES as u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    assert!(paths(&repos).contains(&p("repo0")));
}

#[test]
fn touch_existing_in_full_list_does_not_evict() {
    let mut repos = RecentRepos::default();
    for i in 0..MAX_ENTRIES as u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    touch(&mut repos, "repo0", 100);
    assert_eq!(repos.entries().len(), MAX_ENTRIES);
}

#[test]
fn touch_existing_in_full_list_moves_it_to_front() {
    let mut repos = RecentRepos::default();
    for i in 0..MAX_ENTRIES as u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    touch(&mut repos, "repo0", 100);
    assert_eq!(repos.entries()[0], entry("repo0", 100));
}

#[test]
fn touch_existing_in_full_list_keeps_the_newest_other_entry() {
    let mut repos = RecentRepos::default();
    for i in 0..MAX_ENTRIES as u64 {
        touch(&mut repos, &format!("repo{i}"), i);
    }
    touch(&mut repos, "repo0", 100);
    assert!(paths(&repos).contains(&p("repo1")));
}

// --- remove ---

#[test]
fn remove_present_returns_true() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    assert!(repos.remove(&p("a")));
}

#[test]
fn remove_present_deletes_the_entry() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    repos.remove(&p("a"));
    assert!(repos.entries().is_empty());
}

#[test]
fn remove_absent_returns_false() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    assert!(!repos.remove(&p("zzz")));
}

#[test]
fn remove_absent_leaves_entries_unchanged() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    repos.remove(&p("zzz"));
    assert_eq!(repos.entries(), &[entry("a", 1)]);
}

#[test]
fn remove_from_empty_list_returns_false() {
    let mut repos = RecentRepos::default();
    assert!(!repos.remove(Path::new("/r/a")));
}

#[test]
fn remove_preserves_order_of_others() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    touch(&mut repos, "b", 2);
    touch(&mut repos, "c", 3);
    repos.remove(&p("b"));
    assert_eq!(paths(&repos), vec![p("c"), p("a")]);
}

#[test]
fn remove_twice_returns_false_the_second_time() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    repos.remove(&p("a"));
    assert!(!repos.remove(&p("a")));
}

// --- serde ---

#[test]
fn serde_round_trip() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    touch(&mut repos, "b", 2);
    let text = serde_json::to_string(&repos).unwrap();
    let back: RecentRepos = serde_json::from_str(&text).unwrap();
    assert_eq!(back, repos);
}

#[test]
fn serde_round_trip_of_empty_list() {
    let repos = RecentRepos::default();
    let text = serde_json::to_string(&repos).unwrap();
    let back: RecentRepos = serde_json::from_str(&text).unwrap();
    assert_eq!(back, repos);
}

#[test]
fn serialized_shape_is_entries_object_with_camel_case() {
    let mut repos = RecentRepos::default();
    repos.touch(PathBuf::from("/r/a"), "a".to_string(), 5);
    let value = serde_json::to_value(&repos).unwrap();
    assert_eq!(
        value,
        json!({"entries": [{"path": "/r/a", "name": "a", "lastOpened": 5}]})
    );
}

#[test]
fn deserialize_reads_camel_case_last_opened() {
    let value = json!({"entries": [{"path": "/r/a", "name": "a", "lastOpened": 7}]});
    let repos: RecentRepos = serde_json::from_value(value).unwrap();
    assert_eq!(repos.entries(), &[entry("a", 7)]);
}

#[test]
fn deserialize_empty_object_is_default() {
    let repos: RecentRepos = serde_json::from_str("{}").unwrap();
    assert_eq!(repos, RecentRepos::default());
}

#[test]
fn deserialize_ignores_unknown_fields() {
    let result = serde_json::from_str::<RecentRepos>(r#"{"entries":[],"future":1}"#);
    assert!(result.is_ok());
}

#[test]
fn deserialize_rejects_snake_case_last_opened() {
    let value = json!({"entries": [{"path": "/r/a", "name": "a", "last_opened": 7}]});
    assert!(serde_json::from_value::<RecentRepos>(value).is_err());
}

#[test]
fn deserialize_rejects_negative_timestamp() {
    let value = json!({"entries": [{"path": "/r/a", "name": "a", "lastOpened": -1}]});
    assert!(serde_json::from_value::<RecentRepos>(value).is_err());
}

#[test]
fn deserialize_rejects_non_object_document() {
    assert!(serde_json::from_str::<RecentRepos>("[]").is_err());
}

#[test]
fn deserialize_rejects_entry_missing_name() {
    let value = json!({"entries": [{"path": "/r/a", "lastOpened": 1}]});
    assert!(serde_json::from_value::<RecentRepos>(value).is_err());
}

// --- derives needed by callers ---

#[test]
fn cloned_list_is_equal_and_independent() {
    let mut repos = RecentRepos::default();
    touch(&mut repos, "a", 1);
    let copy = repos.clone();
    repos.remove(&p("a"));
    assert_eq!(copy.entries(), &[entry("a", 1)]);
}

// --- serde: leniency and strictness edges ---

#[test]
fn deserialize_ignores_unknown_entry_fields() {
    let value = json!({"entries": [{"path": "/r/a", "name": "a", "lastOpened": 1, "extra": true}]});
    let repos: RecentRepos = serde_json::from_value(value).unwrap();
    assert_eq!(repos.entries(), &[entry("a", 1)]);
}

#[test]
fn deserialize_unknown_top_level_key_keeps_entries() {
    let value =
        json!({"future": {"x": 1}, "entries": [{"path": "/r/a", "name": "a", "lastOpened": 1}]});
    let repos: RecentRepos = serde_json::from_value(value).unwrap();
    assert_eq!(repos.entries(), &[entry("a", 1)]);
}

#[test]
fn deserialize_empty_entries_array_is_default() {
    let repos: RecentRepos = serde_json::from_str(r#"{"entries":[]}"#).unwrap();
    assert_eq!(repos, RecentRepos::default());
}

#[test]
fn deserialize_preserves_entry_order_from_file() {
    let value = json!({"entries": [
        {"path": "/r/b", "name": "b", "lastOpened": 1},
        {"path": "/r/a", "name": "a", "lastOpened": 9}
    ]});
    let repos: RecentRepos = serde_json::from_value(value).unwrap();
    assert_eq!(paths(&repos), vec![p("b"), p("a")]);
}

#[test]
fn deserialize_rejects_scalar_and_null_documents() {
    for text in ["null", "42", r#""entries""#, "true"] {
        assert!(
            serde_json::from_str::<RecentRepos>(text).is_err(),
            "{text} should be rejected"
        );
    }
}

#[test]
fn deserialize_rejects_entries_that_is_not_an_array() {
    assert!(serde_json::from_str::<RecentRepos>(r#"{"entries":{}}"#).is_err());
}

#[test]
fn deserialize_rejects_entry_missing_path() {
    let value = json!({"entries": [{"name": "a", "lastOpened": 1}]});
    assert!(serde_json::from_value::<RecentRepos>(value).is_err());
}

#[test]
fn deserialize_rejects_entry_missing_last_opened() {
    let value = json!({"entries": [{"path": "/r/a", "name": "a"}]});
    assert!(serde_json::from_value::<RecentRepos>(value).is_err());
}

// --- behaviour on hand-edited data ---

#[test]
fn touch_on_deserialized_over_cap_list_truncates_to_max() {
    let entries: Vec<_> = (0..25)
        .map(|i| json!({"path": format!("/r/old{i}"), "name": "o", "lastOpened": i}))
        .collect();
    let mut repos: RecentRepos = serde_json::from_value(json!({ "entries": entries })).unwrap();
    touch(&mut repos, "new", 99);
    assert_eq!(repos.entries().len(), MAX_ENTRIES);
    assert_eq!(repos.entries()[0], entry("new", 99));
}

#[test]
fn remove_deletes_every_duplicate_from_hand_edited_data() {
    let value = json!({"entries": [
        {"path": "/r/a", "name": "a", "lastOpened": 2},
        {"path": "/r/b", "name": "b", "lastOpened": 1},
        {"path": "/r/a", "name": "a", "lastOpened": 0}
    ]});
    let mut repos: RecentRepos = serde_json::from_value(value).unwrap();
    assert!(repos.remove(&p("a")));
    assert_eq!(repos.entries(), &[entry("b", 1)]);
}

#[test]
fn touch_on_hand_edited_duplicates_collapses_them_to_one() {
    let value = json!({"entries": [
        {"path": "/r/a", "name": "a", "lastOpened": 2},
        {"path": "/r/a", "name": "a", "lastOpened": 0}
    ]});
    let mut repos: RecentRepos = serde_json::from_value(value).unwrap();
    touch(&mut repos, "a", 5);
    assert_eq!(repos.entries(), &[entry("a", 5)]);
}
