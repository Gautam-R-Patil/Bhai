#!/usr/bin/env swift
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Dumps the macOS Accessibility tree for the frontmost (or specified) app to JSON.
//
// Usage:
//   dump_ax_bin [--pid <pid>] [--frontmost] [--depth N] [--bbox-only]
//
// Output (stdout): JSON tree
//   {
//     "app": "Safari",
//     "pid": 12345,
//     "root": {
//       "role": "AXApplication",
//       "label": "Safari",
//       ...,
//       "children": [ ... ]
//     }
//   }
//
// On error: prints "error|<reason>" to stdout, exits 1.
//   Reasons: not_trusted, no_frontmost, pid_not_found, ax_query_failed

import Foundation
import ApplicationServices
import AppKit

// ── Args ──────────────────────────────────────────

var targetPid: pid_t = 0
var maxDepth: Int = 20  // raised from 12 — Safari/VS Code can be 25-40 levels deep
var bboxOnly: Bool = false

let args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    let a = args[i]
    switch a {
    case "--pid":
        if i + 1 < args.count, let p = pid_t(args[i + 1]) { targetPid = p; i += 1 }
    case "--frontmost":
        targetPid = 0
    case "--depth":
        if i + 1 < args.count, let d = Int(args[i + 1]) { maxDepth = max(1, min(30, d)); i += 1 }
    case "--bbox-only":
        bboxOnly = true
    default:
        break
    }
    i += 1
}

// ── Permission check ──────────────────────────────

guard AXIsProcessTrusted() else {
    FileHandle.standardOutput.write("error|not_trusted\n".data(using: .utf8)!)
    exit(1)
}

// ── Pick target process ──────────────────────────

var pid: pid_t = targetPid
var appName: String = "unknown"
if pid == 0 {
    guard let front = NSWorkspace.shared.frontmostApplication else {
        FileHandle.standardOutput.write("error|no_frontmost\n".data(using: .utf8)!)
        exit(1)
    }
    pid = front.processIdentifier
    appName = front.localizedName ?? "unknown"
} else {
    appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid:\(pid)"
}

// ── AX helpers ───────────────────────────────────

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v as? String
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let b = v as? Bool { return b }
    return false
}

func axNumber(_ el: AXUIElement, _ attr: String) -> NSNumber? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v as? NSNumber
}

func axPoint(_ el: AXUIElement) -> CGPoint {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &v) == .success,
          let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return .zero }
    var p = CGPoint.zero
    AXValueGetValue(val as! AXValue, .cgPoint, &p)
    return p
}

func axSize(_ el: AXUIElement) -> CGSize {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &v) == .success,
          let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return .zero }
    var s = CGSize.zero
    AXValueGetValue(val as! AXValue, .cgSize, &s)
    return s
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
       let arr = v as? [AXUIElement] {
        return arr
    }
    return []
}

// ── Walk + serialize ────────────────────────────

struct AXNode: Encodable {
    let role: String?
    let subrole: String?
    let label: String?
    let value: String?
    let x: Int
    let y: Int
    let w: Int
    let h: Int
    let focusable: Bool
    let enabled: Bool
    let children: [AXNode]
}

func sliceValue(_ s: String?, _ max: Int = 200) -> String? {
    guard let s = s else { return nil }
    if s.count <= max { return s }
    return String(s.prefix(max))
}

func walk(_ el: AXUIElement, depth: Int) -> AXNode {
    let pos = axPoint(el)
    let sz = axSize(el)
    let role = axString(el, kAXRoleAttribute)
    let subrole = axString(el, kAXSubroleAttribute)

    // Try multiple label fields in priority order; AXValue can be a string or a number.
    var label = axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute)
    if label == nil { label = axString(el, kAXHelpAttribute) }

    // SECURITY: never expose password-field contents. macOS marks them with subrole AXSecureTextField.
    let isSecure = (subrole == "AXSecureTextField")

    var valueStr: String? = nil
    if !bboxOnly && !isSecure {
        if let v = axString(el, kAXValueAttribute) {
            valueStr = v
        } else if let n = axNumber(el, kAXValueAttribute) {
            valueStr = String(describing: n)
        }
    } else if isSecure {
        valueStr = "[secure]"
    }

    var kids: [AXNode] = []
    if depth < maxDepth {
        for c in axChildren(el) {
            kids.append(walk(c, depth: depth + 1))
        }
    }

    return AXNode(
        role: role,
        subrole: subrole,
        label: sliceValue(label),
        value: sliceValue(valueStr),
        x: Int(pos.x),
        y: Int(pos.y),
        w: Int(sz.width),
        h: Int(sz.height),
        focusable: axBool(el, kAXFocusedAttribute),
        enabled: axBool(el, kAXEnabledAttribute),
        children: kids
    )
}

// ── Dump ──────────────────────────────────────────

let app = AXUIElementCreateApplication(pid)
let root = walk(app, depth: 0)

struct Output: Encodable {
    let app: String
    let pid: Int32
    let root: AXNode
    let trusted: Bool
    let depth: Int
}

let out = Output(app: appName, pid: pid, root: root, trusted: true, depth: maxDepth)
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

do {
    let data = try encoder.encode(out)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
} catch {
    FileHandle.standardOutput.write("error|encode_failed:\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
