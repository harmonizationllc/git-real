//! Settings v2: the nested shape, lenient per-field loading (Load mode), the
//! nested patch (Patch mode) and the versioned file codec.

// The cfg(unix) imports serve only the GR-36 unix-gated tests below.
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use git_real_core::settings::SettingsError;
use git_real_core::settings::{
    CloneUrlForm, DiffMode, SETTINGS_VERSION, Settings, SettingsFile, SettingsFileError,
    SettingsPatch, Theme, WINDOW_MIN, WindowGeometry,
};
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/lib/store/settingsDefaults.json"
);

const TOKENS_CSS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/styles/tokens.css"
);

fn patch(json: Value) -> SettingsPatch {
    serde_json::from_value(json).unwrap()
}

fn fields(warnings: &[git_real_core::settings::SettingsWarning]) -> Vec<&str> {
    warnings.iter().map(|w| w.field.as_str()).collect()
}

// --- Theme background ---

#[test]
fn background_rgb_matches_tokens_css() {
    use git_real_core::settings::{BG_DARK_RGB, BG_LIGHT_RGB, Theme, background_rgb};
    assert_eq!(BG_DARK_RGB, (30, 30, 30));
    assert_eq!(BG_LIGHT_RGB, (246, 246, 246));
    assert_eq!(background_rgb(Theme::Dark, false), (30, 30, 30));
    assert_eq!(background_rgb(Theme::Dark, true), (30, 30, 30));
    assert_eq!(background_rgb(Theme::Light, true), (246, 246, 246));
    assert_eq!(background_rgb(Theme::System, true), (30, 30, 30));
    assert_eq!(background_rgb(Theme::System, false), (246, 246, 246));
}

/// The `--color-bg` value inside the block whose header line is `header`
/// (compared after trimming, so indentation inside `@media` does not matter).
fn color_bg_in(css: &str, header: &str) -> (u8, u8, u8) {
    let mut lines = css.lines().skip_while(|l| l.trim() != header.trim());
    assert!(
        lines.next().is_some(),
        "no block header {header:?} in tokens.css"
    );
    for line in lines {
        let line = line.trim();
        if line.starts_with('}') {
            break;
        }
        if let Some(hex) = line
            .strip_prefix("--color-bg:")
            .and_then(|v| v.trim().strip_suffix(';'))
            .and_then(|v| v.trim().strip_prefix('#'))
        {
            let n = u32::from_str_radix(hex, 16).unwrap();
            return ((n >> 16) as u8, (n >> 8) as u8, n as u8);
        }
    }
    panic!("no --color-bg in block {header:?}");
}

#[test]
fn background_constants_match_tokens_css() {
    use git_real_core::settings::{BG_DARK_RGB, BG_LIGHT_RGB};
    let css = std::fs::read_to_string(TOKENS_CSS).unwrap();
    assert_eq!(color_bg_in(&css, ":root {"), BG_LIGHT_RGB);
    assert_eq!(
        color_bg_in(&css, r#":root[data-theme="dark"] {"#),
        BG_DARK_RGB
    );
    assert_eq!(
        color_bg_in(&css, r#":root:not([data-theme="light"]) {"#),
        BG_DARK_RGB
    );
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
    let mut got = fields(&warnings);
    got.sort_unstable();
    assert_eq!(
        got,
        vec![
            "appearance.diffFontSize",
            "layout.refsWidth",
            "layout.sidebarWidth",
            "window"
        ]
    );
}

#[test]
fn lenient_u32_overflow_and_negative_fall_back() {
    for bad in [json!(4_294_967_296_u64), json!(-5)] {
        let (s, warnings) = Settings::from_json_lenient(&json!({
            "layout": {"refsWidth": bad}
        }));
        assert_eq!(s.layout.refs_width, 240, "{bad}");
        assert_eq!(fields(&warnings), vec!["layout.refsWidth"], "{bad}");
    }
}

#[test]
fn lenient_non_object_section_falls_back() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": 5,
        "diff": {"mode": "unified"}
    }));
    assert_eq!(s.layout, Settings::default().layout);
    assert_eq!(s.diff.mode, DiffMode::Unified);
    assert_eq!(fields(&warnings), vec!["layout"]);
}

