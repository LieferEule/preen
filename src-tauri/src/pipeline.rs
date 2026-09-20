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
use crate::sizes::{output_size, Limits};

/// Lossy WebP quality tried first, and used whenever the file fits.
pub const QUALITY_START: u8 = 80;
/// Quality never goes below this, even if the size limit is missed —
/// a slightly too large file beats a mushy one.
///
/// Before anyone lowers this because some photo came out far too large:
/// dense nature motifs really do cost that much. A wet, mossy forest wall
/// measures 0,39 bytes per pixel at quality 60 — roughly twenty times a
/// calm motif. That was checked against `cwebp -q 60` on the identical
/// pixels, for eight images: byte for byte the same numbers, so it is
/// libwebp's honest answer and not a bug in our encoder call, our decoder
/// or our resampling. The way out of such a file is fewer pixels
/// (`EMERGENCY_SCALE`), not less quality.
pub const QUALITY_FLOOR: u8 = 60;
/// File extensions accepted as input (compared case-insensitively).
pub const SUPPORTED_EXTENSIONS: [&str; 8] =
    ["jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff"];
/// Images decoded at the same time. A 48 MP photo takes ~200 MB as RGBA,
/// so this is kept small on purpose.
const MAX_PARALLEL_IMAGES: usize = 3;
/// How far `name-2.webp`, `name-3.webp` … is tried before giving up.
const MAX_NAME_ATTEMPTS: u32 = 999;

/// Last resort when even [`QUALITY_FLOOR`] misses the size limit: shrink the
/// long edge by this much and bisect again.
const EMERGENCY_SCALE: f64 = 0.9;
/// How often that may happen before the file is written as it is.
const EMERGENCY_STEPS: u8 = 3;

/// What one run should produce.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Output dimensions: long edge and pixel cap.
    pub limits: Limits,
    /// Floor for the emergency scaling — the long edge of the next preset
    /// down. Below it the picture is no longer the thing that was asked for
    /// (an 1182 px "hero" is smaller than an inhaltsbild), so the run stops
    /// shrinking and reports an oversized file instead. 0 turns the floor off.
    pub min_long_edge: u32,
    /// Upper file size in bytes; `None` means no limit (always quality 80).
    pub max_bytes: Option<u64>,
    /// Replace a file that is already there. Off by default: a run counts up
    /// to `name-2.webp` instead of eating what someone else put there.
    pub overwrite: bool,
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
    /// The size limit forced the picture below the dimensions the preset
    /// would have given it — it is smaller than the preset promises.
    pub emergency_scaled: bool,
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

