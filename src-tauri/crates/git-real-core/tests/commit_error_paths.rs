//! Error and environment paths of the commit API that the main commit tests
//! do not reach: malformed config, dangling HEAD, corrupt index, re-encoded
//! messages, amend on an unborn branch, and the git CLI environment hygiene
//! of `clone_with` and `git_commit::run`.

mod common;

use common::git_available;

use std::path::Path;

use git_real_core::commit::git_commit;
use git_real_core::remote::clone;
use git_real_core::{CommitMessage, GitError, Progress, ProgressSink, RepoSession};
use git2::Repository;

fn msg(subject: &str, body: &str) -> CommitMessage {
    CommitMessage {
        subject: subject.to_string(),
        body: body.to_string(),
    }
}

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, RepoSession) {
    let (dir, path) = common::temp_repo_with_commit();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).expect("open");
    (dir, path, session)
}

fn set_config(path: &Path, key: &str, value: &str) {
    Repository::open(path)
        .unwrap()
        .config()
        .unwrap()
        .set_str(key, value)
        .unwrap();
}

// --- commit_config: malformed values surface as errors, not silent defaults ---

#[test]
fn commit_config_non_boolean_gpgsign_is_an_error() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "definitely-not-a-bool");

    let err = session.commit_config().unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}

#[test]
fn commit_config_non_utf8_user_name_is_an_error() {
    let (_d, path, session) = fixture();
    let config_path = path.join(".git").join("config");
    let mut bytes = std::fs::read(&config_path).unwrap();
    bytes.extend_from_slice(b"[user]\n\tname = caf\xe9\n");
    std::fs::write(&config_path, bytes).unwrap();

    let err = session.commit_config().unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}

#[test]
fn commit_config_non_utf8_gpg_format_is_an_error_when_signing() {
    let (_d, path, session) = fixture();
    set_config(&path, "commit.gpgsign", "true");
    let config_path = path.join(".git").join("config");
    let mut bytes = std::fs::read(&config_path).unwrap();
    bytes.extend_from_slice(b"[gpg]\n\tformat = ss\xe9\n");
    std::fs::write(&config_path, bytes).unwrap();

    let err = session.commit_config().unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}

// --- head_message: only a missing branch is "unborn" ---

#[test]
fn head_message_with_dangling_head_target_is_an_error_not_none() {
    let (_d, path, session) = fixture();
    // HEAD -> branch whose tip names an object that does not exist.
    let branch = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .name()
        .unwrap()
        .to_string();
    std::fs::write(
        path.join(".git").join(&branch),
        "0123456789012345678901234567890123456789\n",
    )
    .unwrap();

    let err = session.head_message().unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}

// --- commit: staged-change detection on a broken repository ---

#[test]
fn commit_with_corrupt_index_is_an_error_and_leaves_head_alone() {
    let (_d, path, session) = fixture();
    let before = Repository::open(&path).unwrap().head().unwrap().target();
    std::fs::write(path.join(".git").join("index"), b"this is not an index").unwrap();

    let err = session.commit(&msg("Subject", ""), false).unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
    assert_eq!(
        Repository::open(&path).unwrap().head().unwrap().target(),
        before
    );
}

#[test]
fn commit_with_dangling_head_is_an_error() {
    let (_d, path, session) = fixture();
    let branch = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .name()
        .unwrap()
        .to_string();
    std::fs::write(
        path.join(".git").join(&branch),
        "0123456789012345678901234567890123456789\n",
    )
    .unwrap();

    let err = session.commit(&msg("Subject", ""), false).unwrap_err();

    assert!(matches!(err, GitError::Git2(_)), "{err:?}");
}

// --- commit: amend where there is nothing to amend is git's call ---

#[test]
fn amend_on_unborn_head_fails_through_git() {
    if !git_available() {
        return;
    }
    let (_d, path) = common::temp_repo_unborn();
    common::configure_identity(&path);
    let session = RepoSession::open(&path).unwrap();

    let err = session.commit(&msg("Subject", ""), true).unwrap_err();

    assert!(matches!(err, GitError::CommitFailed { .. }), "{err:?}");
    assert!(session.head_message().unwrap().is_none());
}

