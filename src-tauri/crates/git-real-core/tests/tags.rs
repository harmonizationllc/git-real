//! Tag list, create, delete, push and remote delete (GR-11b), against real
//! temp repositories, a local bare repository as the remote (no network) and
//! the system git CLI.

mod common;

use std::path::{Path, PathBuf};

use git_real_core::{GitError, RepoSession, TagEntry};
use git2::Repository;
use tempfile::TempDir;

/// A repo with README.md committed, an identity, signing off, and an open session.
fn repo() -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

fn head(path: &Path) -> String {
    Repository::open(path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
        .to_string()
}

/// A repo whose `origin` is a local bare clone; returns (dirs, path, bare, session).
fn remote_repo() -> (TempDir, TempDir, PathBuf, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let head_name = common::head_branch_name(&path);
    let (bare_dir, bare) = common::temp_bare_clone(&path);
    common::add_remote_and_fetch(&path, &bare, &head_name);
    let session = RepoSession::open(&path).unwrap();
    (dir, bare_dir, path, bare, session)
}

/// The commit `refs/tags/<name>` peels to in `repo_path`, if the tag exists.
fn tag_commit(repo_path: &Path, name: &str) -> Option<String> {
    let repo = Repository::open(repo_path).unwrap();
    let r = repo.find_reference(&format!("refs/tags/{name}")).ok()?;
    Some(r.peel_to_commit().unwrap().id().to_string())
}

fn entry<'a>(tags: &'a [TagEntry], name: &str) -> &'a TagEntry {
    tags.iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("no {name} in {tags:?}"))
}

/// An executable that prints `gpg-boom` on stderr and exits 2.
#[cfg(unix)]
fn failing_gpg(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join("fake-gpg");
    std::fs::write(&p, "#!/bin/sh\necho gpg-boom >&2\nexit 2\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

// ---------- list ----------

#[test]
fn list_tags_is_empty_without_tags_or_remotes() {
    let (_d, _p, session) = repo();
    let list = session.list_tags().unwrap();
    assert_eq!((list.tags, list.remotes), (vec![], Vec::<String>::new()));
}

#[test]
fn list_tags_reports_a_lightweight_tag() {
    let (_d, path, session) = repo();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::tag_lightweight(&path, "v1", oid);
    let commit_time = Repository::open(&path)
        .unwrap()
        .find_commit(oid)
        .unwrap()
        .time()
        .seconds();
    let list = session.list_tags().unwrap();
    assert_eq!(
        list.tags,
        vec![TagEntry {
            name: "v1".into(),
            target: oid.to_string(),
            annotated: false,
            subject: None,
            time: commit_time
        }]
    );
}

#[test]
fn list_tags_reports_an_annotated_tag_peeled_with_subject_and_tagger_time() {
    let (_d, path, session) = repo();
    let repo = Repository::open(&path).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    repo.tag(
        "v2",
        commit.as_object(),
        &common::signature_at(500),
        "  Release 2  \n\nbody\n",
        false,
    )
    .unwrap();
    let list = session.list_tags().unwrap();
    let v2 = entry(&list.tags, "v2");
    assert_eq!(v2.target, commit.id().to_string()); // the commit, not the tag object
    assert!(v2.annotated);
    assert_eq!(v2.subject.as_deref(), Some("Release 2"));
    assert_eq!(v2.time, common::FIXTURE_TIME + 500);
}

#[test]
fn list_tags_annotated_with_a_blank_message_has_no_subject() {
    let (_d, path, session) = repo();
    let repo = Repository::open(&path).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    repo.tag(
        "blank",
        commit.as_object(),
        &common::signature_at(0),
        "",
        false,
    )
    .unwrap();
    assert_eq!(
        entry(&session.list_tags().unwrap().tags, "blank").subject,
        None
    );
}

#[test]
fn list_tags_orders_newest_first_then_by_name() {
    let (_d, path, session) = repo();
    let repo = Repository::open(&path).unwrap();
    let c = repo.head().unwrap().peel_to_commit().unwrap();
    repo.tag("old", c.as_object(), &common::signature_at(10), "o", false)
        .unwrap();
    repo.tag(
        "b-new",
        c.as_object(),
        &common::signature_at(90),
        "b",
        false,
    )
    .unwrap();
    repo.tag(
        "a-new",
        c.as_object(),
        &common::signature_at(90),
        "a",
        false,
    )
    .unwrap();
    let names: Vec<_> = session
        .list_tags()
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert_eq!(names, ["a-new", "b-new", "old"]);
}

#[test]
fn list_tags_skips_a_tag_of_a_tree() {
    let (_d, path, session) = repo();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id();
    common::tag_lightweight(&path, "tree-tag", tree);
    assert!(session.list_tags().unwrap().tags.is_empty());
}

#[test]
fn list_tags_includes_slashed_and_packed_tags() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::tag_lightweight(&path, "release/v1", oid);
    common::tag_annotated(&path, "packed", oid);
    common::run_git_ok(&path, &["pack-refs", "--all"]);
    let names: Vec<_> = session
        .list_tags()
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(
        names.contains(&"release/v1".to_owned()) && names.contains(&"packed".to_owned()),
        "{names:?}"
    );
}

#[test]
fn list_tags_lists_remotes_sorted_even_without_remote_branches() {
    let (_d, path, session) = repo();
    let repo = Repository::open(&path).unwrap();
    repo.remote("zeta", "/nowhere/z.git").unwrap();
    repo.remote("alpha", "/nowhere/a.git").unwrap();
    assert_eq!(session.list_tags().unwrap().remotes, ["alpha", "zeta"]);
}

// ---------- create ----------

#[test]
fn create_lightweight_tag_points_at_the_commit() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let first = head(&path);
    common::commit_file(&path, "a.txt", "a\n", "second");
    session.create_tag("v1", &first, None).unwrap();
    assert_eq!(tag_commit(&path, "v1").as_deref(), Some(first.as_str()));
    assert!(!entry(&session.list_tags().unwrap().tags, "v1").annotated);
}

