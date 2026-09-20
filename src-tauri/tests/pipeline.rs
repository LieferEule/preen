//! End-to-end: real files in, WebP files out.
//! Fixtures come from scripts/make-fixtures.swift (flat red/blue halves).

use std::fs;
use std::path::{Path, PathBuf};

use preen_lib::imageio;
use preen_lib::pipeline::{self, BatchResult, OutputFile, Settings, QUALITY_FLOOR, QUALITY_START};
use preen_lib::sizes::Limits;
use sha2::{Digest, Sha256};

const FIXTURES: [&str; 8] = [
    "wide-16x9.jpg",     // 2000x1125
    "photo-4x3.png",     // 1000x750
    "tiny.jpg",          // 300x200
    "transparent.png",   // 900x600
    "rotated-exif6.jpg", // stored 1200x800, displayed 800x1200
    "iphone.heic",       // 4032x3024
    "scan.tiff",         // 3000x2000
    "hero-5000.jpg",     // 5000x2813
];

const CONTENT: Settings = Settings {
    limits: Limits {
        long_edge: 1600,
        max_pixels: 1_800_000,
    },
    min_long_edge: 1000,
    max_bytes: Some(260_000),
    overwrite: false,
};

/// Copies the fixtures into a fresh temp folder (so the default output
/// folder lands there) and returns their paths in FIXTURES order.
fn fixture_copies(dir: &Path) -> Vec<PathBuf> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    FIXTURES
        .iter()
        .map(|name| {
            let to = dir.join(name);
            fs::copy(src.join(name), &to).unwrap();
            to
        })
        .collect()
}

fn hashes(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|p| format!("{:x}", Sha256::digest(fs::read(p).unwrap())))
        .collect()
}

fn run(paths: &[PathBuf], slug: &str, settings: &Settings) -> BatchResult {
    let out = pipeline::resolve_output_dir(&paths[0], None, slug, paths.len());
    let result = pipeline::process_batch(paths, slug, &out, settings, |_, _| {}).unwrap();
    for image in &result.images {
        assert!(image.error.is_none(), "{}: {:?}", image.source, image.error);
    }
    result
}

fn outputs(result: &BatchResult) -> Vec<&OutputFile> {
    result
        .images
        .iter()
        .map(|i| i.output.as_ref().unwrap())
        .collect()
}

/// Whether a WebP file uses the lossy VP8 codec (not lossless VP8L).
fn chunk_kinds(bytes: &[u8]) -> (bool, bool) {
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WEBP");
    let (mut lossy, mut lossless) = (false, false);
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        lossy |= id == b"VP8 ";
        lossless |= id == b"VP8L";
        pos += 8 + size + (size & 1);
    }
    (lossy, lossless)
}

fn pixel(img: &webp::WebPImage, x: u32, y: u32) -> Vec<u8> {
    let bpp = if img.is_alpha() { 4 } else { 3 };
    let i = ((y * img.width() + x) * bpp) as usize;
    img[i..i + bpp as usize].to_vec()
}

fn decode(path: &str) -> webp::WebPImage {
    webp::Decoder::new(&fs::read(path).unwrap())
        .decode()
        .unwrap()
}

fn is_red(p: &[u8]) -> bool {
    p[0] > 200 && p[1] < 50 && p[2] < 50
}
fn is_blue(p: &[u8]) -> bool {
    p[0] < 50 && p[1] < 50 && p[2] > 200
}

