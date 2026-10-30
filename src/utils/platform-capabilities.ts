// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, homedir, release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PlatformCapabilities {
    platform: "darwin" | "win32" | "linux";
    arch: string;
    osRelease: string;
    shell: {
        type: "bash" | "gitbash" | "powershell7" | "powershell5" | "cmd";
        path: string;
    };
    screenshot: {
        available: boolean;
        engine: "screencapture" | "system.drawing" | "screenshot-desktop" | "scrot" | "grim" | null;
    };
    clipboard: {
        available: boolean;
        engine: "pbcopy" | "clipboardy" | "wl-copy" | "xclip" | "xsel" | null;
    };
    ocr: {
        available: boolean;
        engine: "swift" | "windows.media.ocr" | "tesseract" | null;
    };
    appAutomation: {
        applescript: boolean;
        powershellHelpers: boolean;
        xdotool: boolean;
        ydotool: boolean;
    };
    location: {
        available: boolean;
        engine: "corelocation" | "windows.geolocation" | "geoclue" | "wifi" | null;
    };
    browser: {
        playwright: boolean;
        nativeMessaging: boolean;
    };
    nativeModule: {
        loaded: boolean;
    };
    audio: {
        portaudio: boolean;
    };
}

let _cached: PlatformCapabilities | null = null;

async function probe(cmd: string, args: string[]): Promise<boolean> {
    try {
        await execFileAsync(cmd, args, { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
    if (_cached) return _cached;

    const p = process.platform as "darwin" | "win32" | "linux";

    // ── Shell detection ──────────────────────────
    let shell: PlatformCapabilities["shell"] = { type: "bash", path: "/bin/bash" };
    if (p === "win32") {
        const gitPaths = [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
        ];
        const found = gitPaths.find(existsSync);
        if (found) {
            shell = { type: "gitbash", path: found };
        } else if (await probe("pwsh", ["-NoProfile", "-Command", "exit 0"])) {
            shell = { type: "powershell7", path: "pwsh.exe" };
        } else {
            shell = { type: "powershell5", path: "powershell.exe" };
        }
    }

    // ── Screenshot ───────────────────────────────
    let screenshotEngine: PlatformCapabilities["screenshot"]["engine"] = null;
    if (p === "darwin") {
        screenshotEngine = "screencapture"; // always available
    } else if (p === "win32") {
        screenshotEngine = "system.drawing"; // PowerShell fallback always available
    } else {
        const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
        if (wayland && (await probe("grim", ["--help"]))) screenshotEngine = "grim";
        else if (await probe("scrot", ["--version"])) screenshotEngine = "scrot";
        else if (await probe("gnome-screenshot", ["--version"]))
            screenshotEngine = "scrot"; // use scrot slot
        else screenshotEngine = "screenshot-desktop"; // npm fallback
    }

    // ── Clipboard ────────────────────────────────
    let clipboardEngine: PlatformCapabilities["clipboard"]["engine"] = null;
    if (p === "darwin") {
        clipboardEngine = "pbcopy";
    } else if (p === "win32") {
        clipboardEngine = "clipboardy";
    } else {
        const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
        if (wayland && (await probe("wl-paste", ["--version"]))) clipboardEngine = "wl-copy";
        else if (await probe("xclip", ["-version"])) clipboardEngine = "xclip";
        else if (await probe("xsel", ["--version"])) clipboardEngine = "xsel";
    }

    // ── OCR ──────────────────────────────────────
    let ocrEngine: PlatformCapabilities["ocr"]["engine"] = null;
    if (p === "darwin") {
        ocrEngine = existsSync(join(process.cwd(), "scripts", "ocr_screen_bin")) ? "swift" : null;
    } else if (p === "win32") {
        ocrEngine = existsSync(join(process.cwd(), "scripts", "ocr_screen.ps1")) ? "windows.media.ocr" : null;
    } else {
        if (await probe("tesseract", ["--version"])) ocrEngine = "tesseract";
    }

    // ── App automation ───────────────────────────
    const appAutomation = {
        applescript: p === "darwin",
        powershellHelpers: p === "win32",
        xdotool: p === "linux" && (await probe("xdotool", ["version"])),
        ydotool: p === "linux" && (await probe("ydotool", ["--version"])),
    };

    // ── Location ─────────────────────────────────
    let locationEngine: PlatformCapabilities["location"]["engine"] = null;
    if (p === "darwin") locationEngine = "corelocation";
    else if (p === "win32") locationEngine = "windows.geolocation";
    else locationEngine = "geoclue";

    // ── Browser ──────────────────────────────────
    let playwrightAvailable = false;
    try {
        // Resolve, don't load: importing Playwright costs ~27 MB just to set a flag.
        createRequire(import.meta.url).resolve("playwright-core");
        playwrightAvailable = true;
    } catch {
        /* not installed */
    }

    const nmHostDir =
        p === "darwin"
            ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
            : p === "linux"
              ? join(homedir(), ".config", "google-chrome", "NativeMessagingHosts")
              : null;
    const nativeMessaging = nmHostDir ? existsSync(join(nmHostDir, "com.atlas.bridge.json")) : false;

    // ── Native module ────────────────────────────
    let nativeModuleLoaded = false;
    try {
        const mod = await import("../../native/index.js");
        nativeModuleLoaded = !!(mod as Record<string, unknown>).selectModel;
    } catch {
        /* not built */
    }

    // ── Audio ────────────────────────────────────
    const portaudio = await probe("python3", ["-c", "import sounddevice"]).catch(() => false);

    _cached = {
        platform: p,
        arch: arch(),
        osRelease: release(),
        shell,
        screenshot: { available: screenshotEngine !== null, engine: screenshotEngine },
        clipboard: { available: clipboardEngine !== null, engine: clipboardEngine },
        ocr: { available: ocrEngine !== null, engine: ocrEngine },
        appAutomation,
        location: { available: locationEngine !== null, engine: locationEngine },
        browser: { playwright: playwrightAvailable, nativeMessaging },
        nativeModule: { loaded: nativeModuleLoaded },
        audio: { portaudio },
    };

    if (process.env.ATLAS_SKIP_CAPABILITY_PROBE !== "true") {
        console.log(
            `⚡ [capabilities] platform=${p} shell=${_cached.shell.type} screenshot=${_cached.screenshot.engine} clipboard=${_cached.clipboard.engine} ocr=${_cached.ocr.engine} native=${_cached.nativeModule.loaded}`,
        );
    }

    return _cached;
}

export function formatCapabilitiesForContext(caps: PlatformCapabilities): string {
    const lines = [
        `Platform: ${caps.platform} (${caps.arch}) — OS ${caps.osRelease}`,
        `Shell: ${caps.shell.type} (${caps.shell.path})`,
        `Screenshot: ${caps.screenshot.available ? caps.screenshot.engine : "unavailable"}`,
        `Clipboard: ${caps.clipboard.available ? caps.clipboard.engine : "unavailable"}`,
        `OCR: ${caps.ocr.available ? caps.ocr.engine : "unavailable"}`,
        `App automation: ${
            [
                caps.appAutomation.applescript && "applescript",
                caps.appAutomation.powershellHelpers && "powershell-helpers",
                caps.appAutomation.xdotool && "xdotool",
                caps.appAutomation.ydotool && "ydotool",
            ]
                .filter(Boolean)
                .join(", ") || "none"
        }`,
        `Browser: playwright=${caps.browser.playwright} native-messaging=${caps.browser.nativeMessaging}`,
        `Native module: ${caps.nativeModule.loaded ? "loaded (SIMD-accelerated)" : "JS fallback"}`,
    ];
    return lines.join("\n");
}
