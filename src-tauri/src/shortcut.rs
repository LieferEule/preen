//! The global shortcut that summons the panel.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{panel, settings};

/// Registers `accelerator` as the panel toggle.
pub fn register(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("„{accelerator}“ ist keine gültige Tastenkombination"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                panel::toggle(app);
            }
        })
        .map_err(|e| format!("Tastenkombination ist belegt ({e})"))
}

pub fn unregister(app: &AppHandle, accelerator: &str) {
    if let Ok(shortcut) = accelerator.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

/// Swaps the shortcut, rolling back to the old one if the new one can't be
/// registered — the app must never end up without a way to be summoned.
pub fn replace(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let current = settings::get(app).shortcut;
    if accelerator == current {
        return Ok(());
    }
    unregister(app, &current);
    match register(app, accelerator) {
        Ok(()) => {
            settings::set(app, "shortcut", accelerator.into());
            crate::tray::refresh(app);
            Ok(())
        }
        Err(error) => {
            // Back to what worked before.
            if register(app, &current).is_err() {
                let _ = register(app, settings::DEFAULT_SHORTCUT);
                settings::set(app, "shortcut", settings::DEFAULT_SHORTCUT.into());
                crate::tray::refresh(app);
            }
            Err(error)
        }
    }
}

/// Registers the stored shortcut at startup, falling back to the default and
/// then to nothing rather than failing the launch.
pub fn register_stored(app: &AppHandle) {
    let stored = settings::get(app).shortcut;
    if register(app, &stored).is_ok() {
        return;
    }
    if stored != settings::DEFAULT_SHORTCUT && register(app, settings::DEFAULT_SHORTCUT).is_ok() {
        settings::set(app, "shortcut", settings::DEFAULT_SHORTCUT.into());
        let _ = app.app_handle();
    }
}
