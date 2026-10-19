//! Reading images through macOS ImageIO.
//!
//! ImageIO decodes JPG, PNG, HEIC and TIFF natively, applies the EXIF
//! orientation, and — by drawing into an sRGB bitmap context — converts any
//! embedded colour profile (e.g. iPhone Display P3) to sRGB, which is what
//! browsers assume for WebP files without a profile.

use std::ffi::c_void;
use std::path::Path;

use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize, CFURL,
};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGInterpolationQuality,
};
use objc2_image_io::{
    kCGImagePropertyOrientation, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceShouldCache, kCGImageSourceThumbnailMaxPixelSize, CGImageSource,
};

/// A decoded image: 8-bit sRGB RGBA, alpha premultiplied (as CoreGraphics
/// renders it — which is also what correct resampling needs).
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    /// True only when a pixel is actually not opaque. ImageIO hands back an
    /// alpha channel for plain JPEGs and HEICs too, so the CGImage's own
    /// answer is not usable: it would send every photo down the RGBA path.
    pub has_alpha: bool,
}

/// Pixel dimensions as displayed, i.e. after EXIF orientation.
pub fn dimensions(path: &Path) -> Result<(u32, u32), String> {
    let source = open(path)?;
    let (width, height, orientation) = raw_properties(&source)?;
    // EXIF orientations 5–8 rotate by 90°, swapping width and height.
    Ok(if (5..=8).contains(&orientation) {
        (height, width)
    } else {
        (width, height)
    })
}

pub fn decode(path: &Path) -> Result<Bitmap, String> {
    decode_capped(path, None)
}

/// Decodes at most `max_pixels` on the longer side — for panel previews.
pub fn decode_thumbnail(path: &Path, max_pixels: u32) -> Result<Bitmap, String> {
    decode_capped(path, Some(max_pixels))
}

fn decode_capped(path: &Path, max_pixels: Option<u32>) -> Result<Bitmap, String> {
    let source = open(path)?;
    let (width, height, _) = raw_properties(&source)?;

    // A "thumbnail" at the full pixel size is the documented way to get
    // ImageIO to apply the EXIF orientation while decoding.
    let yes = CFBoolean::new(true);
    let longest = width.max(height);
    let max_size = CFNumber::new_i64(max_pixels.map_or(longest, |cap| cap.min(longest)) as i64);
    let options = CFDictionary::<CFString, CFType>::from_slices(
        &[
            unsafe { kCGImageSourceCreateThumbnailFromImageAlways },
            unsafe { kCGImageSourceCreateThumbnailWithTransform },
            unsafe { kCGImageSourceThumbnailMaxPixelSize },
            unsafe { kCGImageSourceShouldCache },
        ],
        &[
            yes.as_ref(),
            yes.as_ref(),
            max_size.as_ref(),
            CFBoolean::new(false).as_ref(),
        ],
    );
    let index = unsafe { source.primary_image_index() };
    let image = unsafe { source.thumbnail_at_index(index, Some(options.as_opaque())) }
        .ok_or_else(|| "nicht dekodierbar".to_string())?;

    bitmap_from_image(&image)
}

/// Draws a CGImage into 8-bit sRGB RGBA, alpha premultiplied — the colour
/// management step every decoded picture goes through, images and video
/// frames alike.
pub(crate) fn bitmap_from_image(image: &CGImage) -> Result<Bitmap, String> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let channel = !matches!(
        CGImage::alpha_info(Some(image)),
        CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipLast | CGImageAlphaInfo::NoneSkipFirst
    );

    let srgb = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| "sRGB-Farbraum nicht verfügbar".to_string())?;
    let bytes_per_row = width * 4;
    let mut pixels = vec![0u8; bytes_per_row * height];
    let context = unsafe {
        CGBitmapContextCreate(
            pixels.as_mut_ptr() as *mut c_void,
            width,
            height,
            8,
            bytes_per_row,
            Some(&srgb),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    }
    .ok_or_else(|| "Bildpuffer konnte nicht angelegt werden".to_string())?;
    CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
    let rect = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::draw_image(Some(&context), rect, Some(image));
    drop(context);

    // One pass over the drawn pixels decides it: an alpha channel that is
    // opaque everywhere is no alpha channel. Cheaper than the un-premultiply
    // it saves, and it keeps opaque photos out of the RGBA encoder.
    let has_alpha = channel && pixels.chunks_exact(4).any(|p| p[3] != 255);

    Ok(Bitmap {
        width: width as u32,
        height: height as u32,
        pixels,
        has_alpha,
    })
}

/// Luma of a CGImage at exactly `width`×`height`, the way a video stores it:
/// BT.709 weights on the gamma-encoded values, video range (16–235). That is
/// the Y plane ffmpeg's `ssim` filter compares, so the numbers line up.
pub fn luma_from_image(image: &CGImage, width: u32, height: u32) -> Result<Vec<u8>, String> {
    // Both pictures are read as plain sRGB numbers, whatever their tags say.
    // An untagged source next to a BT.709-tagged result would otherwise be
    // colour-managed differently, and SSIM would count that as loss.
    let srgb = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| "sRGB-Farbraum nicht verfügbar".to_string())?;
    let retagged = CGImage::new_copy_with_color_space(Some(image), Some(&srgb));
    let image = retagged.as_deref().unwrap_or(image);

    let (w, h) = (width as usize, height as usize);
    let mut pixels = vec![0u8; w * h * 4];
    let context = unsafe {
        CGBitmapContextCreate(
            pixels.as_mut_ptr() as *mut c_void,
            w,
            h,
            8,
            w * 4,
            Some(&srgb),
            CGImageAlphaInfo::NoneSkipLast.0,
        )
    }
    .ok_or_else(|| "Bildpuffer konnte nicht angelegt werden".to_string())?;
    CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
    CGContext::draw_image(Some(&context), rect, Some(image));
    drop(context);
    Ok(pixels
        .chunks_exact(4)
        .map(|p| {
            let y = 0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64;
            (16.0 + y * 219.0 / 255.0).round() as u8
        })
        .collect())
}

fn open(path: &Path) -> Result<CFRetained<CGImageSource>, String> {
    let url = CFURL::from_file_path(path).ok_or_else(|| "Ungültiger Dateipfad".to_string())?;
    let source =
        unsafe { CGImageSource::with_url(&url, None) }.ok_or_else(|| "nicht lesbar".to_string())?;
    if unsafe { source.count() } == 0 {
        return Err("kein lesbares Bild".to_string());
    }
    Ok(source)
}

/// (width, height, EXIF orientation) of the stored pixels.
fn raw_properties(source: &CGImageSource) -> Result<(u32, u32, i64), String> {
    let index = unsafe { source.primary_image_index() };
    let properties = unsafe { source.properties_at_index(index, None) }
        .ok_or_else(|| "Eigenschaften nicht lesbar".to_string())?;
    let properties: &CFDictionary<CFString, CFType> = unsafe { properties.cast_unchecked() };
    let number = |key: &CFString| -> Option<i64> {
        properties.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
    };
    let width = number(unsafe { kCGImagePropertyPixelWidth });
    let height = number(unsafe { kCGImagePropertyPixelHeight });
    let orientation = number(unsafe { kCGImagePropertyOrientation }).unwrap_or(1);
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w as u32, h as u32, orientation)),
        _ => Err("Bildgröße nicht lesbar".to_string()),
    }
}
