//! Tests for `SettingsStore`: load, get, update, apply_git_override, window
//! geometry, the init script, the file path and the settings health check.

#![cfg(unix)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use git_real_core::git_cli::{configured_path, set_configured_path};
use git_real_lib::settings_store::SettingsStore;

/// Serialises tests that touch the process-wide `CONFIGURED` static.
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Panic-safe guard.
struct ResetConfigured;
impl Drop for ResetConfigured {
    fn drop(&mut self) {
        set_configured_path(None);
    }
}

// ─── load ─────────────────────────────────────────────────────────────────────

#[test]
fn load_missing_corrupt_unreadable_and_unknown_version_yield_defaults() {
    // Missing file
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());
    assert_eq!(store.get(), Default::default());

    // Corrupt JSON
    let (_dir2, path2) = common::temp_file_path("settings.json");
    fs::write(&path2, "{not json").unwrap();
    let store2 = SettingsStore::load(path2.clone());
    assert_eq!(store2.get(), Default::default());

    // Unreadable directory path
    let dir3 = tempfile::tempdir().unwrap();
    let store3 = SettingsStore::load(dir3.path().to_path_buf());
    assert_eq!(store3.get(), Default::default());

    // Unknown version (version 1)
    let (_dir4, path4) = common::temp_file_path("settings.json");
    fs::write(
        &path4,
        r#"{"version":1,"settings":{"tools":{"editor":"code"}}}"#,
    )
    .unwrap();
    let store4 = SettingsStore::load(path4.clone());
    assert_eq!(store4.get(), Default::default());
}

#[test]
fn load_does_not_create_the_file() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let _ = SettingsStore::load(path.clone());
    assert!(!path.exists(), "load() must not create the settings file");
}

// ─── update ───────────────────────────────────────────────────────────────────

#[test]
fn update_persists_the_patch_and_round_trips() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"tools":{"editor":"code --wait"}}"#).unwrap();
    let result = store.update(&patch).unwrap();
    assert_eq!(result.tools.editor.as_deref(), Some("code --wait"));

    // File must be valid two-space pretty JSON with version:2, no .tmp file
    let content = fs::read_to_string(&path).unwrap();
    assert!(
        content.contains("\n  \"version\": 2"),
        "pretty-printed: {content}"
    );
    let v: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(v["version"], 2);
    assert_eq!(v["settings"]["tools"]["editor"], "code --wait");

    let tmp = path.clone();
    let mut s = tmp.as_os_str().to_owned();
    s.push(".tmp");
    let tmp_path = PathBuf::from(s);
    assert!(!tmp_path.exists(), ".tmp file must be cleaned up");
}

#[test]
fn update_rejects_invalid_settings_without_saving() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"clone":{"defaultDir":"relative/path"}}"#).unwrap();
    let err = store.update(&patch).unwrap_err();
    use git_real_lib::error::AppErrorKind;
    assert_eq!(err.kind, AppErrorKind::InvalidSettings);
    assert!(
        !path.exists(),
        "file must not be created on validation error"
    );
}

