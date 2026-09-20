//! File naming: context text → slug, and the running numbers per batch.

use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Slugs are cut at a word boundary once they exceed this many characters.
const MAX_SLUG_LEN: usize = 60;
/// Used when the context yields no usable characters at all.
const FALLBACK_SLUG: &str = "bild";

/// Turns free text into a file-name slug.
///
/// German umlauts are transliterated (ä→ae, ö→oe, ü→ue, ß→ss), other accents
/// are dropped (é→e), everything is lowercased, and any run of characters that
/// isn't a–z or 0–9 becomes a single hyphen.
pub fn slugify(input: &str) -> String {
    // NFC first so a decomposed "a + ◌̈" (e.g. pasted from a macOS file name)
    // is recognised as "ä" before the umlaut mapping runs.
    let mut mapped = String::with_capacity(input.len());
    for c in input.nfc() {
        match c {
            'ä' | 'Ä' => mapped.push_str("ae"),
            'ö' | 'Ö' => mapped.push_str("oe"),
            'ü' | 'Ü' => mapped.push_str("ue"),
            'ß' | 'ẞ' => mapped.push_str("ss"),
            'æ' | 'Æ' => mapped.push_str("ae"),
            'ø' | 'Ø' | 'œ' | 'Œ' => mapped.push_str("oe"),
            'ł' | 'Ł' => mapped.push('l'),
            'đ' | 'Đ' => mapped.push('d'),
            _ => mapped.push(c),
        }
    }

    let mut slug = String::with_capacity(mapped.len());
    let mut pending_hyphen = false;
    for c in mapped.nfkd().filter(|c| !is_combining_mark(*c)) {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            pending_hyphen = false;
            slug.push(c);
        } else {
            pending_hyphen = true;
        }
    }

    if slug.len() > MAX_SLUG_LEN {
        let cut = slug[..=MAX_SLUG_LEN]
            .rfind('-')
            .filter(|&i| i > 0)
            .unwrap_or(MAX_SLUG_LEN);
        slug.truncate(cut);
        while slug.ends_with('-') {
            slug.pop();
        }
    }

    if slug.is_empty() {
        FALLBACK_SLUG.to_string()
    } else {
        slug
    }
}

/// File stems (without ".webp") for a batch of `count` images.
///
/// A single image gets the bare slug; several get `slug-01`, `slug-02`, ….
/// Nothing is ever reused: if files for this slug already exist in the output
/// folder, numbering continues after the highest number found there (a bare
/// `slug.webp` counts as number 01).
pub fn plan_base_names<'a>(
    slug: &str,
    count: usize,
    existing_files: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    let mut highest: Option<u32> = None;
    for name in existing_files {
        let Some(stem) = name.strip_suffix(".webp") else {
            continue;
        };
        let number = if stem == slug {
            Some(1)
        } else {
            // slug-NN: only 2–3 digit numbers, so "foto" doesn't mistake
            // "foto-2024.webp" (slug "foto-2024") for number 2024.
            stem.strip_prefix(slug)
                .and_then(|rest| rest.strip_prefix('-'))
                .filter(|n| (2..=3).contains(&n.len()) && all_digits(n))
                .and_then(|n| n.parse().ok())
        };
        if let Some(n) = number {
            highest = Some(highest.map_or(n, |h: u32| h.max(n)));
        }
    }

    if count == 1 && highest.is_none() {
        return vec![slug.to_string()];
    }

    let first = highest.map_or(1, |h| h + 1);
    let last = first + count as u32 - 1;
    let digits = last.to_string().len().max(2);
    (first..=last)
        .map(|n| format!("{slug}-{n:0digits$}"))
        .collect()
}

