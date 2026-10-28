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
//   An optional top-level "partial": true means the target app stopped answering
//   (an AX call hit the messaging timeout) and the tree was cut short.
//
// Environment switches:
//   ATLAS_AX_BATCH=true            one AXUIElementCopyMultipleAttributeValues per node
//                                  instead of one IPC per attribute (opt-in)
//   ATLAS_AX_MSG_TIMEOUT_MS=N      per-call AX messaging timeout (default 1000, clamped 100-5000)
//   ATLAS_NO_AX_MSG_TIMEOUT=true   keep the system default timeout (~6s)
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

let env = ProcessInfo.processInfo.environment
let useBatch = env["ATLAS_AX_BATCH"] == "true"
let msgTimeoutOn = env["ATLAS_NO_AX_MSG_TIMEOUT"] != "true"
let msgTimeoutMs = max(100, min(5000, Int(env["ATLAS_AX_MSG_TIMEOUT_MS"] ?? "") ?? 1000))
// A kAXErrorCannotComplete that comes back fast is an app quirk, not a hang: only a
// call that ran for at least half the timeout counts. The system default is ~6s.
let hangNs = UInt64(msgTimeoutOn ? msgTimeoutMs : 6000) * 500_000

/// Set once an AX call times out. Every later call is skipped, so a hung app costs
/// one timeout instead of one per attribute per node.
var hung = false

func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

func noteError(_ err: AXError, since t0: UInt64) {
    if err == .cannotComplete && now() - t0 >= hangNs { hung = true }
}

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    if hung { return nil }
    var v: CFTypeRef?
    let t0 = now()
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err != .success { noteError(err, since: t0); return nil }
    return v
}

// Converters shared by both walks, so a value means the same thing however it was read.
func cfString(_ v: CFTypeRef?) -> String? { v as? String }
func cfNumber(_ v: CFTypeRef?) -> NSNumber? { v as? NSNumber }
func cfBool(_ v: CFTypeRef?) -> Bool { (v as? Bool) ?? false }
func cfChildren(_ v: CFTypeRef?) -> [AXUIElement] { (v as? [AXUIElement]) ?? [] }

func cfPoint(_ v: CFTypeRef?) -> CGPoint {
    guard let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return .zero }
    var p = CGPoint.zero
    AXValueGetValue(val as! AXValue, .cgPoint, &p)
    return p
}

func cfSize(_ v: CFTypeRef?) -> CGSize {
    guard let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return .zero }
    var s = CGSize.zero
    AXValueGetValue(val as! AXValue, .cgSize, &s)
    return s
}

/// Empty strings count as missing: a button's title is often "" while its
/// description carries the real name.
func ne(_ s: String?) -> String? {
    guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s
}

// Traffic-light buttons have no title or description, only a subrole.
let subroleNames: [String: String] = [
    "AXCloseButton": "Close", "AXMinimizeButton": "Minimize",
    "AXZoomButton": "Zoom", "AXFullScreenButton": "Full Screen",
]

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

/// Builds a node from attribute readers. Label and value readers are lazy so the
/// per-attribute walk asks only for what it uses, as it always has.
func buildNode(
    role: String?, subrole: String?,
    title: () -> String?, desc: () -> String?, help: () -> String?, value: () -> CFTypeRef?,
    pos: CGPoint, size: CGSize, focused: Bool, enabled: Bool, children: [AXNode]
) -> AXNode {
    // Try multiple label fields in priority order; AXValue can be a string or a number.
    let label = ne(title()) ?? ne(desc()) ?? subrole.flatMap { subroleNames[$0] } ?? ne(help())

    // SECURITY: never expose password-field contents. macOS marks them with subrole AXSecureTextField.
    let isSecure = (subrole == "AXSecureTextField")

    var valueStr: String? = nil
    if !bboxOnly && !isSecure {
        let v = value()
        if let s = cfString(v) {
            valueStr = s
        } else if let n = cfNumber(v) {
            valueStr = String(describing: n)
        }
    } else if isSecure {
        valueStr = "[secure]"
    }

    return AXNode(
        role: role,
        subrole: subrole,
        label: sliceValue(label),
        value: sliceValue(valueStr),
        x: Int(pos.x),
        y: Int(pos.y),
        w: Int(size.width),
        h: Int(size.height),
        focusable: focused,
        enabled: enabled,
        children: children
    )
}

