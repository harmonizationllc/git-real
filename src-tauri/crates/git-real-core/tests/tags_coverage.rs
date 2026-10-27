//! Coverage audit for GR-11b tags: edge paths of list, create and the shared
//! remote pre-check that `tags.rs` does not reach.

mod common;

// Only the unix non-UTF-8 ref test below uses these.
#[cfg(unix)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use git_real_core::{GitError, RepoSession};
use git2::{ObjectType, Oid, Repository};
use tempfile::TempDir;

fn repo() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

fn head_oid(path: &Path) -> Oid {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

/// Writes a loose tag object straight into the odb and points `refs/tags/<name>` at it.
fn raw_tag(path: &Path, name: &str, body: &str) -> Oid {
    let repo = Repository::open(path).unwrap();
    let oid = repo
        .odb()
        .unwrap()
        .write(ObjectType::Tag, body.as_bytes())
        .unwrap();
    repo.reference(&format!("refs/tags/{name}"), oid, false, "test")
        .unwrap();
    oid
}

#[test]
fn annotated_tag_without_a_tagger_falls_back_to_the_commit_time() {
    let (_d, path, session) = repo();
    let commit = head_oid(&path);
    raw_tag(
        &path,
        "no-tagger",
        &format!("object {commit}\ntype commit\ntag no-tagger\n\nSubject line\n"),
    );
    let list = session.list_tags().unwrap();
    let t = list.tags.iter().find(|t| t.name == "no-tagger").unwrap();
    assert!(t.annotated);
    assert_eq!(t.subject.as_deref(), Some("Subject line"));
    let commit_time = Repository::open(&path)
        .unwrap()
        .find_commit(commit)
        .unwrap()
        .time()
        .seconds();
    assert_eq!(t.time, commit_time);
    assert_eq!(t.target, commit.to_string());
}

#[test]
fn annotated_tag_with_a_whitespace_only_message_has_no_subject() {
    let (_d, path, session) = repo();
    let commit = head_oid(&path);
    raw_tag(
        &path,
        "spaces",
        &format!("object {commit}\ntype commit\ntag spaces\n\n   \n"),
    );
    let list = session.list_tags().unwrap();
    let t = list.tags.iter().find(|t| t.name == "spaces").unwrap();
    assert!(t.annotated);
    assert_eq!(t.subject, None);
}

#[test]
fn tag_of_a_tag_peels_to_the_commit_and_is_annotated() {
    let (_d, path, session) = repo();
    let commit = head_oid(&path);
    let inner = raw_tag(
        &path,
        "inner",
        &format!("object {commit}\ntype commit\ntag inner\n\ninner msg\n"),
    );
    raw_tag(
        &path,
        "outer",
        &format!("object {inner}\ntype tag\ntag outer\n\nouter msg\n"),
    );
    let list = session.list_tags().unwrap();
    let outer = list.tags.iter().find(|t| t.name == "outer").unwrap();
    assert!(outer.annotated);
    assert_eq!(outer.target, commit.to_string());
    assert_eq!(outer.subject.as_deref(), Some("outer msg"));
}

#[test]
fn list_tags_skips_an_annotated_tag_of_a_tree() {
    let (_d, path, session) = repo();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id();
    raw_tag(
        &path,
        "tree-ann",
        &format!("object {tree}\ntype tree\ntag tree-ann\n\nmsg\n"),
    );
    assert!(session.list_tags().unwrap().tags.is_empty());
}

#[test]
fn list_tags_skips_a_remote_whose_name_is_not_utf8() {
    let (_d, path, session) = repo();
    let mut config = std::fs::read(path.join(".git/config")).unwrap();
    config.extend_from_slice(b"[remote \"bad\xff\"]\n\turl = /nowhere/x.git\n");
    std::fs::write(path.join(".git/config"), config).unwrap();
    Repository::open(&path)
        .unwrap()
        .remote("good", "/nowhere/g.git")
        .unwrap();
    assert_eq!(session.list_tags().unwrap().remotes, ["good"]);
}

#[cfg(unix)]
#[test]
fn list_tags_skips_a_tag_whose_ref_is_not_utf8() {
    let (_d, path, session) = repo();
    let commit = head_oid(&path);
    let file = path
        .join(".git/refs/tags")
        .join(OsStr::from_bytes(b"bad\xff"));
    std::fs::write(file, format!("{commit}\n")).unwrap();
    Repository::open(&path)
        .unwrap()
        .reference("refs/tags/good", commit, false, "test")
        .unwrap();
    let names: Vec<_> = session
        .list_tags()
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(names, ["good"]);
}

#[test]
fn create_annotated_tag_with_a_message_larger_than_a_pipe_buffer() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let line = "x".repeat(99);
    let message = format!("Big\n\n{}", vec![line; 3000].join("\n")); // ~300 KB
    session
        .create_tag("big", &head_oid(&path).to_string(), Some(&message))
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let tag = repo
        .find_reference("refs/tags/big")
        .unwrap()
        .peel(ObjectType::Tag)
        .unwrap()
        .into_tag()
        .unwrap();
    assert_eq!(tag.message().unwrap().trim_end(), message);
}

#[test]
fn remote_delete_checks_the_remote_before_the_branch_name() {
    let (_d, path, session) = repo();
    let bare = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare.1, &common::head_branch_name(&path));
    for remote in ["nope", "-x"] {
        let err = session
            .prepare_remote_delete(remote, "bad..name")
            .unwrap_err();
        assert!(
            matches!(err, GitError::RemoteNotFound(ref r) if r == remote),
            "{err:?}"
        );
    }
    // A known remote with that name still reports the name.
    assert!(matches!(
        session.prepare_remote_delete("origin", "bad..name"),
        Err(GitError::InvalidBranchName(_))
    ));
}

#[test]
fn prepare_tag_push_with_a_dash_or_invalid_tag_name_is_tag_not_found() {
    let (_d, path, session) = repo();
    let bare = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare.1, &common::head_branch_name(&path));
    for name in ["-v1", "bad..name", "nul\0name"] {
        assert!(matches!(
            session.prepare_tag_push("origin", name),
            Err(GitError::TagNotFound(_))
        ));
        assert!(matches!(
            session.prepare_remote_tag_delete("origin", name),
            Err(GitError::TagNotFound(_))
        ));
    }
}

#[test]
fn prepared_tag_pushes_expose_what_they_were_built_from() {
    let (_d, path, session) = repo();
    let bare = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare.1, &common::head_branch_name(&path));
    common::tag_lightweight(&path, "v1", head_oid(&path));
    let push = session.prepare_tag_push("origin", "v1").unwrap();
    assert_eq!((push.remote(), push.name()), ("origin", "v1"));
    let del = session.prepare_remote_tag_delete("origin", "v1").unwrap();
    assert_eq!((del.remote(), del.name()), ("origin", "v1"));
    assert_eq!(push.workdir(), del.workdir());
}
