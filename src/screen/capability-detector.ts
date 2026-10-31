// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import * as fsSync from "node:fs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// One setup for everyone: accessibility tree → click memory → cloud grounding.
// "lite" only remains as a diagnostic override (it also skips OmniParser).
// The old "full" tier (local UI-TARS, ~4.5 GB) is gone; a stored "full" reads as standard.
export type VisionProfile = "lite" | "standard";

export type GpuClass = "none" | "integrated" | "discrete" | "apple-silicon";

export interface CapabilityReport {
    profile: VisionProfile;
    ramGB: number;
    freeRamGB: number;
    cpuCores: number;
    cpuModel: string;
    cpuBenchScore: number; // higher = faster; arbitrary scale (~1000 baseline modern laptop)
    gpu: GpuClass;
    gpuDetails?: string;
    diskFreeGB: number;
    online: boolean;
    deps: {
        python: boolean;
        pillow: boolean;
        ollama: boolean;
        cliclick: boolean;
        xdotool: boolean;
        accessibilityPermission: boolean;
    };
    notes: string[];
    detectedAt: number;
    cacheVersion: number;
}

const CACHE_VERSION = 1;
const CACHE_FILE = ".bhai-vision-capabilities.json";

const OVERRIDE_ENV = "BHAI_VISION_PROFILE";

let _cached: CapabilityReport | null = null;

/**
 * Detect host capabilities and pick a vision-nav profile. Result is cached
 * in-process for the lifetime of the process AND persisted to disk so the
 * benchmark only runs once per week or after a major hardware change.
 *
 * To force a re-probe: pass { force: true }.
 * To override the profile: set BHAI_VISION_PROFILE=lite|standard.
 */
export async function detectCapabilities(opts: { force?: boolean; cacheDir?: string } = {}): Promise<CapabilityReport> {
    if (!opts.force && _cached) return _cached;

    const cachePath = join(opts.cacheDir || os.tmpdir(), CACHE_FILE);
    if (!opts.force) {
        try {
            const cached = await fs.readFile(cachePath, "utf-8");
            const parsed = JSON.parse(cached) as CapabilityReport;
            const ageMs = Date.now() - parsed.detectedAt;
            const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
            if (parsed.cacheVersion === CACHE_VERSION && ageMs < WEEK_MS) {
                _cached = applyOverride(parsed);
                return _cached;
            }
        } catch {
            /* no cache or unreadable */
        }
    }

    const report = await probeCapabilities();
    _cached = applyOverride(report);

    try {
        await fs.writeFile(cachePath, JSON.stringify(report, null, 2), "utf-8");
    } catch {
        /* persist is best-effort */
    }

    return _cached;
}

export function clearCapabilityCache(): void {
    _cached = null;
}

function applyOverride(report: CapabilityReport): CapabilityReport {
    const override = process.env[OVERRIDE_ENV] || readProfileFromRuntimeEnv();
    if (override === "lite" || override === "standard") {
        return {
            ...report,
            profile: override,
            notes: [...report.notes, `Profile overridden by ${OVERRIDE_ENV}=${override}`],
        };
    }
    return report;
}

/**
 * Defense-in-depth fallback: when the desktop spawns the bot it writes the
 * user's wizard selections to `${BHAI_DATA_DIR}/.env.runtime` and points
 * dotenv at it via `DOTENV_CONFIG_PATH`. The production bundle obfuscates
 * dotenv's internals, and we've seen cases where the side-effect import
 * doesn't survive bundling — leaving `process.env.BHAI_VISION_PROFILE`
 * undefined even though the wizard correctly persisted "full". Parsing the
 * runtime env file directly bypasses that dependency.
 */