/// True when a file name reads like a machine wrote it: `IMG_20260914_071304`,
/// `3615fd4d-9c11-4f0e-...`, plain counters. Such a name makes a useless folder
/// name, so the panel leaves the field empty and shows a placeholder instead.
pub fn looks_machine_generated(file_stem: &str) -> bool {
    let slug = slugify(file_stem);
    if slug == FALLBACK_SLUG {
        return true;
    }
    let tokens: Vec<&str> = slug.split('-').filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return true;
    }
    // Screenshots and camera exports: the prefix carries no meaning either.
    const MACHINE_PREFIXES: [&str; 9] = [
        "bildschirmfoto",
        "screenshot",
        "screen",
        "img",
        "dsc",
        "dscf",
        "dji",
        "gopr",
        "pxl",
    ];
    if MACHINE_PREFIXES.contains(&tokens[0]) && tokens[1..].iter().any(|t| all_digits(t)) {
        return true;
    }
    // Nothing but digits: a counter or a timestamp.
    if tokens.iter().all(|t| all_digits(t)) {
        return true;
    }
    // A hex run that long is an id, not a word.
    if tokens
        .iter()
        .any(|t| t.len() >= 12 && t.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return true;
    }
    // Two or more long number groups: date plus time, or an export counter.
    tokens
        .iter()
        .filter(|t| t.len() >= 6 && all_digits(t))
        .count()
        >= 2
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn umlauts_are_transliterated_not_stripped() {
        assert_eq!(
            slugify("Größte Brücke über den Fluss!"),
            "groesste-bruecke-ueber-den-fluss"
        );
        assert_eq!(slugify("ÄRGER Öl Übung"), "aerger-oel-uebung");
        assert_eq!(slugify("Straße"), "strasse");
        assert_eq!(slugify("GROẞ"), "gross");
    }

    #[test]
    fn decomposed_umlauts_are_handled() {
        // "Mädchen" with ä as a + combining diaeresis (NFD, as in macOS file names)
        assert_eq!(slugify("Ma\u{0308}dchen"), "maedchen");
    }

    #[test]
    fn other_accents_are_dropped() {
        assert_eq!(slugify("Café Crème à la carte"), "cafe-creme-a-la-carte");
        assert_eq!(slugify("Smørrebrød"), "smoerrebroed");
    }

    #[test]
    fn separators_collapse_and_trim() {
        assert_eq!(slugify("  Hallo,   Welt -- 2024!!  "), "hallo-welt-2024");
        assert_eq!(slugify("a_b.c/d"), "a-b-c-d");
        assert_eq!(slugify("Team & Büro (Köln)"), "team-buero-koeln");
    }

    #[test]
    fn empty_or_symbol_only_context_falls_back() {
        assert_eq!(slugify(""), "bild");
        assert_eq!(slugify("   "), "bild");
        assert_eq!(slugify("!!! 🎉 ???"), "bild");
    }

    #[test]
    fn long_slugs_are_cut_at_a_word_boundary() {
        let s = slugify(
            "Das ist ein ausgesprochen langer Kontext für ein Bild vom Sommerfest im Garten hinter dem Haus",
        );
        assert!(s.len() <= MAX_SLUG_LEN, "{s}");
        assert!(!s.ends_with('-'));
        assert_eq!(
            s,
            "das-ist-ein-ausgesprochen-langer-kontext-fuer-ein-bild-vom"
        );
        let one_word = slugify(&"x".repeat(100));
        assert_eq!(one_word.len(), MAX_SLUG_LEN);
    }

    #[test]
    fn machine_names_are_recognised() {
        assert!(looks_machine_generated("20260914_071304"));
        assert!(looks_machine_generated("hf-20260914-071304-3615fd4d-6b21"));
        assert!(looks_machine_generated("3615fd4d9c114f0e8a77"));
        assert!(looks_machine_generated("0042"));
        assert!(looks_machine_generated("Bildschirmfoto 2026-09-17 um 21.53.33"));
        assert!(looks_machine_generated("IMG_4471"));
        assert!(looks_machine_generated("DSC_0001"));
        assert!(looks_machine_generated("   "));
    }

    #[test]
    fn ordinary_names_are_kept() {
        assert!(!looks_machine_generated("Teppich Wohnzimmer Fromm"));
        assert!(!looks_machine_generated("Laden-2026"));
        assert!(!looks_machine_generated("Hausdecor Fromm 03"));
    }

    #[test]
    fn single_image_is_unnumbered() {
        assert_eq!(plan_base_names("hero", 1, []), vec!["hero"]);
    }

    #[test]
    fn multiple_images_are_numbered() {
        assert_eq!(
            plan_base_names("team", 3, []),
            vec!["team-01", "team-02", "team-03"]
        );
        let many = plan_base_names("x", 100, []);
        assert_eq!(many[0], "x-001");
        assert_eq!(many[99], "x-100");
    }

    #[test]
    fn numbering_continues_after_existing_files() {
        let existing = ["team-01.webp", "team-02.webp", "other-05.webp", "notes.txt"];
        assert_eq!(
            plan_base_names("team", 2, existing),
            vec!["team-03", "team-04"]
        );
        assert_eq!(plan_base_names("team", 1, existing), vec!["team-03"]);
    }

    #[test]
    fn existing_unnumbered_file_counts_as_01() {
        let existing = ["hero.webp"];
        assert_eq!(plan_base_names("hero", 1, existing), vec!["hero-02"]);
        assert_eq!(
            plan_base_names("hero", 2, existing),
            vec!["hero-02", "hero-03"]
        );
    }

    #[test]
    fn similar_slugs_do_not_interfere() {
        let existing = [
            "foto-2024.webp",
            "fotos-01.webp",
            "foto-01.jpg",
            "foto-x.webp",
        ];
        assert_eq!(plan_base_names("foto", 1, existing), vec!["foto"]);
    }
}
