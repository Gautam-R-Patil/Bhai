# Setup Wizard Redesign — Design Spec

**Date:** 2026-04-18
**Author:** brainstormed with Dheeraj
**Status:** approved for plan

---

## 1. Context

The current A.T.L.A.S setup wizard (`desktop/wizard.html`) is a fixed 6-step flow that hard-requires a Telegram bot token, silently omits account sign-in (it happens later in `panel.html`), and never mentions permissions — users hit macOS permission prompts ad-hoc when they first use a feature. The final "Ready to Go" screen is a wall of acronyms (LRU, HNSW, RRF, SAN, ATS, ESM, HMC, SHP, SAC-DR) that is cool for engineers and intimidating for anyone else.

The target user is someone opening Atlas for the first time. Their goal is *not* to configure anything; it's to see what Atlas can do. The current wizard makes them configure a bot first.

## 2. Goals

- Cut time-to-first-interaction from ~5 minutes of data entry to under 2 minutes of confirmations.
- Let Atlas work end-to-end with **zero external accounts** — desktop overlay + account sign-in is the critical path; everything else is optional.
- Make macOS permissions a first-class, self-healing step.
- Move account sign-in (OTPless / SMS OTP) into the wizard so "install complete" actually means "ready to chat".
- Give users a persistent, legible picture of what's configured and what isn't, usable both at end-of-setup and as the Settings surface afterwards.
- Preserve the existing aesthetic (orbs, glass, purple→pink gradients) while tightening motion and typography.

## 3. Non-goals

- Not touching the underlying install phases (Node, Playwright, embedding model download) beyond making them skippable and resumable.
- Not adding telemetry. Detection runs entirely locally.
- Not supporting multi-profile accounts on a single machine.
- Not importing settings from other AI assistants.
- Not replacing the Electron + HTML wizard stack with a React rewrite; we refactor into components but stay in Electron-native HTML.

## 4. Core Philosophy

The wizard asks only for what it genuinely can't detect. Everything else is detected, displayed for confirmation, and skipped by default. Three rules:

1. **Detect, don't assume.** If detection fails or is ambiguous, show the step. Fail-safe is always "show", never "skip".
2. **Everything is visible.** Skipped steps appear in a collapsible "Already set" strip on every screen — a small row of chips like `Account ✓ · Google ✓ · Telegram ✓` pinned above the step title. Clicking any chip drops the user back into that step with its current value pre-filled.
3. **Wizard is a lens on Settings, not a separate UI.** Every wizard screen is backed by the same component that later lives in Settings. Re-running setup from Settings opens the same flow.

## 5. Detection Signals

All signals read in parallel before the first screen paints, each capped at 500 ms with a fail-safe "show the step" fallback on timeout or error.

### Core signals

| Signal | Source | Triggers |
|---|---|---|
| OS platform | `process.platform` | Hides Windows-only / macOS-only cards |
| Existing `SETUP_FLAG` | `fs.existsSync(SETUP_FLAG)` | Header copy "Welcome" → "Reconfigure"; preserves prior answers as defaults |
| Encrypted `.env` present | `loadEnvDecrypted()` | Pre-fills credential fields as `••••••• (detected)` — actual tokens never displayed, even masked |
| Google tokens file | `data/google-tokens/*.json` | Shows connected email; skips Sign-in button |
| OTPless session | `prefs.account` | Skips Sign-in step if valid + not expired |
| Node.js 20+ | `checkNodeInstalled()` | Skips Node download phase |
| Playwright Chromium | `node_modules/.playwright-browsers/` | Skips ~130 MB Chromium phase |
| Embedding model | `~/.cache/huggingface/transformers/...MiniLM...` | Skips model warmup phase |
| Accessibility permission | `systemPreferences.isTrustedAccessibilityClient(false)` (macOS) | Green-checks the Accessibility tile |
| Screen Recording | `systemPreferences.getMediaAccessStatus('screen')` | Same pattern |
| Microphone | `systemPreferences.getMediaAccessStatus('microphone')` | Same pattern |
| Location | `systemPreferences.getMediaAccessStatus('location')` | Same pattern |
| System theme | `nativeTheme.shouldUseDarkColors` | Pre-selects theme |
| Workspace folder | `fs.existsSync(defaultWorkspace)` | Pre-confirms path |
| Hotkey conflict | Test-register `Alt+Space` via `globalShortcut` | On conflict, hotkey step is forced (not skippable) |
| App version | `package.json` vs stored version | On upgrade, route to slim "What's new + re-auth" flow |

