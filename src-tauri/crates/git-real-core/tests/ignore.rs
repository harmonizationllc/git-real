mod common;

use git_real_core::{RepoSession, gitignore_pattern};

fn session(path: &std::path::Path) -> RepoSession {
    RepoSession::open(path).expect("open")
}

// --- gitignore_pattern: pure pattern construction ---

#[test]
fn gitignore_pattern_file_is_rooted() {
    assert_eq!(gitignore_pattern("src/main.rs", false), "/src/main.rs");
}

#[test]
fn gitignore_pattern_dir_has_trailing_slash() {
    assert_eq!(gitignore_pattern("build", true), "/build/");
}

#[test]
fn gitignore_pattern_top_level_file_is_rooted() {
    assert_eq!(gitignore_pattern("x.log", false), "/x.log");
}

#[test]
fn gitignore_pattern_nested_dir_has_trailing_slash() {
    assert_eq!(gitignore_pattern("a/b", true), "/a/b/");
}

// --- add_to_gitignore: writes the pattern into <workdir>/.gitignore ---

#[test]
fn add_to_gitignore_creates_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("ignore");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "/x.log\n"
    );
}

#[test]
fn add_to_gitignore_returns_pattern_written() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.log", "noise\n");
    let pattern = session(&path).add_to_gitignore("x.log").expect("ignore");
    assert_eq!(pattern, "/x.log");
}

#[test]
fn add_to_gitignore_uses_dir_pattern_for_directory() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "build/out.o", "o\n");
    let pattern = session(&path).add_to_gitignore("build").expect("ignore");
    assert_eq!(pattern, "/build/");
}

#[test]
fn add_to_gitignore_appends_to_existing_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "*.tmp\n");
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("ignore");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "*.tmp\n/x.log\n"
    );
}

#[test]
fn add_to_gitignore_appends_with_newline_fix() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "*.tmp");
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("ignore");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "*.tmp\n/x.log\n"
    );
}

#[test]
fn add_to_gitignore_makes_status_hide_path() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("ignore");
    let paths: Vec<_> = session(&path)
        .status()
        .expect("status")
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, vec![".gitignore".to_string()]);
}

// --- escaping, normalisation and idempotence ---

#[test]
fn gitignore_pattern_escapes_glob_chars() {
    assert_eq!(
        gitignore_pattern("a*b[1]?.txt", false),
        "/a\\*b\\[1]\\?.txt"
    );
}

#[test]
fn gitignore_pattern_escapes_backslash() {
    assert_eq!(gitignore_pattern("a\\b", false), "/a\\\\b");
}

#[test]
fn gitignore_pattern_escapes_trailing_space() {
    assert_eq!(gitignore_pattern("sp ", false), "/sp\\ ");
}

#[test]
fn gitignore_pattern_strips_trailing_slash() {
    assert_eq!(gitignore_pattern("build/", true), "/build/");
}

#[test]
fn gitignore_pattern_does_not_escape_hash_or_bang() {
    assert_eq!(gitignore_pattern("#h", false), "/#h");
}

#[test]
fn add_to_gitignore_is_idempotent() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("first");
    session(&path).add_to_gitignore("x.log").expect("second");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "/x.log\n"
    );
}

#[test]
fn add_to_gitignore_second_call_still_returns_pattern() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "x.log", "noise\n");
    session(&path).add_to_gitignore("x.log").expect("first");
    let pattern = session(&path).add_to_gitignore("x.log").expect("second");
    assert_eq!(pattern, "/x.log");
}

#[test]
fn add_to_gitignore_ignores_only_the_literal_glob_named_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a*b.txt", "star\n");
    common::write_file(&path, "aXb.txt", "x\n");
    session(&path).add_to_gitignore("a*b.txt").expect("ignore");
    let paths: Vec<_> = session(&path)
        .status()
        .expect("status")
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert!(paths.contains(&"aXb.txt".to_string()), "{paths:?}");
}

#[test]
fn add_to_gitignore_strips_trailing_slash_on_directory() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "build/out.o", "o\n");
    let pattern = session(&path).add_to_gitignore("build/").expect("ignore");
    assert_eq!(pattern, "/build/");
}

#[test]
fn add_to_gitignore_hides_directory_contents_from_status() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "build/out.o", "o\n");
    session(&path).add_to_gitignore("build").expect("ignore");
    let paths: Vec<_> = session(&path)
        .status()
        .expect("status")
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert!(!paths.contains(&"build/out.o".to_string()), "{paths:?}");
}

#[test]
fn add_to_gitignore_missing_path_is_path_not_found() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .add_to_gitignore("nope.txt")
        .expect_err("missing");
    assert!(
        matches!(err, git_real_core::GitError::PathNotFound(_)),
        "got {err:?}"
    );
}

