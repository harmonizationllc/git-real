//! Integration tests for the tag command `*_inner` functions (GR-11b).

mod common;

use git_real_core::{RepoSession, TagEntry, TagList};
use git_real_lib::commands::tags::{
    create_tag_inner, delete_remote_tag_inner, delete_tag_inner, list_tags_inner, push_tag_inner,
};
use git_real_lib::error::AppErrorKind;
use git_real_lib::state::{RepoId, RepoRegistry};
use git2::Repository;
use serde_json::json;

const MISSING_ID: RepoId = 4242;

fn setup() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    RepoRegistry,
    RepoId,
    String,
) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string();
    let reg = RepoRegistry::default();
    let id = reg.register(RepoSession::open(&path).unwrap());
    (dir, path, reg, id, head)
}

#[test]
fn list_tags_inner_is_empty_for_a_fresh_repo() {
    let (_d, _p, reg, id, _h) = setup();
    assert_eq!(
        list_tags_inner(&reg, id).unwrap(),
        TagList {
            tags: vec![],
            remotes: vec![]
        }
    );
}

#[test]
fn create_list_and_delete_tags_through_the_commands() {
    if !common::git_available() {
        return;
    }
    let (_d, _p, reg, id, head) = setup();
    create_tag_inner(&reg, id, "light", &head, None).unwrap();
    create_tag_inner(&reg, id, "heavy", &head, Some("Release\n")).unwrap();
    let tags = list_tags_inner(&reg, id).unwrap().tags;
    let heavy = tags.iter().find(|t| t.name == "heavy").unwrap();
    assert!(heavy.annotated && heavy.subject.as_deref() == Some("Release") && heavy.target == head);
    assert!(!tags.iter().find(|t| t.name == "light").unwrap().annotated);
    delete_tag_inner(&reg, id, "light").unwrap();
    delete_tag_inner(&reg, id, "heavy").unwrap();
    assert!(list_tags_inner(&reg, id).unwrap().tags.is_empty());
}

#[test]
fn create_tag_inner_maps_the_new_kinds() {
    let (_d, path, reg, id, head) = setup();
    let oid = git2::Oid::from_str(&head).unwrap();
    {
        let repo = Repository::open(&path).unwrap();
        repo.tag_lightweight("taken", &repo.find_object(oid, None).unwrap(), false)
            .unwrap();
    }
    assert_eq!(
        create_tag_inner(&reg, id, "-x", &head, None)
            .unwrap_err()
            .kind,
        AppErrorKind::InvalidTagName
    );
    assert_eq!(
        create_tag_inner(&reg, id, "taken", &head, None)
            .unwrap_err()
            .kind,
        AppErrorKind::TagExists
    );
    assert_eq!(
        create_tag_inner(&reg, id, "v1", &"f".repeat(40), None)
            .unwrap_err()
            .kind,
        AppErrorKind::CommitNotFound
    );
    assert_eq!(
        create_tag_inner(&reg, id, "v1", &head, Some("  "))
            .unwrap_err()
            .kind,
        AppErrorKind::EmptyMessage
    );
    assert_eq!(
        delete_tag_inner(&reg, id, "ghost").unwrap_err().kind,
        AppErrorKind::TagNotFound
    );
}

#[test]
fn push_tag_and_delete_remote_tag_inner_round_trip() {
    if !common::git_available() {
        return;
    }
    let (_d, path, reg, id, head) = setup();
    let (_bd, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare);
    create_tag_inner(&reg, id, "v1", &head, None).unwrap();
    push_tag_inner(&reg, id, "origin", "v1").unwrap();
    assert!(
        Repository::open_bare(&bare)
            .unwrap()
            .find_reference("refs/tags/v1")
            .is_ok()
    );
    delete_remote_tag_inner(&reg, id, "origin", "v1").unwrap();
    assert!(
        Repository::open_bare(&bare)
            .unwrap()
            .find_reference("refs/tags/v1")
            .is_err()
    );
    let err = delete_remote_tag_inner(&reg, id, "origin", "v1").unwrap_err();
    assert_eq!(err.kind, AppErrorKind::NetworkFailed);
    assert_eq!(err.network.unwrap().verb, "push");
    assert!(
        err.message.contains("remote ref does not exist"),
        "{}",
        err.message
    );
}

#[test]
fn push_commands_map_remote_and_tag_errors() {
    let (_d, path, reg, id, _h) = setup();
    let (_bd, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare);
    assert_eq!(
        push_tag_inner(&reg, id, "nope", "v1").unwrap_err().kind,
        AppErrorKind::RemoteNotFound
    );
    assert_eq!(
        push_tag_inner(&reg, id, "origin", "ghost")
            .unwrap_err()
            .kind,
        AppErrorKind::TagNotFound
    );
    assert_eq!(
        delete_remote_tag_inner(&reg, id, "-x", "v1")
            .unwrap_err()
            .kind,
        AppErrorKind::RemoteNotFound
    );
    assert_eq!(
        delete_remote_tag_inner(&reg, id, "origin", "ghost")
            .unwrap_err()
            .kind,
        AppErrorKind::TagNotFound
    );
}

#[test]
fn tag_commands_report_unknown_repo() {
    let reg = RepoRegistry::default();
    let oid = "a".repeat(40);
    assert_eq!(
        list_tags_inner(&reg, MISSING_ID).unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        create_tag_inner(&reg, MISSING_ID, "v1", &oid, None)
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        delete_tag_inner(&reg, MISSING_ID, "v1").unwrap_err().kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        push_tag_inner(&reg, MISSING_ID, "origin", "v1")
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
    assert_eq!(
        delete_remote_tag_inner(&reg, MISSING_ID, "origin", "v1")
            .unwrap_err()
            .kind,
        AppErrorKind::UnknownRepo
    );
}

#[test]
fn tag_models_serialise_camel_case() {
    let list = TagList {
        tags: vec![TagEntry {
            name: "v1".into(),
            target: "c".into(),
            annotated: true,
            subject: Some("s".into()),
            time: 7,
        }],
        remotes: vec!["origin".into()],
    };
    assert_eq!(
        serde_json::to_value(list).unwrap(),
        json!({
            "tags": [{ "name": "v1", "target": "c", "annotated": true, "subject": "s", "time": 7 }],
            "remotes": ["origin"]
        })
    );
}
