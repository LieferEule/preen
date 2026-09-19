//! The whole job: decode → resize → lossy WebP within a size limit → write.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use rayon::prelude::*;
use serde::Serialize;

use crate::imageio::{self, Bitmap};
use crate::naming::{plan_base_names, slugify};
use crate::sizes::output_size;

/// Lossy WebP quality tried first, and used whenever the file fits.
pub const QUALITY_START: u8 = 80;
/// Quality never goes below this, even if the size limit is missed —
/// a slightly too large file beats a mushy one.
pub const QUALITY_FLOOR: u8 = 60;
/// File extensions accepted as input (compared case-insensitively).
pub const SUPPORTED_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff"];
/// Images decoded at the same time. A 48 MP photo takes ~200 MB as RGBA,
/// so this is kept small on purpose.
const MAX_PARALLEL_IMAGES: usize = 3;

/// What one run should produce.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Wider originals are scaled down to this width; narrower ones are kept.
    pub max_width: u32,
    /// Upper file size in bytes; `None` means no limit (always quality 80).
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub quality: u8,
    /// The size limit could not be met even at [`QUALITY_FLOOR`].
    pub limit_missed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub source: String,
    pub output: Option<OutputFile>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub output_dir: String,
    pub images: Vec<ImageResult>,
}

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SUPPORTED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// The folder results go to. The target is the chosen folder or, by default,
/// the folder of the first image. A single image lands directly in it; several
/// get a subfolder named after the slug so they don't lie around loose.
pub fn resolve_output_dir(
    first_image: &Path,
    custom: Option<&Path>,
    slug: &str,
    count: usize,
) -> PathBuf {
    let target = match custom {
        Some(dir) => dir,
        None => first_image.parent().unwrap_or_else(|| Path::new("/")),
    };
    if count > 1 {
        target.join(slugify(slug))
    } else {
        target.to_path_buf()
    }
}

/// File names the batch would get right now (for the live preview).
pub fn plan_file_names(slug: &str, count: usize, output_dir: &Path) -> Vec<String> {
    let existing = existing_file_names(output_dir);
    plan_base_names(&slugify(slug), count, existing.iter().map(String::as_str))
        .into_iter()
        .map(|stem| format!("{stem}.webp"))
        .collect()
}

pub fn process_batch(
    images: &[PathBuf],
    slug: &str,
    output_dir: &Path,
    settings: &Settings,
    on_progress: impl Fn(usize, usize) + Sync,
) -> Result<BatchResult, String> {
    if images.is_empty() {
        return Err("Keine Bilder ausgewählt".to_string());
    }
    fs::create_dir_all(output_dir)
        .map_err(|e| format!("Zielordner konnte nicht angelegt werden: {e}"))?;

    let file_names = plan_file_names(slug, images.len(), output_dir);
    let total = images.len();
    let done = AtomicUsize::new(0);

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(MAX_PARALLEL_IMAGES.min(total))
        .build()
        .map_err(|e| e.to_string())?;
    let results = pool.install(|| {
        images
            .par_iter()
            .zip(file_names.par_iter())
            .map(|(source, file_name)| {
                let outcome = process_image(source, &output_dir.join(file_name), settings);
                on_progress(done.fetch_add(1, Ordering::SeqCst) + 1, total);
                let (output, error) = match outcome {
                    Ok(output) => (Some(output), None),
                    Err(e) => (None, Some(e)),
                };
                ImageResult {
                    source: source.to_string_lossy().into_owned(),
                    output,
                    error,
                }
            })
            .collect()
    });

    Ok(BatchResult {
        output_dir: output_dir.to_string_lossy().into_owned(),
        images: results,
    })
}