#[test]
fn add_to_gitignore_rejects_paths_outside_repo() {
    let (_dir, path) = common::temp_repo_with_commit();
    let err = session(&path)
        .add_to_gitignore("../x")
        .expect_err("outside");
    assert!(
        matches!(err, git_real_core::GitError::PathNotFound(_)),
        "got {err:?}"
    );
}

#[test]
fn add_to_gitignore_does_not_write_when_path_is_invalid() {
    let (_dir, path) = common::temp_repo_with_commit();
    let _ = session(&path).add_to_gitignore("nope.txt");
    assert!(!path.join(".gitignore").exists());
}

// --- coverage audit: nested paths and awkward names ---

fn listed_paths(path: &std::path::Path) -> Vec<String> {
    session(path)
        .status()
        .expect("status")
        .entries
        .into_iter()
        .map(|e| e.path)
        .collect()
}

#[test]
fn add_to_gitignore_nested_directory_is_rooted_and_hides_contents() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "pkg/build/out.o", "o\n");
    common::write_file(&path, "pkg/src.c", "c\n");
    let pattern = session(&path)
        .add_to_gitignore("pkg/build")
        .expect("ignore");
    assert_eq!(pattern, "/pkg/build/");
    let listed = listed_paths(&path);
    assert!(
        !listed.contains(&"pkg/build/out.o".to_string())
            && listed.contains(&"pkg/src.c".to_string()),
        "{listed:?}"
    );
}

#[test]
fn add_to_gitignore_nested_file_hides_only_that_file() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a/x.log", "x\n");
    common::write_file(&path, "b/x.log", "x\n");
    session(&path).add_to_gitignore("a/x.log").expect("ignore");
    let listed = listed_paths(&path);
    assert!(
        !listed.contains(&"a/x.log".to_string()) && listed.contains(&"b/x.log".to_string()),
        "{listed:?}"
    );
}

#[test]
fn add_to_gitignore_path_with_spaces_matches_literally() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "my notes.txt", "n\n");
    common::write_file(&path, "my", "m\n");
    let pattern = session(&path)
        .add_to_gitignore("my notes.txt")
        .expect("ignore");
    assert_eq!(pattern, "/my notes.txt");
    let listed = listed_paths(&path);
    assert!(
        !listed.contains(&"my notes.txt".to_string()) && listed.contains(&"my".to_string()),
        "{listed:?}"
    );
}

#[test]
fn add_to_gitignore_name_with_trailing_space_is_escaped_and_matches() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "pad ", "p\n");
    let pattern = session(&path).add_to_gitignore("pad ").expect("ignore");
    assert_eq!(pattern, "/pad\\ ");
    assert!(!listed_paths(&path).contains(&"pad ".to_string()));
}

#[test]
fn add_to_gitignore_hash_and_bang_names_are_not_comments_or_negations() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "#hash.txt", "h\n");
    common::write_file(&path, "!bang.txt", "b\n");
    common::write_file(&path, "other.txt", "o\n");
    let hash = session(&path).add_to_gitignore("#hash.txt").expect("hash");
    let bang = session(&path).add_to_gitignore("!bang.txt").expect("bang");
    assert_eq!((hash.as_str(), bang.as_str()), ("/#hash.txt", "/!bang.txt"));
    let listed = listed_paths(&path);
    assert!(
        !listed.contains(&"#hash.txt".to_string())
            && !listed.contains(&"!bang.txt".to_string())
            && listed.contains(&"other.txt".to_string()),
        "{listed:?}"
    );
}

#[test]
fn add_to_gitignore_rejects_malformed_paths_without_writing() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a/b", "b\n");
    for bad in ["a//b", "./a", "a/./b", "a/../a", ".GIT", ".git/", "", "/"] {
        let err = session(&path).add_to_gitignore(bad).expect_err(bad);
        assert!(
            matches!(err, git_real_core::GitError::PathNotFound(_)),
            "{bad:?}: {err:?}"
        );
    }
    assert!(!path.join(".gitignore").exists());
}

#[test]
fn add_to_gitignore_allows_gitignore_itself() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, ".gitignore", "x\n");
    let pattern = session(&path)
        .add_to_gitignore(".gitignore")
        .expect("ignore");
    assert_eq!(pattern, "/.gitignore");
}

#[test]
fn add_to_gitignore_tolerates_crlf_existing_line() {
    let (_dir, path) = common::temp_repo_with_commit();
    common::write_file(&path, "a.txt", "a\n");
    common::write_file(&path, ".gitignore", "/a.txt\r\n");
    session(&path).add_to_gitignore("a.txt").expect("ignore");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "/a.txt\r\n"
    );
}
