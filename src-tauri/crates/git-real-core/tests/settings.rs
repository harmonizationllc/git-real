//! Task 1: Failing tests for `settings.rs` — Settings, SettingsPatch, SettingsFile.
//! Imports reference the not-yet-existing module; this file is expected to fail to compile.

mod common;

use std::path::PathBuf;

use git_real_core::{SETTINGS_VERSION, Settings, SettingsError, SettingsFile, SettingsPatch};

fn abs(p: &str) -> PathBuf {
    PathBuf::from(p)
}

// --- Default ---

#[test]
fn default_settings_are_all_none() {
    let s = Settings::default();
    assert!(s.default_clone_dir.is_none());
    assert!(s.git_executable.is_none());
    assert!(s.external_editor.is_none());
    assert!(s.external_diff_tool.is_none());
    assert!(s.external_merge_tool.is_none());
}

// --- Serialisation ---

#[test]
fn settings_serialize_camel_case_with_nulls() {
    let s = Settings::default();
    let v = serde_json::to_value(&s).unwrap();
    // All five keys exist as camelCase and are null
    assert_eq!(v["defaultCloneDir"], serde_json::Value::Null);
    assert_eq!(v["gitExecutable"], serde_json::Value::Null);
    assert_eq!(v["externalEditor"], serde_json::Value::Null);
    assert_eq!(v["externalDiffTool"], serde_json::Value::Null);
    assert_eq!(v["externalMergeTool"], serde_json::Value::Null);
    // Round-trip
    let back: Settings = serde_json::from_value(v).unwrap();
    assert_eq!(back, s);
}

// --- SettingsPatch behaviour ---

#[test]
fn patch_absent_key_keeps_and_null_clears_and_value_sets() {
    let base = Settings {
        external_editor: Some("code --wait".into()),
        ..Default::default()
    };

    // Absent key → keep
    let patch_keep: SettingsPatch = serde_json::from_str("{}").unwrap();
    let kept = base.apply(&patch_keep).unwrap();
    assert_eq!(kept.external_editor.as_deref(), Some("code --wait"));

    // null → clear
    let patch_clear: SettingsPatch = serde_json::from_str(r#"{"externalEditor":null}"#).unwrap();
    let cleared = base.apply(&patch_clear).unwrap();
    assert!(cleared.external_editor.is_none());

    // value → set
    let patch_set: SettingsPatch =
        serde_json::from_str(r#"{"externalEditor":"code --wait"}"#).unwrap();
    let set = base.apply(&patch_set).unwrap();
    assert_eq!(set.external_editor.as_deref(), Some("code --wait"));
}

// --- String normalisation ---

#[test]
fn apply_trims_strings_and_maps_empty_to_none() {
    let base = Settings::default();

    // Whitespace-only → None
    let patch: SettingsPatch = serde_json::from_str(r#"{"externalEditor":"  "}"#).unwrap();
    let result = base.apply(&patch).unwrap();
    assert!(result.external_editor.is_none());

    // Surrounding whitespace → trimmed
    let patch2: SettingsPatch = serde_json::from_str(r#"{"externalDiffTool":" meld "}"#).unwrap();
    let result2 = base.apply(&patch2).unwrap();
    assert_eq!(result2.external_diff_tool.as_deref(), Some("meld"));
}

// --- Validation errors ---

#[test]
fn apply_rejects_a_relative_clone_dir() {
    let base = Settings::default();
    let patch: SettingsPatch =
        serde_json::from_str(r#"{"defaultCloneDir":"relative/path"}"#).unwrap();
    let err = base.apply(&patch).unwrap_err();
    assert_eq!(err, SettingsError::RelativePath("default clone directory"));
}

#[test]
fn apply_rejects_a_relative_git_executable() {
    let base = Settings::default();
    let patch: SettingsPatch = serde_json::from_str(r#"{"gitExecutable":"relative/git"}"#).unwrap();
    let err = base.apply(&patch).unwrap_err();
    assert_eq!(err, SettingsError::RelativePath("Git executable"));
}

#[test]
fn apply_rejects_a_clone_dir_that_is_not_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    // Create a file (not a directory) inside the temp dir
    let file_path = dir.path().join("not_a_dir.txt");
    std::fs::write(&file_path, "x").unwrap();

    let base = Settings::default();
    let json = format!(
        r#"{{"defaultCloneDir":"{}"}}"#,
        file_path.to_str().unwrap().replace('\\', "\\\\")
    );
    let patch: SettingsPatch = serde_json::from_str(&json).unwrap();
    let err = base.apply(&patch).unwrap_err();
    assert_eq!(err, SettingsError::NotADirectory(file_path));
}

#[test]
fn apply_accepts_an_existing_absolute_clone_dir() {
    let dir = tempfile::tempdir().unwrap();
    let base = Settings::default();
    let json = format!(
        r#"{{"defaultCloneDir":"{}"}}"#,
        dir.path().to_str().unwrap().replace('\\', "\\\\")
    );
    let patch: SettingsPatch = serde_json::from_str(&json).unwrap();
    let result = base.apply(&patch).unwrap();
    assert_eq!(
        result.default_clone_dir,
        Some(abs(dir.path().to_str().unwrap()))
    );
}

// --- SettingsFile versioning ---

#[test]
fn settings_file_round_trips_version_1_and_rejects_version_2() {
    let settings = Settings {
        external_editor: Some("code --wait".into()),
        ..Default::default()
    };
    let file = SettingsFile::current(settings.clone());
    assert_eq!(file.version, SETTINGS_VERSION);
    // into_settings succeeds for version 1
    let back = file.into_settings().unwrap();
    assert_eq!(back, settings);

    // version 2 → None
    let file_v2 = SettingsFile {
        version: 2,
        settings: Settings::default(),
    };
    assert!(file_v2.into_settings().is_none());
}

#[test]
fn settings_file_without_a_settings_key_is_defaults() {
    let json = r#"{"version":1}"#;
    let file: SettingsFile = serde_json::from_str(json).unwrap();
    let settings = file.into_settings().unwrap();
    assert_eq!(settings, Settings::default());
}