### Channel signals

| Signal | Source | Triggers |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` + `ALLOWED_USER_IDS` in `.env` | Telegram card "Connected", shows Test button |
| Discord | `DISCORD_BOT_TOKEN` | Discord card "Connected" |
| Slack | `data/slack-installs/*.json` | Shows workspace name |
| WhatsApp | `data/whatsapp-users/owners.json` non-empty | Shows owner JID + live status |
| Matrix | `MATRIX_HOMESERVER` + `MATRIX_ACCESS_TOKEN` | Shows homeserver |
| Email | `EMAIL_USER` + `EMAIL_PASSWORD` | Shows IMAP address |

Every detected value has a "change" / "reconnect" / "remove" affordance next to it. Detection never locks a field.

## 6. Wizard Flow

Six linear steps, followed by the Ready Hub (landing surface, covered in Section 7). Each step shows / skips based on `SystemState`.

| # | Step | Skipped when... | Defaults |
|---|---|---|---|
| 1 | **Welcome** | Reconfigure mode | — |
| 2 | **Sign in** (OTPless / SMS OTP) | Valid OTPless session exists | — |
| 3 | **Profile** (name + tone) | Prior profile in `data/profile.json` | Name from OS user; tone = "friendly" |
| 4 | **Personalize** (one page, 4 cards: Hotkey / Theme / Voice / Wake word) | All four already configured (each card skippable individually) | Alt+Space; OS theme; first Gemini voice; wake word off |
| 5 | **Permissions** (macOS card grid) | All needed permissions granted, or non-macOS platform | Live-polled every 1 s while visible |
| 6 | **Install** | Always shown, but auto-advances if detection left zero phases to run | Phase list derived from detection |
| — | **Ready Hub** (landing, not a wizard step) | Never | Always reached |

Step dots always show all six slots even when a step is skipped, filled gray — users can see skipped steps exist and click back to them.

### Screen 4 — Personalize

Single page, four cards:

- **Hotkey** — pre-fills `Alt + Space`, "Record new" button captures a combo via temporary `globalShortcut` registration. If detection found a conflict, this card gets a red banner and Continue is disabled until the user picks a working combo.
- **Theme** — three-pill Light / Dark / System, pre-selected from `nativeTheme.shouldUseDarkColors`. Wizard recolors live as user toggles.
- **Voice** — dropdown grouped by backend (Gemini Live: Aoede/Charon/Kore/Fenrir/Puck; OpenAI Realtime: alloy/shimmer/echo), with a 3-second "Preview" button and a "Decide later" link.
- **Wake word** — off by default. When enabled, text field with "Hey Atlas" default + info tooltip.

User can click Continue without touching anything (safe defaults).

### Screen 5 — Permissions

Each needed permission is a card: icon, one-sentence purpose, status pill, Grant button. Clicking Grant opens the correct Preferences pane via `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_...')`. The card listens for permission changes and flips green live — user does not need to come back and click anything.

A "Skip this" button collapses the card with a `⚠️ Some features disabled` note; the skipped permission reappears as an amber tile in the Ready Hub.

Windows version: single info card ("Windows will prompt when needed") — no upfront grants.

### Screen 6 — Install

The install phase list is built from detection. A fully-cached machine might only run 3 phases (data dir, workspace, seed flag) and finish in under 5 seconds. Progress bar percentages are derived from the actual task list, not hardcoded.

Real-time log keeps the terminal feel. Error lines get action buttons: **Retry phase** / **Skip this phase** / **Copy error**. Failure pauses the install mid-flight; user can retry the single failed phase without restarting.

### Screen 7 — Ready Hub

See Section 7.

## 7. Ready Hub

The hub is the combined end-of-setup screen and Settings → Setup tab. Same HTML, same component instances, same IPC.

**Structure (top to bottom):**

1. **Greeting hero** — breathing orb avatar (3 s scale cycle 1.00 → 1.04 → 1.00), personalized greeting (`"Hey {name} 👋"`), one-line subtitle with hotkey reminder, two primary buttons: `🎙 Talk to A.T.L.A.S` / `⌨️ Type a message`.
2. **Status header** — label "YOUR SETUP" left, "X of Y complete" right. The counter is an invitation, not pressure; users can stay at "6 of 8" forever.
3. **Status tiles grid** — semantic left-border colors: green = done, amber = needs attention, neutral = unset.

**Tile set:**

| Tile | Data | Action |
|---|---|---|
| Account | email + plan + credits | Click → Settings → Account |
| Overlay | current hotkey | Click → Personalize → Hotkey |
| Permissions | `X of 4 granted` | Click → Permissions grid |
| Google | connected email, Calendar + Gmail | Click → reconnect / remove |
| Channels | `N connected` or `+ Add ...` | Click → channel picker |
| Voice | voice name + backend | Click → Voice picker |
| Theme | current theme | Click → Theme switch |
| Wake word | on / off | Click → toggle + phrase |

4. **"Try this" strip** — rotating 3 example prompts chosen from what's connected (Google linked → calendar examples; channels linked → messaging examples; no channels → overlay examples).

**Behavior:**

- Tiles live-update. Granting Screen Recording flips its tile green without refresh. Border does a single 300 ms green pulse on state transition.
- Tapping any tile opens its detail pane — the same pane used inside the wizard. No duplicate surfaces.
- "Launch A.T.L.A.S" collapses the hub into Settings. Users can also just ignore it and talk to Atlas.

## 8. Channels Sub-flow

Channels are optional and deferrable. Desktop overlay works with only sign-in — "no channel connected" is valid forever.

Tapping the Channels tile opens a full-screen picker with a 6-cell grid:

- **Telegram** — bot token + allowed user IDs fields + "Test connection" button that hits Telegram `getMe` before saving.
- **Discord** — same pattern (token + allowed IDs + test).
- **Slack** — "Install to workspace" button kicks off OAuth in a popup.
- **WhatsApp** — live QR code via Baileys; connection progress in real time; auto-regenerate on QR expiry.
- **Matrix** — homeserver URL + access token + element.io linkout for how to get a token.
- **Email** — IMAP host/port/TLS + SMTP host/port/TLS + credentials. Presets for Gmail (993/587) and Outlook. "Verify IMAP login" button before save.

**Test-before-save is mandatory for credential-entry channels** (Telegram, Discord, Matrix, Email). Credentials are never written to `.env` until the live API test passes. On failure, the form shows the specific error with a docs link.

**Slack and WhatsApp don't have a separate test step** — the connect flow itself is the test: Slack OAuth only returns with a real workspace bind, and WhatsApp QR scan only completes when Baileys confirms the pairing. Both are transactional by construction.

## 9. Visual & Motion

- Orbs shift position slightly between wizard screens (CSS transforms, negligible cost) so background subtly reflects progress.
- Ready Hub's breathing orb avatar also appears as a small persistent marker in the Settings header — threads identity through the app.
- Status tile colors follow semantics, not decoration. Accent colors are never status signals.
- Permission grant transitions produce a single 300 ms green border-pulse.
- Theme toggle is live — wizard recolors instantly on change, no reload.
- The LRU / HNSW / etc. acronym wall is retired from the wizard. It becomes a "Settings → About Atlas → Under the hood" page — self-selecting for the curious.
- Type scale: 24 / 16 / 13 px (down from 32 / 18 / 15 today). Lighter, less "installer-y".

No lottie, no heavy gradient animation, no parallax.

## 10. Technical Architecture

### New files

- `desktop/detection.js` — runs all signals in parallel, returns `SystemState`. Each signal wrapped in 500 ms timeout with fail-safe fallback.
- `desktop/components/permissions-grid.js` — OS permission list with live polling + grant links.
- `desktop/components/hotkey-picker.js` — combo capture + conflict detection via `globalShortcut`.
- `desktop/components/channel-card.js` — single component, `type` prop switches between Telegram / Discord / Slack / WhatsApp / Matrix / Email forms; owns its test button.
- `desktop/components/voice-picker.js` — dropdown + preview.
- `desktop/components/theme-switch.js` — three-pill switch with live preview.
- `desktop/components/status-tile.js` — colored-border tile with live-update hooks.
- `desktop/components/install-log.js` — terminal-feel log with per-error action buttons.
- `desktop/ready-hub.html` — hub shell, embedded both at end of wizard and inside `panel.html` as Settings → Setup tab.

### Modified files

- `desktop/wizard.html` — rewritten as adaptive flow driven by `SystemState`. Imports components.
- `desktop/main.js` — new IPC handlers.
- `desktop/preload.js` — new IPC surface.
- `desktop/panel.html` — embeds `ready-hub.html` under a new Setup tab.

### IPC surface (preload)

```js
setupDetect()                    // → SystemState
setupTestChannel(type, creds)    // → { ok: bool, error?: string }
setupRequestPermission(name)     // opens Preferences pane
setupPollPermissions()           // → current permission map
setupRecordHotkey()              // briefly registers listener → combo string
setupListVoices(backend)         // → voice array
setupPreviewVoice(backend, name) // plays sample
setupSavePersonalize(config)     // persists hotkey/voice/theme/wake-word
setupRetryInstallPhase(phaseId)  // retries one phase
setupResumeInstall()             // picks up crashed install
```

### `SystemState` shape

```js
{
  platform: 'darwin' | 'win32' | 'linux',
  isReconfigure: boolean,
  version: { current: string, previous?: string },
  account: { signedIn: boolean, email?: string, plan?: string, credits?: number },
  profile: { name?: string, tone?: string },
  permissions: { accessibility, screen, microphone, location }, // each 'granted' | 'denied' | 'unknown'
  installed: { node, playwright, embeddingModel, sox },         // each boolean
  google: { connected: boolean, email?: string },
  channels: { telegram?, discord?, slack?, whatsapp?, matrix?, email? },
  hotkey: { current: string, conflicts: string[] },
  theme: 'light' | 'dark',
  workspace: { path: string, exists: boolean }
}
```

### Install resumability

- New file `data/setup-state.json` tracks per-phase completion. Each phase writes a done-marker after success.
- `SETUP_FLAG` is only written when every required phase has a done-marker.
- On crash mid-install, `setup:detect` reads the state file and routes the wizard to a "Resume install" screen with completed phases pre-checked and grayed.
- Each phase is idempotent. Retry runs only the failed phase, not the whole sequence.

### Channel save transactions

Creds are never persisted before the test passes. Order: enter → Test → IPC fires live API call (Telegram `getMe`, Discord `gateway/bot`, IMAP LOGIN, etc.) → success → write encrypted `.env` → tile turns green. On test failure, form shows the specific error and a docs link.

### Windows parity

- Permissions grid hidden; replaced by "Windows will prompt when needed" info card.
- Hotkey default: `Ctrl + Space` (Alt + Space opens window menu on Windows).
- Install skips macOS-only phases (Swift OCR, CoreLocation helper).

### Safety

- No telemetry. Detection is fully local.
- Install log redacts sensitive prefixes (bot tokens, IMAP passwords) so screenshots don't leak creds.

## 11. Rollout

- Replace, don't feature-flag. The current `wizard.html` is a single file; swapping it is reversible via git.
- Existing users on a completed install are unaffected: `SETUP_FLAG` is already written, so they boot straight to panel. Only impact is new "Setup" tab in Settings, which reads their already-configured state and shows green tiles.
- Migration: first run after upgrade loads `SystemState`, confirms everything is configured, and silently flips `SETUP_FLAG` version field. No user interaction required.

## 12. Open Questions for Implementation Plan

- Which component framework for the shared components — vanilla JS classes, or adopt a thin library (Preact, lit-html)? Current wizard is vanilla; leaning vanilla for consistency.
- Hotkey conflict detection: `globalShortcut.isRegistered()` only tests our own registrations. Third-party app conflicts (e.g., Spotlight on Alt+Space) require a different probe. Plan needs to settle on an approach (try-register + immediate unregister + heuristic check against known system hotkeys).
- Windows permissions: confirm which Atlas features actually need UAC elevation at install time vs which are handled by runtime prompts. Plan should enumerate.
