//! The floating glass panel: an NSPanel that takes keyboard input, stays
//! visible when it loses focus, and sits at the left edge of the screen the
//! mouse is on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask,
};
use window_vibrancy::{
    apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
};

tauri_panel! {
    panel!(PreenPanel {
        config: {
            // The file name field is the heart of the panel, so unlike a mere
            // overlay it must be able to become the key window.
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

pub const PANEL_LABEL: &str = "main";
/// Resting size: just the feather and one line of text.
pub const IDLE_SIZE: (f64, f64) = (184.0, 184.0);
pub const IDLE_RADIUS: f64 = 42.0;
/// Loaded width; the height follows the content.
pub const LOADED_WIDTH: f64 = 340.0;
pub const LOADED_RADIUS: f64 = 34.0;
/// Distance from the left screen edge for the very first appearance.
const EDGE_MARGIN: f64 = 32.0;
/// How far down the usable screen the panel starts out.
const START_HEIGHT_FRACTION: f64 = 0.22;

/// Bumped on every move so only the last one in a burst is stored.
static MOVE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// While the app moves the panel itself (growing, emphasis), `Moved` events
/// must not be mistaken for the user dragging it somewhere.
static PROGRAMMATIC_MOVES: AtomicU64 = AtomicU64::new(0);
/// Bumped whenever the panel is shown or hidden, so only the last hide can
/// trigger the forgetting below.
static HIDE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// A picture left in a hidden panel is forgotten after this long, so coming
/// back hours later doesn't hand you yesterday's work.
const FORGET_AFTER: Duration = Duration::from_secs(300);
const POSITION_SAVE_DELAY: Duration = Duration::from_millis(300);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let (width, height) = IDLE_SIZE;
    PanelBuilder::<_, PreenPanel>::new(app, PANEL_LABEL)
        .url(WebviewUrl::App("index.html".into()))
        .title("Preen")
        .size(tauri::Size::Logical(LogicalSize { width, height }))
        .level(PanelLevel::Floating)
        .has_shadow(false)
        .transparent(true)
        .corner_radius(IDLE_RADIUS)
        // NonactivatingPanel: takes keys without pulling the whole app forward.
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .accept_first_mouse(true)
                .visible(false)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()?;

    if let Some(panel) = app.get_webview_panel(PANEL_LABEL).ok() {
        // Stay put when the user clicks into Finder to grab an image.
        panel.set_hides_on_deactivate(false);
        panel.hide();
    }
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        set_vibrancy(&window, IDLE_RADIUS);
    }
    Ok(())
}

/// Frosted glass behind the webview. The desktop shows through this, which
/// CSS `backdrop-filter` cannot do.
///
/// `Popover` is lighter than `HudWindow` and greys the desktop less. The
/// `Active` state keeps the blur alive while the panel is not the key
/// window — which, for a panel you click away from, is most of the time.
/// Without it the material dulls as soon as focus moves, which reads as a bug.
pub fn set_vibrancy(window: &WebviewWindow, radius: f64) {
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let _ = clear_vibrancy(&window);
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(radius),
        );
        // The blur view and the web view draw square corners of their own.
        crate::corners::round(&window, radius);
    });
}

/// Everything below touches AppKit, which only tolerates the main thread.
/// The global shortcut, the tray and the second-instance listener all call in
/// from threads of their own, so every entry point hops over first.
fn on_main(app: &AppHandle, work: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || work(&app));
}

fn is_visible_on_main(app: &AppHandle) -> bool {
    app.get_webview_panel(PANEL_LABEL)
        .map(|p| p.is_visible())
        .unwrap_or(false)
}

pub fn show(app: &AppHandle) {
    HIDE_GENERATION.fetch_add(1, Ordering::SeqCst);
    on_main(app, show_now);
}

pub fn hide(app: &AppHandle) {
    forget_later(app);
    on_main(app, |app| {
        if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
            panel.hide();
        }
    });
}

pub fn toggle(app: &AppHandle) {
    let generation = HIDE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app_for_forget = app.clone();
    on_main(app, move |app| {
        if is_visible_on_main(app) {
            if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
                panel.hide();
            }
            if HIDE_GENERATION.load(Ordering::SeqCst) == generation {
                forget_later(&app_for_forget);
            }
        } else {
            show_now(app);
        }
    });
}

