//! Resizing the panel window natively.
//!
//! Driving the size from a background thread at 80 fps looked fine on paper,
//! but the web view does not always keep up with it: the window ends up taller
//! than its content and the blurred backing shows as a grey band. AppKit's own
//! animator resizes the content view as part of the animation, so the web view
//! can never fall behind.

use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext, NSWindow};
use objc2_core_foundation::{CGPoint as NSPoint, CGRect as NSRect, CGSize as NSSize};
use objc2_quartz_core::CAMediaTimingFunction;
use tauri::{Runtime, WebviewWindow};

/// Counts resize requests, so a superseded one keeps quiet.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn set_size<R: Runtime>(
    window: &WebviewWindow<R>,
    width: f64,
    height: f64,
    duration_ms: u64,
    radius: f64,
) {
    let sequence = SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    let corners_window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(handle) = window.ns_window() else {
            return;
        };
        // SAFETY: on the main thread, with a live NSWindow from Tauri.
        unsafe {
            let ns_window: &NSWindow = &*(handle as *const NSWindow);
            let frame = ns_window.frame();
            // AppKit measures from the bottom left, so holding the top edge
            // means moving the origin down by the height we gain.
            let top = frame.origin.y + frame.size.height;
            // The top edge and the horizontal centre stay put, so the panel
            // opens outwards to both sides.
            let x = frame.origin.x - (width - frame.size.width) / 2.0;
            let y = top - height;
            let target = clamp_to_screen(
                ns_window,
                NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)),
            );

            if duration_ms == 0 {
                ns_window.setFrame_display(target, true);
            } else {
                NSAnimationContext::beginGrouping();
                let context = NSAnimationContext::currentContext();
                context.setDuration(duration_ms as f64 / 1000.0);
                // The panel is arriving, so it has to move at once.
                context.setTimingFunction(Some(&CAMediaTimingFunction::functionWithControlPoints(
                    0.23, 1.0, 0.32, 1.0,
                )));
                ns_window.animator().setFrame_display(target, true);
                NSAnimationContext::endGrouping();
            }
        }
    });

    // The web view can hand out a fresh layer while resizing, so the rounded
    // corners are re-applied once the movement has finished.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(duration_ms + 60));
        if SEQUENCE.load(Ordering::SeqCst) != sequence {
            return; // a newer request is already on its way
        }
        crate::corners::round(&corners_window, radius);
        // Asked for versus arrived at: the two must agree, or the content is
        // being clipped.
        #[cfg(debug_assertions)]
        if let (Ok(size), Ok(scale)) = (corners_window.inner_size(), corners_window.scale_factor())
        {
            eprintln!(
                "[preen] {}: Inhalt {:.0} px -> Fenster {:.0} px",
                corners_window.label(),
                height,
                size.height as f64 / scale
            );
        }
    });
}

/// Keeps the window inside the screen it is on, with a little air at the edges.
unsafe fn clamp_to_screen(window: &NSWindow, mut frame: NSRect) -> NSRect {
    const MARGIN: f64 = 12.0;
    let Some(screen) = window.screen() else {
        return frame;
    };
    let visible = screen.visibleFrame();
    let max_x = visible.origin.x + visible.size.width - frame.size.width - MARGIN;
    let max_y = visible.origin.y + visible.size.height - frame.size.height - MARGIN;
    frame.origin.x = frame
        .origin
        .x
        .clamp(visible.origin.x + MARGIN, max_x.max(visible.origin.x));
    frame.origin.y = frame
        .origin
        .y
        .clamp(visible.origin.y + MARGIN, max_y.max(visible.origin.y));
    frame
}