#[test]
fn one_image_in_one_lossy_webp_out() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = fixture_copies(tmp.path());
    let before = hashes(&paths);

    let result = run(&paths, "Größte Brücke über den Fluss", &CONTENT);

    // Several images go into a folder named after the slug, next to the originals.
    let slug = "groesste-bruecke-ueber-den-fluss";
    let folder = tmp.path().join(slug);
    assert_eq!(Path::new(&result.output_dir), folder);

    let files = outputs(&result);
    let names: Vec<&str> = files.iter().map(|o| o.file_name.as_str()).collect();
    assert_eq!(
        names,
        (1..=8)
            .map(|n| format!("{slug}-0{n}.webp"))
            .collect::<Vec<_>>()
    );

    // Scaled down to a long edge of 1600 keeping the aspect ratio, then under
    // the 1,8-MP cap; smaller ones untouched.
    let dims: Vec<(u32, u32)> = files.iter().map(|o| (o.width, o.height)).collect();
    assert_eq!(
        dims,
        [
            (1600, 900),  // 16:9
            (1000, 750),  // not upscaled
            (300, 200),   // not upscaled
            (900, 600),   // not upscaled
            (800, 1200),  // EXIF-rotated portrait, not upscaled
            (1549, 1162), // HEIC 4:3: 1600x1200 waeren 1,92 MP, der Deckel zieht nach
            (1600, 1067), // TIFF 3:2
            (1600, 900),  // 5000x2813
        ]
    );

    for out in &files {
        let bytes = fs::read(&out.path).unwrap();
        assert_eq!(bytes.len() as u64, out.bytes);
        let (lossy, lossless) = chunk_kinds(&bytes);
        assert!(lossy && !lossless, "{} is not lossy VP8", out.file_name);
        let img = webp::Decoder::new(&bytes).decode().unwrap();
        assert_eq!((img.width(), img.height()), (out.width, out.height));
        // Flat test images are tiny, so the limit never kicks in.
        assert_eq!(out.quality, QUALITY_START);
        assert!(!out.limit_missed);
    }

    // Exactly one file per image, all inside the slug folder.
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 8);
    // Originals are byte-for-byte unchanged; only the slug folder was added.
    assert_eq!(hashes(&paths), before);
    assert_eq!(
        fs::read_dir(tmp.path()).unwrap().count(),
        FIXTURES.len() + 1
    );
}

#[test]
fn single_image_lands_directly_in_target_without_subfolder() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = vec![fixture_copies(tmp.path()).swap_remove(0)];
    let result = run(&paths, "Hausdecor Fromm", &CONTENT);
    assert_eq!(Path::new(&result.output_dir), tmp.path());
    assert_eq!(outputs(&result)[0].file_name, "hausdecor-fromm.webp");
    assert!(tmp.path().join("hausdecor-fromm.webp").is_file());
    assert!(!tmp.path().join("hausdecor-fromm").exists());
    // Next to the originals, which stay untouched: 8 fixtures + 1 WebP.
    assert_eq!(
        fs::read_dir(tmp.path()).unwrap().count(),
        FIXTURES.len() + 1
    );

    // A second single image with the same name doesn't overwrite it.
    let again = run(&paths, "Hausdecor Fromm", &CONTENT);
    assert_eq!(outputs(&again)[0].file_name, "hausdecor-fromm-02.webp");
}

#[test]
fn max_width_is_respected_and_never_upscales() {
    let tmp = tempfile::tempdir().unwrap();
    let all = fixture_copies(tmp.path());
    let paths = vec![all[7].clone(), all[0].clone(), all[1].clone()]; // 5000, 2000, 1000
    let hero = Settings {
        limits: Limits::long_edge_only(3200),
        min_long_edge: 0,
        max_bytes: Some(500_000),
        overwrite: false,
    };
    let dims: Vec<(u32, u32)> = outputs(&run(&paths, "hero", &hero))
        .iter()
        .map(|o| (o.width, o.height))
        .collect();
    assert_eq!(dims, [(3200, 1800), (2000, 1125), (1000, 750)]);

    let thumb = Settings {
        limits: Limits::long_edge_only(800),
        min_long_edge: 0,
        max_bytes: Some(100_000),
        overwrite: false,
    };
    let dims: Vec<(u32, u32)> = outputs(&run(&paths, "thumb", &thumb))
        .iter()
        .map(|o| (o.width, o.height))
        .collect();
    assert_eq!(dims, [(800, 450), (800, 450), (800, 600)]);
}

#[test]
fn exif_orientation_is_applied() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rotated-exif6.jpg");
    // Stored 1200x800 landscape, displayed as 800x1200 portrait.
    assert_eq!(imageio::dimensions(&path).unwrap(), (800, 1200));

    let tmp = tempfile::tempdir().unwrap();
    let paths = vec![fixture_copies(tmp.path()).swap_remove(4)];
    let result = run(&paths, "gedreht", &CONTENT);
    let img = decode(&outputs(&result)[0].path);
    assert_eq!((img.width(), img.height()), (800, 1200));
    // Red was on top in storage → on the right after a 90° clockwise turn.
    assert!(is_blue(&pixel(&img, 100, 600)), "left should be blue");
    assert!(is_red(&pixel(&img, 700, 600)), "right should be red");
}