#[test]
fn create_annotated_tag_stores_the_whitespace_cleaned_message() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let oid = head(&path);
    session
        .create_tag(
            "v1",
            &oid,
            Some("\n  Subject  \n\n\n# kept\n  indented\n\n"),
        )
        .unwrap();
    let repo = Repository::open(&path).unwrap();
    let tag = repo
        .find_reference("refs/tags/v1")
        .unwrap()
        .peel_to_tag()
        .unwrap();
    assert_eq!(tag.message(), Some("  Subject\n\n# kept\n  indented\n"));
    assert_eq!(tag.target_id().to_string(), oid);
    assert_eq!(
        entry(&session.list_tags().unwrap().tags, "v1")
            .subject
            .as_deref(),
        Some("Subject")
    );
}

#[test]
fn create_tag_with_an_invalid_name_is_invalid_tag_name() {
    let (_d, path, session) = repo();
    let oid = head(&path);
    for bad in ["bad..name", "", "a b", "x.lock", "end/"] {
        assert!(
            matches!(session.create_tag(bad, &oid, None), Err(GitError::InvalidTagName(n)) if n == bad),
            "{bad:?}"
        );
    }
}

#[test]
fn create_tag_with_a_leading_dash_is_invalid_tag_name() {
    let (_d, path, session) = repo();
    assert!(matches!(
        session.create_tag("-x", &head(&path), Some("m")),
        Err(GitError::InvalidTagName(_))
    ));
}

#[test]
fn create_tag_with_a_nul_byte_is_invalid_tag_name() {
    let (_d, path, session) = repo();
    assert!(matches!(
        session.create_tag("a\0b", &head(&path), None),
        Err(GitError::InvalidTagName(_))
    ));
}

#[test]
fn create_tag_with_a_taken_name_is_tag_exists() {
    let (_d, path, session) = repo();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::tag_lightweight(&path, "light", oid);
    common::tag_annotated(&path, "heavy", oid);
    for name in ["light", "heavy"] {
        assert!(
            matches!(session.create_tag(name, &oid.to_string(), None), Err(GitError::TagExists(n)) if n == name)
        );
    }
}

#[test]
fn create_tag_on_an_unknown_or_non_commit_oid_is_commit_not_found() {
    let (_d, path, session) = repo();
    let tree = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id()
        .to_string();
    for oid in ["f".repeat(40), "abc1234".to_owned(), tree] {
        assert!(
            matches!(session.create_tag("v1", &oid, None), Err(GitError::CommitNotFound(o)) if o == oid)
        );
    }
}

#[test]
fn create_annotated_tag_with_a_blank_message_is_empty_message_and_creates_nothing() {
    let (_d, path, session) = repo();
    assert!(matches!(
        session.create_tag("v1", &head(&path), Some(" \n\t\n")),
        Err(GitError::EmptyMessage)
    ));
    assert_eq!(tag_commit(&path, "v1"), None);
}

