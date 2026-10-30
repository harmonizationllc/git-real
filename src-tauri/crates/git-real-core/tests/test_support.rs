//! The missing-git policy of `tests/common`: a test that needs git fails the run
//! unless `GIT_REAL_SKIP_GIT_TESTS=1` opts out.

mod common;

use common::git_available_with;

// Git found: the tests run, whatever the opt-out says.
#[test]
fn git_available_with_git_found_is_true() {
    assert!(git_available_with(true, None));
}

// Git missing with the exact opt-out: skip.
#[test]
fn git_available_with_missing_git_and_the_opt_out_is_false() {
    assert!(!git_available_with(false, Some("1")));
}

// Git missing without the opt-out: fail loudly.
#[test]
#[should_panic(expected = "GIT_REAL_SKIP_GIT_TESTS")]
fn git_available_with_missing_git_and_no_opt_out_panics() {
    git_available_with(false, None);
}

// Only the exact value "1" opts out.
#[test]
#[should_panic(expected = "GIT_REAL_SKIP_GIT_TESTS")]
fn git_available_with_an_opt_out_other_than_1_panics() {
    git_available_with(false, Some("true"));
}

// A fixture repo pins autocrlf off in its own local config, so a host with
// system-wide autocrlf=true (Git for Windows) cannot change fixture bytes.
#[test]
fn init_repo_pins_autocrlf_off() {
    let dir = tempfile::tempdir().unwrap();
    common::init_repo(dir.path());
    let repo = git2::Repository::open(dir.path()).unwrap();
    let local = repo
        .config()
        .unwrap()
        .open_level(git2::ConfigLevel::Local)
        .unwrap();
    assert_eq!(local.get_bool("core.autocrlf"), Ok(false));
}

#[test]
fn set_autocrlf_writes_the_local_value() {
    let dir = tempfile::tempdir().unwrap();
    common::init_repo(dir.path());
    common::set_autocrlf(dir.path(), "input");
    let repo = git2::Repository::open(dir.path()).unwrap();
    let local = repo
        .config()
        .unwrap()
        .open_level(git2::ConfigLevel::Local)
        .unwrap();
    assert_eq!(local.get_string("core.autocrlf").unwrap(), "input");
}