/// Tells the panel to drop the loaded picture, but only if it is still hidden
/// when the time is up.
fn forget_later(app: &AppHandle) {
    let generation = HIDE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FORGET_AFTER);
        if HIDE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let _ = app.emit("preen://forget-images", ());
    });
}

fn show_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let size = logical_size(&window).unwrap_or(IDLE_SIZE);
    place(app, &window, size.0, size.1);

    if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
        panel.make_key_and_order_front();
    }
    let _ = app.emit("preen://panel-shown", ());
}

/// Where the panel appears: where the user last dragged it, or — the first
/// time, or when that spot is gone with its monitor — near the top left of the
/// screen the mouse is on.
fn place(app: &AppHandle, window: &WebviewWindow, width: f64, height: f64) {
    let saved = crate::settings::get(app)
        .panel_position
        .filter(|p| on_some_monitor(app, p.x, p.y, width, height));
    let position = match saved {
        Some(p) => LogicalPosition { x: p.x, y: p.y },
        None => default_position(app, height),
    };
    mark_programmatic();
    let _ = window.set_position(position);
}

fn default_position(app: &AppHandle, height: f64) -> LogicalPosition<f64> {
    let Some(monitor) = monitor_with_cursor(app) else {
        return LogicalPosition {
            x: EDGE_MARGIN,
            y: EDGE_MARGIN,
        };
    };
    let (x, y, _, usable_height) = usable_area(&monitor);
    LogicalPosition {
        x: x + EDGE_MARGIN,
        y: (y + usable_height * START_HEIGHT_FRACTION).min(y + usable_height - height),
    }
}

/// Monitor bounds minus menu bar and Dock, in logical points.
fn usable_area(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    )
}

/// True when a good part of the panel would still be on a connected screen.
fn on_some_monitor(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let (mx, my, mw, mh) = usable_area(monitor);
        let overlap_x = (x + width).min(mx + mw) - x.max(mx);
        let overlap_y = (y + height).min(my + mh) - y.max(my);
        // Enough of the panel to grab hold of it again.
        overlap_x > width.min(80.0) && overlap_y > height.min(60.0)
    })
}

fn logical_size(window: &WebviewWindow) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

fn logical_position(window: &WebviewWindow) -> Option<LogicalPosition<f64>> {
    let position = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(LogicalPosition {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
    })
}

/// Marks a move the app makes itself, so it is not stored as the position the
/// user dragged the panel to.
fn mark_programmatic() {
    PROGRAMMATIC_MOVES.fetch_add(1, Ordering::SeqCst);
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(400));
        PROGRAMMATIC_MOVES.fetch_sub(1, Ordering::SeqCst);
    });
}

/// Remembers where the user dragged the panel, once the dragging has settled.
pub fn remember_position(app: &AppHandle) {
    if PROGRAMMATIC_MOVES.load(Ordering::SeqCst) > 0 {
        return;
    }
    let generation = MOVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(POSITION_SAVE_DELAY);
        if MOVE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if PROGRAMMATIC_MOVES.load(Ordering::SeqCst) > 0 {
            return;
        }
        let Some(window) = app.get_webview_window(PANEL_LABEL) else {
            return;
        };
        if let Some(position) = logical_position(&window) {
            crate::settings::set(
                &app,
                "panelPosition",
                serde_json::json!({ "x": position.x, "y": position.y }),
            );
        }
    });
}

/// The monitor containing the mouse pointer, falling back to the primary one.
fn monitor_with_cursor(app: &AppHandle) -> Option<tauri::Monitor> {
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(monitors) = app.available_monitors() {
            for monitor in monitors {
                let position = monitor.position();
                let size = monitor.size();
                let inside = cursor.x >= position.x as f64
                    && cursor.x < (position.x + size.width as i32) as f64
                    && cursor.y >= position.y as f64
                    && cursor.y < (position.y + size.height as i32) as f64;
                if inside {
                    return Some(monitor);
                }
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Grows or shrinks the panel. The top edge and the horizontal centre stay
/// put, so the panel opens outwards to both sides instead of unrolling to the
/// right. `duration_ms` of 0 snaps (used for reduced motion and for plain
/// content changes).
pub fn resize(app: &AppHandle, width: f64, height: f64, radius: f64, duration_ms: u64) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    mark_programmatic();
    set_vibrancy(&window, radius);
    crate::frame::set_size(&window, width, height, duration_ms, radius);
}