#[cfg(unix)]
#[test]
fn create_annotated_tag_honours_tag_gpg_sign_and_reports_its_stderr() {
    if !common::git_available() {
        return;
    }
    let (dir, path, session) = repo();
    let gpg = failing_gpg(dir.path());
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config.set_bool("tag.gpgSign", true).unwrap();
    config
        .set_str("gpg.program", gpg.to_str().unwrap())
        .unwrap();
    match session.create_tag("signed", &head(&path), Some("msg")) {
        Err(GitError::OperationFailed { verb, stderr, .. }) => {
            assert_eq!(verb, "tag");
            assert!(stderr.contains("gpg-boom"), "{stderr}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(tag_commit(&path, "signed"), None);
}

#[cfg(unix)]
#[test]
fn create_lightweight_tag_ignores_tag_gpg_sign() {
    if !common::git_available() {
        return;
    }
    let (dir, path, session) = repo();
    let gpg = failing_gpg(dir.path());
    let mut config = Repository::open(&path).unwrap().config().unwrap();
    config.set_bool("tag.gpgSign", true).unwrap();
    config
        .set_str("gpg.program", gpg.to_str().unwrap())
        .unwrap();
    session.create_tag("light", &head(&path), None).unwrap();
    assert!(!entry(&session.list_tags().unwrap().tags, "light").annotated);
}

// ---------- delete ----------

#[test]
fn delete_tag_removes_lightweight_and_annotated_tags() {
    let (_d, path, session) = repo();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::tag_lightweight(&path, "light", oid);
    common::tag_annotated(&path, "heavy", oid);
    session.delete_tag("light").unwrap();
    session.delete_tag("heavy").unwrap();
    assert!(session.list_tags().unwrap().tags.is_empty());
}

#[test]
fn delete_tag_removes_a_slashed_packed_tag_from_packed_refs() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo();
    let oid = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    common::tag_lightweight(&path, "release/v1", oid);
    common::run_git_ok(&path, &["pack-refs", "--all"]);
    session.delete_tag("release/v1").unwrap();
    let packed = std::fs::read_to_string(path.join(".git/packed-refs")).unwrap_or_default();
    assert!(
        session.list_tags().unwrap().tags.is_empty() && !packed.contains("refs/tags/release/v1"),
        "{packed}"
    );
}

#[test]
fn delete_tag_missing_or_invalid_is_tag_not_found() {
    let (_d, _p, session) = repo();
    for name in ["ghost", "-x", "bad..name", "a\0b"] {
        assert!(
            matches!(session.delete_tag(name), Err(GitError::TagNotFound(n)) if n == name),
            "{name:?}"
        );
    }
}

// ---------- prepare ----------

#[test]
fn prepare_tag_push_unknown_or_dash_remote_is_remote_not_found() {
    let (_d, _b, path, _bare, session) = remote_repo();
    common::tag_lightweight(
        &path,
        "v1",
        Repository::open(&path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    );
    for remote in ["nope", "-x"] {
        assert!(
            matches!(session.prepare_tag_push(remote, "v1"), Err(GitError::RemoteNotFound(r)) if r == remote)
        );
        assert!(
            matches!(session.prepare_remote_tag_delete(remote, "v1"), Err(GitError::RemoteNotFound(r)) if r == remote)
        );
    }
}

#[test]
fn prepare_tag_push_and_remote_delete_need_the_local_tag() {
    let (_d, _b, _p, _bare, session) = remote_repo();
    assert!(matches!(
        session.prepare_tag_push("origin", "ghost"),
        Err(GitError::TagNotFound(_))
    ));
    assert!(matches!(
        session.prepare_remote_tag_delete("origin", "ghost"),
        Err(GitError::TagNotFound(_))
    ));
}

#[test]
fn prepare_checks_the_remote_before_the_tag() {
    let (_d, _b, _p, _bare, session) = remote_repo();
    assert!(matches!(
        session.prepare_tag_push("nope", "ghost"),
        Err(GitError::RemoteNotFound(_))
    ));
}

// ---------- push / remote delete (CLI, local bare remote) ----------

#[test]
fn push_tag_sends_the_tag_to_the_remote() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, session) = remote_repo();
    let oid = head(&path);
    session.create_tag("v1", &oid, Some("Release")).unwrap();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(tag_commit(&bare, "v1").as_deref(), Some(oid.as_str()));
}

#[test]
fn push_tag_already_on_the_remote_at_the_same_commit_succeeds() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, session) = remote_repo();
    session.create_tag("v1", &head(&path), None).unwrap();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap(); // "Everything up-to-date"
}