/// The images behind what was handed in: files as they are, and for a folder
/// the supported images directly inside it.
///
/// One level deep on purpose — a dropped folder should give what is visible
/// in it, not everything an archive underneath happens to hold. Sorted, so a
/// run is reproducible; folders inside folders and everything unsupported
/// are passed over in silence. A folder that yields nothing is kept as
/// itself, so it can be reported instead of vanishing without a word.
pub fn expand_inputs(inputs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for input in inputs {
        if input.is_dir() {
            let mut found: Vec<PathBuf> = fs::read_dir(input)
                .map(|entries| {
                    entries
                        .filter_map(|e| {
                            let path = e.ok()?.path();
                            (path.is_file() && is_supported(&path)).then_some(path)
                        })
                        .collect()
                })
                .unwrap_or_default();
            found.sort();
            if found.is_empty() {
                out.push(input.clone());
            } else {
                out.append(&mut found);
            }
        } else {
            out.push(input.clone());
        }
    }
    out
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
///
/// `avoid_existing` is off when the run is allowed to replace: then the names
/// are the plain ones, and the preview says what will really be written.
pub fn plan_file_names(
    slug: &str,
    count: usize,
    output_dir: &Path,
    avoid_existing: bool,
) -> Vec<String> {
    let existing = if avoid_existing {
        existing_file_names(output_dir)
    } else {
        Vec::new()
    };
    plan_base_names(&slugify(slug), count, existing.iter().map(String::as_str))
        .into_iter()
        .map(|stem| format!("{stem}.webp"))
        .collect()
}

/// One complete run, from source paths to written files — everything the app
/// does after the user hits Enter, and the only entry point the Tauri command
/// and `preen-cli` both go through.
///
/// `custom_output_dir` of `None` means "next to the first image"; the folder
/// rule (subfolder for several images, straight into the target for one) is
/// [`resolve_output_dir`].
pub fn convert(
    images: &[PathBuf],
    slug: &str,
    custom_output_dir: Option<&Path>,
    settings: &Settings,
    on_progress: impl Fn(usize, usize) + Sync,
) -> Result<BatchResult, String> {
    let images = expand_inputs(images);
    let first = images.first().ok_or("Keine Bilder ausgewählt")?;
    let output_dir = resolve_output_dir(first, custom_output_dir, slug, images.len());
    process_batch(&images, slug, &output_dir, settings, on_progress)
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
    fs::create_dir_all(output_dir).map_err(|e| format!("Zielordner nicht anlegbar: {e}"))?;
    // Once, before anything is encoded. A folder that cannot be written to is
    // not a per-image problem, and finding it out eight times in a row helps
    // nobody.
    ensure_writable(output_dir)?;

    let file_names = plan_file_names(slug, images.len(), output_dir, !settings.overwrite);
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

/// Fehlertexte sind kurz gehalten: sie stehen im Panel hinter dem Dateinamen
/// in einer Zeile von rund 42 Zeichen. Kurz und ganz zu lesen schlägt
/// vollständig und abgeschnitten.
fn process_image(source: &Path, path: &Path, settings: &Settings) -> Result<OutputFile, String> {
    if source.is_dir() {
        return Err("Ordner ohne Bilder".to_string());
    }
    if !is_supported(source) {
        return Err("Format nicht unterstützt".to_string());
    }
    let original = imageio::decode(source)?;
    let (mut width, mut height) = output_size(original.width, original.height, settings.limits);

    // Quality alone cannot always reach the limit. When the floor is hit and
    // the file is still too large, take 10 % off the long edge and bisect
    // again — fewer pixels at quality 60-80 beat a huge file at 60. Always
    // resampled from the original, never from an already shrunken copy, and
    // never past `min_long_edge`: rather an honestly oversized file than a
    // quietly undersized one.
    let mut step = 0;
    let encoded = loop {
        let pixels = resize(&original, width, height)?;
        let encoded = encode_within_limit(
            pixels,
            width,
            height,
            original.has_alpha,
            settings.max_bytes,
        )?;
        let long_edge = width.max(height);
        if !encoded.limit_missed || step == EMERGENCY_STEPS || long_edge <= settings.min_long_edge {
            break encoded;
        }
        step += 1;
        let shorter = ((long_edge as f64 * EMERGENCY_SCALE).round() as u32)
            .max(settings.min_long_edge)
            .max(1);
        (width, height) = output_size(width, height, Limits::long_edge_only(shorter));
    };

    // Where it really landed — the planned name may have been taken.
    let (path, bytes) = write_file(path, &encoded.data, settings.overwrite)?;
    Ok(OutputFile {
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        bytes,
        quality: encoded.quality,
        limit_missed: encoded.limit_missed,
        emergency_scaled: step > 0,
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

/// Writes the file and says where it actually landed.
///
/// Unless `overwrite` is set, nothing that is already there is touched:
/// `create_new` either wins the name or reports it taken, and then
/// `name-2.webp`, `name-3.webp` … is tried. Asking whether a file exists and
/// writing afterwards would be a race — three images of a batch are encoded
/// at the same time, and two of them can plan the same name.
fn write_file(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(PathBuf, u64), String> {
    let written = |path: &Path, mut file: std::fs::File| -> Result<(PathBuf, u64), String> {
        if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(e.to_string());
        }
        Ok((path.to_path_buf(), bytes.len() as u64))
    };

    if overwrite {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        return written(path, file);
    }

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path.extension().unwrap_or_default().to_string_lossy();
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let candidate = if attempt == 1 {
            path.to_path_buf()
        } else {
            dir.join(format!("{}.{extension}", next_stem(&stem)))
        };
        stem = next_stem(&stem).into();
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return written(&candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!(
        "Kein freier Dateiname nach {MAX_NAME_ATTEMPTS} Versuchen"
    ))
}

/// The next name after `stem`, in the shape the batch numbering already uses:
/// `bild` → `bild-02`, `bild-02` → `bild-03`. One counter for both, so a
/// folder does not end up with `bild-02.webp` next to `bild-2.webp`.
fn next_stem(stem: &str) -> String {
    if let Some((head, tail)) = stem.rsplit_once('-') {
        if !head.is_empty() && tail.len() >= 2 {
            if let Ok(number) = tail.parse::<u32>() {
                return format!("{head}-{:02}", number + 1);
            }
        }
    }
    format!("{stem}-02")
}

/// Proves the folder takes a file, instead of trusting a permission bit that
/// says little about folders owned by someone else.
fn ensure_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(
        ".preen-schreibprobe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("Zielordner nicht beschreibbar: {e}")),
    }
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
