> **Status: HISTORICAL checklist (2026-05-17); not re-verified on Windows.** Still relevant: Windows installer is built with `cd desktop && npm run build:win` (NSIS x64, `build/patch-nsis.js`); fresh-Windows installer fixes landed (`7667390`, PR #1) and the forge supervisor fails open without the native binary (`acd16a7`). Per CLAUDE.md the Windows AppContainer + JobObject spawn is still **deferred** (`native/src/forge_sandbox/windows_appcontainer.rs` exists). Stale references: the forge design spec `docs/superpowers/specs/2026-05-16-forge-sandbox-rust-supervisor-design.md` and plan `...-forge-sandbox-plan3-linux-windows.md` are **not in the repo** (CLAUDE.md cites the spec too); `src/screen/ocr.ts` and `src/screen/screenshot.ts` do not exist (OCR is `src/models/local-ocr.ts`; screen code is in `src/screen/` e.g. `perception-router.ts`, `capability-detector.ts`, `drift-calibration.ts`); `src/local-ocr.ts` is now `src/models/local-ocr.ts`. Windows release builds are done on a Windows host (see `docs/RELEASING.md`).

# Windows Testing & Porting Handoff — Bhai Desktop

**Date:** 2026-05-17
**Branch:** `main` (head `c2994f9`)
**Reader:** you, on a Windows machine

This is a **full-surface** handoff covering every Bhai subsystem that needs Windows verification or porting — not just Phase 4. Bhai is primarily developed on macOS; Linux has partial CI coverage; Windows has had MINIMAL ground-truth testing. Treat this doc as a checklist of "things that may or may not work — verify each."

---

## 0. TL;DR

| Category | Status | What you need to do |
|----------|--------|---------------------|
| **TS core (agent, channels, memory)** | Should work — TS is portable | Run the test suite |
| **Native Rust modules** | Compiles on Windows, but only some tested | Build + run `cargo test` |
| **Forge sandbox (Phase 4)** | **STUB on Windows** | See §6 — biggest porting effort |
| **Vision / OS automation** | Cross-OS designed but never run on Windows | See §7 |
| **Voice (live + transcribe + TTS)** | Should work; APIs are cross-OS | See §8 |
| **Email / channels (Discord, Slack, Telegram, WhatsApp, Matrix)** | Should work | See §9 |
| **Desktop app + auth + overlay** | electron-builder ships .exe installer | See §10 |
| **Convex backend** | Cloud-side; nothing to test on Windows | skip |
| **Skills + Store + MCP** | Should work | See §11 |
| **Build pipeline** | NSIS installer config exists but untested in months | See §3 |

---

## 1. Environment setup

### Required tools

```powershell
# Node 20 LTS or newer
node --version  # >= 20.0.0

# Rust stable MSVC toolchain (not gnu — napi-rs prebuilds need msvc)
rustup default stable-x86_64-pc-windows-msvc
rustc --version  # >= 1.75

# Visual Studio Build Tools 2022 with these workloads installed:
#   - Desktop development with C++
#   - Windows 11 SDK (latest)
# Without these, windows-sys compilation will fail on link.

# Git for Windows (with Git Bash; many build scripts assume bash semantics)
git --version

# Optional but recommended
gh --version  # GitHub CLI
choco --version  # Chocolatey, for installing python3 + ffmpeg if missing

# Python 3.10+ — required by video-studio module
python --version

# ffmpeg — required for video processing tools
ffmpeg -version
```

### Optional (for specific subsystems)

```powershell
# Tesseract OCR — fallback when local-ocr.ts can't use Vision Framework (macOS-only)
choco install tesseract -y

# Ollama — required if you want to test FunctionGemma local routing (zero-cost tool selection)
# Download from ollama.com; then: ollama pull gemma:270m
```

### Clone + branch

```powershell
git clone https://github.com/dheeraj-codingdesk/ATLAS.git
cd Bhai
git checkout main
git log --oneline -5  # head should be c2994f9 (this handoff) on top
```

### Install + first build

```powershell
npm install
npm run build:native  # Rust → atlas-native.win32-x64-msvc.node
npm run build         # TS → dist/
```

If `npm run build:native` fails with `LNK1181: cannot open input file 'advapi32.lib'`, your VS Build Tools install is missing the Windows SDK. Open the VS Installer, modify, add "Windows 11 SDK".

**Skip the Swift helpers** (`build:ocr`, `build:location`) — those are macOS-only.

---

## 2. Run the test suites

### TS unit + integration tests

```powershell
npm test -- src/
```

Expected baseline (on a fresh main check-out):
- ~2767 pass / 1 skip / 1 pre-existing perception-router fail (unrelated to Windows)

Anything else that fails is platform-specific — write it down and we'll triage.

**Known Windows-specific test concerns:**
- `src/utils/win-shell.test.ts` — should pass; if it doesn't, real Windows shell-quoting bug
- `src/utils/platform-capabilities.test.ts` — should pass; tells you which optional features are available
- `src/screen/__tests__/capability-detector.test.ts` — should detect Windows correctly
- Any test that hardcodes `/etc/` or `~/.atlas/` paths likely doesn't fail on Windows because `path.join` handles separators, but watch for hard-coded `\` vs `/` assertions

### Rust unit tests

```powershell
cd native
cargo test --lib
```

Expected: 200+ tests pass. The forge_sandbox + linux* modules will skip cleanly on Windows (cfg-gated).

```powershell
cargo test --lib forge_sandbox
```

Expected: ~44 pass (StrikeRecord, Worker, Pool, Capabilities — all the cross-platform Rust). 0 fail. The 3 `#[ignore]`'d integration tests are macOS-specific and will silently skip.

### Convex backend tests (if you care about cloud-side)

```powershell
cd convex
# Already tested in CI; you don't need to re-run on Windows.
```

---

## 3. Building the Windows desktop app

### Quick build (unsigned, dev)

```powershell
npm run build  # TS first
cd desktop
npm run build:win:protected  # or build:win
```

The installer comes out at `desktop/dist/Bhai Setup 0.2.1.exe`.

**Quirks to watch for:**

1. **`desktop/package.json` win section** had recent schema changes — keys like `_TODO_signing`, `signDlls`, `certificateFile` moved under `signtoolOptions`. If electron-builder complains about unknown win properties, the schema rejected them — drop the offending keys or move them inside `win.signtoolOptions`.

2. **`build:win:protected`** runs `desktop/build/patch-nsis.js` first — it patches the NSIS installer script for code obfuscation. If it errors, run `npm run build:win` instead and report what broke.

3. **Native binary**: electron-builder needs `native/atlas-native.win32-x64-msvc.node` to be present. Run `npm run build:native` first if it's missing.

### Signed build (production)

Set these env vars in PowerShell:

```powershell
$env:CSC_LINK = "C:\path\to\codesign.pfx"           # or base64-encoded blob
$env:WIN_CSC_KEY_PASSWORD = "your-pfx-password"
$env:CI = "true"  # makes desktop/build/check-signing.js fail loudly if certs missing
```

Then `npm run build:win:protected`.

If you don't have an EV cert, SmartScreen will scare-warn users. For internal QA an unsigned .exe is fine — just right-click → Properties → Unblock first.

---

## 4. Smoke-test the installed app

After installing the .exe:

1. Launch — Windows Defender SmartScreen may pop up; click "More info" → "Run anyway" (this is normal for unsigned builds).
2. On first run, the app needs:
   - **OTPless auth** — opens `tryatlasagi.com/auth-login` in default browser; you sign in; the page redirects back via a custom protocol. **If protocol handler doesn't fire**, you may need to manually register it (see §10).
   - **API key bundled** — OpenRouter + Convex keys are baked in; no user config needed.
3. After auth, you should see the overlay UI. Open it (default hotkey: `Ctrl+Shift+Space`).
4. Type a simple prompt: "What's the time in Tokyo?" — should hit Sonnet/Haiku via the model router and return an answer.

If any of those fail, that's where to start digging.

---

## 5. TS-portability landmines

These are spots in the codebase that have been wrong on Windows historically. Quick audit:

```powershell
# Search for path bugs
git grep -nE "'~/" src/  # tilde expansion broken on Windows
git grep -nE '"\\/' src/  # forward-slash-anchored regexes
git grep -nE "process\.env\.HOME[^_]" src/  # HOME doesn't exist on Windows; use os.homedir() or USERPROFILE
```

Known fixed: `src/config/paths.ts::getWorkspaceDir()` already prefers `os.homedir()` over `process.env.HOME`. But other files may still use `~/.atlas/` literally. Watch for `EACCES`-style errors at startup that mention a literal `~`.

---

## 6. Forge sandbox (Phase 4) — biggest porting effort

`native/src/forge_sandbox/windows.rs` is a **deliberate stub** — calling `WindowsSandbox::spawn` always returns `io::ErrorKind::Unsupported` with this message:

> "WindowsSandbox: AppContainer-isolated spawn requires tokio Child::from_raw_handles (not yet exposed in tokio 1.x). Helpers in windows_appcontainer.rs + windows_jobobject.rs are production-ready; integration deferred until tokio ships the conversion API or a fork is vendored."

### What's done already

- `windows_appcontainer.rs` — `ensure_profile(slug)` creates/derives a per-tool AppContainer SID. Idempotent — `ERROR_ALREADY_EXISTS` → `DeriveAppContainerSidFromAppContainerName` fallback. `sid_to_string()` for diagnostics + tests.
- `windows_jobobject.rs` — `create_supervisor_job()` builds a JobObject with 512MB memory cap, 60s CPU cap, ActiveProcessLimit=1, KILL_ON_JOB_CLOSE. `assign(job, process)` to attach.
- `windows_managed_process.rs` — `WindowsManagedProcess` wraps raw HANDLE pair from `CreateProcessAsUserW`, implements `kill` (TerminateProcess), `wait` (WaitForSingleObject + GetExitCodeProcess).

### What's blocking

Our `Sandbox` trait returns `tokio::process::Child`. macOS/Linux build via `tokio::process::Command`. Windows needs `CreateProcessAsUserW` with `STARTUPINFOEX` carrying `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` — that returns raw `HANDLE`s. Tokio 1.x has no public API to convert.

### Two paths forward

1. **Vendor a small fork of `tokio::process::Child`** exposing a private constructor accepting raw handles. ~200 lines, mechanically straightforward, maintenance burden.
2. **Wait for tokio to ship `Child::from_raw_handles`** (no ETA on tokio-rs/tokio#2837).

Option 1 is the only realistic path if you need Phase 4 to actually fence on Windows.

### What to wire when ready

In `windows.rs::WindowsSandbox::spawn`:

1. `ensure_profile(slug)` → AppContainer SID
2. Build `SECURITY_CAPABILITIES { AppContainerSid: sid, ... }`
3. Build `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` set
4. For each `caps.fs_read` path: `SetNamedSecurityInfoW` adding `GENERIC_READ` for the AppContainer SID
5. For each `caps.fs_write` path: same, with `GENERIC_WRITE | DELETE | FILE_GENERIC_READ`
6. `CreateProcessAsUserW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED`
7. `create_supervisor_job()` + `assign(job, processHandle)`
8. `ResumeThread(threadHandle)`
9. Wrap raw HANDLE pair in `WindowsManagedProcess`
10. Convert into `tokio::process::Child` (the blocking question above)

### V8 / Node startup quirks to watch

On macOS, Node V8 needed specific primitives (`iokit-open`, `mach-priv-task-port`, `system-info`) that the initial restrictive SBPL denied — Node aborted in `low_level_alloc.cc`. See commit `8633018` for what we added. Expect similar issues on Windows: AppContainer may deny what V8 needs. If `CreateProcessAsUserW` succeeds but the child exits 0xC000... within a second, V8 hit a denied API. The minimal AppContainer capability set for Node V8 isn't well-documented — you'll have to bisect empirically.

### Adversarial bypass tests on Windows

Adapt `src/forge/__tests__/capability-bypass.test.ts`:

- Replace `/etc/passwd` reads with `C:\Windows\System32\config\SAM` (always locked) or `C:\Users\<other-user>\NTUSER.DAT`
- The AWS metadata IP `169.254.169.254` still works as a network exfil target (Azure VMs use the same IP)
- `process.binding("spawn_sync")` test — Node's child_process should be blocked by AppContainer
- `fs.symlink` — Windows symlinks need admin OR developer mode; test with `mklink /D` equivalent or just `fs.createReadStream` against a junction point

All 15 patterns should defeat the sandbox the same way they do on macOS. If ANY succeed, AppContainer caps are too broad.

### Approval flow + plan-mode + library

These layers are pure TS and should work unchanged on Windows. After the spawn issue is solved, the existing `approve_dynamic_tool` / `revoke_dynamic_tool` flow runs identically.

**Critical:** Phase 4 added `~/.atlas/store/dynamic/` to `HARD_DENY_SUBSTRINGS`. On Windows the equivalent path is `C:\Users\<you>\.atlas\store\dynamic\` (forward slashes vs backslashes). `isPathHardDenied` does a case-insensitive `.includes()` on darwin+win32, so this should match either way — but verify with a unit test.

---

## 7. Vision / OS automation (`src/screen/`, `src/tools/`)

Bhai has a "computer-use" agent that takes screenshots, runs OCR + UI element detection (DOM + accessibility-tree), and clicks targets. Cross-OS by design but Windows-specific paths are less exercised.

### What to verify

1. **Screenshot capture** (`src/screen/screenshot.ts`): uses `screencapture` on macOS, `gnome-screenshot`/`scrot` on Linux. On Windows it should fall back to a Node screenshot library — check `node-screenshots` or similar in package.json. If unavailable, `os_screenshot` tool will fail.

2. **OCR fallback** (`src/screen/ocr.ts` → `src/models/local-ocr.ts`): macOS uses Vision Framework via the Swift helper. Linux/Windows use Tesseract via `node-tesseract-ocr` or shelling out to `tesseract.exe`. **Verify tesseract is on PATH** before running the OCR tier.

3. **Accessibility tree (AX dump)** (`src/screen/__tests__/ax-dump.test.ts`): macOS uses the Swift CoreAX helper; Windows uses UI Automation (UIA) via... actually, **this is probably unimplemented on Windows** — check `src/screen/perception-router.ts` for whether it has a Windows branch.

4. **Click memory + drift calibration** (`src/screen/click-memory.ts`, `drift-calibration.ts`): these are storage-only; should work unchanged.

5. **Capability detector** (`src/screen/capability-detector.ts`): boot-time probe that decides Lite/Standard/Full tier based on RAM + GPU + screen res. Should run; verify it picks the right tier for your Windows box.

### What to fix

If `os_screenshot` doesn't work, Bhai can't see the screen → can't do computer-use tasks. **High priority.** Likely fix: add a `node-screenshots` import in `src/screen/screenshot.ts` for win32 + linux branches.

---

## 8. Voice subsystem (`src/voice/`)

Three sub-modules: live-voice (real-time), transcribe (Whisper-style ASR), TTS (text-to-speech).

### Live voice

`src/voice/live/` uses Gemini Live or OpenAI Realtime APIs depending on `LIVE_VOICE_BACKEND` env. Pure WebSocket; should work on Windows.

**Verify:**
1. Microphone access works — Windows will pop up a permissions dialog the first time. Accept.
2. PCM audio capture — uses `naudiodon` or `node-microphone`. If those don't build on Windows, you'll get a runtime error.
3. VAD (voice activity detection) — `ATLAS_NATIVE_VAD=true` uses libfvad via the Rust native module. Falls back to RMS if libfvad isn't compiled. On Windows the native build doesn't include libfvad by default (needs `--features vad` cargo flag), so RMS is the default. That's fine.

### Transcribe / TTS

Both use cloud APIs (Gemini, OpenAI, ElevenLabs). Cross-OS by definition. Verify env vars are set: `ATLAS_TTS_PROVIDER`, `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`.

### Quick test

```
Bhai> /voice
```

Should drop into live voice mode. Speak a phrase. If you hear the model respond, voice works end-to-end.

---

## 9. Channels (Telegram, Discord, Slack, WhatsApp, Matrix, Email)

All channel implementations are pure Node + external SDKs. Cross-OS.

### Verify each that you use

- **Telegram** (`src/telegram.ts`): set `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`. DM the bot; should respond. Group support, voice transcription via @reply.
- **Discord** (`src/discord.ts`): set `DISCORD_BOT_TOKEN`, mention the bot in a channel.
- **Slack** (`src/slack.ts`): set Slack app tokens; mention the bot.
- **WhatsApp** (`src/whatsapp.ts`): Baileys-based. May need to scan QR on first run. State stored in `data/whatsapp-users/`. **Watch out:** Baileys uses native crypto bindings; may need MSVC build tools to install on Windows. If `npm install` failed on `@whiskeysockets/baileys`, that's why.
- **Matrix** (`src/matrix.ts`): uses `matrix-js-sdk`; pure Node; should work.
- **Email** (`src/email.ts`): IMAP/SMTP via `imapflow` + `nodemailer`. Set `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_WHITELIST`.

### Known Windows quirk

The WhatsApp `data/whatsapp-users/*.json` paths use forward slashes in the code. On Windows, `path.join` handles this transparently, but if you see any "ENOENT C:/Users/..." errors with mixed slashes, it's a regex matching string-path comparison gone wrong.

---

## 10. Desktop app, auth, overlay

### Electron app

`desktop/main.js` — Electron main process. Cross-OS. The custom protocol handler for OTPless auth (`atlas://` scheme) registers via `app.setAsDefaultProtocolClient('atlas')`.

**On Windows that registration writes to HKEY_CURRENT_USER\Software\Classes\atlas.** Verify:

```powershell
reg query "HKCU\Software\Classes\atlas"
```

Should show URL handler pointing to the installed exe. If not, run the installer as admin OR call the registration manually from a packaged build.

### Overlay

`src/overlay/overlay.html` — webview that runs inside Electron. Cross-OS. Uses WebSocket to talk to Bhai server on `localhost`. Should just work.

**Quirk on Windows:** electron-builder packs the overlay HTML into the asar bundle; the postbuild script `scripts/postbuild-copy-assets.mjs` copies it to `dist/overlay/`. If overlay won't load, check that `dist/overlay/overlay.html` exists after `npm run build`.

### OTPless auth

`portals/admin-panel/src/lib/auth.ts` — JWT-based. Cross-OS.

The auth flow:
1. User clicks "Sign in" → Electron opens `https://tryatlasagi.com/auth-login`
2. User authenticates (OTPless via SMS/WhatsApp/email)
3. tryatlasagi.com redirects to `atlas://auth-callback?token=...`
4. Windows protocol handler launches the installed atlas.exe (or focuses existing instance) and passes the URL
5. atlas.exe parses the token, stores it, signals the overlay

**If step 4 doesn't fire**, the protocol handler isn't registered. Manual fix:

```powershell
# Run as admin
reg add "HKCU\Software\Classes\atlas" /ve /d "URL:Bhai Protocol" /f
reg add "HKCU\Software\Classes\atlas" /v "URL Protocol" /d "" /f
reg add "HKCU\Software\Classes\atlas\shell\open\command" /ve /d "\"C:\Program Files\Bhai\Bhai.exe\" \"%1\"" /f
```

### Permissions on Windows

Bhai may want:
- **Microphone** (for voice mode) — Settings → Privacy → Microphone → enable for Bhai
- **Screen recording / capture** — Windows usually doesn't gate this, but watch for permission popups on first screenshot
- **File access** — desktop apps get user-folder access by default; OneDrive folders may need explicit grant
- **Notifications** — Windows 11 Action Center; check Settings → System → Notifications → Bhai allowed

---

## 11. Skills, Store, MCP, plugins

### Skills

`skills/` directory contains 12 role MD files + 5 Convex skills. Pure markdown; cross-OS.

Side-loaded skills live in `~/.atlas/store/skills/` — on Windows that's `C:\Users\<you>\.atlas\store\skills\`. Verify the directory is created on first boot.

### Store

`src/store/` — Convex-auth'd marketplace client. Read-only access via `store_browse` agent tool. Cross-OS.

Install/uninstall happens via the desktop UI's "Store" tab. **Verify install works on Windows** — it downloads a zip from Convex storage and extracts via `Expand-Archive` on Windows, `tar` elsewhere. Check `src/store/installer.ts` line where it branches on `process.platform === "win32"`.

### MCP (Model Context Protocol)

`src/mcp/` — connects to MCP servers (gitmcp-bridge, etc.). Uses stdio or HTTP transports. Cross-OS.

### Plugins (Vercel, Firecrawl, etc.)

Listed in the system reminders. All cloud APIs; cross-OS.

---

## 12. Things known to NOT work on Windows

These are honest gaps — don't try to use them:

1. **Swift helpers** (`scripts/get_location.swift`, `ocr_screen.swift`, `dump_ax.swift`) — macOS-only. Their compiled binaries won't be present; the calling code has Windows fallbacks (`local-ocr.ts` uses Tesseract, location uses IP-based geolocation, AX dump falls back to DOM-only on the browser tools).

2. **Phase 4 sandbox** — see §6. Returns `Unsupported` until you wire it.

3. **macOS-specific UX** — overlay positioning, hotkeys, dock integration. Electron handles most of this transparently but visual polish may differ.

4. **Some browser tools** — `os_computer_action` (universal click via OS APIs) is macOS-first; Windows path uses different Win32 calls and may have bugs.

5. **OCR via Vision Framework** — macOS-only. Tesseract is the fallback on Windows; install it.

---

## 13. Suggested test sequence (in order)

Do these in order. Stop at first major failure and report.

```powershell
# 1. Build
npm install
npm run build:native
npm run build
cd desktop
npm run build:win
cd ..

# 2. Unit tests
npm test -- src/

# 3. Install + smoke test
# (run desktop\dist\Bhai Setup 0.2.1.exe, complete OTPless auth)

# 4. Basic agent prompt
# In Bhai: "what's 2+2?"
# Expected: Haiku/Sonnet answers "4"; model router log shows correct task type

# 5. Memory persistence test
# In Bhai: "remember my favorite color is blue"
# Restart Bhai
# Ask: "what's my favorite color?"
# Expected: Bhai recalls "blue" via SQLite memory

# 6. Channel test (pick one you use)
# - Telegram: DM the bot
# - Email: send a test email to the address
# - Verify agent responds

# 7. Voice test
# /voice in Bhai
# Speak: "tell me a joke"
# Expected: voice response

# 8. Computer-use test (vision)
# Ask Bhai: "take a screenshot and tell me what you see"
# Expected: screenshot captured, OCR runs, description returned

# 9. Synthesize a non-persistent tool
# Ask: "use create_tool to make a tool that returns 'hello world'"
# Verify it runs

# 10. Synthesize a PERSISTENT tool (Phase 4)
# Ask: "create a persistent tool called test_doubler that doubles a number"
# EXPECTED: persistent path returns awaiting_approval
# Confirm via approve_dynamic_tool with verbatim quote
# THEN invoke the tool — EXPECTED on Windows: "platform_unsupported" or "spawn_failed: WindowsSandbox..."
#   because Windows backend is stubbed
# This is the gap to close.

# 11. Try an adversarial tool (once Windows sandbox is wired)
# Create a tool that does fs.readFileSync("C:\\Windows\\System32\\config\\SAM")
# EXPECTED after wiring: denied:true with EACCES code
# IF it returns leaked: <bytes>, the sandbox is broken
```

---

## 14. Where to dig in code

| Concern | File / directory |
|---------|------------------|
| Windows-specific path handling | `src/config/paths.ts`, `src/utils/win-shell.ts`, `src/utils/platform-capabilities.ts` |
| Native module load | `src/llm.ts`, `src/model-router.ts` (createRequire pattern) |
| Desktop main process | `desktop/main.js`, `desktop/auth-helpers.js` |
| Electron build config | `desktop/package.json` `build` section, `desktop/build/*` |
| Forge sandbox Windows | `native/src/forge_sandbox/windows*.rs` + `src/forge/sandbox-supervisor.ts` |
| Screen / vision Windows path | `src/screen/`, particularly `capability-detector.ts` and `perception-router.ts` |
| Channel implementations | `src/{telegram,discord,slack,whatsapp,matrix,email}.ts` |
| Auth flow | `desktop/auth-helpers.js`, `desktop/main.js` (protocol handler), `src/auth/` |
| Skills / store | `src/skills/`, `src/store/` |

---

## 15. Reporting issues

Branch convention for Windows fixes: `fix/win-<area>` (e.g. `fix/win-ocr-fallback`, `fix/win-overlay-positioning`).

PR template:
- What broke (with exact error message + repro steps)
- Which test would have caught it (write one if missing)
- Fix description
- Confirmation that macOS still works (run `npm test -- src/` on the CI macOS runner or ask me to verify)

For the Phase 4 sandbox specifically, see `docs/superpowers/specs/2026-05-16-forge-sandbox-rust-supervisor-design.md` for the original design and `docs/superpowers/plans/2026-05-16-forge-sandbox-plan3-linux-windows.md` for the Windows backend plan I wrote but couldn't validate on a Mac.

---

## 16. Quick reference — env vars you'll likely need

```powershell
# Required
$env:TELEGRAM_BOT_TOKEN = "..."        # if using Telegram
$env:ALLOWED_USER_IDS = "12345,67890"
$env:ATLAS_OTPLESS_USER_ID = "..."

# Recommended
$env:EMAIL_USER = "..."
$env:EMAIL_PASSWORD = "..."
$env:EMAIL_WHITELIST = "you@example.com"

# Voice (pick a backend)
$env:LIVE_VOICE_BACKEND = "gemini-live"  # or openai-realtime or hybrid
$env:LIVE_VOICE_NAME = "Aoede"
$env:ATLAS_TTS_PROVIDER = "elevenlabs"   # or openai
$env:ELEVENLABS_API_KEY = "..."

# Forge sandbox kill switches (only if testing the sandbox)
$env:ATLAS_FORGE_POOL_SIZE = "10"
$env:ATLAS_FORGE_STRICT = "true"         # refuse to spawn without full sandbox
$env:ATLAS_FORGE_WINDOWS_STRICT = "true" # refuse install on Windows when caps.net non-empty (per-host not yet enforced)

# Debug (verbose logging)
$env:MEMORY_DEBUG = "true"
$env:ATLAS_TOOL_DEBUG = "verbose"
$env:ATLAS_FORGE_SANDBOX_DEBUG = "true"
```

---

Good luck. Phase 4 sandbox + vision path are the big unknowns. Everything else should "just work" or fail loudly in a way that's easy to fix.

If you hit something I haven't anticipated, file an issue with the exact error + repro and I'll write the fix on macOS + send you a patch.