#[test]
fn update_verifies_a_changed_git_executable_and_pushes_the_override() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake_git = common_fake_git(dir.path());

    let (_sdir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    let json = format!(r#"{{"git":{{"executable":"{}"}}}}"#, fake_git.display());
    let patch: git_real_core::SettingsPatch = serde_json::from_str(&json).unwrap();
    store.update(&patch).unwrap();

    assert_eq!(configured_path(), Some(fake_git));
}

#[test]
fn update_rejects_a_non_git_executable_and_keeps_the_old_value() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let non_git = make_non_git(dir.path());

    let (_sdir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    let json = format!(r#"{{"git":{{"executable":"{}"}}}}"#, non_git.display());
    let patch: git_real_core::SettingsPatch = serde_json::from_str(&json).unwrap();
    let err = store.update(&patch).unwrap_err();

    use git_real_lib::error::AppErrorKind;
    assert_eq!(err.kind, AppErrorKind::GitCliInvalid);
    // In-memory value unchanged
    assert!(store.get().git.executable.is_none());
    // Override unchanged (None)
    assert_eq!(configured_path(), None);
}

#[test]
fn update_clearing_the_git_executable_resets_the_override() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake_git = common_fake_git(dir.path());

    let (_sdir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    // First install a fake git
    let set_json = format!(r#"{{"git":{{"executable":"{}"}}}}"#, fake_git.display());
    let set_patch: git_real_core::SettingsPatch = serde_json::from_str(&set_json).unwrap();
    store.update(&set_patch).unwrap();
    assert_eq!(configured_path(), Some(fake_git));

    // Clear it
    let clear_patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"git":{"executable":null}}"#).unwrap();
    store.update(&clear_patch).unwrap();
    assert_eq!(configured_path(), None);
}

#[test]
fn apply_git_override_installs_the_stored_path() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = ResetConfigured;

    let dir = tempfile::tempdir().unwrap();
    let fake_git = common_fake_git(dir.path());

    let (_sdir, path) = common::temp_file_path("settings.json");
    // Write a settings file that has a git executable already.
    fs::write(
        &path,
        format!(
            r#"{{"version":2,"settings":{{"git":{{"executable":"{}"}}}}}}"#,
            fake_git.display()
        ),
    )
    .unwrap();

    let store = SettingsStore::load(path.clone());
    // At this point configured_path is still None; apply_git_override sets it.
    store.apply_git_override();
    assert_eq!(configured_path(), Some(fake_git));
}

#[test]
fn update_reports_io_when_the_directory_is_unwritable() {
    let dir = tempfile::tempdir().unwrap();
    // Make the directory unwritable
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o500)).unwrap();

    let path = dir.path().join("settings.json");
    let store = SettingsStore::load(path.clone());

    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"tools":{"editor":"code"}}"#).unwrap();
    let err = store.update(&patch).unwrap_err();

    use git_real_lib::error::AppErrorKind;
    assert_eq!(err.kind, AppErrorKind::Io);
    // In-memory value is NOT persisted — it should not have changed
    assert!(store.get().tools.editor.is_none());

    // Restore permissions so the temp dir can be cleaned up
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn common_fake_git(dir: &std::path::Path) -> PathBuf {
    let script = "echo git version 9.9.9";
    let path = dir.join("git");
    let body = format!("#!/bin/sh\n[ -n \"$FAKE_GIT_PROBE\" ] && exit 0\n{script}\n");
    fs::write(&path, body).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn make_non_git(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("not_git");
    fs::write(&path, "#!/bin/sh\necho hello\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

// ─── get_settings_inner / update_settings_inner wrappers ──────────────────────

/// Coverage gap: `get_settings_inner` is a thin wrapper; exercise it end-to-end.
#[test]
fn get_settings_inner_returns_current_settings() {
    use git_real_lib::commands::settings::get_settings_inner;

    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path);

    let settings = get_settings_inner(&store);
    assert_eq!(settings, git_real_core::Settings::default());
}

/// Coverage gap: `update_settings_inner` is a thin wrapper; exercise it end-to-end.
#[test]
fn update_settings_inner_persists_the_patch() {
    use git_real_lib::commands::settings::{get_settings_inner, update_settings_inner};

    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path);

    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"tools":{"editor":"nano"}}"#).unwrap();
    let updated = update_settings_inner(&store, &patch).unwrap();
    assert_eq!(updated.tools.editor.as_deref(), Some("nano"));
    assert_eq!(
        get_settings_inner(&store).tools.editor.as_deref(),
        Some("nano")
    );
}

// ─── v2: lenient load, window geometry, init script, path, health ────────────

#[test]
fn load_logs_and_keeps_the_rest_when_one_field_is_invalid() {
    let (_dir, path) = common::temp_file_path("settings.json");
    fs::write(
        &path,
        r#"{"version":2,"settings":{"appearance":{"theme":"sepia"},"layout":{"refsWidth":300}}}"#,
    )
    .unwrap();
    let store = SettingsStore::load(path);
    let settings = store.get();
    assert_eq!(
        settings.appearance.theme,
        git_real_core::Settings::default().appearance.theme
    );
    assert_eq!(settings.layout.refs_width, 300);
}