#[test]
fn content_is_not_flipped_and_heic_decodes() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = vec![fixture_copies(tmp.path()).swap_remove(5)]; // iphone.heic
    let result = run(&paths, "iPhone", &CONTENT);
    let img = decode(&outputs(&result)[0].path); // 1600x1200
    assert!(!img.is_alpha(), "opaque images are stored without alpha");
    assert!(is_red(&pixel(&img, 800, 200)), "top should be red");
    assert!(is_blue(&pixel(&img, 800, 1000)), "bottom should be blue");
}

#[test]
fn transparency_is_preserved() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = vec![fixture_copies(tmp.path()).swap_remove(3)]; // transparent.png
    let result = run(&paths, "Logo", &CONTENT);
    let img = decode(&outputs(&result)[0].path); // 900x600
    assert!(img.is_alpha());
    assert_eq!(pixel(&img, 100, 300)[3], 0, "left half transparent");
    let right = pixel(&img, 800, 300);
    assert_eq!(right[3], 255, "right half opaque");
    assert!(is_red(&right), "right half keeps its colour: {right:?}");
}

#[test]
fn second_run_continues_numbering_and_never_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    let all = fixture_copies(tmp.path());
    let two = vec![all[2].clone(), all[2].clone()];
    let first = run(&two, "Test", &CONTENT);
    let first_path = outputs(&first)[0].path.clone();
    let first_bytes = fs::read(&first_path).unwrap();
    let modified = fs::metadata(&first_path).unwrap().modified().unwrap();

    let second = run(&two, "Test", &CONTENT);
    let names: Vec<&str> = outputs(&second)
        .iter()
        .map(|o| o.file_name.as_str())
        .collect();
    assert_eq!(names, ["test-03.webp", "test-04.webp"]);

    assert_eq!(fs::read(&first_path).unwrap(), first_bytes);
    assert_eq!(
        fs::metadata(&first_path).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(fs::read_dir(tmp.path().join("test")).unwrap().count(), 4);
}

#[test]
fn custom_output_dir_subfolder_only_for_several_images() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let all = fixture_copies(tmp.path());

    let one = vec![all[2].clone()];
    let out = pipeline::resolve_output_dir(&one[0], Some(target.path()), "Mein Projekt", 1);
    assert_eq!(out, target.path());
    let result = pipeline::process_batch(&one, "Mein Projekt", &out, &CONTENT, |_, _| {}).unwrap();
    assert_eq!(
        Path::new(&outputs(&result)[0].path),
        target.path().join("mein-projekt.webp")
    );

    let two = vec![all[2].clone(), all[1].clone()];
    let out = pipeline::resolve_output_dir(&two[0], Some(target.path()), "Mein Projekt", 2);
    assert_eq!(out, target.path().join("mein-projekt"));
    let result = pipeline::process_batch(&two, "Mein Projekt", &out, &CONTENT, |_, _| {}).unwrap();
    let names: Vec<&str> = outputs(&result)
        .iter()
        .map(|o| o.file_name.as_str())
        .collect();
    assert_eq!(names, ["mein-projekt-01.webp", "mein-projekt-02.webp"]);
    assert!(target
        .path()
        .join("mein-projekt/mein-projekt-01.webp")
        .is_file());

    // Nothing next to the originals.
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), FIXTURES.len());
}

#[test]
fn unreadable_file_fails_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let mut paths = fixture_copies(tmp.path());
    let broken = tmp.path().join("kaputt.jpg");
    fs::write(&broken, b"not an image").unwrap();
    paths.truncate(1);
    paths.push(broken);
    let out = pipeline::resolve_output_dir(&paths[0], None, "mix", paths.len());
    let result = pipeline::process_batch(&paths, "mix", &out, &CONTENT, |_, _| {}).unwrap();
    assert!(result.images[0].output.is_some());
    assert!(result.images[1].output.is_none());
    assert!(result.images[1].error.is_some());
}

/// Photo-like detail that doesn't compress well: smooth gradients plus
/// deterministic noise. Premultiplied RGBA, opaque.
fn detailed_pixels(width: u32, height: u32) -> Vec<u8> {
    let mut seed: u32 = 0x1234_5678;
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 24) as i32 - 128;
            let base = [
                x * 255 / width,
                y * 255 / height,
                (x + y) * 255 / (width + height),
            ];
            for c in base {
                pixels.push((c as i32 + noise / 2).clamp(0, 255) as u8);
            }
            pixels.push(255);
        }
    }
    pixels
}