/// Walks children until the app hangs; the child whose call timed out is kept, the rest are skipped.
func walkKids(_ list: [AXUIElement], depth: Int, _ walker: (AXUIElement, Int) -> AXNode) -> [AXNode] {
    var kids: [AXNode] = []
    for c in list {
        if hung { break }
        kids.append(walker(c, depth + 1))
    }
    return kids
}

/// One IPC round-trip per attribute. The default; kept for parity and rollback.
func walkLegacy(_ el: AXUIElement, depth: Int) -> AXNode {
    let pos = cfPoint(axCopy(el, kAXPositionAttribute))
    let sz = cfSize(axCopy(el, kAXSizeAttribute))
    let role = cfString(axCopy(el, kAXRoleAttribute))
    let subrole = cfString(axCopy(el, kAXSubroleAttribute))
    let kids = depth < maxDepth
        ? walkKids(cfChildren(axCopy(el, kAXChildrenAttribute)), depth: depth, walkLegacy) : []
    return buildNode(
        role: role, subrole: subrole,
        title: { cfString(axCopy(el, kAXTitleAttribute)) },
        desc: { cfString(axCopy(el, kAXDescriptionAttribute)) },
        help: { cfString(axCopy(el, kAXHelpAttribute)) },
        value: { axCopy(el, kAXValueAttribute) },
        pos: pos, size: sz,
        focused: cfBool(axCopy(el, kAXFocusedAttribute)),
        enabled: cfBool(axCopy(el, kAXEnabledAttribute)),
        children: kids
    )
}

// Slot order of the batched read. Value is last so --bbox-only can leave it off.
// The value of an AXSecureTextField is read here and dropped by buildNode; it never
// leaves this process, the same as the per-attribute walk's guarantee on output.
let batchAttrs: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute,
    kAXEnabledAttribute, kAXChildrenAttribute, kAXValueAttribute,
]
let batchAttrsCF = (bboxOnly ? Array(batchAttrs.dropLast()) : batchAttrs) as CFArray

/// One AXUIElementCopyMultipleAttributeValues per node. A slot that failed comes back
/// as an AXValue of type .axError; it and any missing slot become nil, which the
/// converters turn into the same defaults the per-attribute reads give.
func axCopyBatch(_ el: AXUIElement) -> [CFTypeRef?] {
    var slots = [CFTypeRef?](repeating: nil, count: batchAttrs.count)
    if hung { return slots }
    var values: CFArray?
    let t0 = now()
    let err = AXUIElementCopyMultipleAttributeValues(
        el, batchAttrsCF, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    if err != .success { noteError(err, since: t0); return slots }
    guard let arr = values as [AnyObject]? else { return slots }
    for (idx, v) in arr.prefix(slots.count).enumerated() {
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError {
            var slotErr = AXError.success
            AXValueGetValue(v as! AXValue, .axError, &slotErr)
            noteError(slotErr, since: t0)
            continue
        }
        slots[idx] = v
    }
    return slots
}

func walkBatched(_ el: AXUIElement, depth: Int) -> AXNode {
    let s = axCopyBatch(el)
    let kids = depth < maxDepth ? walkKids(cfChildren(s[9]), depth: depth, walkBatched) : []
    return buildNode(
        role: cfString(s[0]), subrole: cfString(s[1]),
        title: { cfString(s[2]) }, desc: { cfString(s[3]) }, help: { cfString(s[4]) },
        value: { s[10] },
        pos: cfPoint(s[5]), size: cfSize(s[6]),
        focused: cfBool(s[7]), enabled: cfBool(s[8]),
        children: kids
    )
}

// ── Dump ──────────────────────────────────────────

let app = AXUIElementCreateApplication(pid)
if msgTimeoutOn {
    // The system-wide element sets this process's global timeout, which covers every
    // element we reach; the app element is set as well in case a per-element value wins.
    let t = Float(msgTimeoutMs) / 1000
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), t)
    AXUIElementSetMessagingTimeout(app, t)
}
// Electron apps (Slack, VS Code, Discord…) only build their tree for assistive
// tech that asks; other apps ignore the attribute. A cold tree fills in shortly
// after, which the caller's one-shot re-dump picks up.
let manualT0 = now()
noteError(AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue), since: manualT0)
let root = useBatch ? walkBatched(app, depth: 0) : walkLegacy(app, depth: 0)

struct Output: Encodable {
    let app: String
    let pid: Int32
    let root: AXNode
    let trusted: Bool
    let depth: Int
    let partial: Bool?  // omitted unless the app hung mid-walk
}

let out = Output(app: appName, pid: pid, root: root, trusted: true, depth: maxDepth, partial: hung ? true : nil)
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
