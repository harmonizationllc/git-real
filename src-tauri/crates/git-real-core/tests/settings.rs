//! Settings v2: the nested shape, lenient per-field loading (Load mode), the
//! nested patch (Patch mode) and the versioned file codec.

use std::path::PathBuf;

use git_real_core::settings::{
    CloneUrlForm, DiffMode, SETTINGS_VERSION, Settings, SettingsError, SettingsFile,
    SettingsFileError, SettingsPatch, Theme, WINDOW_MIN, WindowGeometry,
};
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/lib/store/settingsDefaults.json"
);

fn patch(json: Value) -> SettingsPatch {
    serde_json::from_value(json).unwrap()
}

fn fields(warnings: &[git_real_core::settings::SettingsWarning]) -> Vec<&str> {
    warnings.iter().map(|w| w.field.as_str()).collect()
}

// --- Defaults ---

#[test]
fn default_settings_equal_the_shared_fixture() {
    let text = std::fs::read_to_string(FIXTURE).unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(serde_json::to_value(Settings::default()).unwrap(), fixture);
}

// --- File codec ---

#[test]
fn file_round_trips_version_2() {
    let mut s = Settings::default();
    s.tools.editor = Some("code --wait".into());
    s.appearance.theme = Theme::Dark;
    s.clone.url_form = CloneUrlForm::Ssh;
    s.diff.mode = DiffMode::Unified;
    s.layout.refs_width = 300;
    s.window = WindowGeometry {
        width: 1500,
        height: 900,
        maximized: true,
    };

    let file = SettingsFile::current(s.clone());
    assert_eq!(file.version, SETTINGS_VERSION);
    assert_eq!(SETTINGS_VERSION, 2);
    let text = serde_json::to_string_pretty(&file).unwrap();
    assert!(text.starts_with("{\n  \"version\": 2,"), "{text}");

    let (back, warnings) = SettingsFile::parse(&text).unwrap();
    assert_eq!(back, s);
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn file_version_1_is_unknown() {
    let v1 = r#"{
      "version": 1,
      "settings": {
        "defaultCloneDir": null,
        "gitExecutable": "/usr/bin/git",
        "externalEditor": "code --wait",
        "externalDiffTool": null,
        "externalMergeTool": null
      }
    }"#;
    assert_eq!(
        SettingsFile::parse(v1),
        Err(SettingsFileError::UnknownVersion(1))
    );
}

#[test]
fn file_corrupt_is_corrupt() {
    assert!(matches!(
        SettingsFile::parse("{not json"),
        Err(SettingsFileError::Corrupt(_))
    ));
    assert!(matches!(
        SettingsFile::parse("[1, 2]"),
        Err(SettingsFileError::Corrupt(_))
    ));
    assert!(matches!(
        SettingsFile::parse(r#"{"version":"two"}"#),
        Err(SettingsFileError::Corrupt(_))
    ));
}

#[test]
fn file_version_2_without_settings_is_defaults_with_a_warning() {
    let (s, warnings) = SettingsFile::parse(r#"{"version":2}"#).unwrap();
    assert_eq!(s, Settings::default());
    assert_eq!(fields(&warnings), vec!["settings"]);
}

// --- Load mode (lenient) ---

#[test]
fn lenient_unknown_theme_falls_back_and_keeps_the_rest() {
    let (s, warnings) =
        Settings::from_json_lenient(&json!({"appearance":{"theme":"sepia","diffFontSize":16}}));
    assert_eq!(s.appearance.theme, Theme::System);
    assert_eq!(s.appearance.diff_font_size, 16);
    assert_eq!(fields(&warnings), vec!["appearance.theme"]);
}

#[test]
fn lenient_clamps_font_size_and_widths() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "appearance": {"diffFontSize": 99},
        "layout": {"refsWidth": 10, "sidebarWidth": 10},
        "window": {"width": 1, "height": 1}
    }));
    assert_eq!(s.appearance.diff_font_size, 24);
    assert_eq!(s.layout.refs_width, 160);
    assert_eq!(s.layout.sidebar_width, 240);
    assert_eq!((s.window.width, s.window.height), (960, 600));
    assert_eq!(warnings.len(), 4, "{warnings:?}");
}

#[test]
fn lenient_wrong_type_falls_back_per_field() {
    for bad in [json!(240.5), json!("240")] {
        let (s, warnings) = Settings::from_json_lenient(&json!({
            "layout": {
                "refsWidth": bad,
                "sidebarWidth": 400,
                "tagsCollapsed": false,
                "pullRequestsCollapsed": true,
                "issuesCollapsed": false
            }
        }));
        assert_eq!(s.layout.refs_width, 240);
        assert_eq!(s.layout.sidebar_width, 400);
        assert!(!s.layout.tags_collapsed);
        assert!(s.layout.pull_requests_collapsed);
        assert!(!s.layout.issues_collapsed);
        assert_eq!(fields(&warnings), vec!["layout.refsWidth"]);
    }
}

#[test]
fn lenient_keeps_a_relative_path_out_but_a_missing_absolute_path_in() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "clone": {"defaultDir": "rel/dir"},
        "git": {"executable": "rel/git"}
    }));
    assert_eq!(s.clone.default_dir, None);
    assert_eq!(s.git.executable, None);
    let mut got = fields(&warnings);
    got.sort_unstable();
    assert_eq!(got, vec!["clone.defaultDir", "git.executable"]);

    let (s, warnings) = Settings::from_json_lenient(&json!({
        "clone": {"defaultDir": "/definitely/missing"},
        "git": {"executable": "/definitely/missing/git"}
    }));
    assert_eq!(
        s.clone.default_dir,
        Some(PathBuf::from("/definitely/missing"))
    );
    assert_eq!(
        s.git.executable,
        Some(PathBuf::from("/definitely/missing/git"))
    );
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn lenient_ignores_unknown_keys_without_warning() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "bogus": {"x": 1},
        "diff": {"mode": "unified", "colour": "blue"},
        "layout": {}
    }));
    let mut expected = Settings::default();
    expected.diff.mode = DiffMode::Unified;
    assert_eq!(s, expected);
    assert!(warnings.is_empty(), "{warnings:?}");
}

