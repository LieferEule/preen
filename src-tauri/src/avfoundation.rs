//! Reading and writing video through AVFoundation and VideoToolbox.
//!
//! The same idea as `imageio`: macOS already ships a decoder for everything a
//! camera produces (H.264, HEVC, ProRes, HDR) and a hardware H.264 encoder, so
//! Preen brings neither HandBrake (GPLv2) nor ffmpeg (40–80 MB) along.
//!
//! Reading goes through a video composition, which applies the rotation a
//! phone stores next to the pixels, drops frames down to the planned rate and
//! maps HDR to SDR Rec. 709 — what browsers show an H.264 file as anyway. The
//! writer scales to the output size and encodes. Sound is never read.
//!
//! The synchronous `AVAsset` accessors are deprecated in favour of async
//! loading, but they still work and this never runs on the main thread.
#![allow(deprecated)]

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_av_foundation::{
    AVAsset, AVAssetReader, AVAssetReaderStatus, AVAssetReaderVideoCompositionOutput, AVAssetTrack,
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeAudio,
    AVMediaTypeVideo, AVMutableVideoComposition, AVURLAsset, AVVideoAllowFrameReorderingKey,
    AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264, AVVideoColorPrimariesKey,
    AVVideoColorPrimaries_ITU_R_709_2, AVVideoColorPropertiesKey, AVVideoCompressionPropertiesKey,
    AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalDurationKey,
    AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey, AVVideoScalingModeKey,
    AVVideoScalingModeResize, AVVideoTransferFunctionKey, AVVideoTransferFunction_ITU_R_709_2,
    AVVideoWidthKey, AVVideoYCbCrMatrixKey, AVVideoYCbCrMatrix_ITU_R_709_2,
};
use objc2_core_foundation::CFString;
use objc2_core_media::CMTime;
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};

/// Keyframe at least every two seconds: a looping hero restarts cleanly and
/// a browser can start a cut-off download early.
const KEYFRAME_INTERVAL_SECONDS: f64 = 2.0;
/// How long `finishWriting` may take to put the index in front of the data.
const FINISH_TIMEOUT: Duration = Duration::from_secs(60);

/// What a source file is, as it will be shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    /// Displayed size, after the stored rotation.
    pub width: u32,
    pub height: u32,
    /// Nominal frame rate of the video track.
    pub fps: f64,
    pub duration_seconds: f64,
    /// Average video data rate in bits per second, if the file says.
    pub bitrate: Option<u64>,
    pub has_audio: bool,
}

/// How one encoding pass should run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EncodeSettings {
    /// Output size; both even, as 4:2:0 H.264 needs.
    pub width: u32,
    pub height: u32,
    /// Output frame rate. Equal to the source rate means "keep the source
    /// timing", lower means frames are dropped evenly.
    pub fps: f64,
    pub source_fps: f64,
    /// Average bits per second asked of the encoder. It only roughly obeys.
    pub bitrate: u64,
}

pub fn probe(path: &Path) -> Result<Probe, String> {
    let asset = open(path)?;
    let track = video_track(&asset)?;
    let natural = unsafe { track.naturalSize() };
    let t = unsafe { track.preferredTransform() };
    // The rotation only swaps or mirrors the axes; its absolute value is the
    // displayed size.
    let width = (t.a * natural.width + t.c * natural.height).abs().round() as u32;
    let height = (t.b * natural.width + t.d * natural.height).abs().round() as u32;
    let fps = unsafe { track.nominalFrameRate() } as f64;
    let duration_seconds = unsafe { asset.duration().seconds() };
    let rate = unsafe { track.estimatedDataRate() } as f64;
    let has_audio = unsafe { asset.tracksWithMediaType(media(AVMediaTypeAudio)?).count() } > 0;

    if width == 0 || height == 0 {
        return Err("Videogröße nicht lesbar".to_string());
    }
    if !(duration_seconds.is_finite() && duration_seconds > 0.0) {
        return Err("Videolänge nicht lesbar".to_string());
    }
    if !(fps.is_finite() && fps > 0.0) {
        return Err("Bildrate nicht lesbar".to_string());
    }
    Ok(Probe {
        width,
        height,
        fps,
        duration_seconds,
        bitrate: (rate.is_finite() && rate > 0.0).then_some(rate.round() as u64),
        has_audio,
    })
}