#[test]
fn lenient_null_on_non_nullable_leaf_falls_back() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "diff": {"mode": null}
    }));
    assert_eq!(s.diff.mode, DiffMode::Split);
    assert_eq!(fields(&warnings), vec!["diff.mode"]);
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

/// Load mode cannot fail: every relative form of either path leaf is dropped
/// to the default with one warning per leaf, and a missing absolute path is
/// kept (Load never checks existence).
// GR-36: /definitely/missing is not absolute on Windows; test data is Unix-shaped.
#[cfg(unix)]
#[test]
fn lenient_relative_paths_never_panic() {
    for rel in ["rel/dir", "", ".", "..", "./git", "~/git"] {
        let (s, warnings) = Settings::from_json_lenient(&json!({
            "clone": {"defaultDir": rel},
            "git": {"executable": rel},
            "layout": {"refsWidth": 300}
        }));
        assert_eq!(s.clone.default_dir, None, "{rel:?}");
        assert_eq!(s.git.executable, None, "{rel:?}");
        assert_eq!(s.layout.refs_width, 300, "{rel:?}");
        let mut got = fields(&warnings);
        got.sort_unstable();
        assert_eq!(got, vec!["clone.defaultDir", "git.executable"], "{rel:?}");
    }

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

// GR-36: /definitely/missing is not absolute on Windows; test data is Unix-shaped.
#[cfg(unix)]
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

// GR-36: /definitely/missing is not absolute on Windows; test data is Unix-shaped.
#[cfg(unix)]
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

// Contract: the four section heights are optional leaves, clamped to SECTION_HEIGHT_MIN, null meaning automatic.
#[test]
fn layout_section_heights_default_to_none() {
    let d = Settings::default();
    assert_eq!(d.layout.branches_height, None);
    assert_eq!(d.layout.stashes_height, None);
    assert_eq!(d.layout.tags_height, None);
    assert_eq!(d.layout.pull_requests_height, None);
    assert_eq!(git_real_core::settings::SECTION_HEIGHT_MIN, 72);
}

#[test]
fn lenient_section_heights_absent_null_wrong_type_and_small() {
    let (s, warnings) = Settings::from_json_lenient(&json!({"layout": {}}));
    assert_eq!(s.layout.tags_height, None);
    assert!(warnings.is_empty(), "{warnings:?}");

    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"tagsHeight": null, "stashesHeight": "300", "branchesHeight": 10, "pullRequestsHeight": 200}
    }));
    assert_eq!(s.layout.tags_height, None);
    assert_eq!(s.layout.stashes_height, None);
    assert_eq!(s.layout.branches_height, Some(72));
    assert_eq!(s.layout.pull_requests_height, Some(200));
    let mut got = fields(&warnings);
    got.sort_unstable();
    assert_eq!(got, vec!["layout.branchesHeight", "layout.stashesHeight"]);
}

#[test]
fn lenient_section_heights_name_tags_and_pull_requests_warnings() {
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"tagsHeight": "x", "pullRequestsHeight": 1}
    }));
    assert_eq!(s.layout.tags_height, None);
    assert_eq!(s.layout.pull_requests_height, Some(72));
    let mut got = fields(&warnings);
    got.sort_unstable();
    assert_eq!(got, vec!["layout.pullRequestsHeight", "layout.tagsHeight"]);
}

#[test]
fn patch_section_height_clamps_every_section_and_zero() {
    let base = Settings::default();
    let apply =
        |layout: serde_json::Value| base.apply(&patch(json!({ "layout": layout }))).unwrap();
    assert_eq!(
        apply(json!({"stashesHeight": 5})).layout.stashes_height,
        Some(72)
    );
    assert_eq!(
        apply(json!({"pullRequestsHeight": 5}))
            .layout
            .pull_requests_height,
        Some(72)
    );
    assert_eq!(apply(json!({"tagsHeight": 0})).layout.tags_height, Some(72));
}

