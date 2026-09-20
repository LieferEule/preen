//! The two output profiles, by name. No Tauri, no app state — just numbers.
//!
//! The panel sends width and size limit explicitly (its sliders can move them),
//! so these are the defaults behind `src/lib/presets.ts`; keep both in step.

use crate::pipeline::Settings;
use crate::sizes::Limits;

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
}
