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
    let source = open(path)?;
    let (width, height, _) = raw_properties(&source)?;

    // A "thumbnail" at the full pixel size is the documented way to get
    // ImageIO to apply the EXIF orientation while decoding.
    let yes = CFBoolean::new(true);
    let max_size = CFNumber::new_i64(width.max(height) as i64);
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
        .ok_or_else(|| "Bild konnte nicht dekodiert werden".to_string())?;

    let width = CGImage::width(Some(&image));
    let height = CGImage::height(Some(&image));
    let has_alpha = !matches!(
        CGImage::alpha_info(Some(&image)),
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
    CGContext::draw_image(Some(&context), rect, Some(&image));
    drop(context);

    Ok(Bitmap {
        width: width as u32,
        height: height as u32,
        pixels,
        has_alpha,
    })
}

fn open(path: &Path) -> Result<CFRetained<CGImageSource>, String> {
    let url = CFURL::from_file_path(path).ok_or_else(|| "Ungültiger Dateipfad".to_string())?;
    let source = unsafe { CGImageSource::with_url(&url, None) }
        .ok_or_else(|| "Datei konnte nicht gelesen werden".to_string())?;
    if unsafe { source.count() } == 0 {
        return Err("Kein lesbares Bild in der Datei".to_string());
    }
    Ok(source)
}

/// (width, height, EXIF orientation) of the stored pixels.
fn raw_properties(source: &CGImageSource) -> Result<(u32, u32, i64), String> {
    let index = unsafe { source.primary_image_index() };
    let properties = unsafe { source.properties_at_index(index, None) }
        .ok_or_else(|| "Bildeigenschaften nicht lesbar".to_string())?;
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
