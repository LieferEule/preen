//! Videos: a finished clip in, a smaller H.264 MP4 without sound out.
//!
//! Nothing is cut and nothing is edited — the clip comes ready, it only has
//! to get small enough for a website. The size target is reached by encoding,
//! measuring and correcting, not by a calculation: Apple's encoder lands
//! within roughly ±15 % of the bitrate it is given (+15 %, −15 %, +3 % on
//! three clips with the same settings), so one pass cannot be trusted to fit.
//!
//! What is deliberately *not* here: deriving a lower resolution from the
//! bitrate "so it does not get blocky". Measured on three clips at the same
//! 2 MB, the native edge beat a 720 px edge every time (SSIM 0,9838 / 0,9837 /
//! 0,8896 against 0,9828 / 0,9814 / 0,8822) — the encoder spends bits better
//! than a smaller picture saves them. The long edge is only a ceiling.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::avfoundation::{self, EncodeSettings, Probe};
use crate::imageio;
use crate::pipeline::{ensure_writable, next_stem, plan_names, resolve_output_dir};
use crate::sizes::{output_size, Limits};

/// Highest output frame rate. A hero loops silently in the background; more
/// frames would only take bits from each one.
pub const MAX_FPS: f64 = 30.0;
/// A pass counts as on target within this much of it, either way.
pub const SIZE_TOLERANCE: f64 = 0.03;
/// Passes after the first. One hardware pass takes 1–2 s, so this is cheap.
pub const MAX_CORRECTIONS: usize = 2;
/// The encoder is never asked for less than this; below it H.264 falls apart
/// and the correction formula would chase zero on a broken first pass.
const MIN_BITRATE: u64 = 100_000;
/// File extensions accepted as input (compared case-insensitively).
pub const SUPPORTED_EXTENSIONS: [&str; 3] = ["mp4", "mov", "m4v"];
const MAX_NAME_ATTEMPTS: u32 = 999;
/// Frames compared against the source after encoding, spread evenly.
pub const SSIM_SAMPLES: usize = 24;
/// Below this mean SSIM the result counts as soft, and the panel says so
/// with the number. Set from three real clips: a phone clip and a screen
/// recording at 0,969–0,987 look like their source; a screen recording with
/// film grain at 0,928 (1 MB) and 0,841 (2 MB) lost the grain and a line of
/// faint text — visibly. The 24 samples agree with ffmpeg's `ssim` over every
/// frame to within 0,003.
pub const SOFT_SSIM: f64 = 0.95;

/// What one run should produce.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoSettings {
    /// The longer side of the output at most. Never upscaled.
    pub long_edge: u32,
    /// Size target in bytes.
    pub max_bytes: u64,
    /// Replace a file that is already there instead of counting up.
    pub overwrite: bool,
}

/// What will be asked of the encoder, before the first pass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Bytes the passes aim at: the size target, or the source's own video
    /// size if that is smaller — re-encoding at a higher rate than the
    /// source buys nothing.
    pub target_bytes: u64,
    pub bitrate: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub bitrate: u64,
    pub bytes: u64,
}

