//! End-to-end: real clips in, MP4 files out, through the real hardware
//! encoder. Fixtures come from scripts/make-video-fixtures.sh.

use std::fs;
use std::path::{Path, PathBuf};

use preen_lib::avfoundation;
use preen_lib::video::{self, VideoBatchResult, VideoOutput, VideoSettings, SIZE_TOLERANCE};

/// 1600x900, 60 fps, 4 s, with a sound track.
const MOVING: &str = "bewegt-1600x900-60fps.mp4";
/// Stored 640x360, shown rotated by 90°; 30 fps, 2 s, ~90 KB.
const ROTATED: &str = "hochkant-gedreht.mp4";

const SMALL: VideoSettings = VideoSettings {
    long_edge: 1280,
    max_bytes: 400_000,
    overwrite: false,
};

fn fixture_copy(dir: &Path, name: &str) -> PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let to = dir.join(name);
    fs::copy(src, &to).unwrap();
    to
}

fn run(paths: &[PathBuf], slug: &str, settings: &VideoSettings) -> VideoBatchResult {
    let result = video::convert(paths, slug, None, settings, |_, _| {}).unwrap();
    for v in &result.videos {
        assert!(v.error.is_none(), "{}: {:?}", v.source, v.error);
    }
    result
}

fn only(result: &VideoBatchResult) -> &VideoOutput {
    assert_eq!(result.videos.len(), 1);
    result.videos[0].output.as_ref().unwrap()
}

/// Top-level MP4 boxes in file order.
fn top_level_boxes(bytes: &[u8]) -> Vec<String> {
    let mut kinds = Vec::new();
    let mut pos = 0;
    while pos + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        kinds.push(String::from_utf8_lossy(&bytes[pos + 4..pos + 8]).into_owned());
        let size = if size == 1 {
            u64::from_be_bytes(bytes[pos + 8..pos + 16].try_into().unwrap()) as usize
        } else {
            size
        };
        if size < 8 {
            break;
        }
        pos += size;
    }
    kinds
}

/// Width and height stored in the H.264 sample description — the pixels
/// themselves, not what a rotation would make of them.
fn coded_size(bytes: &[u8]) -> (u16, u16) {
    let at = bytes
        .windows(4)
        .position(|w| w == b"avc1")
        .expect("kein H.264");
    let field = |offset: usize| u16::from_be_bytes([bytes[at + offset], bytes[at + offset + 1]]);
    (field(28), field(30))
}

fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with(".preen"))
        .collect()
}

#[test]
fn shrinks_to_the_size_target_at_30_fps_without_sound() {
    let dir = tempfile::tempdir().unwrap();
    let source = fixture_copy(dir.path(), MOVING);
    let out = run(&[source], "testvideo", &SMALL);
    let file = only(&out);

    assert_eq!(file.file_name, "testvideo.mp4");
    assert_eq!((file.width, file.height), (1280, 720));
    assert_eq!(file.fps, 30.0);
    assert_eq!(file.target_bytes, 400_000);
    assert!(!file.limit_missed, "{:?}", file.attempts);
    assert!(
        file.bytes as f64 <= 400_000.0 * (1.0 + SIZE_TOLERANCE),
        "{} Bytes, Durchgänge {:?}",
        file.bytes,
        file.attempts
    );

    let written = Path::new(&file.path);
    assert_eq!(fs::metadata(written).unwrap().len(), file.bytes);
    let probe = avfoundation::probe(written).unwrap();
    assert_eq!((probe.width, probe.height), (1280, 720));
    assert!((probe.fps - 30.0).abs() < 0.5, "{} fps", probe.fps);
    assert!((probe.duration_seconds - 4.0).abs() < 0.1);
    assert!(!probe.has_audio, "Ton ist noch drin");

    let bytes = fs::read(written).unwrap();
    assert_eq!(coded_size(&bytes), (1280, 720));
    let boxes = top_level_boxes(&bytes);
    let moov = boxes.iter().position(|b| b == "moov").unwrap();
    let mdat = boxes.iter().position(|b| b == "mdat").unwrap();
    assert!(moov < mdat, "kein faststart: {boxes:?}");

    assert!(
        leftovers(dir.path()).is_empty(),
        "{:?}",
        leftovers(dir.path())
    );
}

#[test]
fn rotation_is_applied_to_the_pixels() {
    let dir = tempfile::tempdir().unwrap();
    let source = fixture_copy(dir.path(), ROTATED);
    let file = only(&run(&[source], "hochkant", &SMALL)).clone();
    assert_eq!((file.width, file.height), (360, 640));
    assert_eq!(coded_size(&fs::read(&file.path).unwrap()), (360, 640));
}

/// A clip already smaller than the target is not blown up to it.
#[test]
fn a_small_source_is_not_inflated_to_the_target() {
    let dir = tempfile::tempdir().unwrap();
    let source = fixture_copy(dir.path(), ROTATED);
    let source_bytes = fs::metadata(&source).unwrap().len();
    let file = only(&run(&[source], "klein", &SMALL)).clone();
    assert!(file.target_bytes < source_bytes, "{}", file.target_bytes);
    assert!(
        file.bytes as f64 <= source_bytes as f64 * (1.0 + SIZE_TOLERANCE),
        "{} Bytes aus {source_bytes}",
        file.bytes
    );
}

#[test]
fn nothing_is_overwritten_unless_asked() {
    let dir = tempfile::tempdir().unwrap();
    let source = fixture_copy(dir.path(), ROTATED);
    let first = only(&run(std::slice::from_ref(&source), "clip", &SMALL)).clone();
    let second = only(&run(std::slice::from_ref(&source), "clip", &SMALL)).clone();
    assert_eq!(first.file_name, "clip.mp4");
    assert_eq!(second.file_name, "clip-02.mp4");

    let replace = VideoSettings {
        overwrite: true,
        ..SMALL
    };
    let third = only(&run(&[source], "clip", &replace)).clone();
    assert_eq!(third.file_name, "clip.mp4");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn several_videos_go_into_a_subfolder() {
    let dir = tempfile::tempdir().unwrap();
    let a = fixture_copy(dir.path(), ROTATED);
    let b = dir.path().join("zweites.mov");
    fs::copy(&a, &b).unwrap();
    let out = run(&[a, b], "Sommer Clips", &SMALL);
    assert_eq!(Path::new(&out.output_dir), dir.path().join("sommer-clips"));
    let names: Vec<_> = out
        .videos
        .iter()
        .map(|v| v.output.as_ref().unwrap().file_name.clone())
        .collect();
    assert_eq!(names, ["sommer-clips-01.mp4", "sommer-clips-02.mp4"]);
}

#[test]
fn unreadable_files_fail_alone_and_leave_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let good = fixture_copy(dir.path(), ROTATED);
    let fake = dir.path().join("kein-video.mp4");
    fs::write(&fake, b"das ist kein Film").unwrap();
    let other = dir.path().join("notizen.txt");
    fs::write(&other, b"x").unwrap();

    let out = video::convert(&[fake, good, other], "gemischt", None, &SMALL, |_, _| {}).unwrap();
    let errors: Vec<_> = out.videos.iter().map(|v| v.error.clone()).collect();
    assert!(errors[0].is_some());
    assert!(errors[1].is_none(), "{:?}", errors[1]);
    assert_eq!(errors[2].as_deref(), Some("Format nicht unterstützt"));
    for e in errors.iter().flatten() {
        assert!(e.chars().count() <= 42, "zu lang fürs Panel: {e}");
    }
    assert!(leftovers(Path::new(&out.output_dir)).is_empty());
}
