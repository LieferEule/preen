pub mod imageio;
mod naming;
pub mod pipeline;
mod sizes;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use pipeline::BatchResult;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    path: String,
    name: String,
    width: u32,
    height: u32,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            inspect_images,
            suggest_slug,
            preview_output,
            process_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running Preen");
}