/// Which pass was kept, and every pass that was made.
#[derive(Debug, Clone, PartialEq)]
pub struct Fit {
    pub chosen: usize,
    pub attempts: Vec<Attempt>,
    /// Even the kept pass is more than [`SIZE_TOLERANCE`] over the target.
    pub limit_missed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutput {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_seconds: f64,
    pub bytes: u64,
    pub target_bytes: u64,
    /// Every pass, in order — how far the encoder was off and what it took.
    pub attempts: Vec<Attempt>,
    /// The file is more than [`SIZE_TOLERANCE`] over the size target.
    pub limit_missed: bool,
    /// Mean SSIM (luma) of [`SSIM_SAMPLES`] frames against the source, both
    /// at the output size — what the compression cost, not the resizing.
    /// `None` if the frames could not be read; that is no reason to fail.
    pub ssim: Option<f64>,
    /// The weakest of those frames.
    pub ssim_worst: Option<f64>,
    /// Mean SSIM below [`SOFT_SSIM`]: the size target is too tight for this
    /// clip. Said out loud instead of shrinking the picture behind the
    /// user's back.
    pub soft: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoResult {
    pub source: String,
    pub output: Option<VideoOutput>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoBatchResult {
    pub output_dir: String,
    pub videos: Vec<VideoResult>,
}

pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SUPPORTED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Output size: the long edge as a ceiling, never upscaled, both sides even.
///
/// 4:2:0 video stores colour for 2×2 blocks, so H.264 wants even sides. Odd
/// ones are rounded down; the aspect ratio moves by less than a pixel.
pub fn output_dimensions(width: u32, height: u32, long_edge: u32) -> (u32, u32) {
    let (w, h) = output_size(width, height, Limits::long_edge_only(long_edge));
    ((w & !1).max(2), (h & !1).max(2))
}

/// Output frame rate: the source rate divided by the smallest whole number
/// that brings it to [`MAX_FPS`] or below.
///
/// Whole divisors keep the motion even — 60 → 30, 50 → 25, 120 → 30. Taking
/// 50 fps to 30 would mean dropping two frames in five, and that judders.
/// 5 % slack, because phones report a nominal 30,02 for a 30 fps clip, and
/// halving that to 15 would be absurd.
pub fn output_fps(source_fps: f64) -> f64 {
    let step = (source_fps / (MAX_FPS * 1.05)).ceil().max(1.0);
    source_fps / step
}

/// Bits per second that would give `bytes` over `duration_seconds`.
pub fn bitrate_for(bytes: u64, duration_seconds: f64) -> u64 {
    ((bytes as f64 * 8.0 / duration_seconds).round() as u64).max(MIN_BITRATE)
}

pub fn plan(probe: &Probe, settings: &VideoSettings) -> Plan {
    let (width, height) = output_dimensions(probe.width, probe.height, settings.long_edge);
    let source_bytes = probe
        .bitrate
        .map(|rate| (rate as f64 / 8.0 * probe.duration_seconds).round() as u64);
    let target_bytes = source_bytes.map_or(settings.max_bytes, |s| s.min(settings.max_bytes));
    Plan {
        width,
        height,
        fps: output_fps(probe.fps),
        target_bytes,
        bitrate: bitrate_for(target_bytes, probe.duration_seconds),
    }
}

/// Encodes until a pass lands within [`SIZE_TOLERANCE`] of `target_bytes`,
/// with at most [`MAX_CORRECTIONS`] corrections.
///
/// `encode(index, bitrate)` makes pass number `index` and returns its size.
/// Each correction scales the last bitrate by how far its pass was off — the
/// encoder's miss is roughly proportional. If no pass lands on target, the
/// largest one that is not over is kept (the most picture for the budget);
/// if all are over, the smallest, and `limit_missed` says so.
pub fn fit_size(
    target_bytes: u64,
    first_bitrate: u64,
    mut encode: impl FnMut(usize, u64) -> Result<u64, String>,
) -> Result<Fit, String> {
    let target = target_bytes as f64;
    let ceiling = target * (1.0 + SIZE_TOLERANCE);
    let floor = target * (1.0 - SIZE_TOLERANCE);
    let mut attempts: Vec<Attempt> = Vec::new();
    let mut bitrate = first_bitrate.max(MIN_BITRATE);

    for index in 0..=MAX_CORRECTIONS {
        let bytes = encode(index, bitrate)?;
        attempts.push(Attempt { bitrate, bytes });
        let size = bytes as f64;
        if (floor..=ceiling).contains(&size) {
            return Ok(Fit {
                chosen: index,
                attempts,
                limit_missed: false,
            });
        }
        let next = ((bitrate as f64 * target / size.max(1.0)).round() as u64).max(MIN_BITRATE);
        // The encoder has nowhere further to go (already at the minimum).
        if next == bitrate {
            break;
        }
        bitrate = next;
    }

    let under = attempts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.bytes as f64 <= ceiling)
        .max_by_key(|(_, a)| a.bytes);
    let (chosen, limit_missed) = match under {
        Some((i, _)) => (i, false),
        None => {
            let smallest = attempts
                .iter()
                .enumerate()
                .min_by_key(|(_, a)| a.bytes)
                .map(|(i, _)| i)
                .unwrap_or(0);
            (smallest, true)
        }
    };
    Ok(Fit {
        chosen,
        attempts,
        limit_missed,
    })
}

/// One complete run, from source paths to written files. Videos go one after
/// another: the hardware encoder is one unit, and parallel passes would only
/// queue for it.
///
/// `custom_output_dir` of `None` means "next to the first video", with the
/// same folder rule as for images.
pub fn convert(
    videos: &[PathBuf],
    slug: &str,
    custom_output_dir: Option<&Path>,
    settings: &VideoSettings,
    on_progress: impl Fn(usize, usize),
) -> Result<VideoBatchResult, String> {
    let first = videos.first().ok_or("Keine Videos ausgewählt")?;
    let output_dir = resolve_output_dir(first, custom_output_dir, slug, videos.len());
    fs::create_dir_all(&output_dir).map_err(|e| format!("Zielordner nicht anlegbar: {e}"))?;
    ensure_writable(&output_dir)?;

    let file_names = plan_names(slug, videos.len(), &output_dir, !settings.overwrite, "mp4");
    let total = videos.len();
    let mut results = Vec::with_capacity(total);
    for (index, (source, file_name)) in videos.iter().zip(&file_names).enumerate() {
        let outcome = process_video(source, &output_dir.join(file_name), settings);
        on_progress(index + 1, total);
        let (output, error) = match outcome {
            Ok(output) => (Some(output), None),
            Err(e) => (None, Some(e)),
        };
        results.push(VideoResult {
            source: source.to_string_lossy().into_owned(),
            output,
            error,
        });
    }
    Ok(VideoBatchResult {
        output_dir: output_dir.to_string_lossy().into_owned(),
        videos: results,
    })
}

/// Fehlertexte kurz halten, wie bei den Bildern: rund 42 Zeichen im Panel.
fn process_video(
    source: &Path,
    path: &Path,
    settings: &VideoSettings,
) -> Result<VideoOutput, String> {
    if source.is_dir() {
        return Err("Ordner werden noch nicht gelesen".to_string());
    }
    if !is_supported(source) {
        return Err("Format nicht unterstützt".to_string());
    }
    let probe = avfoundation::probe(source)?;
    let plan = plan(&probe, settings);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let passes = Passes::new(dir)?;

    let fit = fit_size(plan.target_bytes, plan.bitrate, |index, bitrate| {
        let pass = passes.path(index);
        avfoundation::encode(
            source,
            &pass,
            &EncodeSettings {
                width: plan.width,
                height: plan.height,
                fps: plan.fps,
                source_fps: probe.fps,
                bitrate,
            },
        )?;
        fs::metadata(&pass)
            .map(|m| m.len())
            .map_err(|e| e.to_string())
    })?;

    let kept = passes.path(fit.chosen);
    let quality = measure(source, &kept, &plan, &probe).ok();
    let path = place(&kept, path, settings.overwrite)?;
    let bytes = fit.attempts[fit.chosen].bytes;
    Ok(VideoOutput {
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        duration_seconds: probe.duration_seconds,
        bytes,
        target_bytes: plan.target_bytes,
        attempts: fit.attempts,
        limit_missed: fit.limit_missed,
        ssim: quality.map(|q| q.0),
        ssim_worst: quality.map(|q| q.1),
        soft: quality.is_some_and(|q| q.0 < SOFT_SSIM),
    })
}

/// When to compare: [`SSIM_SAMPLES`] moments spread over the clip, each just
/// after the start of an output frame. Taken at an arbitrary time, the source
/// (60 fps) would show the frame the output (30 fps) dropped, and the
/// comparison would measure motion instead of compression.
pub fn sample_times(duration_seconds: f64, fps: f64, source_fps: f64) -> Vec<f64> {
    let frames = (duration_seconds * fps).floor().max(1.0);
    (0..SSIM_SAMPLES)
        .map(|i| {
            let frame = ((i as f64 + 0.5) / SSIM_SAMPLES as f64 * frames).floor();
            frame / fps + 0.25 / source_fps.max(fps)
        })
        .filter(|t| *t < duration_seconds)
        .collect()
}

/// (mean, worst) SSIM of the encoded file against its source.
fn measure(
    source: &Path,
    encoded: &Path,
    plan: &Plan,
    probe: &Probe,
) -> Result<(f64, f64), String> {
    let original = avfoundation::Frames::open(source)?;
    let result = avfoundation::Frames::open(encoded)?;
    let (w, h) = (plan.width, plan.height);
    let mut scores = Vec::new();
    for t in sample_times(probe.duration_seconds, plan.fps, probe.fps) {
        let a = imageio::luma_from_image(&*original.at(t)?, w, h)?;
        let b = imageio::luma_from_image(&*result.at(t)?, w, h)?;
        scores.push(ssim(&a, &b, w as usize, h as usize));
    }
    if scores.is_empty() {
        return Err("keine Stichproben".to_string());
    }
    let mean = scores.iter().sum::<f64>() / scores.len() as f64;
    let worst = scores.iter().cloned().fold(f64::INFINITY, f64::min);
    Ok((mean, worst))
}

/// Structural similarity of two 8-bit luma planes of the same size, as
/// ffmpeg's `ssim` filter computes it for Y: 8×8 windows every 4
/// pixels, the usual constants, mean over all windows. 1 is identical.
pub fn ssim(a: &[u8], b: &[u8], width: usize, height: usize) -> f64 {
    const C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
    const C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);
    const N: usize = 8;
    if width < N || height < N {
        return if a == b { 1.0 } else { 0.0 };
    }
    let (mut total, mut count) = (0.0, 0usize);
    for y in (0..=height - N).step_by(4) {
        for x in (0..=width - N).step_by(4) {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for row in y..y + N {
                let start = row * width + x;
                for (&p, &q) in a[start..start + N].iter().zip(&b[start..start + N]) {
                    let (p, q) = (p as u64, q as u64);
                    sa += p;
                    sb += q;
                    saa += p * p;
                    sbb += q * q;
                    sab += p * q;
                }
            }
            let n = (N * N) as f64;
            let (ma, mb) = (sa as f64 / n, sb as f64 / n);
            let va = saa as f64 / n - ma * ma;
            let vb = sbb as f64 / n - mb * mb;
            let cov = sab as f64 / n - ma * mb;
            total += ((2.0 * ma * mb + C1) * (2.0 * cov + C2))
                / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            count += 1;
        }
    }
    total / count as f64
}

/// A hidden working folder next to the destination for the passes of one
/// video (same volume, so the kept one moves into place without copying).
/// AVAssetWriter puts its own scratch files here too — for the faststart
/// rewrite it writes `<pass>.sb-…` copies and does not clean them up. The
/// whole folder goes when this goes out of scope, on success and on error.
struct Passes {
    dir: PathBuf,
}

impl Passes {
    fn new(dir: &Path) -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = dir.join(format!(".preen-video-{}-{nanos}", std::process::id()));
        fs::create_dir(&dir).map_err(|e| format!("Arbeitsordner nicht anlegbar: {e}"))?;
        Ok(Self { dir })
    }