#[test]
fn push_tag_moved_locally_is_network_failed_with_git_rejection() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, session) = remote_repo();
    let first = head(&path);
    session.create_tag("v1", &first, None).unwrap();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    let second = common::commit_file(&path, "a.txt", "a\n", "second").to_string();
    session.delete_tag("v1").unwrap();
    session.create_tag("v1", &second, None).unwrap();
    match session.prepare_tag_push("origin", "v1").unwrap().run(None) {
        Err(GitError::NetworkFailed { stderr, .. }) => {
            assert!(stderr.contains("already exists"), "{stderr}")
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(tag_commit(&bare, "v1").as_deref(), Some(first.as_str()));
}

#[test]
fn delete_remote_tag_removes_it_from_the_remote() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, session) = remote_repo();
    session.create_tag("v1", &head(&path), None).unwrap();
    session
        .prepare_tag_push("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    session
        .prepare_remote_tag_delete("origin", "v1")
        .unwrap()
        .run(None)
        .unwrap();
    assert_eq!(tag_commit(&bare, "v1"), None);
    assert!(tag_commit(&path, "v1").is_some(), "the local tag stays");
}

#[test]
fn delete_remote_tag_missing_on_the_remote_is_network_failed() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, _bare, session) = remote_repo();
    session.create_tag("v1", &head(&path), None).unwrap();
    match session
        .prepare_remote_tag_delete("origin", "v1")
        .unwrap()
        .run(None)
    {
        Err(GitError::NetworkFailed { stderr, .. }) => {
            assert!(stderr.contains("remote ref does not exist"), "{stderr}")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn delete_remote_tag_never_removes_a_branch_with_the_same_name() {
    if !common::git_available() {
        return;
    }
    let (_d, _b, path, bare, session) = remote_repo();
    {
        let repo = Repository::open(&path).unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("same", &c, false).unwrap();
    }
    common::push_branch(&path, "same");
    session.create_tag("same", &head(&path), None).unwrap();
    assert!(matches!(
        session
            .prepare_remote_tag_delete("origin", "same")
            .unwrap()
            .run(None),
        Err(GitError::NetworkFailed { .. })
    ));
    assert!(
        Repository::open_bare(&bare)
            .unwrap()
            .find_branch("same", git2::BranchType::Local)
            .is_ok()
    );
}

/// A repo with the given lightweight tags and `core.ignorecase` switched on.
fn ignorecase_repo_with_tags(tags: &[&str]) -> (TempDir, PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    {
        let repo = Repository::open(&path).unwrap();
        let target = repo.head().unwrap().peel(git2::ObjectType::Commit).unwrap();
        for name in tags {
            repo.tag_lightweight(name, &target, false).unwrap();
        }
    }
    common::set_ignorecase(&path, true);
    let session = RepoSession::open(&path).unwrap();
    (dir, path, session)
}

fn tag_names(session: &RepoSession) -> Vec<String> {
    session
        .list_tags()
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.name)
        .collect()
}

#[test]
fn create_tag_case_variant_of_existing_tag_is_tag_exists_with_the_existing_spelling() {
    let (_d, path, session) = ignorecase_repo_with_tags(&["V1"]);
    let err = session.create_tag("v1", &head(&path), None).unwrap_err();
    assert!(
        matches!(err, GitError::TagExists(ref n) if n == "V1"),
        "{err:?}"
    );
    assert!(tag_commit(&path, "v1").is_none() || cfg!(windows));
}

#[test]
fn create_tag_exact_duplicate_is_tag_exists_when_ignorecase() {
    let (_d, path, session) = ignorecase_repo_with_tags(&["v1"]);
    let err = session.create_tag("v1", &head(&path), None).unwrap_err();
    assert!(
        matches!(err, GitError::TagExists(ref n) if n == "v1"),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn delete_tag_removes_exact_spelling_when_both_spellings_exist() {
    let (_d, _p, session) = ignorecase_repo_with_tags(&["V1", "v1"]);
    session.delete_tag("v1").unwrap();
    let names = tag_names(&session);
    assert!(
        names.contains(&"V1".to_owned()) && !names.contains(&"v1".to_owned()),
        "{names:?}"
    );
}

#[cfg(unix)]
#[test]
fn delete_tag_case_variant_is_tag_not_found_when_ignorecase() {
    let (_d, _p, session) = ignorecase_repo_with_tags(&["V1"]);
    let err = session.delete_tag("v1").unwrap_err();
    assert!(
        matches!(err, GitError::TagNotFound(ref n) if n == "v1"),
        "{err:?}"
    );
}

#[cfg(windows)]
#[test]
fn fresh_repo_on_windows_does_not_resolve_tag_case_variants() {
    if !common::git_available() {
        return;
    }
    let (_d, path, session) = repo(); // git wrote core.ignorecase=true at init
    session.create_tag("V1", &head(&path), None).unwrap();
    let err = session.delete_tag("v1").unwrap_err();
    assert!(
        matches!(err, GitError::TagNotFound(ref n) if n == "v1"),
        "{err:?}"
    );
    assert!(tag_names(&session).contains(&"V1".to_owned()));
}
