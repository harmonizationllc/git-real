//! A push whose stash commit is byte-identical to the current tip is still a
//! push (GR-11a F2). Identical commits need a fixed clock, and the clock is
//! process-wide, so this binary holds exactly one test.

mod common;

use git_real_core::{RepoSession, StashOutcome};

#[test]
fn stash_push_identical_to_the_tip_is_still_a_push() {
    if !common::git_available() {
        return;
    }
    // SAFETY: this is the only test in the binary, so nothing else reads or writes the environment.
    unsafe {
        std::env::set_var("GIT_AUTHOR_DATE", "1700000000 +0000");
        std::env::set_var("GIT_COMMITTER_DATE", "1700000000 +0000");
    }
    let (_d, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();
    common::write_file(&path, "README.md", "x\n");
    session.stash_push(Some("same"), false).unwrap();
    let first = session.list_stashes().unwrap().remove(0);
    assert_eq!(
        session.stash_apply(0, &first.oid).unwrap(),
        StashOutcome::Applied
    );

    let again = session.stash_push(Some("same"), false);

    assert!(matches!(again, Ok(())), "{again:?}");
    assert!(
        common::run_git_ok(&path, &["status", "--porcelain"])
            .stdout
            .is_empty()
    );
    assert_eq!(session.list_stashes().unwrap()[0].oid, first.oid);
}
