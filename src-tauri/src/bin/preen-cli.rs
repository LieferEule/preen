//! Preen without the GUI: same conversion, callable from a shell.
//!
//!   preen-cli --preset hero --name testbild --out /tmp/preen-test a.jpg b.mov
//!
//! A tool for checking the pipeline, not a product — it is not bundled into
//! the .app. Everything it does goes through `pipeline::convert` and
//! `video::convert`, exactly the paths the panel takes.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use preen_lib::pipeline::{self, BatchResult, ImageResult};
use preen_lib::preset::{self, Preset, VideoPreset};
use preen_lib::video::{self, VideoBatchResult};

const USAGE: &str = "\
preen-cli — Bilder als WebP und Videos als MP4 web-fertig, ohne GUI

  preen-cli [Optionen] <datei> [<datei> ...]

  --preset <name>   inhaltsbild (Bild: lange Kante 1600, 1,8 MP, 260 KB;
                    Video: 1280, 1 MB) oder hero (Bild: 2400, 3,5 MP,
                    500 KB; Video: 1920, 4 MB). Vorgabe: inhaltsbild
  --name <text>     Zielname; wird zum Slug für Dateinamen und Unterordner
  --out <ordner>    Zielordner. Vorgabe: der Ordner des ersten Bildes
  --replace         bestehende Zieldateien ersetzen. Ohne das zählt ein
                    Lauf weiter: name-2.webp, name-3.webp
  --json            Ergebnis als JSON auf stdout, sonst nichts
  -h, --help        diese Hilfe

Videos (mp4, mov, m4v) werden H.264 ohne Ton, höchstens 30 fps, mit
Posterbild (.webp) und <video>-Schnipsel (.html) daneben. Mehrere Dateien
einer Art landen in einem Unterordner <name>/, eine einzelne direkt im
Zielordner. Exitcode 1, sobald mindestens eine Datei fehlschlägt.";

struct Args {
    preset: Preset,
    video_preset: VideoPreset,
    name: String,
    out: Option<PathBuf>,
    json: bool,
    overwrite: bool,
    images: Vec<PathBuf>,
    videos: Vec<PathBuf>,
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(Some(args)) => args,
        // --help
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("Fehler: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let images = (!args.images.is_empty()).then(|| {
        pipeline::convert(
            &args.images,
            &args.name,
            args.out.as_deref(),
            &args.preset.settings(args.overwrite),
            |_, _| {},
        )
    });
    let videos = (!args.videos.is_empty()).then(|| {
        video::convert(
            &args.videos,
            &args.name,
            args.out.as_deref(),
            &args.video_preset.settings(args.overwrite),
            |_, _| {},
        )
    });

    let failed = images.iter().map(|r| match r {
        Ok(b) => b.images.iter().filter(|i| i.error.is_some()).count(),
        Err(_) => args.images.len(),
    });
    let failed = failed.sum::<usize>()
        + videos
            .iter()
            .map(|r| match r {
                Ok(b) => b.videos.iter().filter(|v| v.error.is_some()).count(),
                Err(_) => args.videos.len(),
            })
            .sum::<usize>();

    if args.json {
        print_json(&args, images.as_ref(), videos.as_ref(), failed);
    } else {
        match &images {
            Some(Ok(result)) => print_lines(result),
            Some(Err(message)) => eprintln!("Fehler: {message}"),
            None => {}
        }
        match &videos {
            Some(Ok(result)) => print_video_lines(result),
            Some(Err(message)) => eprintln!("Fehler: {message}"),
            None => {}
        }
    }
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// `Ok(None)` means "--help was asked for".
fn parse(argv: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut preset = preset::INHALTSBILD;
    let mut video_preset = preset::INHALT_VIDEO;
    let mut name = String::new();
    let mut out = None;
    let mut json = false;
    let mut overwrite = false;
    let mut images = Vec::new();

    let mut argv = argv.peekable();
    while let Some(arg) = argv.next() {
        // Both "--preset hero" and "--preset=hero".
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (arg.clone(), None),
        };
        let mut value = |flag: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| argv.next())
                .ok_or_else(|| format!("{flag} braucht einen Wert"))
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--json" => json = true,
            "--replace" => overwrite = true,
            "--preset" => {
                let v = value("--preset")?;
                preset = preset::by_name(&v).ok_or_else(|| {
                    format!(
                        "unbekanntes Preset {v:?}; erlaubt: {}",
                        preset::ALL
                            .iter()
                            .map(|p| p.name)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
                video_preset =
                    preset::video_by_name(&v).expect("jedes Bild-Preset hat ein Video-Preset");
            }
            "--name" => name = value("--name")?,
            "--out" => out = Some(PathBuf::from(value("--out")?)),
            other if other.starts_with('-') && other != "-" => {
                return Err(format!("unbekannte Option {other:?}"))
            }
            _ => images.push(PathBuf::from(arg)),
        }
    }

    if images.is_empty() {
        return Err("keine Dateien angegeben".to_string());
    }
    // Videos by their extension; everything else — images, folders, and
    // what nothing can read — goes the image way and is reported there.
    let (videos, images): (Vec<PathBuf>, Vec<PathBuf>) =
        images.into_iter().partition(|p| video::is_supported(p));
    if name.trim().is_empty() {
        return Err("--name fehlt".to_string());
    }
    Ok(Some(Args {
        preset,
        video_preset,
        name,
        out,
        json,
        overwrite,
        images,
        videos,
    }))
}

