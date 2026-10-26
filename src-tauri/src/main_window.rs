//! The main window. It is built in Rust, not declared in `tauri.conf.json`,
//! so the stored size and maximized flag apply before it shows and the
//! settings init script runs before any page script.

use git_real_core::settings::{Settings, WINDOW_MIN, WindowGeometry};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::settings_store::SettingsStore;

pub const LABEL: &str = "main";
pub const TITLE: &str = "Git Real";

/// The geometry the window opens with: the stored one, raised to the minimum.
pub fn initial_geometry(settings: &Settings) -> WindowGeometry {
    settings.window.clone().clamp_to_min()
}

/// The geometry to save on close. When maximized the live size is the screen,
/// so the previously stored size is kept and only the flag changes.
pub fn logical_geometry(
    physical: (u32, u32),
    scale: f64,
    maximized: bool,
    stored: &WindowGeometry,
) -> WindowGeometry {
    if maximized {
        return WindowGeometry {
            maximized: true,
            ..stored.clone()
        };
    }
    let scale = if scale > 0.0 { scale } else { 1.0 };
    WindowGeometry {
        width: (f64::from(physical.0) / scale).round() as u32,
        height: (f64::from(physical.1) / scale).round() as u32,
        maximized: false,
    }
    .clamp_to_min()
}

pub fn build(app: &AppHandle, store: &SettingsStore) -> tauri::Result<WebviewWindow> {
    let geometry = initial_geometry(&store.get());
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title(TITLE)
        .inner_size(f64::from(geometry.width), f64::from(geometry.height))
        .min_inner_size(f64::from(WINDOW_MIN.0), f64::from(WINDOW_MIN.1))
        .maximized(geometry.maximized)
        .resizable(true)
        .decorations(true)
        .initialization_script(store.to_init_script())
        .build()
}

/// The geometry to save on close, or `None` to save nothing. Fullscreen is
/// not a stored state (spec §5), so a fullscreen close keeps the stored
/// geometry as it is.
pub fn close_geometry(
    physical: (u32, u32),
    scale: f64,
    maximized: bool,
    fullscreen: bool,
    stored: &WindowGeometry,
) -> Option<WindowGeometry> {
    (!fullscreen).then(|| logical_geometry(physical, scale, maximized, stored))
}

/// Saves the window geometry. Never blocks the close.
pub fn on_close_requested(window: &WebviewWindow, store: &SettingsStore) {
    let (fullscreen, maximized, size, scale) = match (
        window.is_fullscreen(),
        window.is_maximized(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        (Ok(fs), Ok(m), Ok(s), Ok(f)) => (fs, m, s, f),
        (fs, m, s, f) => {
            for e in [fs.err(), m.err(), s.err(), f.err()].into_iter().flatten() {
                eprintln!("settings: cannot read window geometry: {e}");
            }
            return;
        }
    };
    let Some(geometry) = close_geometry(
        (size.width, size.height),
        scale,
        maximized,
        fullscreen,
        &store.get().window,
    ) else {
        return;
    };
    if let Err(e) = store.set_window(geometry) {
        eprintln!("settings: cannot save window geometry: {e}");
    }
}
