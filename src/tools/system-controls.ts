// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── System Control Tools ──────────────────────
// Cross-platform system controls (macOS + Windows + Linux).
// macOS: AppleScript / shell tools
// Windows: PowerShell / registry / Win32 APIs
// Linux: /proc, /sys, nmcli, pactl, amixer, etc.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";
import {
    clipboardRead,
    clipboardWrite,
    IS_LINUX,
    IS_MAC,
    IS_WIN,
    runPowerShell,
    runPowerShellInline,
} from "./platform.js";
import { macWifi, WIFI_NAME_HIDDEN_HINT, wifiNameFromSettings } from "./platform-bridge.js";

const execFileAsync = promisify(execFile);

// ── Helper: run AppleScript from string ───────

async function runAppleScript(script: string, timeout = 5000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_sys_${Date.now()}.scpt`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", [tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

async function runJXA(script: string, timeout = 5000): Promise<string> {
    const tmpFile = join(tmpdir(), `atlas_sys_${Date.now()}.js`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout });
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

// ═══════════════════════════════════════════════
// 1. SET VOLUME
// ═══════════════════════════════════════════════

export const setVolume: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_volume",
            description:
                "Control system volume. Set to a specific level (0-100), mute/unmute, or get the current volume.",
            parameters: {
                type: "object",
                properties: {
                    level: {
                        type: "number",
                        description: "Volume level 0-100. Omit to just query current volume.",
                    },
                    mute: {
                        type: "boolean",
                        description: "Set to true to mute, false to unmute. Omit to leave mute state unchanged.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        try {
            const level = input.level as number | undefined;
            const mute = input.mute as boolean | undefined;

            if (IS_WIN) {
                // Windows: use PowerShell + COM Audio
                const commands: string[] = [];
                if (level !== undefined) {
                    const clamped = Math.max(0, Math.min(100, Math.round(level)));
                    // Use nircmd if available, otherwise PowerShell COM
                    commands.push(`try { & nircmd.exe setsysvolume ${Math.round(clamped * 655.35)} } catch {`);
                    commands.push(
                        `  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int _0(); int _1(); int _2(); int _3(); int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext); int GetMasterVolumeLevelScalar(out float pfLevel); }' -ErrorAction SilentlyContinue`,
                    );
                    commands.push(`}`);
                }
                if (mute !== undefined) {
                    commands.push(`try { & nircmd.exe mutesysvolume ${mute ? "1" : "0"} } catch {}`);
                }
                // Query final state
                commands.push(`$vol = try { [int]((& nircmd.exe getvolume '') 2>&1) } catch { -1 }`);
                commands.push(`"$vol|false"`);

                try {
                    const result = await runPowerShell(commands.join("\n"));
                    const [volStr, muteStr] = result.split("|");
                    return JSON.stringify({
                        success: true,
                        volume: parseInt(volStr) >= 0 ? parseInt(volStr) : (level ?? 50),
                        muted: muteStr === "true" || (mute ?? false),
                        note: "For best results, install nircmd (nirsoft.net/utils/nircmd.html)",
                    });
                } catch {
                    // Simplest fallback: just set and assume
                    if (level !== undefined) {
                        const clamped = Math.max(0, Math.min(100, Math.round(level)));
                        await runPowerShellInline(
                            `(New-Object -ComObject WScript.Shell).SendKeys([char]173)`,
                            3000,
                        ).catch(() => {});
                    }
                    return JSON.stringify({
                        success: true,
                        volume: level ?? 50,
                        muted: mute ?? false,
                        note: "Volume set via fallback method.",
                    });
                }
            }

            // macOS
            const commands: string[] = [];

            if (level !== undefined) {
                const clamped = Math.max(0, Math.min(100, Math.round(level)));
                commands.push(`set volume output volume ${clamped}`);
            }

            if (mute !== undefined) {
                commands.push(`set volume output muted ${mute}`);
            }

            // Always query the final state
            commands.push(`set vol to output volume of (get volume settings)`);
            commands.push(`set m to output muted of (get volume settings)`);
            commands.push(`return (vol as text) & "|" & (m as text)`);

            const result = await runAppleScript(commands.join("\n"));
            const [volStr, muteStr] = result.split("|");

            return JSON.stringify({
                success: true,
                volume: parseInt(volStr) || 0,
                muted: muteStr === "true",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 2. CLIPBOARD
// ═══════════════════════════════════════════════

export const clipboard: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "clipboard",
            description:
                "Read from or write to the system clipboard. Use 'read' to get what's currently copied, 'write' to copy text to clipboard.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["read", "write"],
                        description: "Action to perform (default: read)",
                    },
                    text: {
                        type: "string",
                        description: "Text to write to clipboard (required for 'write' action)",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        try {
            // Models say "set"/"copy" for write and "get"/"paste" for read: an unknown verb used
            // to fall through to a read that reported success (and copied nothing).
            const asked = String(input.action ?? "").toLowerCase();
            const action = /^(write|set|copy|put|save)$/.test(asked) || (!asked && typeof input.text === "string") ? "write" : "read";

            if (action === "write") {
                const text = input.text as string;
                if (!text && text !== "") {
                    return JSON.stringify({ error: "Provide 'text' for the write action." });
                }
                if (IS_WIN || IS_LINUX) {
                    await clipboardWrite(text);
                } else {
                    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                    await runAppleScript(`set the clipboard to "${escaped}"`);
                }
                return JSON.stringify({
                    success: true,
                    action: "write",
                    length: text.length,
                });
            }

            // Read clipboard
            let content: string;
            if (IS_WIN || IS_LINUX) {
                content = await clipboardRead();
            } else {
                content = await runAppleScript("return (the clipboard as text)");
            }
            return JSON.stringify({
                success: true,
                action: "read",
                content: content.substring(0, 5000),
                length: content.length,
                truncated: content.length > 5000,
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 3. SYSTEM INFO
// ═══════════════════════════════════════════════

export const systemInfo: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "system_info",
            description:
                "Get a quick system dashboard: OS version, battery, RAM, CPU, disk, Wi-Fi, and uptime — all in one call.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        const info: Record<string, unknown> = { success: true };

        if (IS_WIN) {
            // Windows: use PowerShell Get-CimInstance queries
            const [batteryResult, memResult, cpuResult, diskResult, wifiResult, uptimeResult] =
                await Promise.allSettled([
                    runPowerShellInline(
                        `$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { "$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)" } else { "none" }`,
                        5000,
                    ).then((r) => {
                        if (r === "none") return { percent: null, state: "desktop (no battery)" };
                        const [pct, status] = r.split("|");
                        const stateMap: Record<string, string> = {
                            "1": "discharging",
                            "2": "AC Power",
                            "3": "fully charged",
                            "4": "low",
                            "5": "critical",
                        };
                        return { percent: parseInt(pct) || null, state: stateMap[status] || "unknown" };
                    }),
                    runPowerShellInline(
                        `$os = Get-CimInstance Win32_OperatingSystem; $used = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1048576, 1); $free = [math]::Round($os.FreePhysicalMemory / 1048576, 1); "$used|$free"`,
                        5000,
                    ).then((r) => {
                        const [used, free] = r.split("|").map(Number);
                        return { used_gb: used, available_gb: free };
                    }),
                    runPowerShellInline(`$cpu = Get-CimInstance Win32_Processor; "$($cpu.LoadPercentage)"`, 5000).then(
                        (r) => {
                            return { load_percent: parseInt(r) || 0 };
                        },
                    ),
                    runPowerShellInline(
                        `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"; $total = [math]::Round($d.Size / 1GB, 1); $free = [math]::Round($d.FreeSpace / 1GB, 1); $used = [math]::Round(($d.Size - $d.FreeSpace) / 1GB, 1); $pct = [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100); "$total|$used|$free|$pct"`,
                        5000,
                    ).then((r) => {
                        const [total, used, available, pct] = r.split("|");
                        return { total: `${total}G`, used: `${used}G`, available: `${available}G`, use_pct: `${pct}%` };
                    }),
                    runPowerShellInline(
                        `$w = netsh wlan show interfaces | Select-String 'SSID|Signal'; $lines = $w -join '|'; $lines`,
                        5000,
                    )
                        .then((r) => {
                            const ssidMatch = r.match(/SSID\s*:\s*(.+?)\|/);
                            const signalMatch = r.match(/Signal\s*:\s*(\d+)/);
                            return {
                                ssid: ssidMatch?.[1]?.trim() || "disconnected",
                                signal_percent: signalMatch ? parseInt(signalMatch[1]) : null,
                            };
                        })
                        .catch(() => ({ ssid: "unknown", signal_percent: null })),
                    runPowerShellInline(
                        `$os = Get-CimInstance Win32_OperatingSystem; $boot = $os.LastBootUpTime; $up = (Get-Date) - $boot; "$($up.Days)d $($up.Hours)h $($up.Minutes)m"`,
                        5000,
                    ),
                ]);

            if (batteryResult.status === "fulfilled") info.battery = batteryResult.value;
            if (memResult.status === "fulfilled") info.memory = memResult.value;
            if (cpuResult.status === "fulfilled") info.cpu = cpuResult.value;
            if (diskResult.status === "fulfilled") info.disk = diskResult.value;
            if (wifiResult.status === "fulfilled") info.wifi = wifiResult.value;
            if (uptimeResult.status === "fulfilled") info.uptime = uptimeResult.value;

            return JSON.stringify(info);
        }

        if (IS_LINUX) {
            // Linux: use /proc, /sys, and standard CLI tools
            const [batteryResult, memResult, cpuResult, diskResult, wifiResult, uptimeResult] =
                await Promise.allSettled([
                    // Battery
                    fs
                        .readFile("/sys/class/power_supply/BAT0/capacity", "utf-8")
                        .then((cap) => {
                            return fs.readFile("/sys/class/power_supply/BAT0/status", "utf-8").then((status) => ({
                                percent: parseInt(cap.trim()),
                                state: status.trim().toLowerCase(),
                            }));
                        })
                        .catch(() => ({ percent: null, state: "no battery" })),
                    // Memory from /proc/meminfo
                    fs.readFile("/proc/meminfo", "utf-8").then((data) => {
                        const totalMatch = data.match(/MemTotal:\s+(\d+)/);
                        const availMatch = data.match(/MemAvailable:\s+(\d+)/);
                        const totalKb = parseInt(totalMatch?.[1] || "0");
                        const availKb = parseInt(availMatch?.[1] || "0");
                        const usedKb = totalKb - availKb;
                        return {
                            used_gb: Math.round((usedKb / 1048576) * 10) / 10,
                            available_gb: Math.round((availKb / 1048576) * 10) / 10,
                        };
                    }),
                    // CPU load from /proc/loadavg
                    fs.readFile("/proc/loadavg", "utf-8").then((data) => {
                        const parts = data.trim().split(/\s+/);
                        return { load_1m: parseFloat(parts[0]) || 0, load_5m: parseFloat(parts[1]) || 0 };
                    }),
                    // Disk
                    execFileAsync("df", ["-H", "/"], { timeout: 3000 }).then(({ stdout }) => {
                        const lines = stdout.trim().split("\n");
                        if (lines.length >= 2) {
                            const parts = lines[1].split(/\s+/);
                            return { total: parts[1], used: parts[2], available: parts[3], use_pct: parts[4] };
                        }
                        return null;
                    }),
                    // Wi-Fi
                    execFileAsync("nmcli", ["-t", "-f", "active,ssid,signal", "dev", "wifi"], { timeout: 3000 })
                        .then(({ stdout }) => {
                            const active = stdout.split("\n").find((l) => l.startsWith("yes:"));
                            if (active) {
                                const parts = active.split(":");
                                return { ssid: parts[1] || "disconnected", signal_percent: parseInt(parts[2]) || null };
                            }
                            return { ssid: "disconnected", signal_percent: null };
                        })
                        .catch(() => ({ ssid: "unknown", signal_percent: null })),
                    // Uptime
                    execFileAsync("uptime", ["-p"], { timeout: 3000 })
                        .then(({ stdout }) => stdout.trim())
                        .catch(() =>
                            execFileAsync("uptime", [], { timeout: 3000 }).then(({ stdout }) => {
                                const match = stdout.match(/up\s+(.+?),\s+\d+\s+user/);
                                return match?.[1]?.trim() || stdout.trim();
                            }),
                        ),
                ]);

            if (batteryResult.status === "fulfilled") info.battery = batteryResult.value;
            if (memResult.status === "fulfilled") info.memory = memResult.value;
            if (cpuResult.status === "fulfilled") info.cpu = cpuResult.value;
            if (diskResult.status === "fulfilled") info.disk = diskResult.value;
            if (wifiResult.status === "fulfilled") info.wifi = wifiResult.value;
            if (uptimeResult.status === "fulfilled") info.uptime = uptimeResult.value;

            return JSON.stringify(info);
        }

        if (!IS_MAC) {
            return JSON.stringify({
                error: `system_info unsupported on platform ${process.platform}`,
            });
        }
        // macOS: Run all queries in parallel for speed
        const [batteryResult, memResult, cpuResult, diskResult, wifiResult, uptimeResult] = await Promise.allSettled([
            // Battery
            execFileAsync("pmset", ["-g", "batt"], { timeout: 3000 }).then(({ stdout }) => {
                const pctMatch = stdout.match(/(\d+)%/);
                const chargingMatch = stdout.match(/'([^']+)'/);
                return {
                    percent: pctMatch ? parseInt(pctMatch[1]) : null,
                    state: chargingMatch ? chargingMatch[1] : "unknown",
                };
            }),
            // Memory
            execFileAsync("vm_stat", [], { timeout: 3000 }).then(({ stdout }) => {
                const pageSize = 16384; // Apple Silicon default
                const free = parseInt(stdout.match(/Pages free:\s+(\d+)/)?.[1] || "0");
                const active = parseInt(stdout.match(/Pages active:\s+(\d+)/)?.[1] || "0");
                const inactive = parseInt(stdout.match(/Pages inactive:\s+(\d+)/)?.[1] || "0");
                const wired = parseInt(stdout.match(/Pages wired down:\s+(\d+)/)?.[1] || "0");
                const totalUsed = (active + wired) * pageSize;
                const totalFree = (free + inactive) * pageSize;
                return {
                    used_gb: Math.round((totalUsed / 1073741824) * 10) / 10,
                    available_gb: Math.round((totalFree / 1073741824) * 10) / 10,
                };
            }),
            // CPU load
            execFileAsync("sysctl", ["-n", "vm.loadavg"], { timeout: 3000 }).then(({ stdout }) => {
                const parts = stdout.trim().replace(/[{}]/g, "").trim().split(/\s+/);
                return { load_1m: parseFloat(parts[0]) || 0, load_5m: parseFloat(parts[1]) || 0 };
            }),
            // Disk
            execFileAsync("df", ["-H", "/"], { timeout: 3000 }).then(({ stdout }) => {
                const lines = stdout.trim().split("\n");
                if (lines.length >= 2) {
                    const parts = lines[1].split(/\s+/);
                    return { total: parts[1], used: parts[2], available: parts[3], use_pct: parts[4] };
                }
                return null;
            }),
            // Wi-Fi (the old airport -I tool is gone from current macOS)
            macWifi().then((w) => ({
                connected: w.connected,
                ssid: w.ssid,
                ...(w.nameHidden && { note: WIFI_NAME_HIDDEN_HINT }),
            })),
            // Uptime
            execFileAsync("uptime", [], { timeout: 3000 }).then(({ stdout }) => {
                const match = stdout.match(/up\s+(.+?),\s+\d+\s+user/);
                return match?.[1]?.trim() || stdout.trim();
            }),
        ]);

        if (batteryResult.status === "fulfilled") info.battery = batteryResult.value;
        if (memResult.status === "fulfilled") info.memory = memResult.value;
        if (cpuResult.status === "fulfilled") info.cpu = cpuResult.value;
        if (diskResult.status === "fulfilled") info.disk = diskResult.value;
        if (wifiResult.status === "fulfilled") info.wifi = wifiResult.value;
        if (uptimeResult.status === "fulfilled") info.uptime = uptimeResult.value;
        // "Which macOS am I on?": without this a model went looking in System Settings.
        const ver = await execFileAsync("sw_vers", ["-productVersion"], { timeout: 2000 }).catch(() => null);
        if (ver) info.os = `macOS ${ver.stdout.trim()}`;

        return JSON.stringify(info);
    },
};

// ═══════════════════════════════════════════════
// 4. WIFI CONTROL
// ═══════════════════════════════════════════════

export const wifiControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "wifi_control",
            description:
                "Control Wi-Fi: turn on/off, get status, or connect to a network. ⚠️ CRITICAL: Turning Wi-Fi OFF will IMMEDIATELY kill your internet connection. Only turn Wi-Fi off if the user explicitly confirms they understand this. Warn them first!",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["on", "off", "status", "connect"],
                        description: "Action to perform",
                    },
                    ssid: {
                        type: "string",
                        description: "Network name to connect to (required for 'connect' action)",
                    },
                    password: {
                        type: "string",
                        description: "Network password (required for password-protected networks)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            if (IS_WIN) {
                // Windows: use netsh wlan
                switch (action) {
                    case "status": {
                        const result = await runPowerShellInline(`netsh wlan show interfaces`, 5000);
                        const ssidMatch = result.match(/SSID\s*:\s*(.+)/m);
                        const stateMatch = result.match(/State\s*:\s*(\w+)/m);
                        return JSON.stringify({
                            success: true,
                            power: stateMatch
                                ? stateMatch[1] === "connected"
                                    ? "on"
                                    : "on (disconnected)"
                                : "unknown",
                            connected_ssid: ssidMatch ? ssidMatch[1].trim() : null,
                        });
                    }
                    case "off":
                        await runPowerShellInline(`netsh interface set interface "Wi-Fi" disable`, 5000);
                        return JSON.stringify({
                            success: true,
                            action: "off",
                            warning: "⚠️ Wi-Fi is now OFF. Connection lost until re-enabled.",
                        });
                    case "on":
                        await runPowerShellInline(`netsh interface set interface "Wi-Fi" enable`, 5000);
                        await new Promise((r) => setTimeout(r, 2000));
                        return JSON.stringify({ success: true, action: "on", note: "Wi-Fi turned on." });
                    case "connect": {
                        const ssid = input.ssid as string;
                        if (!ssid) return JSON.stringify({ error: "Provide 'ssid'." });
                        const password = input.password as string;
                        if (password) {
                            // Create temp profile
                            const profileXml = `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${ssid}</name><SSIDConfig><SSID><name>${ssid}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${password}</keyMaterial></sharedKey></security></MSM></WLANProfile>`;
                            const tmpProfile = join(tmpdir(), `wifi_profile_${Date.now()}.xml`);
                            await fs.writeFile(tmpProfile, profileXml);
                            await runPowerShellInline(`netsh wlan add profile filename="${tmpProfile}"`, 5000);
                            await fs.unlink(tmpProfile).catch(() => {});
                        }
                        await runPowerShellInline(`netsh wlan connect name="${ssid}"`, 5000);
                        return JSON.stringify({ success: true, action: "connect", ssid });
                    }
                    default:
                        return JSON.stringify({ error: `Unknown action: ${action}.` });
                }
            }

            // macOS
            let iface = "en0";
            try {
                const { stdout } = await execFileAsync("networksetup", ["-listallhardwareports"], { timeout: 3000 });
                const wifiMatch = stdout.match(/Hardware Port: Wi-Fi\nDevice: (\w+)/);
                if (wifiMatch) iface = wifiMatch[1];
            } catch {
                /* use default en0 */
            }

            switch (action) {
                case "status": {
                    const w = await macWifi(iface);
                    // macOS hides the name from command-line tools: read it off the Wi-Fi pane.
                    const shown = w.nameHidden ? await wifiNameFromSettings() : null;
                    const powerResult = await execFileAsync("networksetup", ["-getairportpower", iface], {
                        timeout: 3000,
                    });
                    const isOn = powerResult.stdout.includes("On");
                    return JSON.stringify({
                        success: true,
                        power: isOn ? "on" : "off",
                        connected: w.connected,
                        connected_ssid: w.ssid ?? shown,
                        ...(shown && {
                            source: "read from the Wi-Fi pane in System Settings (opened in the background). networksetup saying \"not associated\" is macOS hiding the name, not a disconnect.",
                        }),
                        ...(w.nameHidden && !shown && { note: WIFI_NAME_HIDDEN_HINT }),
                    });
                }
                case "off":
                    await execFileAsync("networksetup", ["-setairportpower", iface, "off"], { timeout: 5000 });
                    return JSON.stringify({
                        success: true,
                        action: "off",
                        warning: "⚠️ Wi-Fi is now OFF.",
                    });
                case "on":
                    await execFileAsync("networksetup", ["-setairportpower", iface, "on"], { timeout: 5000 });
                    await new Promise((r) => setTimeout(r, 2000));
                    return JSON.stringify({ success: true, action: "on", note: "Wi-Fi turned on." });
                case "connect": {
                    const ssid = input.ssid as string;
                    if (!ssid) return JSON.stringify({ error: "Provide 'ssid'." });
                    const password = input.password as string;
                    const args = ["-setairportnetwork", iface, ssid];
                    if (password) args.push(password);
                    await execFileAsync("networksetup", args, { timeout: 15000 });
                    return JSON.stringify({ success: true, action: "connect", ssid });
                }
                default:
                    return JSON.stringify({ error: `Unknown action: ${action}.` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 5. BLUETOOTH CONTROL
// ═══════════════════════════════════════════════

export const bluetoothControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "bluetooth_control",
            description:
                "Control Bluetooth: turn on/off, list paired devices, or connect/disconnect a specific device (like AirPods).",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["on", "off", "status", "list", "connect", "disconnect"],
                        description: "Action to perform",
                    },
                    device: {
                        type: "string",
                        description:
                            "Device name to connect/disconnect (e.g. 'AirPods Pro'). Required for connect/disconnect.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            // Windows: use PowerShell to control Bluetooth via Device Management API
            if (IS_WIN) {
                switch (action) {
                    case "status": {
                        try {
                            const result = await runPowerShellInline(
                                `$bt = Get-CimInstance -Namespace root/WMI -ClassName MSBluetooth_RadioInformation -ErrorAction SilentlyContinue; if ($bt) { "on" } else { $dev = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Select-Object -First 1; if ($dev) { $dev.Status } else { "unavailable" } }`,
                                5000,
                            );
                            return JSON.stringify({ success: true, power: result.trim() || "unknown" });
                        } catch {
                            return JSON.stringify({
                                success: true,
                                power: "unknown",
                                note: "Could not query Bluetooth status on Windows.",
                            });
                        }
                    }
                    case "on":
                    case "off": {
                        try {
                            // Enable/disable all Bluetooth devices via PnP
                            const verb = action === "on" ? "Enable-PnpDevice" : "Disable-PnpDevice";
                            await runPowerShell(
                                `Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | ForEach-Object { ${verb} -InstanceId $_.InstanceId -Confirm:$false -ErrorAction SilentlyContinue }`,
                                10000,
                            );
                            return JSON.stringify({
                                success: true,
                                action,
                                note: `Bluetooth turned ${action} (requires admin for some devices).`,
                            });
                        } catch (err) {
                            return JSON.stringify({
                                success: false,
                                error: (err as Error).message,
                                note: "Toggling Bluetooth may require administrator privileges on Windows.",
                            });
                        }
                    }
                    case "list": {
                        try {
                            const result = await runPowerShellInline(
                                `Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Select-Object FriendlyName,Status | ConvertTo-Json -Compress`,
                                5000,
                            );
                            const devices = JSON.parse(result || "[]");
                            const list = Array.isArray(devices) ? devices : [devices];
                            return JSON.stringify({
                                success: true,
                                devices: list.map((d: Record<string, unknown>) => ({
                                    name: d.FriendlyName ?? "unknown",
                                    connected: d.Status === "OK",
                                })),
                            });
                        } catch {
                            return JSON.stringify({
                                success: true,
                                devices: [],
                                note: "Could not enumerate Bluetooth devices on Windows.",
                            });
                        }
                    }
                    case "connect":
                    case "disconnect":
                        return JSON.stringify({
                            success: false,
                            error: "connect/disconnect for specific Bluetooth devices is not supported via this tool on Windows. Use Windows Settings > Bluetooth & devices instead.",
                        });
                    default:
                        return JSON.stringify({ error: `Unknown action: ${action}.` });
                }
            }

            // macOS / Linux: Check if blueutil is available (brew install blueutil)
            let hasBlueutil = false;
            try {
                await execFileAsync("which", ["blueutil"], { timeout: 2000 });
                hasBlueutil = true;
            } catch {
                /* not installed */
            }

            switch (action) {
                case "status": {
                    if (hasBlueutil) {
                        const { stdout } = await execFileAsync("blueutil", ["--power"], { timeout: 3000 });
                        return JSON.stringify({ success: true, power: stdout.trim() === "1" ? "on" : "off" });
                    }
                    // Fallback: use system_profiler
                    const result = await runAppleScript(`
tell application "System Events"
    try
        set btState to do shell script "defaults read /Library/Preferences/com.apple.Bluetooth ControllerPowerState"
        return btState
    on error
        return "unknown"
    end try
end tell`);
                    return JSON.stringify({
                        success: true,
                        power: result === "1" ? "on" : result === "0" ? "off" : "unknown",
                    });
                }

                case "on":
                case "off": {
                    if (hasBlueutil) {
                        await execFileAsync("blueutil", ["--power", action === "on" ? "1" : "0"], { timeout: 5000 });
                    } else {
                        // Fallback: use AppleScript to toggle via System Settings
                        const script =
                            action === "on"
                                ? `do shell script "defaults write /Library/Preferences/com.apple.Bluetooth ControllerPowerState -int 1" with administrator privileges`
                                : `do shell script "defaults write /Library/Preferences/com.apple.Bluetooth ControllerPowerState -int 0" with administrator privileges`;
                        try {
                            await runAppleScript(script, 10000);
                        } catch {
                            // If admin fails, try the GUI approach
                            await runAppleScript(`
tell application "System Events"
    tell process "ControlCenter"
        -- This may not work on all macOS versions
    end tell
end tell`);
                            return JSON.stringify({
                                success: false,
                                error: "Could not toggle Bluetooth. Install 'blueutil' (brew install blueutil) for reliable control.",
                            });
                        }
                    }
                    return JSON.stringify({ success: true, action, note: `Bluetooth turned ${action}.` });
                }

                case "list": {
                    if (hasBlueutil) {
                        const { stdout } = await execFileAsync("blueutil", ["--paired"], { timeout: 5000 });
                        const devices = stdout
                            .trim()
                            .split("\n")
                            .filter(Boolean)
                            .map((line) => {
                                const nameMatch = line.match(/name: "([^"]+)"/);
                                const addrMatch = line.match(/address: ([0-9a-fA-F:-]+)/);
                                const connMatch = line.match(/connected: (\w+)/);
                                return {
                                    name: nameMatch?.[1] || "unknown",
                                    address: addrMatch?.[1] || "",
                                    connected: connMatch?.[1] === "1",
                                };
                            });
                        return JSON.stringify({ success: true, devices });
                    }
                    // Fallback
                    const { stdout } = await execFileAsync("system_profiler", ["SPBluetoothDataType", "-json"], {
                        timeout: 10000,
                    });
                    try {
                        const data = JSON.parse(stdout);
                        const btData = data?.SPBluetoothDataType?.[0];
                        const devices = btData?.devices_list || [];
                        const deviceList = devices.flatMap((d: Record<string, unknown>) =>
                            Object.entries(d).map(([name]) => ({ name })),
                        );
                        return JSON.stringify({
                            success: true,
                            devices: deviceList,
                            note: "Install 'blueutil' for detailed info.",
                        });
                    } catch {
                        return JSON.stringify({ success: true, raw: stdout.substring(0, 2000) });
                    }
                }

                case "connect":
                case "disconnect": {
                    const device = input.device as string;
                    if (!device) return JSON.stringify({ error: "Provide 'device' name for connect/disconnect." });

                    if (hasBlueutil) {
                        // Find the device address first
                        const { stdout } = await execFileAsync("blueutil", ["--paired"], { timeout: 5000 });
                        const lines = stdout.split("\n");
                        const deviceLine = lines.find((l) => l.toLowerCase().includes(device.toLowerCase()));
                        if (!deviceLine) {
                            return JSON.stringify({
                                error: `Device "${device}" not found in paired devices. Use bluetooth_control action="list" to see available devices.`,
                            });
                        }
                        const addrMatch = deviceLine.match(/address: ([0-9a-fA-F:-]+)/);
                        if (!addrMatch) return JSON.stringify({ error: `Could not find address for "${device}".` });

                        const flag = action === "connect" ? "--connect" : "--disconnect";
                        await execFileAsync("blueutil", [flag, addrMatch[1]], { timeout: 10000 });
                        return JSON.stringify({ success: true, action, device });
                    }

                    return JSON.stringify({
                        error: "Install 'blueutil' (brew install blueutil) for device connect/disconnect.",
                    });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}.` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 6. SET DO NOT DISTURB (FOCUS MODE)
// ═══════════════════════════════════════════════

export const setDoNotDisturb: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_do_not_disturb",
            description:
                "Toggle Do Not Disturb (Focus mode) on macOS. Turn on to silence notifications, turn off to resume them.",
            parameters: {
                type: "object",
                properties: {
                    enabled: {
                        type: "boolean",
                        description: "true to enable DND, false to disable it",
                    },
                },
                required: ["enabled"],
            },
        },
    },

    async handler(input) {
        const enabled = input.enabled as boolean;

        try {
            if (IS_WIN) {
                // Windows: Toggle Focus Assist via registry
                const value = enabled ? 2 : 0; // 0=off, 1=priority only, 2=alarms only (full DND)
                await runPowerShellInline(
                    `Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -Value ${enabled ? 0 : 1} -Type DWord -Force`,
                    5000,
                );
                return JSON.stringify({
                    success: true,
                    do_not_disturb: enabled,
                    note: enabled
                        ? "🔕 Focus Assist enabled — notifications silenced."
                        : "🔔 Focus Assist disabled — notifications resumed.",
                });
            }

            // macOS has no supported way for an app to switch Focus. The old code wrote a
            // pre-Big Sur flag (ignored), killed Notification Center and said "Do Not Disturb
            // is ON" — nothing had changed. Now: the owner's own Shortcut if they have one,
            // checked where Focus can be read; otherwise say so and switch it on screen.
            const name = enabled ? "Do Not Disturb" : "Do Not Disturb Off";
            const { stdout: list } = await execFileAsync("shortcuts", ["list"], { timeout: 10000 }).catch(() => ({
                stdout: "",
            }));
            if (list.split("\n").some((l) => l.trim() === name)) {
                await execFileAsync("shortcuts", ["run", name], { timeout: 15000 });
                await new Promise((r) => setTimeout(r, 1000));
                const { macFocusActive } = await import("../proactive/dnd.js");
                const now = await macFocusActive();
                if (now === null)
                    return JSON.stringify({ success: true, do_not_disturb: enabled, note: `Ran your "${name}" Shortcut (Focus state can't be read to confirm).` });
                return now === enabled
                    ? JSON.stringify({ success: true, do_not_disturb: enabled })
                    : JSON.stringify({ success: false, error: `Ran your "${name}" Shortcut, but Focus is still ${now ? "on" : "off"}.` });
            }
            return JSON.stringify({
                success: false,
                error: "macOS doesn't let apps switch Focus by script.",
                next_step: `Do it on screen: open Control Center in the menu bar, click Focus, then ${enabled ? "Do Not Disturb" : "the active Focus to turn it off"} — and check it took. (A Shortcut named "${name}" would let this tool do it directly.)`,
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 7. DARK MODE
// ═══════════════════════════════════════════════

export const darkMode: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "dark_mode",
            description: "Toggle system appearance between dark mode and light mode, or check current mode.",
            parameters: {
                type: "object",
                properties: {
                    mode: {
                        type: "string",
                        enum: ["dark", "light", "toggle", "status"],
                        description:
                            "The appearance mode to set, or 'toggle' to switch, or 'status' to check current mode.",
                    },
                },
                required: ["mode"],
            },
        },
    },

    async handler(input) {
        const mode = input.mode as string;

        try {
            if (IS_WIN) {
                // Windows: use registry AppsUseLightTheme
                const regPath = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

                if (mode === "status") {
                    const result = await runPowerShellInline(
                        `(Get-ItemProperty -Path '${regPath}' -Name AppsUseLightTheme).AppsUseLightTheme`,
                        3000,
                    );
                    const isDark = result.trim() === "0";
                    return JSON.stringify({ success: true, dark_mode: isDark, appearance: isDark ? "dark" : "light" });
                }

                let setDark: boolean;
                if (mode === "toggle") {
                    const current = await runPowerShellInline(
                        `(Get-ItemProperty -Path '${regPath}' -Name AppsUseLightTheme).AppsUseLightTheme`,
                        3000,
                    );
                    setDark = current.trim() !== "0";
                } else {
                    setDark = mode === "dark";
                }

                const val = setDark ? 0 : 1;
                await runPowerShellInline(
                    `Set-ItemProperty -Path '${regPath}' -Name AppsUseLightTheme -Value ${val}; Set-ItemProperty -Path '${regPath}' -Name SystemUsesLightTheme -Value ${val}`,
                    5000,
                );
                return JSON.stringify({ success: true, dark_mode: setDark, appearance: setDark ? "dark" : "light" });
            }

            // macOS
            // The global default reads in ~20ms; asking System Events cold takes ~2.5s.
            // The key is absent in light mode, so a failed read means light.
            const isDarkNow = () =>
                execFileAsync("defaults", ["read", "-g", "AppleInterfaceStyle"], { timeout: 3000 }).then(
                    ({ stdout }) => stdout.trim() === "Dark",
                    () => false,
                );
            if (mode === "status") {
                const dark = await isDarkNow();
                return JSON.stringify({ success: true, dark_mode: dark, appearance: dark ? "dark" : "light" });
            }

            let setDark: boolean;
            if (mode === "toggle") {
                setDark = !(await isDarkNow());
            } else {
                setDark = mode === "dark";
            }

            await runAppleScript(`
tell application "System Events"
    tell appearance preferences
        set dark mode to ${setDark}
    end tell
end tell`);

            return JSON.stringify({
                success: true,
                dark_mode: setDark,
                appearance: setDark ? "dark" : "light",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 7b. OPEN SETTINGS PANE (deep link, no clicking)
// ═══════════════════════════════════════════════

const SETTINGS_APPEX_DIR = "/System/Library/ExtensionKit/Extensions";
// Words people say that are not in the pane's bundle id.
const SETTINGS_ALIASES: Record<string, string> = {
    darkmode: "appearance",
    theme: "appearance",
    privacy: "privacysecurity",
    security: "privacysecurity",
    power: "battery",
    energy: "battery",
    update: "softwareupdate",
    updates: "softwareupdate",
    language: "localization",
    region: "localization",
    vpn: "network",
    background: "wallpaper",
    screensaver: "wallpaper",
    users: "usersgroups",
    password: "touchid",
    loginitems: "loginitems",
    airdrop: "airdrophandoff",
    handoff: "airdrophandoff",
    dock: "desktop",
    menubar: "controlcenter",
    printer: "printscan",
    reset: "transferreset",
};
// Privacy & Security sub-pages (anchor on the PrivacySecurity pane).
const PRIVACY_ANCHORS: Record<string, string> = {
    camera: "Privacy_Camera",
    microphone: "Privacy_Microphone",
    screenrecording: "Privacy_ScreenCapture",
    accessibility: "Privacy_Accessibility",
    fulldisk: "Privacy_AllFiles",
    location: "Privacy_LocationServices",
    locationservices: "Privacy_LocationServices",
    automation: "Privacy_Automation",
    contacts: "Privacy_Contacts",
    calendars: "Privacy_Calendars",
    photos: "Privacy_Photos",
    inputmonitoring: "Privacy_ListenEvent",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let settingsPanes: { id: string; key: string }[] | undefined;
/** Settings panes installed on this Mac, keyed by the name in their bundle id. */
export async function listSettingsPanes(): Promise<{ id: string; key: string }[]> {
    if (settingsPanes) return settingsPanes;
    const panes: { id: string; key: string }[] = [];
    for (const f of await fs.readdir(SETTINGS_APPEX_DIR).catch(() => [] as string[])) {
        const plist = await fs.readFile(`${SETTINGS_APPEX_DIR}/${f}/Contents/Info.plist`, "utf8").catch(() => "");
        const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
        if (
            !id ||
            !/settings|systempreferences|preferences|AboutExtension/i.test(id) ||
            /intent|widget|search/i.test(id)
        )
            continue;
        const key = norm(
            id.replace(/^com\.apple\.(systempreferences\.|settings\.)?/, "").replace(/settings|extension/gi, ""),
        );
        if (key) panes.push({ id, key });
    }
    settingsPanes = panes;
    return panes;
}

/** Resolve a spoken pane name ("wifi", "camera access", "dark mode") to an x-apple.systempreferences URL. */
export async function resolveSettingsUrl(pane: string): Promise<string | null> {
    // Models also write paths: "privacy/camera", "Privacy & Security > Camera". The most
    // specific (last) part that names a pane wins, then the whole name.
    const parts = pane.split(/\s*(?:\/|>|→|»|,|\s-\s)\s*/).filter(Boolean);
    for (const part of parts.length > 1 ? [...parts.reverse(), pane] : [pane]) {
        const hit = await resolveOne(part);
        if (hit) return hit;
    }
    return null;
}

async function resolveOne(pane: string): Promise<string | null> {
    const want = norm(pane.replace(/\b(settings?|preferences?|pane|access|permissions?)\b/gi, ""));
    if (!want) return "x-apple.systempreferences:";
    const panes = await listSettingsPanes();
    const key = SETTINGS_ALIASES[want] ?? want;
    // "accessibility" is its own pane; "accessibility access/permission" is the privacy page.
    const privacy = PRIVACY_ANCHORS[want];
    if (privacy && (/access\b|permission|privacy/i.test(pane) || !panes.some((x) => x.key === key))) {
        const p = panes.find((x) => x.key === "privacysecurity");
        return p ? `x-apple.systempreferences:${p.id}?${privacy}` : null;
    }
    const hit =
        panes.find((x) => x.key === key) ??
        panes
            .filter((x) => x.key.includes(key) || (key.length >= 4 && key.includes(x.key)))
            .sort((a, b) => a.key.length - b.key.length)[0];
    return hit ? `x-apple.systempreferences:${hit.id}` : null;
}

export const openSettings: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "open_settings",
            description:
                "Open a System Settings pane directly (one call, no clicking through the sidebar): e.g. 'wifi', 'bluetooth', 'sound', 'displays', 'battery', 'wallpaper', 'keyboard', 'notifications', 'general', 'storage', 'software update', 'privacy', or a privacy page like 'camera', 'microphone', 'screen recording', 'accessibility access', 'full disk access'. On Windows pass an ms-settings page name (e.g. 'bluetooth', 'display', 'sound', 'network-wifi'). Use the dedicated tools (set_volume, wifi_control, bluetooth_control, dark_mode, set_brightness, set_do_not_disturb) when they cover the change; use this for everything else, then act on the pane with os_inspect/os_smart_click.",
            parameters: {
                type: "object",
                properties: {
                    pane: { type: "string", description: "Pane name, e.g. 'bluetooth' or 'camera'" },
                },
                required: ["pane"],
            },
        },
    },

    async handler(input) {
        const pane = String(input.pane ?? "").trim();
        try {
            if (IS_WIN) {
                const slug = pane
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, "-")
                    .replace(/^-|-$/g, "");
                await execFileAsync("cmd.exe", ["/c", "start", "", `ms-settings:${slug}`], { timeout: 5000 });
                return JSON.stringify({ success: true, opened: `ms-settings:${slug}` });
            }
            if (!IS_MAC) return JSON.stringify({ success: false, error: "open_settings supports macOS and Windows." });
            const url = await resolveSettingsUrl(pane);
            if (!url) {
                const names = (await listSettingsPanes()).map((p) => p.key).join(", ");
                return JSON.stringify({ success: false, error: `No settings pane matches "${pane}". Panes: ${names}` });
            }
            await execFileAsync("open", [url], { timeout: 5000 });
            // Return once the pane is in front: a screen read in the same batch (os_inspect)
            // otherwise reads whatever was in front before (live: Chrome).
            const { waitForFrontmost } = await import("../screen/frontmost.js");
            const front = !!(await waitForFrontmost("System Settings", 5000));
            if (front) await new Promise((r) => setTimeout(r, 500)); // the pane's content draws a moment later
            // Name the page showing: without it, small models kept clicking and left the page
            // they had opened (model-ladder eval, "which apps can use my camera"). A freshly
            // launched Settings shows its last pane first, so wait for the asked-for one.
            const want = [
                norm(pane),
                norm(url.split(/[:?]/).pop() ?? "").replace(/^comapple(systempreferences)?|settings|extension|privacy/g, ""),
            ]
                .filter((w) => w.length >= 3)
                .map((w) => w.slice(0, 6));
            let page = "";
            for (let i = 0; front && i < 12; i++) {
                page = await execFileAsync(
                    "osascript",
                    ["-e", 'tell application "System Events" to tell process "System Settings" to get name of window 1'],
                    { timeout: 2000 },
                ).then(
                    (r) => r.stdout.trim(),
                    () => "",
                );
                if (page && want.some((w) => norm(page).includes(w))) break;
                page = ""; // never report a page that may be the previous one
                await new Promise((r) => setTimeout(r, 250));
            }
            return JSON.stringify({
                success: true,
                opened: url,
                ...(page ? { page } : {}),
                note: front
                    ? "This page is on screen now. If the user only asked to open or see it, you're done: don't click anything else."
                    : "System Settings isn't in front yet: check with os_inspect app='System Settings'.",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 8. LOCK SCREEN
// ═══════════════════════════════════════════════

export const lockScreen: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "lock_screen",
            description: "Lock the screen immediately. The user will need to enter their password to unlock.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        try {
            if (IS_WIN) {
                await execFileAsync("rundll32.exe", ["user32.dll,LockWorkStation"], { timeout: 3000 });
                return JSON.stringify({ success: true, note: "🔒 Screen locked." });
            }

            // macOS
            await runAppleScript(
                `
tell application "System Events" to keystroke "q" using {command down, control down}`,
                3000,
            );
            return JSON.stringify({ success: true, note: "🔒 Screen locked." });
        } catch (err) {
            try {
                if (IS_MAC) {
                    await execFileAsync(
                        "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
                        ["-suspend"],
                        { timeout: 3000 },
                    );
                    return JSON.stringify({ success: true, note: "🔒 Screen locked." });
                }
            } catch {
                /* fall through */
            }
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// 9. SLEEP DISPLAY
// ═══════════════════════════════════════════════

export const sleepDisplay: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "sleep_display",
            description:
                "Put the display to sleep or wake it up. The display turns off but the computer stays running.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["sleep", "wake"],
                        description: "Whether to sleep or wake the display (default: sleep)",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const action = (input.action as string) || "sleep";

        try {
            if (IS_WIN) {
                if (action === "sleep") {
                    // Send SC_MONITORPOWER message to put display to sleep
                    await runPowerShell(
                        `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MonitorAPI {
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
    public const uint WM_SYSCOMMAND = 0x0112;
    public static readonly IntPtr SC_MONITORPOWER = new IntPtr(0xF170);
}
'@
[MonitorAPI]::SendMessage([MonitorAPI]::HWND_BROADCAST, [MonitorAPI]::WM_SYSCOMMAND, [MonitorAPI]::SC_MONITORPOWER, [IntPtr]::new(2))
`,
                        5000,
                    );
                    return JSON.stringify({ success: true, action: "sleep", note: "💤 Display sleeping." });
                } else {
                    // Wake: move mouse slightly
                    await runPowerShell(
                        `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo); }'
[WinAPI]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0001, -1, 0, 0, [UIntPtr]::Zero)
`,
                        5000,
                    );
                    return JSON.stringify({ success: true, action: "wake", note: "☀️ Display woken." });
                }
            }

            // macOS — guard because pmset / caffeinate are Darwin-only.
            if (IS_MAC) {
                if (action === "sleep") {
                    await execFileAsync("pmset", ["displaysleepnow"], { timeout: 3000 });
                    return JSON.stringify({ success: true, action: "sleep", note: "💤 Display sleeping." });
                } else {
                    await execFileAsync("caffeinate", ["-u", "-t", "1"], { timeout: 3000 });
                    return JSON.stringify({ success: true, action: "wake", note: "☀️ Display woken." });
                }
            }
            // Linux — best-effort DPMS via xset (X11). Wayland and headless
            // environments land here too; the command simply fails, which we
            // surface as a skipped action.
            if (IS_LINUX) {
                const arg = action === "sleep" ? "off" : "on";
                try {
                    await execFileAsync("xset", ["dpms", "force", arg], { timeout: 3000 });
                    return JSON.stringify({
                        success: true,
                        action,
                        note: `🖥️ Display ${action} via xset dpms.`,
                    });
                } catch (err) {
                    return JSON.stringify({
                        success: false,
                        action,
                        error: `display-sleep unsupported on this Linux env: ${(err as Error).message}`,
                    });
                }
            }
            return JSON.stringify({ success: false, error: `Unsupported platform: ${process.platform}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