// --- Patch mode ---

#[test]
fn patch_absent_keeps_null_clears_value_sets() {
    let mut base = Settings::default();
    base.tools.editor = Some("code --wait".into());

    let kept = base.apply(&patch(json!({}))).unwrap();
    assert_eq!(kept.tools.editor.as_deref(), Some("code --wait"));
    let kept = base.apply(&patch(json!({"tools": {}}))).unwrap();
    assert_eq!(kept.tools.editor.as_deref(), Some("code --wait"));

    let cleared = base
        .apply(&patch(json!({"tools": {"editor": null}})))
        .unwrap();
    assert_eq!(cleared.tools.editor, None);

    let set = base
        .apply(&patch(json!({"tools": {"editor": "nvim"}})))
        .unwrap();
    assert_eq!(set.tools.editor.as_deref(), Some("nvim"));
}

#[test]
fn patch_non_nullable_leaf_absent_keeps() {
    let mut base = Settings::default();
    base.diff.mode = DiffMode::Unified;

    let kept = base
        .apply(&patch(json!({"diff": {"ignoreWhitespace": true}})))
        .unwrap();
    assert_eq!(kept.diff.mode, DiffMode::Unified);
    assert!(kept.diff.ignore_whitespace);

    let set = base
        .apply(&patch(json!({"diff": {"mode": "split"}})))
        .unwrap();
    assert_eq!(set.diff.mode, DiffMode::Split);
}

#[test]
fn apply_rejects_a_missing_clone_dir_and_a_relative_git_path() {
    let base = Settings::default();

    let err = base
        .apply(&patch(
            json!({"clone": {"defaultDir": "/definitely/missing"}}),
        ))
        .unwrap_err();
    assert_eq!(
        err,
        SettingsError::NotADirectory(PathBuf::from("/definitely/missing"))
    );

    let err = base
        .apply(&patch(json!({"clone": {"defaultDir": "relative/path"}})))
        .unwrap_err();
    assert_eq!(err, SettingsError::RelativePath("default clone directory"));

    let err = base
        .apply(&patch(json!({"git": {"executable": "relative/git"}})))
        .unwrap_err();
    assert_eq!(err, SettingsError::RelativePath("Git executable"));

    let dir = tempfile::tempdir().unwrap();
    let ok = base
        .apply(&patch(json!({"clone": {"defaultDir": dir.path()}})))
        .unwrap();
    assert_eq!(ok.clone.default_dir.as_deref(), Some(dir.path()));
}

#[test]
fn apply_does_not_recheck_an_unpatched_missing_clone_dir() {
    // A file copied from another machine keeps a dir that does not exist here;
    // changing an unrelated setting must still succeed.
    let mut base = Settings::default();
    base.clone.default_dir = Some(PathBuf::from("/definitely/missing"));
    let next = base
        .apply(&patch(json!({"appearance": {"theme": "dark"}})))
        .unwrap();
    assert_eq!(next.appearance.theme, Theme::Dark);
    assert_eq!(next.clone.default_dir, base.clone.default_dir);
}

#[test]
fn apply_clamps_font_size_and_widths() {
    let base = Settings::default();
    let next = base
        .apply(&patch(json!({
            "appearance": {"diffFontSize": 2},
            "layout": {"refsWidth": 10, "sidebarWidth": 10},
            "window": {"width": 100, "height": 100}
        })))
        .unwrap();
    assert_eq!(next.appearance.diff_font_size, 10);
    assert_eq!(next.layout.refs_width, 160);
    assert_eq!(next.layout.sidebar_width, 240);
    assert_eq!((next.window.width, next.window.height), WINDOW_MIN);

    let next = base
        .apply(&patch(json!({"appearance": {"diffFontSize": 99}})))
        .unwrap();
    assert_eq!(next.appearance.diff_font_size, 24);
}

#[test]
fn apply_trims_tool_commands_and_maps_empty_to_none() {
    let mut base = Settings::default();
    base.tools.merge_tool = Some("kdiff3".into());
    let next = base
        .apply(&patch(json!({
            "tools": {"editor": "  ", "diffTool": " meld ", "mergeTool": ""},
            "appearance": {"diffFontFamily": "  Fira Code  "}
        })))
        .unwrap();
    assert_eq!(next.tools.editor, None);
    assert_eq!(next.tools.diff_tool.as_deref(), Some("meld"));
    assert_eq!(next.tools.merge_tool, None);
    assert_eq!(
        next.appearance.diff_font_family.as_deref(),
        Some("Fira Code")
    );
}

// --- Window geometry ---

#[test]
fn window_clamp_to_min() {
    let small = WindowGeometry {
        width: 1,
        height: 1,
        maximized: true,
    };
    assert_eq!(
        small.clamp_to_min(),
        WindowGeometry {
            width: 960,
            height: 600,
            maximized: true
        }
    );
    let big = WindowGeometry {
        width: 2000,
        height: 1200,
        maximized: false,
    };
    assert_eq!(big.clone().clamp_to_min(), big);
    assert_eq!(
        (
            WindowGeometry::default().width,
            WindowGeometry::default().height
        ),
        (1280, 800)
    );
}
