// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedShell {
    type: "gitbash" | "powershell7" | "powershell5" | "cmd";
    path: string;
    /** Unix-compat shim block to prepend when type is powershell* */
    shimBlock?: string;
}

let _cached: ResolvedShell | null = null;

const UNIX_SHIM = `
function ls { Get-ChildItem @args }
function cat { Get-Content @args }
function grep { param($pattern, $file) if ($file) { Select-String -Pattern $pattern -Path $file | ForEach-Object { $_.Line } } else { $input | Select-String -Pattern $pattern | ForEach-Object { $_.Line } } }
function which { param($cmd) (Get-Command $cmd -ErrorAction SilentlyContinue)?.Source }
function touch { param($f) if (!(Test-Path $f)) { New-Item $f -ItemType File | Out-Null } else { (Get-Item $f).LastWriteTime = Get-Date } }
function find { param($path, $name) Get-ChildItem -Path $path -Recurse -Filter $name -ErrorAction SilentlyContinue }
function head { param($n=10) $input | Select-Object -First $n }
function tail { param($n=10) $input | Select-Object -Last $n }
function wc { param([switch]$l) $lines = @($input); if ($l) { $lines.Count } else { $lines.Count } }
Set-Alias -Name open -Value Invoke-Item -Force -ErrorAction SilentlyContinue
$env:BHAI_PS_SHIMS_LOADED = "1"
`.trim();

/** Resolve the best available shell on Windows. Cached after first call. */
export async function resolveWindowsShell(): Promise<ResolvedShell> {
    if (_cached) return _cached;

    // 1. Check BHAI_WIN_SHELL override
    const override = process.env.BHAI_WIN_SHELL;
    if (override === "cmd") {
        _cached = { type: "cmd", path: "cmd.exe" };
        return _cached;
    }
    if (override === "powershell") {
        const path = await findPowerShell();
        _cached = { type: path.includes("pwsh") ? "powershell7" : "powershell5", path, shimBlock: UNIX_SHIM };
        return _cached;
    }

    // 2. Try Git Bash paths
    const gitBashPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
        join(process.env.PROGRAMFILES ?? "", "Git", "bin", "bash.exe"),
    ];

    for (const p of gitBashPaths) {
        if (existsSync(p)) {
            _cached = { type: "gitbash", path: p };
            console.log(`⚡ [win-shell] Using Git Bash: ${p}`);
            return _cached;
        }
    }

    // 3. Try registry for Git install path
    try {
        const { stdout } = await execFileAsync("reg", ["query", "HKLM\\SOFTWARE\\GitForWindows", "/v", "InstallPath"], {
            timeout: 3000,
        });
        const match = stdout.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (match) {
            const gitPath = join(match[1].trim(), "bin", "bash.exe");
            if (existsSync(gitPath)) {
                _cached = { type: "gitbash", path: gitPath };
                console.log(`⚡ [win-shell] Git Bash via registry: ${gitPath}`);
                return _cached;
            }
        }
    } catch {
        /* registry not available or key missing */
    }

    // 4. PowerShell 7+
    const psPath = await findPowerShell();
    const type = psPath.toLowerCase().includes("pwsh") ? "powershell7" : "powershell5";
    _cached = { type, path: psPath, shimBlock: UNIX_SHIM };
    console.log(`⚡ [win-shell] Using PowerShell: ${psPath}`);
    return _cached;
}

async function findPowerShell(): Promise<string> {
    // Try pwsh (PS7+) first
    try {
        await execFileAsync("pwsh", ["-NoProfile", "-Command", "exit 0"], { timeout: 3000 });
        return "pwsh.exe";
    } catch {
        /* not found */
    }
    return "powershell.exe";
}

// Git Bash / POSIX single-quote escaping: close the quote, emit an escaped
// quote, reopen — handles arbitrary content including newlines without
// letting shell metacharacters interpret.
function posixQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

// PowerShell single-quoted literal escaping: doubling the quote character is
// the documented PS escape inside a single-quoted string. Nothing else (back-
// ticks, $var, ;, etc.) is interpreted inside single quotes.
function pwshQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/** Wrap a command+args for the resolved shell. Returns { command, args } ready for execFileAsync. */
export function wrapForShell(
    shell: ResolvedShell,
    command: string,
    args: string[],
): { command: string; args: string[] } {
    if (shell.type === "gitbash") {
        const fullCmd =
            args.length > 0
                ? `${posixQuote(command)} ${args.map(posixQuote).join(" ")}`
                : posixQuote(command);
        return { command: shell.path, args: ["-c", fullCmd] };
    }
    if (shell.type === "powershell7" || shell.type === "powershell5") {
        // `&` is the PowerShell call operator — it invokes the quoted command
        // path and forwards the quoted args without re-interpreting any of
        // their contents. That keeps metacharacters in LLM-controlled args
        // from turning into PowerShell statements.
        const shim = shell.shimBlock ?? "";
        const quotedArgs = args.map(pwshQuote).join(" ");
        const fullCmd =
            args.length > 0
                ? `& ${pwshQuote(command)} ${quotedArgs}`
                : `& ${pwshQuote(command)}`;
        const script = shim ? `${shim}\n${fullCmd}` : fullCmd;
        return {
            command: shell.path,
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        };
    }
    // cmd.exe — pass through unchanged
    return { command, args };
}
