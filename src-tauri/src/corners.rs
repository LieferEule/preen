//! Rounded, see-through window corners.
//!
//! Tauri's `transparent` flag alone is not enough: the frosted glass view and
//! the web view each draw their own opaque rectangle, so the window's square
//! corners stay visible under the rounded CSS card. Rounding their layers —
//! with the continuous curve macOS uses for its own panels, not a plain
//! circular arc — is what actually cuts the corners off.

use objc2_app_kit::{NSColor, NSView, NSWindow};
use objc2_quartz_core::{kCACornerCurveContinuous, CALayer};
use tauri::{Runtime, WebviewWindow};

/// Applies `radius` to the window's layers. Call again after every resize:
/// the web view can hand out a fresh layer when it is re-created.
pub fn round<R: Runtime>(window: &WebviewWindow<R>, radius: f64) {
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(handle) = window.ns_window() else {
            return;
        };
        // SAFETY: on the main thread, and Tauri hands us a live NSWindow.
        unsafe {
            let ns_window: &NSWindow = &*(handle as *const NSWindow);
            // No system-drawn background behind the rounded layers.
            ns_window.setOpaque(false);
            ns_window.setBackgroundColor(Some(&NSColor::clearColor()));

            let Some(content) = ns_window.contentView() else {
                return;
            };
            round_view(&content, radius);
            let subviews = content.subviews();
            for view in subviews.iter() {
                round_view(&view, radius);
            }
            #[cfg(debug_assertions)]
            eprintln!(
                "[preen] corners: radius {radius} on content view + {} subviews",
                subviews.len()
            );
        }
    });
}

unsafe fn round_view(view: &NSView, radius: f64) {
    view.setWantsLayer(true);
    if let Some(layer) = view.layer() {
        round_layer(&layer, radius);
        // The web view keeps its drawing in a sublayer of its own.
        if let Some(sublayers) = layer.sublayers() {
            for sublayer in sublayers.iter() {
                round_layer(&sublayer, radius);
            }
        }
    }
}

unsafe fn round_layer(layer: &CALayer, radius: f64) {
    layer.setCornerRadius(radius);
    layer.setMasksToBounds(true);
    // The macOS squircle, not a circular arc.
    layer.setCornerCurve(kCACornerCurveContinuous);
}