#[test]
fn patch_section_height_absent_keeps_null_clears_value_sets_and_clamps() {
    let mut base = Settings::default();
    base.layout.tags_height = Some(300);

    let kept = base
        .apply(&patch(json!({"layout": {"refsWidth": 250}})))
        .unwrap();
    assert_eq!(kept.layout.tags_height, Some(300));
    let cleared = base
        .apply(&patch(json!({"layout": {"tagsHeight": null}})))
        .unwrap();
    assert_eq!(cleared.layout.tags_height, None);
    let set = base
        .apply(&patch(json!({"layout": {"tagsHeight": 410}})))
        .unwrap();
    assert_eq!(set.layout.tags_height, Some(410));
    let small = base
        .apply(&patch(json!({"layout": {"branchesHeight": 5}})))
        .unwrap();
    assert_eq!(small.layout.branches_height, Some(72));
}

#[test]
fn section_heights_round_trip_through_the_file_codec() {
    let mut s = Settings::default();
    s.layout.stashes_height = Some(120);
    let text = serde_json::to_string_pretty(&SettingsFile::current(s.clone())).unwrap();
    assert!(text.contains("\"stashesHeight\": 120"), "{text}");
    assert!(text.contains("\"tagsHeight\": null"), "{text}");
    let (back, warnings) = SettingsFile::parse(&text).unwrap();
    assert_eq!(back, s);
    assert!(warnings.is_empty(), "{warnings:?}");
}

// --- GR-39: worktrees section layout ---

#[test]
fn worktrees_collapsed_defaults_to_false_and_round_trips_true() {
    assert!(!Settings::default().layout.worktrees_collapsed);
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"worktreesCollapsed": true}
    }));
    assert!(s.layout.worktrees_collapsed);
    assert!(warnings.is_empty(), "{warnings:?}");
    let patched = Settings::default()
        .apply(&patch(json!({"layout": {"worktreesCollapsed": true}})))
        .unwrap();
    assert!(patched.layout.worktrees_collapsed);
    let text = serde_json::to_string_pretty(&SettingsFile::current(patched.clone())).unwrap();
    let (back, _) = SettingsFile::parse(&text).unwrap();
    assert_eq!(back, patched);
}

#[test]
fn lenient_worktrees_height_wrong_type_warns_and_small_clamps() {
    assert_eq!(Settings::default().layout.worktrees_height, None);
    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"worktreesHeight": "300"}
    }));
    assert_eq!(s.layout.worktrees_height, None);
    assert_eq!(fields(&warnings), vec!["layout.worktreesHeight"]);

    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"worktreesHeight": 10}
    }));
    assert_eq!(s.layout.worktrees_height, Some(72));
    assert_eq!(fields(&warnings), vec!["layout.worktreesHeight"]);
}

#[test]
fn patch_worktrees_height_clamps_zero_clears_null_and_sets() {
    let mut base = Settings::default();
    assert_eq!(
        base.apply(&patch(json!({"layout": {"worktreesHeight": 0}})))
            .unwrap()
            .layout
            .worktrees_height,
        Some(72)
    );
    base.layout.worktrees_height = Some(300);
    let kept = base
        .apply(&patch(json!({"layout": {"refsWidth": 250}})))
        .unwrap();
    assert_eq!(kept.layout.worktrees_height, Some(300));
    let cleared = base
        .apply(&patch(json!({"layout": {"worktreesHeight": null}})))
        .unwrap();
    assert_eq!(cleared.layout.worktrees_height, None);
    let set = base
        .apply(&patch(json!({"layout": {"worktreesHeight": 410}})))
        .unwrap();
    assert_eq!(set.layout.worktrees_height, Some(410));
}

#[test]
fn worktrees_height_null_is_serialized_in_the_file() {
    let text = serde_json::to_string_pretty(&SettingsFile::current(Settings::default())).unwrap();
    assert!(text.contains("\"worktreesHeight\": null"), "{text}");
    assert!(text.contains("\"worktreesCollapsed\": false"), "{text}");
}
