//! Output dimensions.

/// Output (width, height) for an original of `width`×`height` and a chosen
/// maximum width: scaled down to `max_width` keeping the aspect ratio, or
/// left at the original size if it is already narrower. Never upscales.
pub fn output_size(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    if width <= max_width {
        return (width, height);
    }
    (max_width, scaled_height(width, height, max_width))
}

/// Height for `width` that keeps the original aspect ratio (rounded, at least 1).
fn scaled_height(original_width: u32, original_height: u32, width: u32) -> u32 {
    let (ow, oh, w) = (original_width as u64, original_height as u64, width as u64);
    ((oh * w + ow / 2) / ow).max(1) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_down_to_max_width_keeping_aspect_ratio() {
        assert_eq!(output_size(3840, 2160, 1600), (1600, 900)); // 16:9
        assert_eq!(output_size(4032, 3024, 800), (800, 600)); // 4:3
        assert_eq!(output_size(3024, 4032, 1600), (1600, 2133)); // 3:4 portrait
        assert_eq!(output_size(5000, 2813, 2400), (2400, 1350));
    }

    #[test]
    fn never_upscales() {
        assert_eq!(output_size(1000, 750, 1600), (1000, 750));
        assert_eq!(output_size(300, 200, 800), (300, 200));
        assert_eq!(output_size(1600, 900, 1600), (1600, 900));
    }

    #[test]
    fn extreme_panorama_never_collapses_to_zero_height() {
        assert_eq!(output_size(10000, 10, 800), (800, 1));
    }
}
