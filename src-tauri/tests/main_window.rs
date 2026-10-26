//! Tests for the pure parts of `main_window`: the label and title, the
//! geometry the window opens with, and the logical geometry saved on close.

use git_real_core::settings::{Settings, WindowGeometry};
use git_real_lib::main_window::{LABEL, TITLE, initial_geometry, logical_geometry};

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
