//! App behaviour settings, stored in the same `settings.json` the frontend uses.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "settings.json";
pub const DEFAULT_SHORTCUT: &str = "Alt+Cmd+P";
/// Seconds the resting panel waits before hiding itself; 0 turns it off.
pub const DEFAULT_AUTO_HIDE_SECONDS: u64 = 20;
/// Output target "next to the original file"; the frontend uses the same word.
pub const TARGET_SOURCE: &str = "source";
const MAX_RECENT_TARGETS: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub show_in_dock: bool,
    /// "source", "desktop" or an absolute path.
    pub default_target: String,
    pub recent_targets: Vec<String>,
    /// Where the user last dragged the panel; `None` until it is moved.
    pub panel_position: Option<Point>,
    pub auto_hide_seconds: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            show_in_dock: false,
            default_target: TARGET_SOURCE.to_string(),
            recent_targets: vec![],
            panel_position: None,
            auto_hide_seconds: DEFAULT_AUTO_HIDE_SECONDS,
        }
    }
}

fn value<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<Value> {
    app.store(STORE_FILE).ok()?.get(key)
}

pub fn get<R: Runtime>(app: &AppHandle<R>) -> AppSettings {
    let default = AppSettings::default();
    AppSettings {
        shortcut: value(app, "shortcut")
            .and_then(|v| v.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
            .unwrap_or(default.shortcut),
        show_in_dock: value(app, "showInDock")
            .and_then(|v| v.as_bool())
            .unwrap_or(default.show_in_dock),
        default_target: value(app, "defaultTarget")
            .and_then(|v| v.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
            .unwrap_or(default.default_target),
        recent_targets: value(app, "recentTargets")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or(default.recent_targets),
        panel_position: value(app, "panelPosition").and_then(|v| serde_json::from_value(v).ok()),
        auto_hide_seconds: value(app, "autoHideSeconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(default.auto_hide_seconds),
    }
}

pub fn set<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(key, value);
        let _ = store.save();
    }
}

/// Puts `path` at the front of the recent list, without duplicates.
pub fn remember_target<R: Runtime>(app: &AppHandle<R>, path: &str) {
    let mut recent = get(app).recent_targets;
    recent.retain(|p| p != path);
    recent.insert(0, path.to_string());
    recent.truncate(MAX_RECENT_TARGETS);
    set(app, "recentTargets", json!(recent));
}

/// True the very first time this is called; used to show the panel once
/// after installation so the app doesn't look dead.
pub fn take_first_run<R: Runtime>(app: &AppHandle<R>) -> bool {
    if value(app, "firstRunDone").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    set(app, "firstRunDone", json!(true));
    true
}

/// "Alt+Cmd+P" → "⌥⌘P", for menus and the settings window.
pub fn pretty_shortcut(accelerator: &str) -> String {
    let mut out = String::new();
    let mut key = String::new();
    for part in accelerator.split('+') {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => out.push('⌃'),
            "alt" | "option" => out.push('⌥'),
            "shift" => out.push('⇧'),
            "cmd" | "command" | "super" | "meta" | "commandorcontrol" | "cmdorctrl" => {
                out.push('⌘')
            }
            _ => key = pretty_key(part),
        }
    }
    out.push_str(&key);
    out
}

fn pretty_key(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "space" => "Space".to_string(),
        "enter" | "return" => "↩".to_string(),
        "escape" | "esc" => "⎋".to_string(),
        "tab" => "⇥".to_string(),
        "backspace" => "⌫".to_string(),
        "arrowup" | "up" => "↑".to_string(),
        "arrowdown" | "down" => "↓".to_string(),
        "arrowleft" | "left" => "←".to_string(),
        "arrowright" | "right" => "→".to_string(),
        other => {
            let stripped = other.strip_prefix("key").unwrap_or(other);
            let stripped = stripped.strip_prefix("digit").unwrap_or(stripped);
            stripped.to_uppercase()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_are_shown_as_mac_symbols() {
        assert_eq!(pretty_shortcut("Alt+Cmd+P"), "⌥⌘P");
        assert_eq!(pretty_shortcut("CommandOrControl+Shift+KeyK"), "⌘⇧K");
        assert_eq!(pretty_shortcut("Ctrl+Alt+Space"), "⌃⌥Space");
        assert_eq!(pretty_shortcut("Cmd+Digit1"), "⌘1");
    }
}