function readProfileFromRuntimeEnv(): string | undefined {
    try {
        const dataDir = process.env.BHAI_DATA_DIR;
        if (!dataDir) return undefined;
        const path = join(dataDir, ".env.runtime");
        // require-style sync read keeps applyOverride synchronous to match the
        // existing call sites; the file is < 1 KB on any real install.
        const fs = fsSync;
        if (!fs.existsSync(path)) return undefined;
        const raw = fs.readFileSync(path, "utf-8");
        // ATLAS_: a settings file written before the rename; a BHAI_ line wins over it.
        for (const prefix of ["BHAI", "ATLAS"]) {
            for (const line of raw.split(/\r?\n/)) {
                const m = line.match(new RegExp(`^\\s*${prefix}_VISION_PROFILE\\s*=\\s*(.+?)\\s*$`));
                if (m) {
                    const v = m[1].replace(/^['"]|['"]$/g, "");
                    if (v === "lite" || v === "standard") return v;
                }
            }
        }
    } catch {
        /* fall back to env-only */
    }
    return undefined;
}

async function probeCapabilities(): Promise<CapabilityReport> {
    const notes: string[] = [];

    const ramGB = totalmem() / 1024 ** 3;
    const freeRamGB = freemem() / 1024 ** 3;
    const cpuInfo = os.cpus();
    const cpuCores = cpuInfo.length;
    const cpuModel = cpuInfo[0]?.model || "unknown";

    const [gpu, diskFreeGB, online, deps, cpuBenchScore] = await Promise.all([
        detectGpu(),
        detectDiskFreeGB(),
        detectOnline(),
        detectDeps(),
        runCpuBench(),
    ]);

    if (!deps.python || !deps.pillow)
        notes.push("Python or Pillow missing — grid overlay will degrade to plain JPEG/PNG.");
    if (!deps.ollama) notes.push("Ollama not installed — local grounding models (UI-TARS) unavailable.");
    if (process.platform === "darwin" && !deps.accessibilityPermission)
        notes.push(
            "Accessibility permission not granted — multi-monitor focused-window detection will fall back to primary.",
        );
    if (process.platform === "linux" && !deps.xdotool)
        notes.push("xdotool missing — Linux click/type will not work outside Wayland fallback.");
    if (process.platform === "darwin" && !deps.cliclick)
        notes.push("cliclick missing — clicks will use slower JXA CGEvent fallback.");

    return {
        profile: "standard",
        ramGB: round(ramGB, 1),
        freeRamGB: round(freeRamGB, 1),
        cpuCores,
        cpuModel,
        cpuBenchScore,
        gpu: gpu.kind,
        gpuDetails: gpu.details,
        diskFreeGB: round(diskFreeGB, 1),
        online,
        deps,
        notes,
        detectedAt: Date.now(),
        cacheVersion: CACHE_VERSION,
    };
}


interface GpuDetection {
    kind: GpuClass;
    details?: string;
}

async function detectGpu(): Promise<GpuDetection> {
    try {
        if (process.platform === "darwin") return await detectMacGpu();
        if (process.platform === "win32") return await detectWinGpu();
        if (process.platform === "linux") return await detectLinuxGpu();
    } catch {
        /* fall through */
    }
    return { kind: "none" };
}

async function detectMacGpu(): Promise<GpuDetection> {
    try {
        const { stdout } = await execFileAsync("sysctl", ["-n", "hw.optional.arm64"], { timeout: 1500 });
        if (stdout.trim() === "1") {
            // Apple Silicon — unified memory; the integrated GPU is "discrete-class" for our purposes
            return { kind: "apple-silicon", details: "Apple Silicon (unified memory)" };
        }
    } catch {
        /* not arm64 or sysctl failed */
    }

    try {
        const { stdout } = await execFileAsync("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 3000 });
        const json = JSON.parse(stdout) as { SPDisplaysDataType?: Array<{ sppci_model?: string; _name?: string }> };
        const displays = json.SPDisplaysDataType || [];
        const names = displays.map((d) => d.sppci_model || d._name || "").join(" | ");
        if (/NVIDIA|AMD|Radeon/i.test(names)) return { kind: "discrete", details: names };
        if (/Intel/i.test(names)) return { kind: "integrated", details: names };
        if (names) return { kind: "integrated", details: names };
    } catch {
        /* fall through */
    }
    return { kind: "none" };
}

async function detectWinGpu(): Promise<GpuDetection> {
    try {
        const { stdout } = await execFileAsync(
            "powershell",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ],
            { timeout: 5000 },
        );
        const names = stdout.trim().split(/\r?\n/).filter(Boolean).join(" | ");
        if (/NVIDIA|RTX|GTX|Quadro/i.test(names)) return { kind: "discrete", details: names };
        if (/AMD|Radeon|RX/i.test(names)) return { kind: "discrete", details: names };
        if (/Intel|HD|UHD|Iris/i.test(names)) return { kind: "integrated", details: names };
        if (names) return { kind: "integrated", details: names };
    } catch {
        /* fall through */
    }
    return { kind: "none" };
}

async function detectLinuxGpu(): Promise<GpuDetection> {
    try {
        await execFileAsync("nvidia-smi", ["-L"], { timeout: 2000 });
        return { kind: "discrete", details: "NVIDIA (nvidia-smi)" };
    } catch {
        /* not nvidia */
    }
    try {
        const { stdout } = await execFileAsync("bash", ["-c", "lspci | grep -i 'vga\\|3d'"], { timeout: 2000 });
        if (/NVIDIA|AMD|Radeon/i.test(stdout)) return { kind: "discrete", details: stdout.trim() };
        if (/Intel/i.test(stdout)) return { kind: "integrated", details: stdout.trim() };
        if (stdout.trim()) return { kind: "integrated", details: stdout.trim() };
    } catch {
        /* fall through */
    }
    return { kind: "none" };
}

async function detectDiskFreeGB(): Promise<number> {
    try {
        if (process.platform === "win32") {
            const { stdout } = await execFileAsync(
                "powershell",
                ["-NoProfile", "-NonInteractive", "-Command", "(Get-PSDrive C).Free / 1GB"],
                { timeout: 3000 },
            );
            return Math.max(0, parseFloat(stdout.trim()) || 0);
        }
        // POSIX df. `-Pk` works on macOS BSD + Linux coreutils: -P forces POSIX
        // column layout (Available is index 3), -k forces 1 KiB blocks.
        // The previous `df -BG --output=avail /` used GNU long-form flags that
        // BSD df rejects with "invalid option -- B", silently returning 0 GB
        // free and pinning every Mac to the Lite vision profile regardless of
        // actual disk space.
        const { stdout } = await execFileAsync("df", ["-Pk", "/"], { timeout: 2000 });
        const lastLine = stdout.trim().split("\n").pop() || "";
        const cols = lastLine.split(/\s+/);
        const availKb = parseInt(cols[3] || "0", 10);
        if (availKb > 0) return Math.round(availKb / (1024 * 1024));
    } catch {
        /* fall through */
    }
    return 0;
}

async function detectOnline(): Promise<boolean> {
    try {
        await execFileAsync(
            process.platform === "win32" ? "powershell" : "bash",
            process.platform === "win32"
                ? ["-NoProfile", "-NonInteractive", "-Command", "(Test-Connection -Count 1 -Quiet 1.1.1.1)"]
                : ["-c", "ping -c 1 -W 2 1.1.1.1 > /dev/null 2>&1"],
            { timeout: 3000 },
        );
        return true;
    } catch {
        return false;
    }
}

async function detectDeps(): Promise<CapabilityReport["deps"]> {
    const [python, pillow, ollama, cliclick, xdotool, accessibilityPermission] = await Promise.all([
        commandExists(process.platform === "win32" ? "python" : "python3"),
        checkPillow(),
        commandExists("ollama"),
        process.platform === "darwin" ? commandExists("cliclick") : Promise.resolve(false),
        process.platform === "linux" ? commandExists("xdotool") : Promise.resolve(false),
        process.platform === "darwin" ? checkMacAccessibility() : Promise.resolve(true),
    ]);
    return { python, pillow, ollama, cliclick, xdotool, accessibilityPermission };
}

async function commandExists(cmd: string): Promise<boolean> {
    try {
        await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd], { timeout: 1500 });
        return true;
    } catch {
        return false;
    }
}

