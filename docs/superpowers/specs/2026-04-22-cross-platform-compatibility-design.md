# Cross-Platform Compatibility — Full Parity Design
**Date:** 2026-04-22
**Status:** Approved
**Scope:** Windows full parity (bot + Electron desktop) + Linux polish

---

## Overview

ATLAS runs on macOS natively and has a solid platform abstraction layer (`platform.ts`, `macos.ts`, `windows.ts`, `linux.ts`). The gaps are specific and well-understood: shell execution breaks on Windows cmd.exe, Chrome native messaging is unregistered on Windows, build scripts hardcode `bash`, some Windows tools (OCR, app automation) exist but have wiring or completeness issues, and Linux has fragile Wayland/clipboard handling.

This spec covers 9 targeted improvements that together bring Windows to full feature parity with macOS and polish Linux edge cases.

---

## Section 1: Shell Execution on Windows

### Problem
`shell_exec` and `shell_exec_background` use `{ shell: true }` in Node.js `child_process`, which on Windows spawns `cmd.exe`. Unix commands the LLM issues (`ls`, `grep`, `cat`, `find`, `which`, `chmod`, `touch`, `mkdir -p`) silently fail or return wrong results.

### Solution

Create `src/utils/win-shell.ts` — a utility that resolves the best available shell on Windows:

