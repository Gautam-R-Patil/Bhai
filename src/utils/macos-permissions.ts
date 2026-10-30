// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * macOS permission probe.
 *
 * Verifies that the bot can actually USE Accessibility + Screen Recording — not
 * just that the binaries exist. Distinguishes:
 *   - GRANTED: probe succeeds, real data returned
 *   - DENIED: probe fails with a TCC-shaped error
 *   - STALE: toggle is on in System Settings but the bot's actual code-hash is
 *     not in the TCC database (common after a fresh DMG install of an unsigned
 *     / ad-hoc-signed app — the entry shows enabled but no longer matches).
 *
 * Logs actionable advice when something is wrong, including the exact tccutil
 * command to reset stale entries.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MacPermissionState {
    appleScript: { ok: boolean; reason?: string };
    screenRecording: { ok: boolean; reason?: string };
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * AppleScript probe — needs Accessibility / Apple Events permission to read
 * the frontmost-process name. If TCC denies, osascript exits non-zero with
 * stderr "1002" / "not authorized" / similar.
 */
async function probeAppleScript(): Promise<{ ok: boolean; reason?: string }> {
    try {
        const { stdout } = await execFileAsync(
            "osascript",
            ["-e", 'tell application "System Events" to get name of first process'],
            { timeout: PROBE_TIMEOUT_MS },
        );
        const name = stdout.trim();
        if (name.length === 0) return { ok: false, reason: "empty_response" };
        return { ok: true };
    } catch (err) {
        const e = err as { message?: string; stderr?: Buffer | string };
        const stderr = (e.stderr || "").toString();
        // -1743's text also says "not authorized", so check it first.
        const reason = stderr.includes("-1743")
            ? "tcc_denied_apple_events"
            : stderr.includes("1002") || stderr.toLowerCase().includes("not authorized")
              ? "tcc_denied"
              : e.message?.includes("timeout")
                ? "timeout"
                : (stderr.slice(0, 120) || e.message?.slice(0, 120) || "unknown_error");
        return { ok: false, reason };
    }
}

/**
 * Screen Recording probe — captures a 1x1 region and verifies the PNG has
 * non-trivial content. macOS without Screen Recording permission returns a
 * desktop-only screenshot (no windows) or fails outright depending on OS version.
 */
async function probeScreenRecording(): Promise<{ ok: boolean; reason?: string }> {
    const probePath = join(tmpdir(), `atlas_perm_probe_${Date.now()}.png`);
    try {
        // Capture the full screen (we need a real capture to detect window stripping)
        // -x = no sound, -t png
        await execFileAsync("screencapture", ["-x", "-t", "png", probePath], { timeout: PROBE_TIMEOUT_MS });
        const stat = await fs.stat(probePath).catch(() => null);
        if (!stat) {
            return { ok: false, reason: "screencapture_no_output" };
        }
        // A real desktop screenshot is typically 100KB+ on a modern Mac. A blank
        // fallback (denied permission) is much smaller. <20KB is a strong signal
        // of permission stripping.
        if (stat.size < 20_000) {
            return { ok: false, reason: `tcc_likely_denied_or_stale (capture=${stat.size}B, expected_>20KB)` };
        }
        return { ok: true };
    } catch (err) {
        const e = err as { message?: string; stderr?: Buffer | string };
        const stderr = (e.stderr || "").toString();
        return { ok: false, reason: stderr.slice(0, 120) || e.message?.slice(0, 120) || "unknown_error" };
    } finally {
        await fs.unlink(probePath).catch(() => {});
    }
}

export async function probeMacPermissions(): Promise<MacPermissionState> {
    if (process.platform !== "darwin") {
        return { appleScript: { ok: true }, screenRecording: { ok: true } };
    }
    const [appleScript, screenRecording] = await Promise.all([probeAppleScript(), probeScreenRecording()]);
    return { appleScript, screenRecording };
}

/**
 * Log probe results to console with actionable advice. Called at boot.
 */
export async function probeAndLogMacPermissions(): Promise<MacPermissionState> {
    const state = await probeMacPermissions();
    if (process.platform !== "darwin") return state;

    const axOk = state.appleScript.ok;
    const srOk = state.screenRecording.ok;

    if (axOk && srOk) {
        console.log("🔓 [permissions] Accessibility ✓  Screen Recording ✓  (vision-nav: all tiers available)");
        return state;
    }

    // The desktop app turns this into a "click to fix" notification: macOS can report a
    // stale grant as granted, so the app can't see this on its own. Only an assistive-access
    // denial means Accessibility; an Apple Events (Automation) denial or a slow System Events
    // launch would send the user to the wrong pane.
    const axDenied = state.appleScript.reason === "tcc_denied";
    if (axDenied || !srOk) console.log(`##ATLAS_PERMS##${JSON.stringify({ accessibility: !axDenied, screen: srOk })}`);
    console.warn("⚠️  [permissions] One or more macOS permissions missing — vision-nav will degrade:");
    if (!axOk) {
        console.warn(`   ✗ Accessibility / Apple Events: ${state.appleScript.reason}`);
        console.warn(`     → System Settings → Privacy & Security → Accessibility → enable Bhai`);
        console.warn(`     → If toggle is already ON: run \`tccutil reset Accessibility com.xagilabs.bhai\` then re-grant`);
    }
    if (!srOk) {
        console.warn(`   ✗ Screen Recording: ${state.screenRecording.reason}`);
        console.warn(`     → System Settings → Privacy & Security → Screen Recording → enable Bhai`);
        console.warn(`     → If toggle is already ON: run \`tccutil reset ScreenCapture com.xagilabs.bhai\` then re-grant`);
    }
    console.warn(`   → After granting, quit + relaunch Bhai`);

    return state;
}