/// One pass: `source` in, H.264 MP4 without sound at `dest`. `dest` must not
/// exist yet — AVAssetWriter refuses to replace a file. AVAssetWriter leaves
/// scratch files in `dest`'s folder; the caller owns that folder.
pub fn encode(source: &Path, dest: &Path, settings: &EncodeSettings) -> Result<(), String> {
    let asset = open(source)?;
    let track = video_track(&asset)?;

    let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }
        .map_err(|e| format!("Video nicht lesbar: {}", e.localizedDescription()))?;
    let output = composition_output(&asset, &track, settings)?;
    unsafe {
        if !reader.canAddOutput(&output) {
            return Err("Video nicht lesbar".to_string());
        }
        reader.addOutput(&output);
    }

    let url = file_url(dest);
    let writer =
        unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, key(AVFileTypeMPEG4)?) }
            .map_err(|e| format!("Ziel nicht schreibbar: {}", e.localizedDescription()))?;
    // Index in front of the data ("faststart"): the browser can start
    // playing before the whole file is there.
    // Its scratch files go next to `dest`, not into the output folder.
    unsafe {
        writer.setShouldOptimizeForNetworkUse(true);
        if let Some(dir) = dest.parent() {
            writer.setDirectoryForTemporaryFiles(Some(&file_url(dir)));
        }
    }
    let input = unsafe {
        AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
            media(AVMediaTypeVideo)?,
            Some(&*writer_settings(settings)?),
        )
    };
    unsafe {
        input.setExpectsMediaDataInRealTime(false);
        if !writer.canAddInput(&input) {
            return Err("Encoder nimmt die Einstellungen nicht".to_string());
        }
        writer.addInput(&input);
    }

    unsafe {
        if !reader.startReading() {
            return Err(reader_error(&reader));
        }
        if !writer.startWriting() {
            reader.cancelReading();
            return Err(writer_error(&writer));
        }
    }

    let mut started = false;
    loop {
        let Some(sample) = (unsafe { output.copyNextSampleBuffer() }) else {
            break;
        };
        if !started {
            unsafe { writer.startSessionAtSourceTime(sample.presentation_time_stamp()) };
            started = true;
        }
        // Offline encoding: wait for the encoder instead of dropping frames.
        while !unsafe { input.isReadyForMoreMediaData() } {
            if unsafe { writer.status() } != AVAssetWriterStatus::Writing {
                unsafe { reader.cancelReading() };
                return Err(writer_error(&writer));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        if !unsafe { input.appendSampleBuffer(&sample) } {
            unsafe { reader.cancelReading() };
            return Err(writer_error(&writer));
        }
    }

    if unsafe { reader.status() } != AVAssetReaderStatus::Completed {
        unsafe { writer.cancelWriting() };
        return Err(reader_error(&reader));
    }
    if !started {
        unsafe { writer.cancelWriting() };
        return Err("Video enthält keine Bilder".to_string());
    }

    unsafe { input.markAsFinished() };
    let (done, finished) = mpsc::channel();
    let handler = RcBlock::new(move || {
        let _ = done.send(());
    });
    unsafe { writer.finishWritingWithCompletionHandler(&handler) };
    finished
        .recv_timeout(FINISH_TIMEOUT)
        .map_err(|_| "Abschluss des Videos hängt".to_string())?;
    match unsafe { writer.status() } {
        AVAssetWriterStatus::Completed => Ok(()),
        _ => Err(writer_error(&writer)),
    }
}

fn open(path: &Path) -> Result<Retained<AVURLAsset>, String> {
    if !path.is_file() {
        return Err("nicht lesbar".to_string());
    }
    Ok(unsafe { AVURLAsset::URLAssetWithURL_options(&file_url(path), None) })
}

fn video_track(asset: &AVAsset) -> Result<Retained<AVAssetTrack>, String> {
    unsafe { asset.tracksWithMediaType(media(AVMediaTypeVideo)?) }
        .firstObject()
        .ok_or_else(|| "kein lesbares Video".to_string())
}

/// Decoded, rotated, frame-rate-limited, SDR frames in the encoder's own
/// pixel layout (4:2:0, video range), so nothing converts twice.
fn composition_output(
    asset: &AVAsset,
    track: &AVAssetTrack,
    settings: &EncodeSettings,
) -> Result<Retained<AVAssetReaderVideoCompositionOutput>, String> {
    let composition =
        unsafe { AVMutableVideoComposition::videoCompositionWithPropertiesOfAsset(asset) };
    unsafe {
        if settings.fps < settings.source_fps {
            // Frame timing from the composition instead of the source track:
            // frames are taken at this spacing, the others dropped.
            composition.setSourceTrackIDForFrameTiming(0);
            composition.setFrameDuration(CMTime::with_seconds(1.0 / settings.fps, 60_000));
        }
        composition.setColorPrimaries(Some(key(AVVideoColorPrimaries_ITU_R_709_2)?));
        composition.setColorTransferFunction(Some(key(AVVideoTransferFunction_ITU_R_709_2)?));
        composition.setColorYCbCrMatrix(Some(key(AVVideoYCbCrMatrix_ITU_R_709_2)?));
    }

    let pixel_format = NSNumber::new_u32(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
    let video_settings = NSDictionary::<NSString, AnyObject>::from_slices(
        &[cf_key(unsafe { kCVPixelBufferPixelFormatTypeKey })],
        &[pixel_format.as_ref()],
    );
    let tracks = NSArray::from_slice(&[track]);
    let output = unsafe {
        AVAssetReaderVideoCompositionOutput::initWithVideoTracks_videoSettings(
            AVAssetReaderVideoCompositionOutput::alloc(),
            &tracks,
            Some(&video_settings),
        )
    };
    unsafe {
        output.setVideoComposition(Some(&composition));
        output.setAlwaysCopiesSampleData(false);
    }
    Ok(output)
}

fn writer_settings(
    settings: &EncodeSettings,
) -> Result<Retained<NSDictionary<NSString, AnyObject>>, String> {
    let compression = NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            key(unsafe { AVVideoAverageBitRateKey })?,
            key(unsafe { AVVideoProfileLevelKey })?,
            key(unsafe { AVVideoExpectedSourceFrameRateKey })?,
            key(unsafe { AVVideoMaxKeyFrameIntervalDurationKey })?,
            key(unsafe { AVVideoAllowFrameReorderingKey })?,
        ],
        &[
            NSNumber::new_u64(settings.bitrate).as_ref(),
            key(unsafe { AVVideoProfileLevelH264HighAutoLevel })?.as_ref(),
            NSNumber::new_f64(settings.fps).as_ref(),
            NSNumber::new_f64(KEYFRAME_INTERVAL_SECONDS).as_ref(),
            NSNumber::new_bool(true).as_ref(),
        ],
    );
    let colour = NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            key(unsafe { AVVideoColorPrimariesKey })?,
            key(unsafe { AVVideoTransferFunctionKey })?,
            key(unsafe { AVVideoYCbCrMatrixKey })?,
        ],
        &[
            key(unsafe { AVVideoColorPrimaries_ITU_R_709_2 })?.as_ref(),
            key(unsafe { AVVideoTransferFunction_ITU_R_709_2 })?.as_ref(),
            key(unsafe { AVVideoYCbCrMatrix_ITU_R_709_2 })?.as_ref(),
        ],
    );
    Ok(NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            key(unsafe { AVVideoCodecKey })?,
            key(unsafe { AVVideoWidthKey })?,
            key(unsafe { AVVideoHeightKey })?,
            // Stretch, not letterbox: rounding to even sides moves the aspect
            // ratio by a fraction of a pixel, and that must not become a
            // black line at the edge.
            key(unsafe { AVVideoScalingModeKey })?,
            key(unsafe { AVVideoColorPropertiesKey })?,
            key(unsafe { AVVideoCompressionPropertiesKey })?,
        ],
        &[
            key(unsafe { AVVideoCodecTypeH264 })?.as_ref(),
            NSNumber::new_u32(settings.width).as_ref(),
            NSNumber::new_u32(settings.height).as_ref(),
            key(unsafe { AVVideoScalingModeResize })?.as_ref(),
            colour.as_ref(),
            compression.as_ref(),
        ],
    ))
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// The framework constants are optional in the bindings (weakly linked).
fn key(value: Option<&'static NSString>) -> Result<&'static NSString, String> {
    value.ok_or_else(|| "AVFoundation unvollständig".to_string())
}

fn media(value: Option<&'static NSString>) -> Result<&'static NSString, String> {
    key(value)
}

/// CFString and NSString are toll-free bridged.
fn cf_key(value: &'static CFString) -> &'static NSString {
    unsafe { &*(value as *const CFString as *const NSString) }
}

fn reader_error(reader: &AVAssetReader) -> String {
    match unsafe { reader.error() } {
        Some(e) => format!("Video nicht lesbar: {}", e.localizedDescription()),
        None => "Video nicht lesbar".to_string(),
    }
}

fn writer_error(writer: &AVAssetWriter) -> String {
    match unsafe { writer.error() } {
        Some(e) => format!("Kodierung fehlgeschlagen: {}", e.localizedDescription()),
        None => "Kodierung fehlgeschlagen".to_string(),
    }
}
