//! Output dimensions.

/// What an output image may be at most.
///
/// Two values, because one is not enough: a width limit alone lets a portrait
/// photo through at 2400 × 3200 — 7,7 MP, three times a 16:9 hero — and no
/// quality setting rescues that file size afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The longer of the two sides, whichever that is.
    pub long_edge: u32,
    /// Upper bound on width × height.
    pub max_pixels: u64,
}

impl Limits {
    /// No pixel cap — the long edge is the only limit.
    pub fn long_edge_only(long_edge: u32) -> Self {
        Self {
            long_edge,
            max_pixels: u64::MAX,
        }
    }
}

/// Output (width, height) for an original of `width`×`height`.
///
/// Scaled down so the longer side is at most `limits.long_edge`, then — if the
/// result still has more than `limits.max_pixels` pixels — proportionally
/// further down until it fits. Aspect ratio is kept, nothing is ever upscaled.
pub fn output_size(width: u32, height: u32, limits: Limits) -> (u32, u32) {
    let (width, height) = fit_long_edge(width, height, limits.long_edge);
    fit_pixels(width, height, limits.max_pixels)
}

fn fit_long_edge(width: u32, height: u32, long_edge: u32) -> (u32, u32) {
    if width.max(height) <= long_edge {
        return (width, height);
    }
    if width >= height {
        (long_edge, scale(height, long_edge, width))
    } else {
        (scale(width, long_edge, height), long_edge)
    }
}

fn fit_pixels(width: u32, height: u32, max_pixels: u64) -> (u32, u32) {
    if width as u64 * height as u64 <= max_pixels {
        return (width, height);
    }
    // Both sides shrink by √(max / actual). Rounding can land a pixel or two
    // over the cap, so step the long side down until it really fits.
    let factor = (max_pixels as f64 / (width as f64 * height as f64)).sqrt();
    let (mut w, mut h) = (
        ((width as f64 * factor).round() as u32).max(1),
        ((height as f64 * factor).round() as u32).max(1),
    );
    while w as u64 * h as u64 > max_pixels && (w > 1 && h > 1) {
        if w >= h {
            w -= 1;
            h = scale(height, w, width);
        } else {
            h -= 1;
            w = scale(width, h, height);
        }
    }
    (w, h)
}

/// `side` scaled by `to`/`from`, rounded, at least 1 — keeps the aspect ratio.
fn scale(side: u32, to: u32, from: u32) -> u32 {
    let (side, to, from) = (side as u64, to as u64, from as u64);
    ((side * to + from / 2) / from).max(1) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3.5 MP at long edge 2400 (hero) and 1.8 MP at 1600 (inhaltsbild).
    const HERO: Limits = Limits {
        long_edge: 2400,
        max_pixels: 3_500_000,
    };
    const CONTENT: Limits = Limits {
        long_edge: 1600,
        max_pixels: 1_800_000,
    };

    fn within(limits: Limits, size: (u32, u32)) -> bool {
        size.0.max(size.1) <= limits.long_edge && size.0 as u64 * size.1 as u64 <= limits.max_pixels
    }

    #[test]
    fn scales_down_to_long_edge_keeping_aspect_ratio() {
        let wide = Limits::long_edge_only(1600);
        assert_eq!(output_size(3840, 2160, wide), (1600, 900)); // 16:9
        assert_eq!(
            output_size(4032, 3024, Limits::long_edge_only(800)),
            (800, 600)
        );
        assert_eq!(
            output_size(5000, 2813, Limits::long_edge_only(2400)),
            (2400, 1350)
        );
    }

    /// The whole point of the long edge: portrait is measured on its height.
    #[test]
    fn long_edge_is_the_longer_side_not_the_width() {
        let limits = Limits::long_edge_only(1600);
        assert_eq!(output_size(3024, 4032, limits), (1200, 1600));
        assert_eq!(output_size(4032, 3024, limits), (1600, 1200));
    }

    #[test]
    fn never_upscales() {
        assert_eq!(output_size(1000, 750, CONTENT), (1000, 750));
        assert_eq!(output_size(300, 200, CONTENT), (300, 200));
        assert_eq!(output_size(1600, 900, CONTENT), (1600, 900));
    }

    #[test]
    fn pixel_cap_pulls_portrait_down_below_the_long_edge() {
        // 3024x4032 would be 1800x2400 = 4,32 MP on the long edge alone.
        assert_eq!(output_size(3024, 4032, HERO), (1620, 2160));
        assert_eq!(output_size(3024, 4032, CONTENT), (1162, 1549));
    }

    #[test]
    fn wide_landscape_keeps_the_full_long_edge() {
        assert_eq!(output_size(4032, 2268, HERO), (2400, 1350)); // 16:9, 3,24 MP
        assert_eq!(output_size(4032, 2268, CONTENT), (1600, 900));
    }

    #[test]
    fn result_is_always_inside_both_limits() {
        for (w, h) in [
            (3024, 4032),
            (4032, 3024),
            (4000, 4000),
            (8064, 6048),
            (10000, 10),
            (10, 10000),
            (2316, 3088),
            (1, 1),
        ] {
            for limits in [HERO, CONTENT] {
                let size = output_size(w, h, limits);
                assert!(
                    within(limits, size),
                    "{w}x{h} -> {size:?} sprengt {limits:?}"
                );
                assert!(
                    size.0 <= w && size.1 <= h,
                    "{w}x{h} -> {size:?} ist hochskaliert"
                );
            }
        }
    }

    #[test]
    fn extreme_panorama_never_collapses_to_zero_height() {
        assert_eq!(
            output_size(10000, 10, Limits::long_edge_only(800)),
            (800, 1)
        );
    }
}
