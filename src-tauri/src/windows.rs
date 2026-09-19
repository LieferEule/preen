//! The settings window — an ordinary window, unlike the panel.

use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::panel;

pub const SETTINGS_LABEL: &str = "settings";
pub const SETTINGS_WIDTH: f64 = 560.0;
const SETTINGS_START_HEIGHT: f64 = 420.0;
pub const SETTINGS_RADIUS: f64 = 26.0;

pub fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Einstellungen")
    .inner_size(SETTINGS_WIDTH, SETTINGS_START_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .visible(false)
    .build();

    if let Ok(window) = built {
        panel::set_vibrancy(&window, SETTINGS_RADIUS);
        crate::corners::round(&window, SETTINGS_RADIUS);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The window is as tall as its content; the frontend reports that height.
pub fn resize_settings(app: &AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.set_size(LogicalSize {
            width: SETTINGS_WIDTH,
            height,
        });
        crate::corners::round(&window, SETTINGS_RADIUS);
    }
}
