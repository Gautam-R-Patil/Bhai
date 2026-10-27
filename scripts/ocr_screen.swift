#!/usr/bin/env swift
// OCR screen text using macOS Vision framework — Bhai v2
// Usage: swift ocr_screen.swift [screenshot_path] [fast|accurate]
// Outputs JSON: {width, height, screen_w, screen_h, elements: [{text, cx_norm, cy_norm, w_norm, h_norm, cx_screen, cy_screen, confidence}]}
// Normalized coords (0.0-1.0) are relative to the IMAGE dimensions.
// cx_screen / cy_screen are already in logical screen POINTS (safe to pass to os_click).

import Foundation
import Vision
import AppKit

// ── Args ──────────────────────────────────────────────
let args = CommandLine.arguments
var imagePath: String
var recognitionMode = "accurate"

if args.count > 1 && !args[1].hasPrefix("-") {
    imagePath = args[1]
    if args.count > 2 { recognitionMode = args[2] }
} else {
    // Take a fresh screenshot
    imagePath = NSTemporaryDirectory() + "atlas_ocr_\(Int(Date().timeIntervalSince1970)).png"
    let task = Process()
    task.launchPath = "/usr/sbin/screencapture"
    task.arguments = ["-x", imagePath]
    task.launch()
    task.waitUntilExit()
    if args.count > 1 { recognitionMode = args[1] }
}

// ── Load image ────────────────────────────────────────
guard let nsImage = NSImage(contentsOfFile: imagePath) else {
    print("{\"error\": \"Failed to load image: \(imagePath)\"}")
    exit(1)
}
guard let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"error\": \"Failed to convert to CGImage\"}")
    exit(1)
}

let imageWidth  = CGFloat(cgImage.width)
let imageHeight = CGFloat(cgImage.height)

// Get logical screen size (points, not pixels) — safe to pass to os_click
let screenWidth  = NSScreen.main?.frame.width  ?? 1470.0
let screenHeight = NSScreen.main?.frame.height ?? 956.0

// Scaling: image is captured at Retina (2x), so logical → image factor = imageWidth / screenWidth
// To go from image coords back to logical screen points:
//   logicalX = imageX / (imageWidth / screenWidth) = imageX * screenWidth / imageWidth
// But Vision gives us NORMALIZED coords (0–1), so:
//   logicalX = cx_norm * imageWidth * (screenWidth / imageWidth) = cx_norm * screenWidth

// ── Vision OCR ───────────────────────────────────────
let request = VNRecognizeTextRequest()
request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.008  // ignore sub-pixel noise

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

// ── Build results ─────────────────────────────────────
var elements: [[String: Any]] = []

if let observations = request.results as? [VNRecognizedTextObservation] {
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }

        // Vision bounding box: normalized, origin at BOTTOM-LEFT
        let box = obs.boundingBox
        let cx_norm = box.origin.x + box.width  / 2.0
        let cy_norm_bl = box.origin.y + box.height / 2.0      // bottom-left origin
        let cy_norm = 1.0 - cy_norm_bl                         // flip to top-left origin

        // Map to logical screen points (what os_click expects)
        let cx_screen = cx_norm * screenWidth
        let cy_screen = cy_norm * screenHeight
        let w_screen  = box.width  * screenWidth
        let h_screen  = box.height * screenHeight

        let confidence = Double(candidate.confidence)

        elements.append([
            "text":       text,
            "cx_norm":    Double(cx_norm),
            "cy_norm":    Double(cy_norm),
            "w_norm":     Double(box.width),
            "h_norm":     Double(box.height),
            "cx_screen":  Double(cx_screen),
            "cy_screen":  Double(cy_screen),
            "w_screen":   Double(w_screen),
            "h_screen":   Double(h_screen),
            "confidence": confidence
        ])
    }
}

// Sort by reading order: top → bottom, left → right
elements.sort {
    let y0 = $0["cy_norm"] as! Double
    let y1 = $1["cy_norm"] as! Double
    if abs(y0 - y1) > 0.015 { return y0 < y1 }
    let x0 = $0["cx_norm"] as! Double
    let x1 = $1["cx_norm"] as! Double
    return x0 < x1
}

// ── Cleanup temp screenshot ───────────────────────────
if CommandLine.arguments.count <= 1 {
    try? FileManager.default.removeItem(atPath: imagePath)
}

// ── Output ────────────────────────────────────────────
let output: [String: Any] = [
    "image_width":    Double(imageWidth),
    "image_height":   Double(imageHeight),
    "screen_width":   Double(screenWidth),
    "screen_height":  Double(screenHeight),
    "recognition":    recognitionMode,
    "element_count":  elements.count,
    "elements":       elements
]

if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys, .prettyPrinted]),
   let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("{\"error\": \"JSON serialization failed\", \"elements\": []}")
}