/// One line per file: Quelldatei, Zielpfad, KB, Qualität, Status.
fn print_lines(result: &BatchResult) {
    println!("Zielordner: {}", result.output_dir);
    for image in &result.images {
        match (&image.output, &image.error) {
            (Some(o), _) => {
                let status = if o.limit_missed {
                    "Limit verfehlt"
                } else {
                    "ok"
                };
                println!(
                    "{}  ->  {}  {} KB  Q{}  {status}",
                    short(&image.source),
                    o.path,
                    o.bytes.div_ceil(1000),
                    o.quality,
                );
            }
            (None, Some(e)) => println!("{}  ->  —  —  —  Fehler: {e}", short(&image.source)),
            (None, None) => println!("{}  ->  —  —  —  Fehler: unbekannt", short(&image.source)),
        }
    }
}

fn print_json(
    args: &Args,
    images: Option<&Result<BatchResult, String>>,
    videos: Option<&Result<VideoBatchResult, String>>,
    failed: usize,
) {
    let mut value = serde_json::json!({
        "preset": args.preset.name,
        "longEdge": args.preset.long_edge,
        "maxMegapixels": args.preset.max_megapixels,
        "maxKb": args.preset.max_kb,
        "minLongEdge": args.preset.min_long_edge,
        "videoLongEdge": args.video_preset.long_edge,
        "videoMaxKb": args.video_preset.max_kb,
        "overwrite": args.overwrite,
        "name": args.name,
        "failed": failed,
        "images": [],
        "videos": [],
    });
    let mut errors = Vec::new();
    match images {
        Some(Ok(result)) => {
            value["outputDir"] = serde_json::json!(result.output_dir);
            value["images"] = serde_json::json!(&result.images as &Vec<ImageResult>);
        }
        Some(Err(message)) => errors.push(message.clone()),
        None => {}
    }
    match videos {
        Some(Ok(result)) => {
            value["videoOutputDir"] = serde_json::json!(result.output_dir);
            value["videos"] = serde_json::json!(result.videos);
        }
        Some(Err(message)) => errors.push(message.clone()),
        None => {}
    }
    if !errors.is_empty() {
        value["error"] = serde_json::json!(errors.join("; "));
    }
    println!("{}", serde_json::to_string_pretty(&value).unwrap());
}

/// One line per video: Quelle, Ziel, Größe gegen Ziel, Maße, SSIM, Status.
fn print_video_lines(result: &VideoBatchResult) {
    println!("Zielordner Videos: {}", result.output_dir);
    for v in &result.videos {
        match (&v.output, &v.error) {
            (Some(o), _) => {
                let mut status = Vec::new();
                if o.limit_missed {
                    status.push("Ziel verfehlt");
                }
                if o.soft {
                    status.push("weich");
                }
                if o.poster.is_none() {
                    status.push("ohne Poster");
                }
                let status = if status.is_empty() {
                    "ok".to_string()
                } else {
                    status.join(", ")
                };
                println!(
                    "{}  ->  {}  {} KB von {}  {}x{} {} fps  SSIM {}  {} Durchgänge  {status}",
                    short(&v.source),
                    o.path,
                    o.bytes.div_ceil(1000),
                    o.target_bytes.div_ceil(1000),
                    o.width,
                    o.height,
                    format_fps(o.fps),
                    o.ssim.map_or("—".to_string(), |s| format!("{s:.3}")),
                    o.attempts.len(),
                );
            }
            (None, Some(e)) => println!("{}  ->  —  Fehler: {e}", short(&v.source)),
            (None, None) => println!("{}  ->  —  Fehler: unbekannt", short(&v.source)),
        }
    }
}

fn format_fps(fps: f64) -> String {
    if (fps - fps.round()).abs() < 0.005 {
        format!("{}", fps.round())
    } else {
        format!("{fps:.2}")
    }
}

fn short(source: &str) -> String {
    Path::new(source)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.to_string())
}
