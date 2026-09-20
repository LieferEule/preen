//! The two output profiles, by name. No Tauri, no app state — just numbers.
//!
//! The panel sends width and size limit explicitly (its sliders can move them),
//! so these are the defaults behind `src/lib/presets.ts`; keep both in step.

use crate::pipeline::Settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    /// Name on the command line.
    pub name: &'static str,
    /// Wider originals are scaled down to this width.
    pub max_width: u32,
    /// Size limit, in KB of 1000 bytes (like Finder).
    pub max_kb: u64,
}

pub const INHALTSBILD: Preset = Preset {
    name: "inhaltsbild",
    max_width: 1600,
    max_kb: 260,
};

pub const HERO: Preset = Preset {
    name: "hero",
    max_width: 2400,
    max_kb: 500,
};

pub const ALL: [Preset; 2] = [INHALTSBILD, HERO];

impl Preset {
    pub fn settings(&self) -> Settings {
        Settings {
            max_width: self.max_width,
            max_bytes: Some(self.max_kb * 1000),
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
    fn settings_use_kb_of_1000_bytes() {
        assert_eq!(HERO.settings().max_bytes, Some(500_000));
        assert_eq!(INHALTSBILD.settings().max_width, 1600);
    }
}
