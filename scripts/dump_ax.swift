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
//   An optional top-level "partial": true means an AX read hit the messaging timeout,
//   so some of the tree is missing (only with ATLAS_AX_MSG_TIMEOUT_MS set).
//
// Environment switches (both opt-in; unset = the old per-attribute walk, system timeout):
//   ATLAS_AX_BATCH=true            one AXUIElementCopyMultipleAttributeValues per node
//                                  instead of one IPC per attribute
//   ATLAS_AX_MSG_TIMEOUT_MS=N      per-call AX messaging timeout (clamped 100-5000). Two
//                                  timeouts in a row count as a hung app and end the walk.
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
/// nil = timeout off: the system default (~6s) applies and no hang tracking runs,
/// exactly the walk this helper had before the timeout existed.
let msgTimeoutMs: Int? = Int(env["ATLAS_AX_MSG_TIMEOUT_MS"] ?? "").flatMap { $0 > 0 ? max(100, min(5000, $0)) : nil }
// A kAXErrorCannotComplete that comes back fast is an app quirk, not a timeout: only a
// call that ran for at least half the timeout counts.
let hangNs: UInt64? = msgTimeoutMs.map { UInt64($0) * 500_000 }

/// Consecutive timed-out calls. One is a slow call (the app is busy, the walk goes on);
/// two in a row is a hung app, so every later call is skipped (`hung`) and the dump
/// costs two timeouts instead of one per attribute per node.
var strikes = 0
var hung = false
/// Some read was lost to the timeout, so the tree is incomplete: output "partial".
var lostRead = false

func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

/// Records every AX call's outcome. `read: false` for the AXManualAccessibility set,
/// which can strike but loses no data.
func note(_ err: AXError, since t0: UInt64, read: Bool = true) {
    guard let hangNs = hangNs else { return }
    if err == .cannotComplete && now() - t0 >= hangNs {
        strikes += 1
        if read { lostRead = true }
        if strikes >= 2 { hung = true }
    } else {
        strikes = 0
    }
}

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    if hung { return nil }
    var v: CFTypeRef?
    let t0 = now()
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    note(err, since: t0)
    return err == .success ? v : nil
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

/// Label and value, read in the order the per-attribute walk always used. Label
/// readers are lazy so it asks only for what it uses. Both walks read AXValue here,
/// per node, and never for a secure field: a password is not even requested.
func labelAndValue(
    _ el: AXUIElement, subrole: String?,
    title: () -> String?, desc: () -> String?, help: () -> String?
) -> (String?, String?) {
    // Try multiple label fields in priority order; AXValue can be a string or a number.
    let label = ne(title()) ?? ne(desc()) ?? subrole.flatMap { subroleNames[$0] } ?? ne(help())

    // SECURITY: never expose password-field contents. macOS marks them with subrole AXSecureTextField.
    let isSecure = (subrole == "AXSecureTextField")

    var valueStr: String? = nil
    if !bboxOnly && !isSecure {
        let v = axCopy(el, kAXValueAttribute)
        if let s = cfString(v) {
            valueStr = s
        } else if let n = cfNumber(v) {
            valueStr = String(describing: n)
        }
    } else if isSecure {
        valueStr = "[secure]"
    }
    return (sliceValue(label), sliceValue(valueStr))
}

