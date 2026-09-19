// Generates the test images in src-tauri/tests/fixtures.
// Usage: swift scripts/make-fixtures.swift src-tauri/tests/fixtures
//
// Images are flat two-colour halves so they compress to almost nothing and
// tests can check where each colour ends up (e.g. after EXIF rotation).

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outDir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let red = CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
let blue = CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
let clear = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0)

/// Top half `top`, bottom half `bottom` (in stored pixel orientation).
func halves(_ w: Int, _ h: Int, top: CGColor, bottom: CGColor, alpha: Bool = false) -> CGImage {
    let info = alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)!
    // CoreGraphics' origin is bottom-left.
    ctx.setFillColor(bottom); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h / 2))
    ctx.setFillColor(top); ctx.fill(CGRect(x: 0, y: h / 2, width: w, height: h - h / 2))
    return ctx.makeImage()!
}

/// Left half `left`, right half `right`.
func sides(_ w: Int, _ h: Int, left: CGColor, right: CGColor) -> CGImage {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.setFillColor(left); ctx.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
    ctx.setFillColor(right); ctx.fill(CGRect(x: w / 2, y: 0, width: w - w / 2, height: h))
    return ctx.makeImage()!
}

func write(_ image: CGImage, _ name: String, _ type: UTType, orientation: Int? = nil) {
    let url = outDir.appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
    var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
    if let o = orientation { props[kCGImagePropertyOrientation] = o }
    if type == .tiff { props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFCompression: 5] } // LZW
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    precondition(CGImageDestinationFinalize(dest), "failed to write \(name)")
    print("wrote \(name) \(image.width)x\(image.height)")
}

write(halves(2000, 1125, top: red, bottom: blue), "wide-16x9.jpg", .jpeg)
write(halves(1000, 750, top: red, bottom: blue), "photo-4x3.png", .png)
write(halves(300, 200, top: red, bottom: blue), "tiny.jpg", .jpeg)
write(sides(900, 600, left: clear, right: red), "transparent.png", .png)
// Stored landscape 1200x800, red on top; EXIF 6 = rotate 90° clockwise for
// display → shown as 800x1200 portrait with red on the RIGHT.
write(halves(1200, 800, top: red, bottom: blue), "rotated-exif6.jpg", .jpeg, orientation: 6)
write(halves(4032, 3024, top: red, bottom: blue), "iphone.heic", .heic)
write(halves(3000, 2000, top: red, bottom: blue), "scan.tiff", .tiff)
write(halves(5000, 2813, top: red, bottom: blue), "hero-5000.jpg", .jpeg)