#[test]
fn size_limit_lowers_quality_by_bisection_down_to_60() {
    let (w, h) = (1200, 800);
    let px = detailed_pixels(w, h);
    let encode =
        |limit: Option<u64>| pipeline::encode_within_limit(px.clone(), w, h, false, limit).unwrap();

    // No limit: always quality 80.
    let free = encode(None);
    assert_eq!((free.quality, free.limit_missed), (QUALITY_START, false));

    // Limit unreachable: quality 60 is used anyway and flagged.
    let floor = encode(Some(1));
    assert_eq!((floor.quality, floor.limit_missed), (QUALITY_FLOOR, true));
    let (s80, s60) = (free.data.len() as u64, floor.data.len() as u64);
    assert!(s60 < s80, "q60 {s60} should be smaller than q80 {s80}");

    // Limit that 80 already meets: untouched.
    let roomy = encode(Some(s80));
    assert_eq!((roomy.quality, roomy.limit_missed), (QUALITY_START, false));

    // Limit between q60 and q80: a quality in between that fits.
    let limit = (s60 + s80) / 2;
    let mid = encode(Some(limit));
    assert!(!mid.limit_missed);
    assert!(
        mid.quality > QUALITY_FLOOR && mid.quality < QUALITY_START,
        "{}",
        mid.quality
    );
    assert!(mid.data.len() as u64 <= limit);
    // It's the highest quality that fits: one step up would not.
    let above = webp::Encoder::from_rgb(
        &px.chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect::<Vec<_>>(),
        w,
        h,
    )
    .encode((mid.quality + 1) as f32);
    assert!(above.len() as u64 > limit);

    // Limit exactly at q60's size: fits at 60 without being flagged.
    let tight = encode(Some(s60));
    assert!(!tight.limit_missed);
    assert!(tight.data.len() as u64 <= s60);
}

/// A detailed WebP on disk — both a source the decoder has to handle and the
/// only fixture that does not compress away to nothing.
fn detailed_webp(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let rgb: Vec<u8> = detailed_pixels(w, h)
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let data = webp::Encoder::from_rgb(&rgb, w, h).encode(100.0);
    let path = dir.join(name);
    fs::write(&path, &*data).unwrap();
    path
}

#[test]
fn webp_is_accepted_as_a_source() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "vorlage.webp", 2000, 1000);
    assert!(pipeline::is_supported(&source));

    let settings = Settings {
        limits: Limits::long_edge_only(800),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };
    let result = run(&[source], "aus-webp", &settings);
    let files = outputs(&result);
    assert_eq!(files.len(), 1, "{:?}", result.images[0].error);
    assert_eq!((files[0].width, files[0].height), (800, 400));
    assert_eq!(files[0].quality, QUALITY_START);
    assert!(!files[0].emergency_scaled);
}

#[test]
fn emergency_scaling_shrinks_when_the_quality_floor_is_not_enough() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "dicht.webp", 1200, 800);
    let at = |limit: Option<u64>, slug: &str| {
        let settings = Settings {
            limits: Limits::long_edge_only(1200),
            min_long_edge: 0,
            max_bytes: limit,
            overwrite: false,
        };
        let result = run(std::slice::from_ref(&source), slug, &settings);
        outputs(&result)[0].clone()
    };

    // Reference: no limit, full size.
    let free = at(None, "frei");
    assert_eq!((free.width, free.height), (1200, 800));

    // Just under what quality 60 manages at full size — so the floor is
    // reached, and only fewer pixels can still get under the limit.
    let floor_full =
        pipeline::encode_within_limit(detailed_pixels(1200, 800), 1200, 800, false, Some(1))
            .unwrap();
    let limit = floor_full.data.len() as u64 * 9 / 10;

    let tight = at(Some(limit), "eng");
    assert!(!tight.limit_missed, "{tight:?}");
    assert!(tight.bytes <= limit, "{tight:?}");
    assert!(tight.width < 1200 && tight.height < 800, "{tight:?}");
    assert!(tight.emergency_scaled);
    assert_eq!(tight.width * 800, tight.height * 1200, "Seitenverhältnis");
    assert!(tight.quality >= QUALITY_FLOOR);

    // Hopeless: exactly three steps of 10 %, then written as it is and flagged.
    let hopeless = at(Some(1), "aussichtslos");
    assert_eq!((hopeless.width, hopeless.height), (875, 583));
    assert_eq!(hopeless.quality, QUALITY_FLOOR);
    assert!(hopeless.limit_missed);
}

