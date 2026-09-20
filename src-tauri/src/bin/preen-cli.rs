//! Preen without the GUI: same conversion, callable from a shell.
//!
//!   preen-cli --preset hero --name testbild --out /tmp/preen-test a.jpg b.png
//!
//! A tool for checking the pipeline, not a product — it is not bundled into
//! the .app. Everything it does goes through `pipeline::convert`, exactly the
//! path the panel takes.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use preen_lib::pipeline::{self, BatchResult, ImageResult};
use preen_lib::preset::{self, Preset};

const USAGE: &str = "\
preen-cli — Bilder web-fertig als WebP, ohne GUI

  preen-cli [Optionen] <bild> [<bild> ...]

  --preset <name>   inhaltsbild (1600 px, 260 KB) oder hero (2400 px, 500 KB).
                    Vorgabe: inhaltsbild
  --name <text>     Zielname; wird zum Slug für Dateinamen und Unterordner
  --out <ordner>    Zielordner. Vorgabe: der Ordner des ersten Bildes
  --json            Ergebnis als JSON auf stdout, sonst nichts
  -h, --help        diese Hilfe

Mehrere Bilder landen in einem Unterordner <name>/, ein einzelnes direkt im
Zielordner. Exitcode 1, sobald mindestens eine Datei fehlschlägt.";

struct Args {
    preset: Preset,
    name: String,
    out: Option<PathBuf>,
    json: bool,
    images: Vec<PathBuf>,
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

    let settings = args.preset.settings();
    match pipeline::convert(
        &args.images,
        &args.name,
        args.out.as_deref(),
        &settings,
        |_, _| {},
    ) {
        Ok(result) => {
            let failed = result.images.iter().filter(|i| i.error.is_some()).count();
            if args.json {
                print_json(&args, &result, failed);
            } else {
                print_lines(&result);
            }
            if failed == 0 {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(message) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::json!({ "error": message, "images": [], "failed": 0 })
                );
            } else {
                eprintln!("Fehler: {message}");
            }
            ExitCode::FAILURE
        }
    }
}

/// `Ok(None)` means "--help was asked for".
fn parse(argv: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut preset = preset::INHALTSBILD;
    let mut name = String::new();
    let mut out = None;
    let mut json = false;
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
        return Err("keine Bilder angegeben".to_string());
    }
    if name.trim().is_empty() {
        return Err("--name fehlt".to_string());
    }
    Ok(Some(Args {
        preset,
        name,
        out,
        json,
        images,
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

fn print_json(args: &Args, result: &BatchResult, failed: usize) {
    let value = serde_json::json!({
        "preset": args.preset.name,
        "maxWidth": args.preset.max_width,
        "maxKb": args.preset.max_kb,
        "name": args.name,
        "outputDir": result.output_dir,
        "failed": failed,
        "images": &result.images as &Vec<ImageResult>,
    });
    println!("{}", serde_json::to_string_pretty(&value).unwrap());
}

fn short(source: &str) -> String {
    Path::new(source)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.to_string())
}
