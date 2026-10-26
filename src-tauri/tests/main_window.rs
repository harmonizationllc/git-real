//! Tests for the pure parts of `main_window`: the label and title, the
//! geometry the window opens with, the logical geometry saved on close, and
//! the close decision that skips saving while fullscreen.

use git_real_core::settings::{Settings, WindowGeometry};
use git_real_lib::main_window::{
    LABEL, TITLE, background_color, close_geometry, desktop_theme, follows_desktop,
    initial_geometry, logical_geometry,
};

#[test]
fn background_color_follows_the_stored_theme_then_the_desktop() {
    use git_real_core::settings::Theme;
    use tauri::webview::Color;
    assert_eq!(
        background_color(Theme::Dark, Some(tauri::Theme::Light)),
        Color(30, 30, 30, 255)
    );
    assert_eq!(
        background_color(Theme::Light, Some(tauri::Theme::Dark)),
        Color(246, 246, 246, 255)
    );
    assert_eq!(
        background_color(Theme::System, Some(tauri::Theme::Dark)),
        Color(30, 30, 30, 255)
    );
    assert_eq!(
        background_color(Theme::System, Some(tauri::Theme::Light)),
        Color(246, 246, 246, 255)
    );
    assert_eq!(
        background_color(Theme::System, None),
        Color(246, 246, 246, 255)
    );
}

#[test]
fn only_the_system_theme_follows_the_desktop() {
    use git_real_core::settings::Theme;
    assert!(follows_desktop(Theme::System));
    assert!(!follows_desktop(Theme::Dark));
    assert!(!follows_desktop(Theme::Light));
}

fn stored(width: u32, height: u32) -> WindowGeometry {
    WindowGeometry {
        width,
        height,
        maximized: false,
    }
}

#[test]
fn label_is_main_and_title_is_git_real() {
    assert_eq!(LABEL, "main");
    assert_eq!(TITLE, "Git Real");
}

#[test]
fn initial_geometry_clamps_to_min() {
    let settings = Settings {
        window: stored(1, 1),
        ..Settings::default()
    };
    assert_eq!(initial_geometry(&settings), stored(960, 600));
}

#[test]
fn logical_geometry_divides_by_scale_and_rounds() {
    let got = logical_geometry((2560, 1600), 2.0, false, &stored(1, 1));
    assert_eq!(got, stored(1280, 800));
    let got = logical_geometry((1801, 1201), 1.5, false, &stored(1, 1));
    assert_eq!(got, stored(1201, 801));
}

#[test]
fn logical_geometry_keeps_the_stored_size_when_maximized() {
    let got = logical_geometry((3840, 2160), 1.0, true, &stored(1100, 700));
    assert_eq!(
        got,
        WindowGeometry {
            width: 1100,
            height: 700,
            maximized: true
        }
    );
}

#[test]
fn logical_geometry_clamps_small_sizes() {
    let got = logical_geometry((100, 100), 1.0, false, &stored(1280, 800));
    assert_eq!(got, stored(960, 600));
}

#[test]
fn logical_geometry_rounds_fractional_scale() {
    let got = logical_geometry((1600, 1000), 1.25, false, &stored(1, 1));
    assert_eq!(got, stored(1280, 800));
}

#[test]
fn logical_geometry_treats_zero_scale_as_one() {
    let got = logical_geometry((1280, 800), 0.0, false, &stored(1, 1));
    assert_eq!(got, stored(1280, 800));
}

#[test]
fn close_geometry_is_none_when_fullscreen() {
    let stored = stored(1100, 700);
    assert_eq!(
        close_geometry((3840, 2160), 1.0, false, true, &stored),
        None
    );
    assert_eq!(close_geometry((3840, 2160), 1.0, true, true, &stored), None);
}

#[test]
fn close_geometry_is_the_logical_geometry_when_not_fullscreen() {
    let stored = stored(1100, 700);
    assert_eq!(
        close_geometry((2560, 1600), 2.0, false, false, &stored),
        Some(logical_geometry((2560, 1600), 2.0, false, &stored))
    );
    assert_eq!(
        close_geometry((3840, 2160), 1.0, true, false, &stored),
        Some(logical_geometry((3840, 2160), 1.0, true, &stored))
    );
}

#[test]
fn desktop_theme_maps_the_page_flag() {
    assert_eq!(desktop_theme(true), tauri::Theme::Dark);
    assert_eq!(desktop_theme(false), tauri::Theme::Light);
}