func makeNode(
    role: String?, subrole: String?, labelValue: (String?, String?),
    pos: CGPoint, size: CGSize, focused: Bool, enabled: Bool, children: [AXNode]
) -> AXNode {
    AXNode(
        role: role, subrole: subrole, label: labelValue.0, value: labelValue.1,
        x: Int(pos.x), y: Int(pos.y), w: Int(size.width), h: Int(size.height),
        focusable: focused, enabled: enabled, children: children
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

/// One IPC round-trip per attribute. The default; same read order as before batching
/// (rect, role, label, value, children, then focused/enabled).
func walkLegacy(_ el: AXUIElement, depth: Int) -> AXNode {
    let pos = cfPoint(axCopy(el, kAXPositionAttribute))
    let sz = cfSize(axCopy(el, kAXSizeAttribute))
    let role = cfString(axCopy(el, kAXRoleAttribute))
    let subrole = cfString(axCopy(el, kAXSubroleAttribute))
    let lv = labelAndValue(
        el, subrole: subrole,
        title: { cfString(axCopy(el, kAXTitleAttribute)) },
        desc: { cfString(axCopy(el, kAXDescriptionAttribute)) },
        help: { cfString(axCopy(el, kAXHelpAttribute)) })
    let kids = depth < maxDepth
        ? walkKids(cfChildren(axCopy(el, kAXChildrenAttribute)), depth: depth, walkLegacy) : []
    return makeNode(
        role: role, subrole: subrole, labelValue: lv, pos: pos, size: sz,
        focused: cfBool(axCopy(el, kAXFocusedAttribute)),
        enabled: cfBool(axCopy(el, kAXEnabledAttribute)),
        children: kids
    )
}

// Slot order of the batched read. AXValue is not here: labelAndValue reads it per
// node, after the subrole is known, so a secure field's value is never requested.
let batchAttrs: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute,
    kAXEnabledAttribute, kAXChildrenAttribute,
]
let batchAttrsCF = batchAttrs as CFArray

/// One AXUIElementCopyMultipleAttributeValues per node. A slot that failed comes back
/// as an AXValue of type .axError and becomes nil, which the converters turn into the
/// same defaults a failed per-attribute read gives; a cannotComplete slot is re-read on
/// its own (below), never timed against the whole batch. When the whole call fails (a toolkit
/// without the multi-attribute message, a quick error, one slow reply) the node is
/// re-read one attribute at a time, unless the app is now considered hung.
func axCopyBatch(_ el: AXUIElement) -> [CFTypeRef?] {
    if hung { return [CFTypeRef?](repeating: nil, count: batchAttrs.count) }
    var values: CFArray?
    let t0 = now()
    let err = AXUIElementCopyMultipleAttributeValues(
        el, batchAttrsCF, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    note(err, since: t0)
    if err == .success, let arr = values as [AnyObject]?, arr.count == batchAttrs.count {
        return arr.enumerated().map { idx, v in
            guard CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError else { return v }
            var slotErr = AXError.success
            AXValueGetValue(v as! AXValue, .axError, &slotErr)
            // A slot can time out inside a reply that succeeded (AppKit answers each
            // attribute in turn). The slot can't be timed on its own, so re-read just
            // that attribute: it is timed, and a lost read is flagged, like the default walk.
            return slotErr == .cannotComplete ? axCopy(el, batchAttrs[idx]) : nil
        }
    }
    return batchAttrs.map { axCopy(el, $0) }
}

func walkBatched(_ el: AXUIElement, depth: Int) -> AXNode {
    let s = axCopyBatch(el)
    let subrole = cfString(s[1])
    let lv = labelAndValue(
        el, subrole: subrole,
        title: { cfString(s[2]) }, desc: { cfString(s[3]) }, help: { cfString(s[4]) })
    let kids = depth < maxDepth ? walkKids(cfChildren(s[9]), depth: depth, walkBatched) : []
    return makeNode(
        role: cfString(s[0]), subrole: subrole, labelValue: lv,
        pos: cfPoint(s[5]), size: cfSize(s[6]),
        focused: cfBool(s[7]), enabled: cfBool(s[8]),
        children: kids
    )
}

// ── Dump ──────────────────────────────────────────

let app = AXUIElementCreateApplication(pid)
if let ms = msgTimeoutMs {
    // The system-wide element sets this process's global timeout, which covers every
    // element we reach; the app element is set as well in case a per-element value wins.
    let t = Float(ms) / 1000
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), t)
    AXUIElementSetMessagingTimeout(app, t)
}
// Electron apps (Slack, VS Code, Discord…) only build their tree for assistive
// tech that asks; other apps ignore the attribute. A cold tree fills in shortly
// after, which the caller's one-shot re-dump picks up. A slow set is one strike, not a
// hang on its own: the walk still runs.
let manualT0 = now()
note(AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue), since: manualT0, read: false)
let root = useBatch ? walkBatched(app, depth: 0) : walkLegacy(app, depth: 0)

struct Output: Encodable {
    let app: String
    let pid: Int32
    let root: AXNode
    let trusted: Bool
    let depth: Int
    let partial: Bool?  // omitted unless a read timed out
}

let out = Output(app: appName, pid: pid, root: root, trusted: true, depth: maxDepth, partial: lostRead || hung ? true : nil)
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