#[test]
fn set_window_writes_only_when_changed() {
    use git_real_core::settings::WindowGeometry;

    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());

    // Equal to the stored default: no write.
    assert!(!store.set_window(WindowGeometry::default()).unwrap());
    assert!(
        !path.exists(),
        "a no-op set_window must not create the file"
    );

    let geometry = WindowGeometry {
        width: 1000,
        height: 700,
        maximized: false,
    };
    assert!(store.set_window(geometry.clone()).unwrap());
    assert_eq!(store.get().window, geometry);
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(v["settings"]["window"]["width"], 1000);
    assert_eq!(v["settings"]["window"]["height"], 700);

    // Same geometry again: no write.
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    assert!(!store.set_window(geometry).unwrap());
    let after = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(
        before, after,
        "an unchanged geometry must not rewrite the file"
    );
}

#[test]
fn to_init_script_assigns_the_global_and_escapes_lt() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path);
    let patch: git_real_core::SettingsPatch =
        serde_json::from_str(r#"{"tools":{"editor":"</script><b>"}}"#).unwrap();
    store.update(&patch).unwrap();

    let script = store.to_init_script();
    assert!(
        script.starts_with("window.__GIT_REAL_SETTINGS__={"),
        "{script}"
    );
    assert!(script.ends_with(';'), "{script}");
    assert!(script.contains(r"\u003c/script"), "{script}");
    assert!(!script.contains("</script"), "{script}");
}

#[test]
fn path_returns_the_file_location() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());
    assert_eq!(store.path(), path.as_path());
}

#[test]
fn settings_file_path_inner_returns_the_store_path_as_a_string() {
    use git_real_lib::commands::settings::settings_file_path_inner;

    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path.clone());
    assert_eq!(
        settings_file_path_inner(&store),
        path.to_string_lossy().into_owned()
    );
}

#[test]
fn check_settings_health_flags_a_missing_clone_dir() {
    use git_real_lib::commands::settings::check_settings_health_inner;

    // No default clone dir.
    let (_dir, path) = common::temp_file_path("settings.json");
    let store = SettingsStore::load(path);
    assert!(!check_settings_health_inner(&store).default_clone_dir_missing);

    // An existing directory.
    let existing = tempfile::tempdir().unwrap();
    let (_dir2, path2) = common::temp_file_path("settings.json");
    let store2 = SettingsStore::load(path2);
    let json = format!(
        r#"{{"clone":{{"defaultDir":"{}"}}}}"#,
        existing.path().display()
    );
    let patch: git_real_core::SettingsPatch = serde_json::from_str(&json).unwrap();
    store2.update(&patch).unwrap();
    assert!(!check_settings_health_inner(&store2).default_clone_dir_missing);

    // A missing directory written straight into the file, bypassing `update`.
    let (_dir3, path3) = common::temp_file_path("settings.json");
    fs::write(
        &path3,
        r#"{"version":2,"settings":{"clone":{"defaultDir":"/definitely/missing"}}}"#,
    )
    .unwrap();
    let store3 = SettingsStore::load(path3);
    assert!(check_settings_health_inner(&store3).default_clone_dir_missing);
}

#[test]
fn settings_health_serialises_camel_case() {
    use git_real_lib::commands::settings::SettingsHealth;

    let v = serde_json::to_value(SettingsHealth {
        default_clone_dir_missing: true,
    })
    .unwrap();
    assert_eq!(v, serde_json::json!({"defaultCloneDirMissing": true}));
}

// ─── ensure_file_exists (Show in folder on a fresh install) ──────────────────

#[test]
fn ensure_file_exists_creates_a_missing_file_with_the_current_settings() {
    let dir = tempfile::tempdir().unwrap();
    // The config directory does not exist yet either, as on a fresh install.
    let path = dir.path().join("config").join("settings.json");
    let store = SettingsStore::load(path.clone());

    store.ensure_file_exists().unwrap();

    let text = fs::read_to_string(&path).unwrap();
    let (settings, warnings) = git_real_core::SettingsFile::parse(&text).unwrap();
    assert_eq!(settings, store.get());
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn ensure_file_exists_leaves_an_existing_file_untouched() {
    let (_dir, path) = common::temp_file_path("settings.json");
    let original = r#"{"version":2,"settings":{"tools":{"editor":"vim"}}}"#;
    fs::write(&path, original).unwrap();
    let store = SettingsStore::load(path.clone());
    let before = fs::metadata(&path).unwrap().modified().unwrap();

    store.ensure_file_exists().unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let after = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(before, after, "an existing file must not be rewritten");
}