#[test]
fn emergency_scaling_stops_at_the_next_preset_down() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "dicht.webp", 1200, 800);
    let settings = Settings {
        limits: Limits::long_edge_only(1200),
        // Wie hero: nie unter die lange Kante des Inhaltsbildes.
        min_long_edge: 1000,
        max_bytes: Some(1),
        overwrite: false,
    };
    let out = outputs(&run(std::slice::from_ref(&source), "boden", &settings))[0].clone();

    // Ohne Untergrenze wären es drei Schritte auf 875 px. Der erste Schritt
    // auf 1080 ist erlaubt, der zweite würde unter 1000 fallen und wird auf
    // 1000 gekappt; danach ist Schluss.
    assert_eq!((out.width, out.height), (1000, 667), "{out:?}");
    assert!(out.limit_missed);
    assert!(out.emergency_scaled);
    assert_eq!(out.quality, QUALITY_FLOOR);
}

#[test]
fn a_source_already_below_the_floor_is_not_shrunk_further() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "klein.webp", 900, 600);
    let settings = Settings {
        limits: Limits::long_edge_only(1200),
        min_long_edge: 1000,
        max_bytes: Some(1),
        overwrite: false,
    };
    let out = outputs(&run(std::slice::from_ref(&source), "klein", &settings))[0].clone();
    assert_eq!((out.width, out.height), (900, 600), "{out:?}");
    assert!(out.limit_missed);
    assert!(
        !out.emergency_scaled,
        "unter der Untergrenze wird nicht skaliert"
    );
}

#[test]
fn an_occupied_name_counts_up_instead_of_overwriting() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "quelle.webp", 400, 300);
    let out = tmp.path().join("ziel");
    fs::create_dir(&out).unwrap();
    // Von Hand belegt, mit Inhalt, der nicht verloren gehen darf.
    fs::write(out.join("bild.webp"), b"fremd").unwrap();
    let settings = Settings {
        limits: Limits::long_edge_only(400),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };

    let first = pipeline::convert(
        std::slice::from_ref(&source),
        "bild",
        Some(&out),
        &settings,
        |_, _| {},
    )
    .unwrap();
    let written = first.images[0].output.as_ref().unwrap();
    assert_eq!(written.file_name, "bild-02.webp");
    // Der Name in der Ergebniszeile ist der, der wirklich auf der Platte steht.
    assert!(Path::new(&written.path).is_file());
    assert_eq!(fs::read(out.join("bild.webp")).unwrap(), b"fremd");

    // Noch einmal: zählt weiter, statt den eigenen Lauf zu fressen.
    let second = pipeline::convert(
        std::slice::from_ref(&source),
        "bild",
        Some(&out),
        &settings,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(
        second.images[0].output.as_ref().unwrap().file_name,
        "bild-03.webp"
    );
}

#[test]
fn replacing_is_only_done_when_it_is_asked_for() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "quelle.webp", 400, 300);
    let out = tmp.path().join("ziel");
    fs::create_dir(&out).unwrap();
    fs::write(out.join("bild.webp"), b"fremd").unwrap();
    let settings = Settings {
        limits: Limits::long_edge_only(400),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: true,
    };

    let result = pipeline::convert(
        std::slice::from_ref(&source),
        "bild",
        Some(&out),
        &settings,
        |_, _| {},
    )
    .unwrap();
    let written = result.images[0].output.as_ref().unwrap();
    assert_eq!(written.file_name, "bild.webp");
    assert!(fs::read(out.join("bild.webp")).unwrap().len() > 5);
    assert_eq!(fs::read_dir(&out).unwrap().count(), 1, "kein zweiter Name");
}

