//! Persisted application settings: every user preference plus the main
//! window's size and maximized state, grouped by section in one version-2
//! `settings.json` that the backend owns and injects into the page before
//! first paint. Any other version, including GR-14's flat version 1, loads as
//! defaults and is overwritten on the next save.
//!
//! Two ways in, one validator:
//! - **Load** ([`Settings::from_json_lenient`]): a bad leaf falls back to its
//!   default with a warning and the rest of the file is kept. Path existence is
//!   never checked, so a file copied from another machine stays as written.
//! - **Patch** ([`Settings::apply`]): a bad path is an error, and a newly set
//!   clone directory must exist.
//!
//! Both run the same [`Settings::normalise`] so clamps and trims cannot drift.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

// --- Types, defaults and constants -------------------------------------------

/// Smallest and largest diff font size, in px.
pub const DIFF_FONT_MIN: u32 = 10;
pub const DIFF_FONT_MAX: u32 = 24;
/// Narrowest refs panel, in px.
pub const REFS_MIN: u32 = 160;
/// Shortest a refs section can be dragged, in px.
pub const SECTION_HEIGHT_MIN: u32 = 72;
/// Narrowest sidebar, in px.
pub const SIDEBAR_MIN: u32 = 240;
/// Smallest window, `(width, height)` in logical px.
pub const WINDOW_MIN: (u32, u32) = (960, 600);
/// First-run window size, `(width, height)` in logical px.
pub const WINDOW_DEFAULT: (u32, u32) = (1280, 800);

/// Every user preference. Each section mirrors one group of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub git: GitSettings,
    pub clone: CloneSettings,
    pub tools: ToolSettings,
    pub appearance: AppearanceSettings,
    pub diff: DiffSettings,
    pub layout: LayoutSettings,
    pub updates: UpdateSettings,
    pub shortcuts: ShortcutSettings,
    pub window: WindowGeometry,
}

/// `None` means "find git on `PATH`".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitSettings {
    pub executable: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneSettings {
    pub default_dir: Option<PathBuf>,
    pub url_form: CloneUrlForm,
}

/// External tool commands; `None` means no tool configured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolSettings {
    pub editor: Option<String>,
    pub diff_tool: Option<String>,
    pub merge_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub theme: Theme,
    pub diff_font_family: Option<String>,
    pub diff_font_size: u32,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            diff_font_family: None,
            diff_font_size: 13,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffSettings {
    pub mode: DiffMode,
    pub ignore_whitespace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutSettings {
    pub refs_width: u32,
    pub sidebar_width: u32,
    pub tags_collapsed: bool,
    pub pull_requests_collapsed: bool,
    pub issues_collapsed: bool,
    pub branches_height: Option<u32>,
    pub stashes_height: Option<u32>,
    pub tags_height: Option<u32>,
    pub worktrees_collapsed: bool,
    pub worktrees_height: Option<u32>,
    pub pull_requests_height: Option<u32>,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            refs_width: 240,
            sidebar_width: 320,
            tags_collapsed: true,
            pull_requests_collapsed: false,
            issues_collapsed: true,
            branches_height: None,
            stashes_height: None,
            tags_height: None,
            worktrees_collapsed: false,
            worktrees_height: None,
            pull_requests_height: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    pub check_on_startup: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            check_on_startup: true,
        }
    }
}

/// Keyboard-shortcut overrides, keyed by shortcut id. A string is a chord, a
/// `null` means the shortcut is unbound, and an absent id keeps its built-in
/// default. Rust checks the shape only: the chord grammar and the set of known
/// ids belong to the front end, so unknown ids are kept as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutSettings {
    pub bindings: BTreeMap<String, Option<String>>,
}

/// The main window's size in logical px, and whether it is maximised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: WINDOW_DEFAULT.0,
            height: WINDOW_DEFAULT.1,
            maximized: false,
        }
    }
}

