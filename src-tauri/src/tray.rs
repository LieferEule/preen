//! Menu bar icon and its menu.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::{panel, settings, windows};

pub const TRAY_ID: &str = "preen";
/// Monochrome feather with alpha, so macOS tints it for light and dark menu bars.
const TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-template.png");

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let icon = Image::from_bytes(TEMPLATE_ICON)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Preen")
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                panel::toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the menu so "Preen öffnen" shows the current shortcut.
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcut = settings::pretty_shortcut(&settings::get(app).shortcut);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                "open",
                format!("Preen öffnen  {shortcut}"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, "settings", "Einstellungen…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Preen beenden", true, None::<&str>)?,
        ],
    )
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => panel::show(app),
        "settings" => windows::open_settings(app),
        "quit" => app.exit(0),
        _ => {}
    }
}