async function checkPillow(): Promise<boolean> {
    const py = process.platform === "win32" ? "python" : "python3";
    try {
        await execFileAsync(py, ["-c", "import PIL; print(PIL.__version__)"], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

async function checkMacAccessibility(): Promise<boolean> {
    // The reliable check is to call an AX API and see if it returns valid data.
    // System Events listing the focused process succeeds even without AX; querying
    // its WINDOWS requires AX. We try that.
    try {
        const { stdout } = await execFileAsync(
            "osascript",
            [
                "-l",
                "JavaScript",
                "-e",
                "try { var se = Application('System Events'); var apps = se.processes.whose({frontmost: true}); if (apps.length > 0) { var w = apps[0].windows; w.length; } else { 'no_apps'; } } catch(e) { 'denied:' + String(e); }",
            ],
            { timeout: 2500 },
        );
        return !stdout.trim().startsWith("denied:");
    } catch {
        return false;
    }
}

async function runCpuBench(): Promise<number> {
    // Float32 GEMM-like microbench. Higher = faster.
    // Sized so M-series finishes in ~5–15 ms (1 ms `Date.now()` resolution
    // previously saturated to ~1,000,000 ops/ms on Apple Silicon, making the
    // signal meaningless above the threshold). `performance.now()` gives µs
    // precision so we don't have to inflate the workload further.
    const N = 200;
    const ITERS = 200;
    const a = new Float32Array(N * N);
    const x = new Float32Array(N);
    const y = new Float32Array(N);
    for (let i = 0; i < N * N; i++) a[i] = Math.random();
    for (let i = 0; i < N; i++) x[i] = Math.random();

    const { performance } = await import("node:perf_hooks");
    const start = performance.now();
    for (let iter = 0; iter < ITERS; iter++) {
        for (let i = 0; i < N; i++) {
            let acc = 0;
            for (let j = 0; j < N; j++) acc += a[i * N + j] * x[j];
            y[i] = acc;
        }
    }
    const elapsedMs = Math.max(0.001, performance.now() - start);
    const totalOps = N * N * ITERS;
    // Hard ceiling at 50k — anything beyond is noise from a sub-ms outlier.
    return Math.min(50_000, Math.round(totalOps / elapsedMs));
}

function round(n: number, decimals: number): number {
    const m = 10 ** decimals;
    return Math.round(n * m) / m;
}

/**
 * Summarize the capability report into a one-liner for logs.
 */
export function summarizeCapabilities(c: CapabilityReport): string {
    const parts = [
        `profile=${c.profile}`,
        `ram=${c.ramGB}GB`,
        `cpu=${c.cpuCores}c bench=${c.cpuBenchScore}`,
        `gpu=${c.gpu}${c.gpuDetails ? `(${c.gpuDetails.slice(0, 40)})` : ""}`,
        `disk=${c.diskFreeGB}GB`,
        c.online ? "online" : "offline",
    ];
    if (c.notes.length > 0) parts.push(`notes=${c.notes.length}`);
    return parts.join(" ");
}