**Detection order:**
1. `C:\Program Files\Git\bin\bash.exe` (Git for Windows default install)
2. `C:\Program Files\Git\usr\bin\bash.exe` (alternate path)
3. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` (user install)
4. Registry lookup: `HKLM\SOFTWARE\GitForWindows` → `InstallPath`
5. `pwsh.exe` (PowerShell 7+, in PATH)
6. `powershell.exe` (PowerShell 5.1 fallback)
7. `cmd.exe` (last resort)

**When Git Bash is found:** Use it directly as the shell — all Unix commands work identically to macOS/Linux. Set `shell: gitBashPath` in `execFileAsync` options.

**When only PowerShell is found:** Prepend a Unix-compat shim block to every script:
```powershell
function ls { Get-ChildItem @args }
function cat { Get-Content @args }
function grep { param($pattern, $file) Select-String -Pattern $pattern -Path $file | % { $_.Line } }
function which { param($cmd) (Get-Command $cmd -ErrorAction SilentlyContinue)?.Source }
function touch { param($f) if (!(Test-Path $f)) { New-Item $f -ItemType File } else { (Get-Item $f).LastWriteTime = Get-Date } }
function find { param($path, [string]$name) Get-ChildItem -Path $path -Recurse -Filter $name }
Set-Alias -Name open -Value Invoke-Item
```

**Env override:** `ATLAS_WIN_SHELL=gitbash|powershell|cmd` for user control.

**Shell background processes:** `shell-monitor.ts` gets the same shell resolution via the shared `win-shell.ts` utility.

### Files
- `src/utils/win-shell.ts` (new)
- `src/tools/shell.ts` (modify: import and use `resolveShell()`)
- `src/tools/shell-monitor.ts` (modify: same)

---

## Section 2: Chrome Native Messaging Host on Windows

### Problem
`registerNativeMessagingHost()` in `chrome-bridge.ts` skips with a comment "Windows or unsupported — skip". Chrome on Windows requires the manifest JSON path to be registered in the Windows Registry, not placed in a directory.

### Solution

Add a Windows branch to `registerNativeMessagingHost()`:

1. Write the manifest JSON to `~/.atlas/com.atlas.bridge.json` (same content as macOS/Linux)
2. Use `winreg2` npm package to create registry key:
   - `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.atlas.bridge` → path to JSON
   - `HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.atlas.bridge` → same path
   - `HKCU\SOFTWARE\Chromium\NativeMessagingHosts\com.atlas.bridge` → same path
3. Handle `winreg2` import failure gracefully (non-Windows or not installed) — HTTP discovery fallback already works
4. On bridge shutdown, optionally remove registry keys (or leave them — they're harmless)

**Package:** `winreg2` (pure JS, no native compilation, async/await API)

### Files
- `src/tools/browser/chrome-bridge.ts` (modify: add Windows branch)
- `package.json` (add `winreg2` dependency)

---

## Section 3: Build Scripts — Cross-Platform

### Problem
`package.json` `postinstall` runs `bash scripts/patch-baileys.sh` — `bash` does not exist natively on Windows. The Baileys patch is a simple text replacement in a source file.

### Solution

Rewrite `scripts/patch-baileys.sh` → `scripts/patch-baileys.mjs` as a Node.js ES module:
- Read the target file path(s) from args or hardcoded relative paths
- Apply the same text patches using `fs.readFileSync`/`replaceAll`/`writeFileSync`
- Exit 0 always (non-fatal — same behavior as `|| true` in the current script)

Update `package.json`:
```json
"postinstall": "node scripts/patch-baileys.mjs || true && npx tsx scripts/postinstall-video.ts 2>/dev/null || true"
```

`desktop/build/create-dmg.sh` stays as-is — it's only called by `build:mac` and will never run on Windows.

Add `scripts/check-deps.mjs` — a startup dependency checker for Windows that:
- Checks for: Git for Windows (bash), ffmpeg, Python 3
- Prints clear one-line install instructions for anything missing
- Called from `npm run dev` preflight on Windows only

### Files
- `scripts/patch-baileys.mjs` (new)
- `scripts/check-deps.mjs` (new)
- `package.json` (modify postinstall)
- `scripts/patch-baileys.sh` (keep for git history reference but no longer executed)

---

## Section 4: Windows OCR — Fix Path Resolution

### Problem
`runWinOcr()` in `windows.ts` references `scripts/ocr_screen.ps1` but the path is constructed relative to `process.cwd()` (the project root during dev) and may break when running from the compiled `dist/` directory or from the Electron app's resource path.

Linux has no OCR path at all.

### Solution

**Windows:** Fix path resolution in `runWinOcr()` to use:
```typescript
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ocrScript = path.resolve(__dirname, "../../scripts/ocr_screen.ps1");
// Falls back to: path.resolve(process.cwd(), "scripts/ocr_screen.ps1")
// Falls back to: path.resolve(app.getPath("resources"), "scripts/ocr_screen.ps1") in Electron
```

Add Electron resource path awareness: check `process.resourcesPath` (set by Electron) as an additional search location.

**Linux:** Add Tesseract OCR path:
- Probe `tesseract --version` on first use; cache result
- Capture screenshot → `tesseract <img> stdout -l eng` → parse stdout into same `{ elements: [{ text, boundingBox }] }` format as Windows/macOS
- Add `tesseract` install hint in `self-heal.ts` platform map

**Kill-switch:** `ATLAS_OCR_ENGINE=native|tesseract|disabled`

### Files
- `src/tools/windows.ts` (fix path resolution in `runWinOcr()`)
- `src/tools/linux.ts` (add tesseract OCR path)
- `src/agents/self-heal.ts` (add tesseract to Linux heal map)

---

## Section 5: Windows App Automation Library

### Problem
`apple_script` is a powerful macOS tool for app control: focus windows, click menu items, get/set UI values, control system settings. Windows has `powershell_script` but it's raw — no pre-loaded helpers for common automation tasks.

### Solution

Inject a `$AtlasHelpers` automation module at the top of every PowerShell script execution via `runPowerShell()`. This adds Windows equivalents for the most-used AppleScript patterns:

```powershell
# Atlas Windows Automation Helpers - auto-injected
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Atlas-FocusApp([string]$Name) {
    $p = Get-Process $Name -EA SilentlyContinue | Select-Object -First 1
    if ($p) {
        $code = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
                 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
        $t = Add-Type -MemberDefinition $code -Name "WinHelp$([System.Guid]::NewGuid().ToString('N'))" -PassThru
        $t::ShowWindow($p.MainWindowHandle, 9); $t::SetForegroundWindow($p.MainWindowHandle)
    }
}
function Atlas-GetFrontApp() {
    $code = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
             [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
    $t = Add-Type -MemberDefinition $code -Name "WinHelp2$([System.Guid]::NewGuid().ToString('N'))" -PassThru
    $sb = New-Object System.Text.StringBuilder 256
    $t::GetWindowText($t::GetForegroundWindow(), $sb, 256) | Out-Null; $sb.ToString()
}
function Atlas-SetDoNotDisturb([bool]$Enable) {
    $val = if ($Enable) { 1 } else { 0 }
    Set-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings" -Name "NOC_GLOBAL_SETTING_TOASTS_ENABLED" -Value ([int](!$Enable)) -Force
}
function Atlas-GetRunningApps() {
    Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
        Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json
}
function Atlas-ClickMenuBar([string]$AppName, [string]$Menu, [string]$Item) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $app = $root.FindFirst([System.Windows.Automation.TreeScope]::Children,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $AppName)))
    # ... UIAutomation tree walk to menu item
}
```

Inject this block **only once per PowerShell session** (detect via `$env:ATLAS_HELPERS_LOADED`).

The LLM can now call `Atlas-FocusApp "notepad"` or `Atlas-SetDoNotDisturb $true` from any PowerShell script.

### Files
- `src/tools/windows.ts` (add helper injection to `runPowerShell()`)
- `src/tools/platform.ts` (update `getFrontmostApp()` Windows path to use new helpers)

---

## Section 6: Clipboard & Screenshot — Fast Native Paths

### Problem
Windows clipboard uses PowerShell (spawns a process — ~200ms per call). Screenshots use `System.Drawing` via PowerShell (~500ms). Both are slow for frequent use.

### Solution

**Clipboard:**
- Add `clipboardy` — cross-platform, uses native OS APIs, no process spawn on any platform
- In `platform.ts`, replace the PowerShell clipboard path with `clipboardy.read()` / `clipboardy.write()`
- macOS path stays as `pbcopy`/`pbpaste` (already fast, no regression)
- Linux path uses `clipboardy` (which tries `wl-copy`, `xclip`, `xsel` in order)

**Screenshots:**
- Add `screenshot-desktop` as a fallback for all platforms
- On Windows: use as primary (faster than `System.Drawing` PowerShell)
- On macOS: keep `screencapture` (native, fastest)
- On Linux: keep `scrot`/`gnome-screenshot` as primary, `screenshot-desktop` as fallback
- `screenshot-desktop` returns a Buffer — convert to file using `fs.writeFileSync` to the existing `outputPath`

**Packages:** `clipboardy`, `screenshot-desktop`

### Files
- `src/tools/platform.ts` (modify `captureScreenshot()`, `getClipboard()`, `setClipboard()`)
- `package.json` (add `clipboardy`, `screenshot-desktop`)

---

## Section 7: Electron Windows Polish

### Problem
The Electron desktop app builds for Windows but is missing key Windows-specific setup that causes notifications to not group in Action Center, and potential path-with-spaces bugs.

### Solution

In `desktop/main.js`, add Windows-specific initialization in `app.whenReady()`:

1. **AppUserModelID:** `app.setAppUserModelId('com.xagilabs.atlas')` — required for Windows Action Center notification grouping and toast click-through
2. **PATH safety check:** If `DATA_DIR` or `BOT_DIR` contains spaces, wrap spawned child process args correctly (already uses `spawn()` with args array — confirm no string interpolation with spaces)
3. **Login startup item (optional, off by default):** `app.setLoginItemSettings({ openAtLogin: false })` — expose toggle in settings UI
4. **Electron-builder NSIS config:** Add `oneClick: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: true`, `runAfterFinish: true`
5. **asarUnpack verification:** Confirm `*.node` (Rust binary), `better-sqlite3`, `@xenova/transformers`, `sharp` are all in `asarUnpack` — add any missing

### Files
- `desktop/main.js` (add AppUserModelID + PATH check)
- `desktop/package.json` (update NSIS config and asarUnpack)

---

## Section 8: Linux Polish — Wayland & Clipboard

### Problem
Linux Wayland detection uses `$XDG_SESSION_TYPE` which is unreliable. Clipboard only tries `xclip`. Brightness has no sysfs fallback. Screenshots don't try `grim` (Wayland-native).

### Solution

**Wayland detection — new reliable check:**
```typescript
function isWayland(): boolean {
  return !!(
    process.env.WAYLAND_DISPLAY ||           // set when Wayland is running
    process.env.XDG_SESSION_TYPE === "wayland" ||
    fsExistsSync(`/run/user/${process.getuid()}/wayland-0`) // socket file existence
  );
}
```

**Clipboard try-order:**
1. `wl-copy` / `wl-paste` (Wayland — check binary exists first)
2. `xclip -selection clipboard`
3. `xsel --clipboard`
4. `xdotool type` (write-only fallback)

**Screenshots try-order (Linux):**
1. `grim` (Wayland, outputs PNG)
2. `scrot`
3. `gnome-screenshot -f`
4. `screenshot-desktop` npm package (ultimate fallback)

**Brightness:**
1. `brightnessctl set`
2. `xbacklight -set`
3. Direct sysfs: `echo <value> > /sys/class/backlight/$(ls /sys/class/backlight | head -1)/brightness`

**ydotool daemon:** Before using `ydotool`, check if `ydotoold` is running via `pgrep ydotoold`. If not, attempt `ydotoold &` in background. Add clear error message if both `xdotool` and `ydotool` are unavailable.

### Files
- `src/tools/linux.ts` (clipboard try-order, screenshot try-order, ydotool daemon check)
- `src/tools/platform.ts` (Wayland detection function, brightness fallback chain)

---

## Section 9: Runtime Capability Detection

### Problem
The LLM sometimes attempts tools that won't work on the current platform (e.g., `apple_script` on Windows, `xdotool` when not installed). There's no mechanism to tell the model upfront what's available.

### Solution

Create `src/utils/platform-capabilities.ts`:
- Runs once at boot (after tool infrastructure init)
- Probes availability of all platform-sensitive features
- Caches results — no repeated probing

**Capability flags:**
```typescript
interface PlatformCapabilities {
  platform: "darwin" | "win32" | "linux";
  arch: string;
  shell: { type: "bash" | "gitbash" | "powershell" | "cmd"; path: string };
  screenshot: { available: boolean; engine: "screencapture" | "system.drawing" | "screenshot-desktop" | "scrot" | "grim" };
  clipboard: { available: boolean; engine: "pbcopy" | "clipboardy" | "powershell" | "xclip" | "wl-copy" };
  ocr: { available: boolean; engine: "swift" | "windows.media.ocr" | "tesseract" | null };
  audio: { available: boolean; portaudio: boolean };
  nativeModule: { loaded: boolean; path: string | null };
  appAutomation: { applescript: boolean; powershellCom: boolean; xdotool: boolean; ydotool: boolean };
  location: { available: boolean; engine: "corelocation" | "windows.devices.geolocation" | "geoclue" | "wifi" };
  browser: { playwright: boolean; chromeExtension: boolean; nativeMessaging: boolean };
}
```

**Usage:**
1. Inject a `<platform_capabilities>` block into the agent's system context on first iteration (alongside the existing `<architecture>` block) — replaces vague "I'm on Windows" context with precise capability info
2. Export as `getPlatformCapabilities()` for use in tool handlers to gate behavior
3. Expose via a `platform_info` tool (read-only, no args) for the LLM to query mid-task

**Kill-switch:** `ATLAS_SKIP_CAPABILITY_PROBE=true` to skip probing at boot (for fast startup in CI)

### Files
- `src/utils/platform-capabilities.ts` (new)
- `src/index.ts` (call at boot, inject into agent context)
- `src/tool-router.ts` (register `platform_info` tool)
- `src/agent.ts` (inject capabilities into first-iteration context alongside `<architecture>`)

---

## Implementation Order

The sections are mostly independent but this order minimizes risk:

1. **Section 1** (Win shell) — highest impact, unblocks all LLM shell usage on Windows
2. **Section 3** (Build scripts) — needed before anyone can `npm install` on Windows
3. **Section 9** (Capability detection) — foundational, other sections register their engines here
4. **Section 6** (Clipboard/screenshot) — quick wins, pure npm packages
5. **Section 4** (OCR wiring) — fix path resolution bug, add Linux tesseract
6. **Section 2** (Chrome native messaging) — Windows registry registration
7. **Section 7** (Electron Windows polish) — AppUserModelID, NSIS config
8. **Section 8** (Linux polish) — Wayland detection, clipboard chain
9. **Section 5** (Windows app automation helpers) — inject PowerShell Atlas-* library

*(Note: Rust native `.node` rebuild on Windows is handled manually by the user — not part of this plan.)*

---

## Dependencies to Add

| Package | Purpose | Platform |
|---|---|---|
| `clipboardy` | Cross-platform clipboard | All |
| `screenshot-desktop` | Fallback screenshot | All |
| `winreg2` | Chrome native messaging registry | Windows |

No packages with native compilation requirements — all pure JS or pre-compiled NAPI.

---

## What Stays the Same

- Rust native module loading (already has JS fallback; user rebuilds on Windows)
- Swift OCR / CoreLocation (macOS-only by design; Windows/Linux have their own paths)
- AppleScript tool (`apple_script`) — macOS only, unchanged
- All existing macOS tooling — zero regressions
- Platform abstraction layer architecture — we're filling gaps, not redesigning