// --- commit: summary read back from a message git re-encoded ---

#[cfg(unix)]
#[test]
fn commit_outcome_survives_a_non_utf8_recorded_message() {
    if !git_available() {
        return;
    }
    let (_d, path, session) = fixture();
    // With a Latin-1 commit encoding, a commit-msg hook that writes Latin-1
    // bytes makes git record them verbatim (without it git re-encodes to
    // UTF-8), so the stored commit is not valid UTF-8.
    set_config(&path, "i18n.commitEncoding", "ISO-8859-1");
    common::install_hook(&path, "commit-msg", r#"printf 'caf\351 au lait\n' > "$1""#);
    common::write_file(&path, "new.txt", "x\n");
    common::stage(&path, "new.txt");

    let outcome = session.commit(&msg("Subject", ""), false).unwrap();

    // The summary is a lossy rendering rather than an error or a panic.
    let head = Repository::open(&path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap();
    assert_eq!(outcome.oid, head.to_string());
    assert_eq!(outcome.summary, "caf\u{FFFD} au lait");
}

// --- git CLI env hygiene: a hostile inherited GIT_DIR must not reach the child ---
//
// Mutating this process's environment is racy and `unsafe`, so each probe
// re-runs this test binary as a child with `GIT_DIR` set and a role variable.

struct NullSink;

impl ProgressSink for NullSink {
    fn report(&mut self, _progress: Progress) {}
}

const ROLE: &str = "GR_ENV_PROBE_ROLE";
const OUT: &str = "GR_ENV_PROBE_OUT";

/// Records, from inside a fake git, whether `GIT_DIR` reached the child.
#[cfg(unix)]
const PROBE_SCRIPT: &str = r#"
out="$(dirname "$0")/seen"
if [ -n "${GIT_DIR+x}" ]; then echo "GIT_DIR=$GIT_DIR" > "$out"; else echo "GIT_DIR=unset" > "$out"; fi
cat >/dev/null
mkdir -p "$5" 2>/dev/null
exit 0
"#;

#[cfg(unix)]
fn run_probe(role: &str) -> String {
    let exe = std::env::current_exe().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(exe)
        .args(["--exact", "env_probe_child", "--nocapture"])
        .env(ROLE, role)
        .env(OUT, scratch.path())
        .env("GIT_DIR", "/nonexistent/hostile/git-dir")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::read_to_string(scratch.path().join("seen")).unwrap()
}

/// Not a test of its own: the body of the probe child. A plain run is a no-op.
#[cfg(unix)]
#[test]
fn env_probe_child() {
    let (Ok(role), Ok(out)) = (std::env::var(ROLE), std::env::var(OUT)) else {
        return;
    };
    // The child really did inherit the hostile value, so "unset" below proves
    // the code under test removed it.
    assert_eq!(
        std::env::var("GIT_DIR").as_deref(),
        Ok("/nonexistent/hostile/git-dir")
    );
    let out = Path::new(&out);
    let git = common::fake_git(out, PROBE_SCRIPT);
    match role.as_str() {
        "clone" => {
            let dest = out.join("dest");
            clone::clone_with(
                &git,
                "https://example.invalid/r.git",
                &dest,
                None,
                &mut NullSink,
            )
            .expect("fake clone succeeds");
        }
        "commit" => git_commit::run(&git, out, "S\n", false).expect("fake commit succeeds"),
        other => panic!("unknown role {other}"),
    }
}

#[cfg(unix)]
#[test]
fn clone_with_child_does_not_inherit_git_dir() {
    assert_eq!(run_probe("clone"), "GIT_DIR=unset\n");
}

#[cfg(unix)]
#[test]
fn commit_run_child_does_not_inherit_git_dir() {
    assert_eq!(run_probe("commit"), "GIT_DIR=unset\n");
}