fn process_image(source: &Path, path: &Path, settings: &Settings) -> Result<OutputFile, String> {
    if !is_supported(source) {
        return Err("Dateiformat wird nicht unterstützt".to_string());
    }
    let original = imageio::decode(source)?;
    let (width, height) = output_size(original.width, original.height, settings.max_width);
    let pixels = resize(&original, width, height)?;
    let encoded = encode_within_limit(
        pixels,
        width,
        height,
        original.has_alpha,
        settings.max_bytes,
    )?;
    let bytes = write_new_file(path, &encoded.data)?;
    Ok(OutputFile {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        width,
        height,
        bytes,
        quality: encoded.quality,
        limit_missed: encoded.limit_missed,
    })
}

/// Resamples premultiplied RGBA with Lanczos3. Returns premultiplied RGBA.
fn resize(original: &Bitmap, width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == original.width && height == original.height {
        return Ok(original.pixels.clone());
    }
    let src = ImageRef::new(
        original.width,
        original.height,
        &original.pixels,
        PixelType::U8x4,
    )
    .map_err(|e| e.to_string())?;
    let mut dst = Image::new(width, height, PixelType::U8x4);
    // Pixels are already premultiplied by CoreGraphics, so the resizer must
    // not multiply/divide alpha again.
    let options = ResizeOptions::new()
        .resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3))
        .use_alpha(false);
    Resizer::new()
        .resize(&src, &mut dst, &options)
        .map_err(|e| e.to_string())?;
    Ok(dst.into_vec())
}

pub struct Encoded {
    pub data: Vec<u8>,
    pub quality: u8,
    pub limit_missed: bool,
}

/// Lossy WebP that fits `max_bytes` if possible.
///
/// Quality 80 if it fits (or there is no limit). Otherwise the highest quality
/// between 60 and 80 that fits, found by bisection. If even 60 is too large,
/// the quality-60 file is returned with `limit_missed` set.
///
/// `pixels` is premultiplied RGBA; opaque images are encoded without alpha.
pub fn encode_within_limit(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    has_alpha: bool,
    max_bytes: Option<u64>,
) -> Result<Encoded, String> {
    let input = prepare_for_webp(pixels, has_alpha);
    let encode = |quality: u8| -> Result<Vec<u8>, String> {
        let encoder = if has_alpha {
            webp::Encoder::from_rgba(&input, width, height)
        } else {
            webp::Encoder::from_rgb(&input, width, height)
        };
        let data = encoder.encode(quality as f32);
        if data.is_empty() {
            return Err("WebP-Kodierung fehlgeschlagen".to_string());
        }
        Ok(data.to_vec())
    };
    let fits = |data: &[u8]| max_bytes.is_none_or(|max| data.len() as u64 <= max);

    let start = encode(QUALITY_START)?;
    if fits(&start) {
        return Ok(Encoded {
            data: start,
            quality: QUALITY_START,
            limit_missed: false,
        });
    }
    let floor = encode(QUALITY_FLOOR)?;
    if !fits(&floor) {
        return Ok(Encoded {
            data: floor,
            quality: QUALITY_FLOOR,
            limit_missed: true,
        });
    }

    // Invariant: `good` fits, `too_big` doesn't.
    let (mut good, mut too_big) = (QUALITY_FLOOR, QUALITY_START);
    let mut best = floor;
    while too_big - good > 1 {
        let mid = good + (too_big - good) / 2;
        let data = encode(mid)?;
        if fits(&data) {
            good = mid;
            best = data;
        } else {
            too_big = mid;
        }
    }
    Ok(Encoded {
        data: best,
        quality: good,
        limit_missed: false,
    })
}

/// Straight (un-premultiplied) RGBA for transparent images, RGB otherwise.
fn prepare_for_webp(mut pixels: Vec<u8>, has_alpha: bool) -> Vec<u8> {
    if has_alpha {
        for p in pixels.chunks_exact_mut(4) {
            let a = p[3] as u32;
            if a != 0 && a != 255 {
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        pixels
    } else {
        pixels
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect()
    }
}

/// Writes a file that must not exist yet — never overwrites anything.
fn write_new_file(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => "Datei existiert bereits".to_string(),
            _ => e.to_string(),
        })?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(e.to_string());
    }
    Ok(bytes.len() as u64)
}

fn existing_file_names(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}