#[test]
fn a_folder_hands_over_the_images_one_level_down() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("urlaub");
    let deeper = folder.join("rohdaten");
    fs::create_dir_all(&deeper).unwrap();
    detailed_webp(&folder, "a.webp", 40, 30);
    detailed_webp(&folder, "b.webp", 40, 30);
    detailed_webp(&deeper, "zu-tief.webp", 40, 30);
    fs::write(folder.join("notizen.txt"), b"kein Bild").unwrap();

    let found = pipeline::expand_inputs(std::slice::from_ref(&folder));
    let names: Vec<String> = found
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["a.webp", "b.webp"], "eine Ebene, sortiert");

    // Datei und Ordner gemischt, und die Datei bleibt, wo sie war.
    let single = folder.join("a.webp");
    let mixed = pipeline::expand_inputs(&[single.clone(), deeper.clone()]);
    assert_eq!(mixed, [single, deeper.join("zu-tief.webp")]);

    // Ein Ordner ohne Bilder verschwindet nicht stillschweigend, sondern
    // bleibt stehen und wird später als Fehlschlag gemeldet.
    let empty = tmp.path().join("leer");
    fs::create_dir(&empty).unwrap();
    assert_eq!(
        pipeline::expand_inputs(std::slice::from_ref(&empty)),
        vec![empty.clone()]
    );

    let settings = Settings {
        limits: Limits::long_edge_only(120),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };
    let result = pipeline::convert(
        std::slice::from_ref(&empty),
        "leer",
        Some(&tmp.path().join("ziel")),
        &settings,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(
        result.images[0].error.as_deref(),
        Some("Ordner ohne Bilder")
    );
}

#[test]
fn a_broken_file_fails_alone_and_the_batch_finishes() {
    let tmp = tempfile::tempdir().unwrap();
    let good = detailed_webp(tmp.path(), "gut.webp", 200, 150);
    let broken = tmp.path().join("kaputt.jpg");
    fs::write(&broken, b"das ist kein JPEG").unwrap();
    let wrong_format = tmp.path().join("notizen.txt");
    fs::write(&wrong_format, b"Text").unwrap();
    let missing = tmp.path().join("weg.png");
    let settings = Settings {
        limits: Limits::long_edge_only(200),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };

    let result = pipeline::convert(
        &[good, broken, wrong_format, missing],
        "teilerfolg",
        Some(&tmp.path().join("ziel")),
        &settings,
        |_, _| {},
    )
    .unwrap();

    assert_eq!(result.images.len(), 4);
    assert!(result.images[0].output.is_some(), "{:?}", result.images[0]);
    for failed in &result.images[1..] {
        assert!(failed.output.is_none());
        assert!(failed.error.is_some(), "{failed:?}");
    }
    // Was fertig ist, bleibt liegen.
    assert!(Path::new(&result.images[0].output.as_ref().unwrap().path).is_file());
}

#[test]
fn an_unwritable_target_stops_the_run_once_and_not_per_image() {
    let tmp = tempfile::tempdir().unwrap();
    let source = detailed_webp(tmp.path(), "quelle.webp", 200, 150);
    let locked = tmp.path().join("gesperrt");
    fs::create_dir(&locked).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();

    let settings = Settings {
        limits: Limits::long_edge_only(200),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };
    let error = pipeline::convert(
        std::slice::from_ref(&source),
        "geht-nicht",
        Some(&locked),
        &settings,
        |_, _| {},
    )
    .unwrap_err();
    assert!(error.contains("nicht beschreibbar"), "{error}");

    // Wieder freigeben, damit das temporäre Verzeichnis aufräumen kann.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn the_counter_has_one_shape_for_batches_and_for_collisions() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("ziel");
    fs::create_dir(&out).unwrap();
    let sources: Vec<PathBuf> = (1..=3)
        .map(|n| detailed_webp(tmp.path(), &format!("q{n}.webp"), 120, 90))
        .collect();
    let settings = Settings {
        limits: Limits::long_edge_only(120),
        min_long_edge: 0,
        max_bytes: None,
        overwrite: false,
    };
    let run_here = |paths: &[PathBuf]| {
        let result = pipeline::convert(paths, "reihe", Some(&out), &settings, |_, _| {}).unwrap();
        outputs(&result)
            .iter()
            .map(|o| o.file_name.clone())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        run_here(&sources),
        ["reihe-01.webp", "reihe-02.webp", "reihe-03.webp"]
    );
    // Der zweite Lauf zählt in derselben Form weiter, nicht in einer zweiten.
    assert_eq!(run_here(&sources[..2]), ["reihe-04.webp", "reihe-05.webp"]);
    // Mehrere Bilder bekommen den Unterordner; dort liegen jetzt fünf Dateien
    // und keine ist überschrieben worden.
    assert_eq!(fs::read_dir(out.join("reihe")).unwrap().count(), 5);
}
