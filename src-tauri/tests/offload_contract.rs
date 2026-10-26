//! Contract: every `#[tauri::command]` handler runs its body inside `run_blocking`,
//! so git2 never executes on the IPC thread (ADR 0002). The scanner is plain
//! functions over `&str` so it can be tested on inline sources.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const ATTRIBUTE: &str = "#[tauri::command]";

/// One command handler: its name and its text, from the attribute to the
/// function's closing brace (rustfmt keeps it at column 0: `"\n}\n"`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Handler {
    name: String,
    text: String,
}

fn handlers(source: &str) -> Vec<Handler> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(rel) = source[from..].find(ATTRIBUTE) {
        let start = from + rel;
        let end = source[start..]
            .find("\n}\n")
            .map(|i| start + i + 3)
            .unwrap_or(source.len());
        let text = &source[start..end];
        let name = text
            .split_once("fn ")
            .map(|(_, rest)| {
                rest.chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect::<String>()
            })
            .unwrap_or_default();
        found.push(Handler {
            name,
            text: text.to_string(),
        });
        from = end.max(start + ATTRIBUTE.len());
    }
    found
}

/// Names of the handlers whose text lacks `run_blocking(`.
fn bare_handlers(source: &str) -> Vec<String> {
    handlers(source)
        .into_iter()
        .filter(|h| !h.text.contains("run_blocking("))
        .map(|h| h.name)
        .collect()
}

/// Last path segments inside `generate_handler![ ... ]`.
fn registered_names(lib_source: &str) -> BTreeSet<String> {
    let start = lib_source
        .find("generate_handler![")
        .expect("generate_handler! in src/lib.rs")
        + "generate_handler![".len();
    let end = start + lib_source[start..].find(']').expect("closing ]");
    lib_source[start..end]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.rsplit("::").next().unwrap().to_string())
        .collect()
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn command_sources() -> Vec<(String, String)> {
    let dir = manifest_dir().join("src/commands");
    let mut files: Vec<(String, String)> = fs::read_dir(&dir)
        .expect("read src/commands")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read_to_string(&p).unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}

// The real tree: every command is wrapped.
#[test]
fn every_command_runs_inside_run_blocking() {
    let offenders: Vec<String> = command_sources()
        .iter()
        .flat_map(|(file, src)| {
            bare_handlers(src)
                .into_iter()
                .map(move |name| format!("{file}: {name}"))
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "handlers that do not call run_blocking( (they would run git2 on the IPC thread):\n  {}",
        offenders.join("\n  ")
    );
}

// The scanner sees every registered command, and nothing else.
#[test]
fn handler_names_match_generate_handler() {
    let scanned: BTreeSet<String> = command_sources()
        .iter()
        .flat_map(|(_, src)| handlers(src).into_iter().map(|h| h.name))
        .collect();
    let lib = fs::read_to_string(manifest_dir().join("src/lib.rs")).unwrap();
    let registered = registered_names(&lib);
    let only_scanned: Vec<_> = scanned.difference(&registered).collect();
    let only_registered: Vec<_> = registered.difference(&scanned).collect();
    assert!(
        only_scanned.is_empty() && only_registered.is_empty(),
        "scanned but not registered: {only_scanned:?}; registered but not scanned: {only_registered:?}"
    );
}

#[test]
fn the_scanner_finds_the_commands_at_all() {
    let total: usize = command_sources()
        .iter()
        .map(|(_, s)| handlers(s).len())
        .sum();
    assert!(total >= 80, "found only {total} handlers");
}

// Scanner behaviour on inline sources.
const WRAPPED_AND_BARE: &str = r#"
#[tauri::command]
pub async fn wrapped(reg: State<'_, Arc<RepoRegistry>>) -> Result<(), AppError> {
    run_blocking(move || wrapped_inner(&reg)).await
}

#[tauri::command]
pub async fn bare(reg: State<'_, Arc<RepoRegistry>>) -> Result<(), AppError> {
    bare_inner(&reg)
}
"#;

#[test]
fn scanner_names_a_bare_handler() {
    assert_eq!(bare_handlers(WRAPPED_AND_BARE), vec!["bare".to_string()]);
}

#[test]
fn scanner_finds_both_handlers() {
    let names: Vec<String> = handlers(WRAPPED_AND_BARE)
        .into_iter()
        .map(|h| h.name)
        .collect();
    assert_eq!(names, vec!["wrapped".to_string(), "bare".to_string()]);
}

#[test]
fn scanner_stops_at_the_closing_brace() {
    let source = r#"
#[tauri::command]
pub async fn sneaky(reg: State<'_, Arc<RepoRegistry>>) -> Result<(), AppError> {
    sneaky_inner(&reg)
}

fn helper() {
    run_blocking(|| ());
}
"#;
    assert_eq!(bare_handlers(source), vec!["sneaky".to_string()]);
}

#[test]
fn scanner_ignores_sources_without_commands() {
    assert!(bare_handlers("pub fn plain() {}\n").is_empty());
}

#[test]
fn scanner_reads_the_name_after_fn_for_non_async_handlers() {
    let source = "#[tauri::command]\npub fn quick() -> u8 {\n    1\n}\n";
    assert_eq!(bare_handlers(source), vec!["quick".to_string()]);
}

#[test]
fn registered_names_take_the_last_path_segment() {
    let lib = "tauri::generate_handler![\n    commands::repo::open_repo,\n    commands::log::get_log_page,\n]";
    let names: Vec<String> = registered_names(lib).into_iter().collect();
    assert_eq!(
        names,
        vec!["get_log_page".to_string(), "open_repo".to_string()]
    );
}

// Negative cases: what the scanner must flag or tolerate.
#[test]
fn scanner_flags_a_handler_that_mentions_run_blocking_without_calling_it() {
    let source =
        "#[tauri::command]\npub async fn lazy() -> u8 {\n    let f = run_blocking;\n    1\n}\n";
    assert_eq!(bare_handlers(source), vec!["lazy".to_string()]);
}

#[test]
fn scanner_flags_an_unterminated_final_handler_without_run_blocking() {
    let source = "#[tauri::command]\npub async fn cut_off() -> u8 {\n    1";
    assert_eq!(bare_handlers(source), vec!["cut_off".to_string()]);
}

#[test]
fn scanner_accepts_an_unterminated_final_handler_that_wraps() {
    let source = "#[tauri::command]\npub async fn ok() -> u8 {\n    run_blocking(|| 1).await";
    assert!(bare_handlers(source).is_empty());
}

#[test]
fn scanner_flags_only_the_bare_one_when_a_wrapped_follows_a_bare() {
    let source = "#[tauri::command]\npub fn first() {\n    inner()\n}\n\n#[tauri::command]\npub async fn second() {\n    run_blocking(|| ()).await\n}\n";
    assert_eq!(bare_handlers(source), vec!["first".to_string()]);
}

#[test]
fn scanner_reports_two_consecutive_bare_handlers() {
    let source = "#[tauri::command]\npub fn a() {\n}\n#[tauri::command]\npub fn b() {\n}\n";
    assert_eq!(
        bare_handlers(source),
        vec!["a".to_string(), "b".to_string()]
    );
}

#[test]
fn registered_names_accept_a_list_without_a_trailing_comma() {
    let lib = "generate_handler![commands::a::one, two]";
    let names: Vec<String> = registered_names(lib).into_iter().collect();
    assert_eq!(names, vec!["one".to_string(), "two".to_string()]);
}

#[test]
#[should_panic(expected = "generate_handler!")]
fn registered_names_panic_without_a_generate_handler_invocation() {
    registered_names("fn main() {}");
}