impl WindowGeometry {
    /// Raises `width` and `height` to at least [`WINDOW_MIN`]; `maximized` is
    /// left alone.
    pub fn clamp_to_min(self) -> WindowGeometry {
        WindowGeometry {
            width: self.width.max(WINDOW_MIN.0),
            height: self.height.max(WINDOW_MIN.1),
            ..self
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// The dark theme's window background, `--color-bg` in `src/styles/tokens.css`.
pub const BG_DARK_RGB: (u8, u8, u8) = (30, 30, 30);

/// The light theme's window background, `--color-bg` in `src/styles/tokens.css`.
pub const BG_LIGHT_RGB: (u8, u8, u8) = (246, 246, 246);

/// The window background for `theme`. [`Theme::System`] follows the desktop:
/// dark when `desktop_dark`, light otherwise.
pub fn background_rgb(theme: Theme, desktop_dark: bool) -> (u8, u8, u8) {
    match theme {
        Theme::Dark => BG_DARK_RGB,
        Theme::Light => BG_LIGHT_RGB,
        Theme::System if desktop_dark => BG_DARK_RGB,
        Theme::System => BG_LIGHT_RGB,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    #[default]
    Split,
    Unified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CloneUrlForm {
    #[default]
    Https,
    Ssh,
}

/// A partial update of [`Settings`]. An absent section or key keeps the
/// current value. Nullable leaves are `Option<Option<T>>`: the outer `None` is
/// "absent", `Some(None)` is "clear" (`null`), `Some(Some(v))` is "set".
/// Non-nullable leaves are `Option<T>`: absent keeps, a value sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<GitPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone: Option<ClonePatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearancePatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<LayoutPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdatesPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<ShortcutsPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowPatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitPatch {
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub executable: Option<Option<PathBuf>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClonePatch {
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_dir: Option<Option<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_form: Option<CloneUrlForm>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolsPatch {
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor: Option<Option<String>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub diff_tool: Option<Option<String>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub merge_tool: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearancePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub diff_font_family: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_font_size: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<DiffMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_whitespace: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refs_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_requests_collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues_collapsed: Option<bool>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub branches_height: Option<Option<u32>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub stashes_height: Option<Option<u32>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub tags_height: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees_collapsed: Option<bool>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub worktrees_height: Option<Option<u32>>,
    #[serde(
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub pull_requests_height: Option<Option<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_on_startup: Option<bool>,
}

/// A present `bindings` replaces the whole map; an absent one keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bindings: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
}

/// Distinguishes an absent key from an explicit `null`: serde only calls this
/// when the key is present, so an absent key keeps the field's default (`None`)
/// while a present key yields `Some(_)`.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A rejected settings update.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SettingsError {
    #[error("the {0} must be an absolute path")]
    RelativePath(&'static str),
    #[error("{0} is not a directory")]
    NotADirectory(PathBuf),
}

/// A leaf that Load mode replaced or adjusted. `field` is the dotted path in
/// the file, e.g. `appearance.theme`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWarning {
    pub field: String,
    pub message: String,
}

impl SettingsWarning {
    fn new(field: &str, message: String) -> Self {
        Self {
            field: field.to_owned(),
            message,
        }
    }
}

// --- The shared validator ----------------------------------------------------

// The path leaves, in check order: (field in the file, label in the error).
const GIT_EXECUTABLE: (&str, &str) = ("git.executable", "Git executable");
const CLONE_DEFAULT_DIR: (&str, &str) = ("clone.defaultDir", "default clone directory");

impl Settings {
    /// Load mode's path check: a relative path is dropped to the default with
    /// a warning. Infallible, so reading a file can never fail here. Never
    /// checks that a path exists.
    fn drop_relative_paths(mut self, warnings: &mut Vec<SettingsWarning>) -> Settings {
        self.git.executable = absolute_or_default(self.git.executable, GIT_EXECUTABLE.0, warnings);
        self.clone.default_dir =
            absolute_or_default(self.clone.default_dir, CLONE_DEFAULT_DIR.0, warnings);
        self
    }

    /// Patch mode's path check: a relative path is rejected. Never checks
    /// that a path exists.
    fn require_absolute_paths(&self) -> Result<(), SettingsError> {
        for (path, (_, label)) in [
            (&self.git.executable, GIT_EXECUTABLE),
            (&self.clone.default_dir, CLONE_DEFAULT_DIR),
        ] {
            if path.as_ref().is_some_and(|p| !p.is_absolute()) {
                return Err(SettingsError::RelativePath(label));
            }
        }
        Ok(())
    }

    /// Clamps numerics and trims strings, warning on each clamp. Shared by
    /// Load and Patch mode (Patch discards the warnings); infallible.
    fn normalise(mut self, warnings: &mut Vec<SettingsWarning>) -> Settings {
        self.tools.editor = trimmed(self.tools.editor);
        self.tools.diff_tool = trimmed(self.tools.diff_tool);
        self.tools.merge_tool = trimmed(self.tools.merge_tool);
        self.appearance.diff_font_family = trimmed(self.appearance.diff_font_family);

        self.appearance.diff_font_size = bounded(
            self.appearance.diff_font_size,
            DIFF_FONT_MIN,
            DIFF_FONT_MAX,
            "appearance.diffFontSize",
            warnings,
        );
        self.layout.refs_width = bounded(
            self.layout.refs_width,
            REFS_MIN,
            u32::MAX,
            "layout.refsWidth",
            warnings,
        );
        self.layout.sidebar_width = bounded(
            self.layout.sidebar_width,
            SIDEBAR_MIN,
            u32::MAX,
            "layout.sidebarWidth",
            warnings,
        );
        let layout = &mut self.layout;
        for (height, field) in [
            (&mut layout.branches_height, "layout.branchesHeight"),
            (&mut layout.stashes_height, "layout.stashesHeight"),
            (&mut layout.tags_height, "layout.tagsHeight"),
            (&mut layout.worktrees_height, "layout.worktreesHeight"),
            (
                &mut layout.pull_requests_height,
                "layout.pullRequestsHeight",
            ),
        ] {
            if let Some(h) = *height {
                *height = Some(bounded(h, SECTION_HEIGHT_MIN, u32::MAX, field, warnings));
            }
        }
        self.shortcuts.bindings.retain(|id, chord| {
            let Some(raw) = chord else { return true };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                warnings.push(SettingsWarning::new(
                    &format!("shortcuts.bindings.{id}"),
                    "blank; dropped".to_owned(),
                ));
                return false;
            }
            if trimmed.len() != raw.len() {
                *raw = trimmed.to_owned();
            }
            true
        });
        let window = self.window.clone().clamp_to_min();
        if window != self.window {
            warnings.push(SettingsWarning::new(
                "window",
                format!(
                    "{}×{} is below the {}×{} minimum; using {}×{}",
                    self.window.width,
                    self.window.height,
                    WINDOW_MIN.0,
                    WINDOW_MIN.1,
                    window.width,
                    window.height
                ),
            ));
            self.window = window;
        }
        self
    }
}

/// Drops a relative path to the default (`None`) with a warning on `field`.
fn absolute_or_default(
    value: Option<PathBuf>,
    field: &str,
    warnings: &mut Vec<SettingsWarning>,
) -> Option<PathBuf> {
    match value {
        Some(path) if !path.is_absolute() => {
            warnings.push(SettingsWarning::new(
                field,
                format!(
                    "{} is not an absolute path; using the default",
                    path.display()
                ),
            ));
            None
        }
        other => other,
    }
}

/// Trims a string and maps a blank one to `None`.
fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

/// Clamps `value` into `min..=max`, warning when it moved.
fn bounded(
    value: u32,
    min: u32,
    max: u32,
    field: &str,
    warnings: &mut Vec<SettingsWarning>,
) -> u32 {
    let clamped = value.clamp(min, max);
    if clamped != value {
        warnings.push(SettingsWarning::new(
            field,
            format!("{value} is out of range; using {clamped}"),
        ));
    }
    clamped
}

// --- Load mode ----------------------------------------------------------------

const SECTIONS: [&str; 9] = [
    "git",
    "clone",
    "tools",
    "appearance",
    "diff",
    "layout",
    "updates",
    "shortcuts",
    "window",
];

impl Settings {
    /// Reads the `settings` object of a file leniently: a leaf with the wrong
    /// type or an unknown enum string falls back to its default with one
    /// warning, out-of-range numbers are clamped with a warning, a relative
    /// path is dropped with a warning. Missing sections and keys are defaults
    /// and unknown keys are ignored, both silently. Never checks existence.
    pub fn from_json_lenient(value: &Value) -> (Settings, Vec<SettingsWarning>) {
        let mut w = Vec::new();
        if !value.is_object() {
            w.push(SettingsWarning::new(
                "settings",
                "not an object; using the defaults".to_owned(),
            ));
            return (Settings::default(), w);
        }
        for section in SECTIONS {
            if value.get(section).is_some_and(|s| !s.is_object()) {
                w.push(SettingsWarning::new(
                    section,
                    "not an object; using the defaults".to_owned(),
                ));
            }
        }

        let d = Settings::default();
        let v = value;
        let read = Settings {
            git: GitSettings {
                executable: leaf(v, "git", "executable", d.git.executable, &mut w),
            },
            clone: CloneSettings {
                default_dir: leaf(v, "clone", "defaultDir", d.clone.default_dir, &mut w),
                url_form: leaf(v, "clone", "urlForm", d.clone.url_form, &mut w),
            },
            tools: ToolSettings {
                editor: leaf(v, "tools", "editor", d.tools.editor, &mut w),
                diff_tool: leaf(v, "tools", "diffTool", d.tools.diff_tool, &mut w),
                merge_tool: leaf(v, "tools", "mergeTool", d.tools.merge_tool, &mut w),
            },
            appearance: AppearanceSettings {
                theme: leaf(v, "appearance", "theme", d.appearance.theme, &mut w),
                diff_font_family: leaf(
                    v,
                    "appearance",
                    "diffFontFamily",
                    d.appearance.diff_font_family,
                    &mut w,
                ),
                diff_font_size: leaf(
                    v,
                    "appearance",
                    "diffFontSize",
                    d.appearance.diff_font_size,
                    &mut w,
                ),
            },
            diff: DiffSettings {
                mode: leaf(v, "diff", "mode", d.diff.mode, &mut w),
                ignore_whitespace: leaf(
                    v,
                    "diff",
                    "ignoreWhitespace",
                    d.diff.ignore_whitespace,
                    &mut w,
                ),
            },
            layout: LayoutSettings {
                refs_width: leaf(v, "layout", "refsWidth", d.layout.refs_width, &mut w),
                sidebar_width: leaf(v, "layout", "sidebarWidth", d.layout.sidebar_width, &mut w),
                tags_collapsed: leaf(
                    v,
                    "layout",
                    "tagsCollapsed",
                    d.layout.tags_collapsed,
                    &mut w,
                ),
                pull_requests_collapsed: leaf(
                    v,
                    "layout",
                    "pullRequestsCollapsed",
                    d.layout.pull_requests_collapsed,
                    &mut w,
                ),
                issues_collapsed: leaf(
                    v,
                    "layout",
                    "issuesCollapsed",
                    d.layout.issues_collapsed,
                    &mut w,
                ),
                branches_height: leaf(
                    v,
                    "layout",
                    "branchesHeight",
                    d.layout.branches_height,
                    &mut w,
                ),
                stashes_height: leaf(
                    v,
                    "layout",
                    "stashesHeight",
                    d.layout.stashes_height,
                    &mut w,
                ),
                tags_height: leaf(v, "layout", "tagsHeight", d.layout.tags_height, &mut w),
                worktrees_collapsed: leaf(
                    v,
                    "layout",
                    "worktreesCollapsed",
                    d.layout.worktrees_collapsed,
                    &mut w,
                ),
                worktrees_height: leaf(
                    v,
                    "layout",
                    "worktreesHeight",
                    d.layout.worktrees_height,
                    &mut w,
                ),
                pull_requests_height: leaf(
                    v,
                    "layout",
                    "pullRequestsHeight",
                    d.layout.pull_requests_height,
                    &mut w,
                ),
            },
            updates: UpdateSettings {
                check_on_startup: leaf(
                    v,
                    "updates",
                    "checkOnStartup",
                    d.updates.check_on_startup,
                    &mut w,
                ),
            },
            shortcuts: ShortcutSettings {
                bindings: read_bindings(v, &mut w),
            },
            window: WindowGeometry {
                width: leaf(v, "window", "width", d.window.width, &mut w),
                height: leaf(v, "window", "height", d.window.height, &mut w),
                maximized: leaf(v, "window", "maximized", d.window.maximized, &mut w),
            },
        };

        let settings = read.drop_relative_paths(&mut w).normalise(&mut w);
        (settings, w)
    }
}

/// Reads `shortcuts.bindings`. A missing section or key is the empty map
/// silently; a `bindings` that is not an object is the empty map with one
/// warning; an entry that is neither a string nor `null` is dropped with a
/// warning on `shortcuts.bindings.<id>`.
fn read_bindings(
    obj: &Value,
    warnings: &mut Vec<SettingsWarning>,
) -> BTreeMap<String, Option<String>> {
    let Some(raw) = obj.get("shortcuts").and_then(|s| s.get("bindings")) else {
        return BTreeMap::new();
    };
    let Some(entries) = raw.as_object() else {
        warnings.push(SettingsWarning::new(
            "shortcuts.bindings",
            "not an object; using the defaults".to_owned(),
        ));
        return BTreeMap::new();
    };
    let mut bindings = BTreeMap::new();
    for (id, value) in entries {
        match Option::<String>::deserialize(value) {
            Ok(chord) => {
                bindings.insert(id.clone(), chord);
            }
            Err(err) => warnings.push(SettingsWarning::new(
                &format!("shortcuts.bindings.{id}"),
                format!("{err}; dropped"),
            )),
        }
    }
    bindings
}

/// Reads `obj.section.key` as `T`. Missing (or a non-object section) is the
/// default silently; present but the wrong shape is the default with a
/// warning on `section.key`.
fn leaf<T: DeserializeOwned>(
    obj: &Value,
    section: &str,
    key: &str,
    default: T,
    warnings: &mut Vec<SettingsWarning>,
) -> T {
    let Some(raw) = obj.get(section).and_then(|s| s.get(key)) else {
        return default;
    };
    match T::deserialize(raw) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(SettingsWarning::new(
                &format!("{section}.{key}"),
                format!("{err}; using the default"),
            ));
            default
        }
    }
}

// --- Patch mode ---------------------------------------------------------------

/// Overwrites `target` when the patch carries a value for it.
fn set<T: Clone>(target: &mut T, value: &Option<T>) {
    if let Some(value) = value {
        *target = value.clone();
    }
}

impl Settings {
    /// Applies `patch`. Strings are trimmed (blank becomes `None`) and numbers
    /// clamped exactly as on load. Paths must be absolute, and a clone
    /// directory the patch sets must be an existing directory. A path the
    /// patch leaves alone is not re-checked for existence.
    pub fn apply(&self, patch: &SettingsPatch) -> Result<Settings, SettingsError> {
        let mut next = self.clone();
        if let Some(p) = &patch.git {
            set(&mut next.git.executable, &p.executable);
        }
        if let Some(p) = &patch.clone {
            set(&mut next.clone.default_dir, &p.default_dir);
            set(&mut next.clone.url_form, &p.url_form);
        }
        if let Some(p) = &patch.tools {
            set(&mut next.tools.editor, &p.editor);
            set(&mut next.tools.diff_tool, &p.diff_tool);
            set(&mut next.tools.merge_tool, &p.merge_tool);
        }
        if let Some(p) = &patch.appearance {
            set(&mut next.appearance.theme, &p.theme);
            set(&mut next.appearance.diff_font_family, &p.diff_font_family);
            set(&mut next.appearance.diff_font_size, &p.diff_font_size);
        }
        if let Some(p) = &patch.diff {
            set(&mut next.diff.mode, &p.mode);
            set(&mut next.diff.ignore_whitespace, &p.ignore_whitespace);
        }
        if let Some(p) = &patch.layout {
            set(&mut next.layout.refs_width, &p.refs_width);
            set(&mut next.layout.sidebar_width, &p.sidebar_width);
            set(&mut next.layout.tags_collapsed, &p.tags_collapsed);
            set(
                &mut next.layout.pull_requests_collapsed,
                &p.pull_requests_collapsed,
            );
            set(&mut next.layout.issues_collapsed, &p.issues_collapsed);
            set(&mut next.layout.branches_height, &p.branches_height);
            set(&mut next.layout.stashes_height, &p.stashes_height);
            set(&mut next.layout.tags_height, &p.tags_height);
            set(&mut next.layout.worktrees_collapsed, &p.worktrees_collapsed);
            set(&mut next.layout.worktrees_height, &p.worktrees_height);
            set(
                &mut next.layout.pull_requests_height,
                &p.pull_requests_height,
            );
        }
        if let Some(p) = &patch.updates {
            set(&mut next.updates.check_on_startup, &p.check_on_startup);
        }
        if let Some(p) = &patch.shortcuts {
            set(&mut next.shortcuts.bindings, &p.bindings);
        }
        if let Some(p) = &patch.window {
            set(&mut next.window.width, &p.width);
            set(&mut next.window.height, &p.height);
            set(&mut next.window.maximized, &p.maximized);
        }

        next.require_absolute_paths()?;
        let next = next.normalise(&mut Vec::new());

        // Existence is a Patch-only check, and only for a value being set now.
        let sets_clone_dir = patch
            .clone
            .as_ref()
            .is_some_and(|p| matches!(p.default_dir, Some(Some(_))));
        if sets_clone_dir
            && let Some(dir) = &next.clone.default_dir
            && !dir.is_dir()
        {
            return Err(SettingsError::NotADirectory(dir.clone()));
        }
        Ok(next)
    }
}

// --- The file codec -----------------------------------------------------------

/// The on-disk settings format version. Bump it when the shape changes.
pub const SETTINGS_VERSION: u32 = 2;

/// The versioned settings file: `{ "version": 2, "settings": { … } }`.
/// Serialise it with `serde_json::to_string_pretty` (two-space indent). It is
/// deliberately not `Deserialize`: read a file with [`SettingsFile::parse`],
/// which is lenient per field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsFile {
    pub version: u32,
    pub settings: Settings,
}

