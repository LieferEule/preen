mod corners;
mod frame;
pub mod imageio;
mod naming;
mod panel;
pub mod pipeline;
mod settings;
mod shortcut;
mod sizes;
mod tray;
mod windows;

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use tauri::{ActivationPolicy, AppHandle, Emitter, Manager as _, WindowEvent};

use settings::AppSettings;

use pipeline::BatchResult;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    path: String,
    name: String,
    width: u32,
    height: u32,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rejected {
    path: String,
    name: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectResult {
    images: Vec<ImageInfo>,
    rejected: Vec<Rejected>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NamePreview {
    output_dir: String,
    items: Vec<PlannedImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedImage {
    file_name: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
}

/// Checks dropped paths: supported format and readable dimensions.
#[tauri::command]
async fn inspect_images(paths: Vec<String>) -> InspectResult {
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = InspectResult {
            images: vec![],
            rejected: vec![],
        };
        for path in paths {
            let p = Path::new(&path);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let checked = if !p.is_file() {
                Err("Keine Datei".to_string())
            } else if !pipeline::is_supported(p) {
                Err("Format nicht unterstützt (nur JPG, PNG, HEIC, TIFF)".to_string())
            } else {
                imageio::dimensions(p)
            };
            match checked {
                Ok((width, height)) => result.images.push(ImageInfo {
                    bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    path,
                    name,
                    width,
                    height,
                }),
                Err(reason) => result.rejected.push(Rejected { path, name, reason }),
            }
        }
        result
    })
    .await
    .expect("inspect task panicked")
}

/// The slug suggested for a context text (also used to normalise a hand-edited slug).
#[tauri::command]
fn suggest_slug(text: String) -> String {
    naming::slugify(&text)
}

/// The name suggested from an original's file name — empty when that name is
/// a machine's (a timestamp, a counter, a uuid), because a folder called
/// `hf-20260914-071304-3615fd4d` helps nobody.
#[tauri::command]
fn suggest_name(file_stem: String) -> String {
    if naming::looks_machine_generated(&file_stem) {
        String::new()
    } else {
        naming::slugify(&file_stem)
    }
}

/// What a run would produce right now: output folder, file names and sizes.
/// `sizes` are the originals' (width, height) in drop order.
#[tauri::command]
fn preview_output(
    slug: String,
    first_image: String,
    sizes: Vec<(u32, u32)>,
    max_width: u32,
    custom_output_dir: Option<String>,
) -> NamePreview {
    let output_dir = pipeline::resolve_output_dir(
        Path::new(&first_image),
        custom_output_dir.as_deref().map(Path::new),
        &slug,
        sizes.len(),
    );
    let file_names = pipeline::plan_file_names(&slug, sizes.len().max(1), &output_dir);
    NamePreview {
        items: file_names
            .into_iter()
            .zip(sizes)
            .map(|(file_name, (w, h))| {
                let (width, height) = sizes::output_size(w, h, max_width);
                PlannedImage {
                    file_name,
                    width,
                    height,
                }
            })
            .collect(),
        output_dir: output_dir.to_string_lossy().into_owned(),
    }
}

/// `max_kb` uses 1 KB = 1000 bytes, like Finder; `None` means no limit.
#[tauri::command]
async fn process_images(
    app: AppHandle,
    paths: Vec<String>,
    slug: String,
    custom_output_dir: Option<String>,
    max_width: u32,
    max_kb: Option<u64>,
) -> Result<BatchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let images: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let first = images.first().ok_or("Keine Bilder ausgewählt")?;
        let output_dir = pipeline::resolve_output_dir(
            first,
            custom_output_dir.as_deref().map(Path::new),
            &slug,
            images.len(),
        );
        let settings = pipeline::Settings {
            max_width,
            max_bytes: max_kb.map(|kb| kb * 1000),
        };
        pipeline::process_batch(&images, &slug, &output_dir, &settings, |done, total| {
            let _ = app.emit("preen://progress", Progress { done, total });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A small WebP preview of the source image, as a data URL for the panel.
#[tauri::command]
async fn thumbnail(path: String, size: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bitmap = imageio::decode_thumbnail(Path::new(&path), size.max(16) * 2)?;
        let encoded = pipeline::encode_within_limit(
            bitmap.pixels,
            bitmap.width,
            bitmap.height,
            bitmap.has_alpha,
            None,
        )?;
        Ok(format!(
            "data:image/webp;base64,{}",
            STANDARD.encode(encoded.data)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn app_settings(app: AppHandle) -> AppSettings {
    settings::get(&app)
}

#[tauri::command]
fn shortcut_label(accelerator: String) -> String {
    settings::pretty_shortcut(&accelerator)
}

/// Swaps the global shortcut; on failure the old one stays registered.
#[tauri::command]
fn set_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    shortcut::replace(&app, &accelerator)
}

#[tauri::command]
fn set_show_in_dock(app: AppHandle, show: bool) {
    settings::set(&app, "showInDock", json!(show));
    apply_activation_policy(&app, show);
}

#[tauri::command]
fn set_default_target(app: AppHandle, target: String) {
    settings::set(&app, "defaultTarget", json!(target));
    let _ = app.emit("preen://settings-changed", ());
}

#[tauri::command]
fn remember_target(app: AppHandle, path: String) {
    settings::remember_target(&app, &path);
}

/// A stored folder that has gone missing (or turned read-only) must not break
/// a run, so the caller silently falls back to "source".
#[tauri::command]
fn target_is_usable(path: String) -> bool {
    let path = Path::new(&path);
    path.is_dir()
        && !std::fs::metadata(path)
            .map(|m| m.permissions().readonly())
            .unwrap_or(true)
}

#[tauri::command]
fn show_panel(app: AppHandle) {
    panel::show(&app);
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

/// Resizes the panel. `duration_ms` of 0 snaps; the frontend passes 0 when the
/// system asks for reduced motion.
#[tauri::command]
fn resize_panel(app: AppHandle, height: f64, loaded: bool, duration_ms: u64) {
    let (width, radius) = if loaded {
        (panel::LOADED_WIDTH, panel::LOADED_RADIUS)
    } else {
        (panel::IDLE_SIZE.0, panel::IDLE_RADIUS)
    };
    panel::resize(&app, width, height, radius, duration_ms);
}

/// Hiding a window from the frontend needs a window permission; going through
/// a command does not, which keeps the close button working no matter what the
/// capability file says.
#[tauri::command]
fn hide_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window(windows::SETTINGS_LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn set_auto_hide_seconds(app: AppHandle, seconds: u64) {
    settings::set(&app, "autoHideSeconds", json!(seconds));
    let _ = app.emit("preen://settings-changed", ());
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    windows::open_settings(&app);
}

#[tauri::command]
fn resize_settings_window(app: AppHandle, height: f64) {
    windows::resize_settings(&app, height);
}

/// Debug-only: lets the panel write what it measures into the app log.
#[tauri::command]
fn debug_log(message: String) {
    #[cfg(debug_assertions)]
    eprintln!("[preen] DOM {message}");
    #[cfg(not(debug_assertions))]
    let _ = message;
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Image paths among the process arguments.
fn image_arguments(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && pipeline::is_supported(Path::new(a)))
        .cloned()
        .collect()
}

/// Hands paths to the panel, once its window is listening.
fn open_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        let _ = app.emit("preen://open-files", paths);
    });
}

fn apply_activation_policy(app: &AppHandle, show_in_dock: bool) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let _ = app.set_activation_policy(if show_in_dock {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch brings the running panel up — and hands it any
            // images that came with it ("Öffnen mit", or a path on the command
            // line).
            panel::show(app);
            open_files(app, image_arguments(&args));
        }))
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            inspect_images,
            suggest_slug,
            suggest_name,
            preview_output,
            process_images,
            thumbnail,
            app_settings,
            shortcut_label,
            set_shortcut,
            set_show_in_dock,
            set_default_target,
            remember_target,
            target_is_usable,
            show_panel,
            hide_panel,
            resize_panel,
            hide_settings,
            set_auto_hide_seconds,
            open_settings_window,
            resize_settings_window,
            quit_app,
            debug_log
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let stored = settings::get(&handle);
            // Set on the App itself during setup: this is what takes the app
            // out of the Dock *and* the menu bar. The Info.plist LSUIElement
            // flag does the same for the bundled app before it even launches.
            app.set_activation_policy(if stored.show_in_dock {
                ActivationPolicy::Regular
            } else {
                ActivationPolicy::Accessory
            });

            panel::create(&handle)?;
            tray::create(&handle)?;
            shortcut::register_stored(&handle);

            // After installation the app would otherwise look like it never
            // started, so the panel shows itself once. A background tool is
            // also expected to come back after a restart.
            let arguments = image_arguments(&std::env::args().collect::<Vec<_>>());
            if !arguments.is_empty() {
                panel::show(&handle);
                open_files(&handle, arguments);
            }

            if settings::take_first_run(&handle) {
                use tauri_plugin_autostart::ManagerExt;
                let _ = handle.autolaunch().enable();
                panel::show(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing a window hides it; quitting happens from the tray only.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Remember where the user dragged the panel.
            WindowEvent::Moved(_) if window.label() == panel::PANEL_LABEL => {
                panel::remember_position(window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Preen");
}
