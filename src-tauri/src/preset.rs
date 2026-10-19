//! The two output profiles, by name. No Tauri, no app state — just numbers.
//!
//! The panel sends width and size limit explicitly (its sliders can move them),
//! so these are the defaults behind `src/lib/presets.ts`; keep both in step.

use crate::pipeline::Settings;
use crate::sizes::Limits;
use crate::video::VideoSettings;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Preset {
    /// Name on the command line.
    pub name: &'static str,
    /// The longer side of the output, whichever that is.
    pub long_edge: u32,
    /// Pixel cap, in megapixels — keeps portrait photos from arriving at
    /// three times the pixel count of a landscape one.
    pub max_megapixels: f64,
    /// Size limit, in KB of 1000 bytes (like Finder).
    pub max_kb: u64,
    /// The emergency scaling never goes below this — the long edge of the
    /// next preset down.
    pub min_long_edge: u32,
}

pub const INHALTSBILD: Preset = Preset {
    name: "inhaltsbild",
    long_edge: 1600,
    max_megapixels: 1.8,
    max_kb: 260,
    min_long_edge: 1000,
};

pub const HERO: Preset = Preset {
    name: "hero",
    long_edge: 2400,
    max_megapixels: 3.5,
    max_kb: 500,
    min_long_edge: 1600,
};

pub const ALL: [Preset; 2] = [INHALTSBILD, HERO];

impl Preset {
    pub fn limits(&self) -> Limits {
        Limits {
            long_edge: self.long_edge,
            max_pixels: (self.max_megapixels * 1_000_000.0) as u64,
        }
    }

    pub fn settings(&self, overwrite: bool) -> Settings {
        Settings {
            limits: self.limits(),
            min_long_edge: self.min_long_edge,
            max_bytes: Some(self.max_kb * 1000),
            overwrite,
        }
    }
}

/// A video profile: the long edge as a ceiling and a size target. Frame rate
/// is not a setting — it is always capped at `video::MAX_FPS`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoPreset {
    pub name: &'static str,
    pub long_edge: u32,
    /// Size target, in KB of 1000 bytes (like Finder).
    pub max_kb: u64,
    /// Limit for the poster WebP — that of the image preset of the same
    /// name, so a poster weighs what any other picture there would.
    pub poster_kb: u64,
}

/// 4 MB, not 2: the usual advice for a hero clip is 2–5 MB, and measured on
/// a 17 s phone clip 2 MB gave SSIM 0,984, 4 MB 0,994. More does not rescue
/// a clip with film grain (0,841 at 2 MB, still 0,895 at 8 MB) — grain does
/// not compress, so that one is reported as soft instead.
pub const HERO_VIDEO: VideoPreset = VideoPreset {
    name: "hero",
    long_edge: 1920,
    max_kb: 4000,
    poster_kb: HERO.max_kb,
};

pub const INHALT_VIDEO: VideoPreset = VideoPreset {
    name: "inhaltsbild",
    long_edge: 1280,
    max_kb: 1000,
    poster_kb: INHALTSBILD.max_kb,
};

pub const ALL_VIDEO: [VideoPreset; 2] = [INHALT_VIDEO, HERO_VIDEO];

impl VideoPreset {
    pub fn settings(&self, overwrite: bool) -> VideoSettings {
        VideoSettings {
            long_edge: self.long_edge,
            max_bytes: self.max_kb * 1000,
            overwrite,
            poster_max_bytes: Some(self.poster_kb * 1000),
        }
    }
}

/// Same names as for images, so one `--preset` picks both.
pub fn video_by_name(name: &str) -> Option<VideoPreset> {
    let name = name.to_ascii_lowercase();
    if name == "content" {
        return Some(INHALT_VIDEO);
    }
    ALL_VIDEO.into_iter().find(|p| p.name == name)
}

/// `"content"` is the name the frontend uses for the same profile.
pub fn by_name(name: &str) -> Option<Preset> {
    let name = name.to_ascii_lowercase();
    if name == "content" {
        return Some(INHALTSBILD);
    }
    ALL.into_iter().find(|p| p.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_found_by_name() {
        assert_eq!(by_name("hero"), Some(HERO));
        assert_eq!(by_name("Inhaltsbild"), Some(INHALTSBILD));
        assert_eq!(by_name("content"), Some(INHALTSBILD));
        assert_eq!(by_name("gibtsnicht"), None);
    }

    #[test]
    fn settings_use_kb_of_1000_bytes_and_whole_pixels() {
        assert_eq!(HERO.settings(false).max_bytes, Some(500_000));
        assert_eq!(HERO.limits().long_edge, 2400);
        assert_eq!(HERO.limits().max_pixels, 3_500_000);
        assert_eq!(INHALTSBILD.limits().max_pixels, 1_800_000);
        assert_eq!(HERO.settings(false).min_long_edge, 1600);
        assert_eq!(INHALTSBILD.settings(false).min_long_edge, 1000);
        assert!(!HERO.settings(false).overwrite);
        assert!(HERO.settings(true).overwrite);
    }

    #[test]
    fn video_presets_share_the_image_names() {
        assert_eq!(video_by_name("hero"), Some(HERO_VIDEO));
        assert_eq!(video_by_name("content"), Some(INHALT_VIDEO));
        assert_eq!(video_by_name("Inhaltsbild"), Some(INHALT_VIDEO));
        assert_eq!(HERO_VIDEO.settings(false).max_bytes, 4_000_000);
        assert_eq!(INHALT_VIDEO.settings(false).long_edge, 1280);
    }
}