/// A settings file that cannot be read as the current version. Either way the
/// caller falls back to defaults and overwrites the file on the next save.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum SettingsFileError {
    #[error("the settings file is corrupt: {0}")]
    Corrupt(String),
    #[error("the settings file has unknown version {0}")]
    UnknownVersion(u32),
}

impl SettingsFile {
    /// Wraps `settings` at the current version.
    pub fn current(settings: Settings) -> Self {
        Self {
            version: SETTINGS_VERSION,
            settings,
        }
    }

    /// Parses a file's text. Not JSON, or no numeric top-level `version`, is
    /// `Corrupt`; any version but [`SETTINGS_VERSION`] is `UnknownVersion`.
    /// The `settings` object is then read leniently (see
    /// [`Settings::from_json_lenient`]).
    pub fn parse(text: &str) -> Result<(Settings, Vec<SettingsWarning>), SettingsFileError> {
        let root: Value =
            serde_json::from_str(text).map_err(|e| SettingsFileError::Corrupt(e.to_string()))?;
        let version = root.get("version").and_then(Value::as_u64).ok_or_else(|| {
            SettingsFileError::Corrupt("no numeric \"version\" at the top level".to_owned())
        })?;
        if version != u64::from(SETTINGS_VERSION) {
            return Err(SettingsFileError::UnknownVersion(
                u32::try_from(version).unwrap_or(u32::MAX),
            ));
        }
        Ok(Settings::from_json_lenient(
            root.get("settings").unwrap_or(&Value::Null),
        ))
    }
}