    fn path(&self, index: usize) -> PathBuf {
        self.dir.join(format!("pass-{index}.mp4"))
    }
}

impl Drop for Passes {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Moves the finished pass to its name and says where it landed.
///
/// Without `overwrite` nothing that is there is touched: a hard link either
/// takes the name or reports it taken — the same race-free rule as
/// `pipeline::write_file`, with the same `-02`, `-03` … numbering.
fn place(pass: &Path, path: &Path, overwrite: bool) -> Result<PathBuf, String> {
    if overwrite {
        fs::rename(pass, path).map_err(|e| e.to_string())?;
        return Ok(path.to_path_buf());
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let extension = path.extension().unwrap_or_default().to_string_lossy();
    let mut stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let candidate = if attempt == 1 {
            path.to_path_buf()
        } else {
            stem = next_stem(&stem);
            dir.join(format!("{stem}.{extension}"))
        };
        match fs::hard_link(pass, &candidate) {
            Ok(()) => {
                let _ = fs::remove_file(pass);
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!(
        "Kein freier Dateiname nach {MAX_NAME_ATTEMPTS} Versuchen"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(width: u32, height: u32, fps: f64, seconds: f64, bitrate: Option<u64>) -> Probe {
        Probe {
            width,
            height,
            fps,
            duration_seconds: seconds,
            bitrate,
            has_audio: false,
        }
    }

    const HERO: VideoSettings = VideoSettings {
        long_edge: 1920,
        max_bytes: 2_000_000,
        overwrite: false,
    };

    #[test]
    fn long_edge_is_a_ceiling_and_never_upscales() {
        assert_eq!(output_dimensions(3840, 2160, 1920), (1920, 1080));
        assert_eq!(output_dimensions(1280, 720, 1920), (1280, 720));
        // Portrait is measured on its height.
        assert_eq!(output_dimensions(2160, 3840, 1920), (1080, 1920));
    }

    #[test]
    fn sides_are_always_even() {
        // 1206x2622 (an iPhone screen recording) at 1920: 883,1 wide.
        assert_eq!(output_dimensions(1206, 2622, 1920), (882, 1920));
        assert_eq!(output_dimensions(1001, 563, 1920), (1000, 562));
        assert_eq!(output_dimensions(1, 1, 1920), (2, 2));
        for (w, h) in [(1206, 2622), (4096, 2160), (999, 999), (3000, 7)] {
            let (ow, oh) = output_dimensions(w, h, 1280);
            assert!(ow % 2 == 0 && oh % 2 == 0, "{w}x{h} -> {ow}x{oh}");
        }
    }

    #[test]
    fn frame_rate_is_divided_by_whole_numbers() {
        assert_eq!(output_fps(60.0), 30.0);
        assert_eq!(output_fps(50.0), 25.0);
        assert_eq!(output_fps(120.0), 30.0);
        assert_eq!(output_fps(30.0), 30.0);
        assert_eq!(output_fps(25.0), 25.0);
        assert_eq!(output_fps(24.0), 24.0);
        assert!((output_fps(59.94) - 29.97).abs() < 1e-9);
        assert!((output_fps(29.97) - 29.97).abs() < 1e-9);
    }

    #[test]
    fn a_phone_reporting_a_hair_over_30_keeps_30() {
        assert_eq!(output_fps(30.02), 30.02);
    }

    #[test]
    fn bitrate_spreads_the_target_over_the_duration() {
        // 2 MB over 10 s = 1,6 Mbit/s.
        assert_eq!(bitrate_for(2_000_000, 10.0), 1_600_000);
        assert_eq!(bitrate_for(1_000, 600.0), MIN_BITRATE);
    }

    #[test]
    fn plan_aims_at_the_size_target() {
        let p = plan(&probe(3840, 2160, 60.0, 10.0, Some(40_000_000)), &HERO);
        assert_eq!((p.width, p.height, p.fps), (1920, 1080, 30.0));
        assert_eq!(p.target_bytes, 2_000_000);
        assert_eq!(p.bitrate, 1_600_000);
    }

    #[test]
    fn plan_never_aims_above_the_source() {
        // 800 kbit/s for 10 s is 1 MB — below the 2 MB target.
        let p = plan(&probe(1280, 720, 30.0, 10.0, Some(800_000)), &HERO);
        assert_eq!(p.target_bytes, 1_000_000);
        assert_eq!(p.bitrate, 800_000);
        // No rate known: the target it is.
        let p = plan(&probe(1280, 720, 30.0, 10.0, None), &HERO);
        assert_eq!(p.target_bytes, 2_000_000);
    }

    /// An encoder that misses every bitrate by the same factor.
    fn off_by(factor: f64, seconds: f64) -> impl FnMut(usize, u64) -> Result<u64, String> {
        move |_, bitrate| Ok((bitrate as f64 / 8.0 * seconds * factor).round() as u64)
    }

    #[test]
    fn a_pass_on_target_is_kept_without_correction() {
        let fit = fit_size(2_000_000, 1_600_000, off_by(1.02, 10.0)).unwrap();
        assert_eq!(fit.attempts.len(), 1);
        assert_eq!(fit.chosen, 0);
        assert!(!fit.limit_missed);
    }

    #[test]
    fn fifteen_percent_over_is_corrected_in_one_step() {
        let fit = fit_size(2_000_000, 1_600_000, off_by(1.15, 10.0)).unwrap();
        assert_eq!(fit.attempts.len(), 2);
        assert_eq!(fit.chosen, 1);
        assert_eq!(fit.attempts[0].bytes, 2_300_000);
        // 1,6 Mbit/s × 2/2,3.
        assert_eq!(fit.attempts[1].bitrate, 1_391_304);
        assert!((fit.attempts[1].bytes as f64 - 2_000_000.0).abs() < 2_000_000.0 * 0.03);
    }

    #[test]
    fn fifteen_percent_under_is_corrected_upwards() {
        let fit = fit_size(2_000_000, 1_600_000, off_by(0.85, 10.0)).unwrap();
        assert_eq!(fit.attempts.len(), 2);
        assert!(fit.attempts[1].bitrate > 1_600_000);
        assert!(!fit.limit_missed);
    }

    #[test]
    fn never_more_than_two_corrections() {
        // Swings ever wider around the target — never inside the window.
        let mut misses = [1.20, 0.80, 1.10].into_iter();
        let fit = fit_size(2_000_000, 1_600_000, |_, bitrate| {
            Ok((bitrate as f64 / 8.0 * 10.0 * misses.next().unwrap()).round() as u64)
        })
        .unwrap();
        assert_eq!(fit.attempts.len(), 1 + MAX_CORRECTIONS);
        // Of the three, only the second is not over; it is kept.
        assert_eq!(fit.chosen, 1);
        assert!(!fit.limit_missed);
    }

    #[test]
    fn when_every_pass_is_over_the_smallest_is_kept_and_reported() {
        // An encoder that will not go below 2,5 MB, whatever it is asked.
        let fit = fit_size(2_000_000, 1_600_000, |_, bitrate| {
            Ok(2_500_000 + bitrate / 100)
        })
        .unwrap();
        assert_eq!(fit.attempts.len(), 3);
        assert!(fit.limit_missed);
        let smallest = fit.attempts.iter().map(|a| a.bytes).min().unwrap();
        assert_eq!(fit.attempts[fit.chosen].bytes, smallest);
    }

    #[test]
    fn the_encoder_is_told_which_pass_it_makes() {
        let mut seen = Vec::new();
        fit_size(2_000_000, 1_600_000, |index, _| {
            seen.push(index);
            Ok(1_000) // far under, whatever it is asked
        })
        .unwrap();
        assert_eq!(seen, [0, 1, 2]);
    }

    #[test]
    fn an_encoder_error_ends_the_fit() {
        let result = fit_size(2_000_000, 1_600_000, |_, _| Err("kaputt".to_string()));
        assert_eq!(result, Err("kaputt".to_string()));
    }

    #[test]
    fn identical_pictures_score_one() {
        let a: Vec<u8> = (0..64 * 48).map(|i| (i * 7 % 251) as u8).collect();
        assert!((ssim(&a, &a, 64, 48) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn noise_scores_lower_than_a_slight_shift_in_brightness() {
        let a: Vec<u8> = (0..64 * 48).map(|i| (i * 7 % 251) as u8).collect();
        let brighter: Vec<u8> = a.iter().map(|&p| p.saturating_add(2)).collect();
        let noisy: Vec<u8> = a
            .iter()
            .enumerate()
            .map(|(i, &p)| p.wrapping_add(((i * 31) % 41) as u8))
            .collect();
        let s_bright = ssim(&a, &brighter, 64, 48);
        let s_noisy = ssim(&a, &noisy, 64, 48);
        assert!(s_bright > 0.99, "{s_bright}");
        assert!(s_noisy < s_bright, "{s_noisy} >= {s_bright}");
    }

    #[test]
    fn samples_sit_inside_output_frames_and_inside_the_clip() {
        let times = sample_times(10.0, 30.0, 60.0);
        assert_eq!(times.len(), SSIM_SAMPLES);
        for t in &times {
            assert!(*t < 10.0);
            // Just after a 30 fps frame start, before the next 60 fps frame.
            let into_frame = t * 30.0 - (t * 30.0).floor();
            assert!(into_frame > 0.0 && into_frame < 0.5, "{t}");
        }
        assert!(times.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn supported_extensions_ignore_case() {
        assert!(is_supported(Path::new("clip.MOV")));
        assert!(is_supported(Path::new("clip.mp4")));
        assert!(is_supported(Path::new("clip.m4v")));
        assert!(!is_supported(Path::new("clip.avi")));
        assert!(!is_supported(Path::new("clip")));
    }
}
