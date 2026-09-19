//! Manual check with real photos (ignored by default):
//! PREEN_SAMPLES="a.heic:b.jpg" PREEN_WIDTH=1600 PREEN_KB=260 \
//!   cargo test --release --test real_photos -- --ignored --nocapture

use std::path::PathBuf;
use std::time::Instant;

use preen_lib::pipeline::{self, Settings};

#[test]
#[ignore]
fn real_photos() {
    let samples: Vec<PathBuf> = std::env::var("PREEN_SAMPLES")
        .expect("set PREEN_SAMPLES")
        .split(':')
        .map(PathBuf::from)
        .collect();
    let max_width: u32 = std::env::var("PREEN_WIDTH").map_or(1600, |v| v.parse().unwrap());
    let max_kb: Option<u64> = std::env::var("PREEN_KB").ok().map(|v| v.parse().unwrap());
    let settings = Settings {
        max_width,
        max_bytes: max_kb.map(|kb| kb * 1000),
    };
    println!("max. {max_width} px, {max_kb:?} KB");

    let out = tempfile::tempdir().unwrap();
    let start = Instant::now();
    let result =
        pipeline::process_batch(&samples, "Echte Fotos", out.path(), &settings, |_, _| {}).unwrap();
    println!("{} Bilder in {:.1?}", samples.len(), start.elapsed());
    for (src, img) in samples.iter().zip(&result.images) {
        let original = std::fs::metadata(src).unwrap().len();
        println!("{} ({} KB) {:?}", src.display(), original / 1000, img.error);
        if let Some(o) = &img.output {
            let missed = if o.limit_missed {
                "  Ziel verfehlt"
            } else {
                ""
            };
            println!(
                "  {:<22} {:>5}x{:<5} {:>4} KB  Q{}{missed}",
                o.file_name,
                o.width,
                o.height,
                o.bytes / 1000,
                o.quality
            );
        }
    }
}
