//! The floating glass panel: an NSPanel that takes keyboard input, stays
//! visible when it loses focus, and sits at the left edge of the screen the
//! mouse is on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

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
const GROW_DURATION: Duration = Duration::from_millis(320);
const FRAME: Duration = Duration::from_millis(12);

/// Bumped on every resize so a running animation stops when a newer one starts.
static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Bumped on every move so only the last one in a burst is stored.
static MOVE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// While the app moves the panel itself (growing, emphasis), `Moved` events
/// must not be mistaken for the user dragging it somewhere.
static PROGRAMMATIC_MOVES: AtomicU64 = AtomicU64::new(0);
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
/// The `Active` state keeps the blur alive while the panel is not the key
/// window — which, for a panel you click away from, is most of the time.
/// Without it the material dulls as soon as focus moves, which reads as a bug.
pub fn set_vibrancy(window: &WebviewWindow, radius: f64) {
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let _ = clear_vibrancy(&window);
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(radius),
        );
        // The blur view and the web view draw square corners of their own.
        crate::corners::round(&window, radius);
    });
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_panel(PANEL_LABEL)
        .map(|p| p.is_visible())
        .unwrap_or(false)
}

pub fn show(app: &AppHandle) {
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

pub fn hide(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
        panel.hide();
    }
}

pub fn toggle(app: &AppHandle) {
    if is_visible(app) {
        hide(app);
    } else {
        show(app);
    }
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

/// Hover and drag-over emphasis: the window itself grows a little around its
/// centre, so the frosted glass grows with it instead of a CSS transform
/// being clipped at the window edge.
pub fn emphasize(app: &AppHandle, scale: f64) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let Some((current_width, current_height)) = logical_size(&window) else {
        return;
    };
    let (target_width, target_height) = (IDLE_SIZE.0 * scale, IDLE_SIZE.1 * scale);
    if (current_width - target_width).abs() < 0.5 {
        return;
    }
    let Some(position) = logical_position(&window) else {
        return;
    };
    mark_programmatic();
    let _ = window.set_position(LogicalPosition {
        x: position.x - (target_width - current_width) / 2.0,
        y: position.y - (target_height - current_height) / 2.0,
    });
    let _ = window.set_size(LogicalSize {
        width: target_width,
        height: target_height,
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

/// Grows or shrinks the panel, keeping its top edge in place (Tauri positions
/// windows by their top-left corner, so only the size changes).
///
/// `animate` is the drop transition; everything else snaps.
pub fn resize(app: &AppHandle, width: f64, height: f64, radius: f64, animate: bool) {
    let Some(window) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    let generation = RESIZE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    mark_programmatic();

    let (from_width, from_height) = logical_size(&window).unwrap_or(IDLE_SIZE);

    set_vibrancy(&window, radius);

    if !animate || (from_height - height).abs() < 1.0 {
        let _ = window.set_size(LogicalSize { width, height });
        keep_on_screen(app, &window, height);
        crate::corners::round(&window, radius);
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        let started = Instant::now();
        let radius = radius;
        loop {
            if RESIZE_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let elapsed = started.elapsed();
            let progress = (elapsed.as_secs_f64() / GROW_DURATION.as_secs_f64()).min(1.0);
            let eased = ease_out_quint(progress);
            let _ = window.set_size(LogicalSize {
                width: from_width + (width - from_width) * eased,
                height: from_height + (height - from_height) * eased,
            });
            if progress >= 1.0 {
                break;
            }
            thread::sleep(FRAME);
        }
        keep_on_screen(&app, &window, height);
        crate::corners::round(&window, radius);
    });
}

/// After growing, pull the panel back onto the screen if it would hang off
/// the bottom edge.
fn keep_on_screen(app: &AppHandle, window: &WebviewWindow, height: f64) {
    let (Some(monitor), Ok(position), Ok(scale)) = (
        monitor_with_cursor(app),
        window.outer_position(),
        window.scale_factor(),
    ) else {
        return;
    };
    let monitor_scale = monitor.scale_factor();
    let monitor_y = monitor.position().y as f64 / monitor_scale;
    let monitor_height = monitor.size().height as f64 / monitor_scale;
    let y = position.y as f64 / scale;
    let lowest = monitor_y + monitor_height - height - EDGE_MARGIN;
    if y > lowest {
        let _ = window.set_position(LogicalPosition {
            x: position.x as f64 / scale,
            y: lowest.max(monitor_y + EDGE_MARGIN),
        });
    }
}

/// cubic-bezier(0.22, 1, 0.36, 1), the panel's drop curve.
fn ease_out_quint(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(5)
}
