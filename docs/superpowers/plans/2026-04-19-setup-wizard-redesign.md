# Setup Wizard Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the A.T.L.A.S desktop setup wizard as a detection-first adaptive flow: cut time-to-first-chat to under 2 minutes, make desktop overlay the zero-config critical path, add account sign-in + macOS permissions + channel picker + voice/hotkey/theme/wake-word to the wizard, and land users on a persistent Ready Hub that doubles as the Settings → Setup surface.

**Architecture:** Vanilla JS Electron app. A new `desktop/detection/` module runs pre-flight signal probes in parallel (each with a 500 ms timeout + fail-safe fallback) and returns a single `SystemState`. A pure `wizard/router.js` consumes that state and returns the ordered list of steps to show. Shared renderer components in `desktop/components/*.js` (status-tile, permissions-grid, hotkey-picker, voice-picker, theme-switch, channel-card, install-log) are mounted by both the wizard and the Ready Hub — same UI, both surfaces. The install step runs a resumable phase pipeline keyed to `data/setup-state.json`, so crashes don't restart from zero. Channel credentials are gated by a test-before-save IPC that only persists to encrypted `.env` after a live API verification passes.

**Tech Stack:** Electron 40 main process (CommonJS), contextBridge-exposed IPC in `preload.js`, vanilla JS class components in the renderer, vitest for pure-logic tests in `desktop/`, existing `electron-store` for prefs, existing `safeStorage`-backed `.env` encryption, `globalShortcut` for hotkey probing, `systemPreferences` for macOS permission state, `nativeTheme` for theme detection.

**Spec:** `docs/superpowers/specs/2026-04-18-setup-wizard-redesign-design.md`

> ⚠️ **Before starting Task A0, read Phase E at the bottom of this plan.** Phase E canonicalizes cross-phase conventions (file paths, component API, IPC names, test dir, SystemState shape) and adds three spec-required tasks (hotkey conflict banner, per-permission Skip, Slack OAuth completion) that were missing from the original fragments. Every rule there overrides conflicting text in Phases A–D.

## Phases at a glance

- **Phase A — Detection & State.** Bootstrap vitest in desktop/, write pure signal probes (TDD), write the parallel orchestrator with per-signal timeouts (TDD), wire `setup:detect` + `setup:poll-permissions` IPCs. Existing wizard untouched and still loads unchanged at end of phase.
- **Phase B — Shared Components.** Eight tasks covering `status-tile`, `permissions-grid`, `hotkey-picker`, `voice-picker`, `theme-switch`, `channel-card` (six channel types with test-before-save), `install-log`, plus `components.css` and a smoke page. TDD the pure helpers; manual checklists for DOM/IPC.
- **Phase C — Adaptive Wizard & Resumable Install.** Pure step router, rewritten `wizard.html` shell, six step modules (welcome / signin / profile / personalize / permissions / install), declarative phase list + resumable runner keyed by `data/setup-state.json`, rewired `setup:install` + `setup:retry-install-phase` + `setup:resume-install`, the "Already set" chip strip, Windows parity pass, and an end-to-end smoke gate.
- **Phase D — Ready Hub, Settings Integration & Migration.** `desktop/ready-hub.html` with breathing avatar + 8 live tiles, live tile diff/pulse animations, rotating "Try this" prompts, Talk/Type button wire-up, Settings → Setup tab in `panel.html` via a shared `ready-hub-body` partial, channel picker sub-flow, motion polish, the retired LRU/HNSW wall moved to a "Settings → About → Under the hood" page, type-scale retune, v1→v2 migration, secret-redaction audit, and a 5-scenario acceptance gate.
- **Phase E — Plan Corrections & Cross-Phase Glue.** Pre-flight section at the bottom of this plan — not a build phase. Canonicalizes conventions, patches drift between the four fragments, adds three missing spec requirements (hotkey conflict banner E3a, per-permission Skip E3b, Slack OAuth completion E3c). Read before Task A0.

---

## Phase A — Detection & State

This phase implements the "detect, don't assume" backbone of the redesigned wizard. We bootstrap vitest in `desktop/`, write a pure-logic signal-probe module (TDD), write a parallel orchestrator with per-signal timeouts (TDD), and wire two new IPC handlers (`setup:detect`, `setup:poll-permissions`) into `main.js` + `preload.js`. No UI is touched in Phase A — the existing wizard must continue to load unchanged at the end of this phase.

### Task A0: Bootstrap vitest in desktop/

**Files:**
- `desktop/package.json`
- `desktop/vitest.config.js`
- `desktop/tests/smoke.test.js`

- [ ] **Step 1: Add vitest as a dev dependency and test script.**

Edit `desktop/package.json` — add `"test": "vitest run"` to the `scripts` block (directly after the `"start"` line) and add `"vitest": "^2.1.9"` to `devDependencies`:

```json
    "scripts": {
        "start": "electron .",
        "test": "vitest run",
        "prebuild": "echo 'Source protection will run after pack...'",
```

```json
    "devDependencies": {
        "bytenode": "^1.5.7",
        "electron": "^40.6.1",
        "electron-builder": "^26.8.1",
        "javascript-obfuscator": "^4.1.1",
        "vitest": "^2.1.9"
    },
```

Then install:

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm install
```

- [ ] **Step 2: Create `desktop/vitest.config.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.js"],
        globals: false,
        testTimeout: 5000,
    },
});
```

- [ ] **Step 3: Write the smoke test (failing-then-passing is trivial here — this verifies the runner works).**

Create `desktop/tests/smoke.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");

describe("smoke", () => {
    it("runs vitest", () => {
        expect(true).toBe(true);
    });
});
```

- [ ] **Step 4: Run tests, confirm green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

Expect: `1 passed`.

- [ ] **Step 5: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add package.json package-lock.json vitest.config.js tests/smoke.test.js && git commit -m "feat(setup): bootstrap vitest in desktop package" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A1: Detection signal probes (pure logic, TDD)

**Files:**
- `desktop/tests/detection/signals.test.js`
- `desktop/detection/signals.js`

- [ ] **Step 1: Write failing tests for every probe.**

Create `desktop/tests/detection/signals.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const signals = require("../../detection/signals");

describe("detectPlatform", () => {
    it("returns 'darwin' for macOS", () => {
        expect(signals.detectPlatform({ platform: "darwin" })).toBe("darwin");
    });
    it("returns 'win32' for Windows", () => {
        expect(signals.detectPlatform({ platform: "win32" })).toBe("win32");
    });
    it("returns 'linux' for Linux", () => {
        expect(signals.detectPlatform({ platform: "linux" })).toBe("linux");
    });
});

describe("detectSetupFlag", () => {
    it("returns true when the flag file exists", () => {
        const fs = { existsSync: (p) => p === "/tmp/SETUP" };
        expect(signals.detectSetupFlag(fs, "/tmp/SETUP")).toBe(true);
    });
    it("returns false when the flag file is missing", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectSetupFlag(fs, "/tmp/SETUP")).toBe(false);
    });
});

describe("detectEnvPresent", () => {
    it("returns true on .env presence, never leaks content", () => {
        const fs = { existsSync: () => true };
        const result = signals.detectEnvPresent(fs, "/tmp/.env");
        expect(result).toBe(true);
    });
    it("returns false when absent", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectEnvPresent(fs, "/tmp/.env")).toBe(false);
    });
});

describe("detectGoogleTokens", () => {
    it("returns disconnected when the directory is missing", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        const result = await signals.detectGoogleTokens(fs, "/tmp/google");
        expect(result).toEqual({ connected: false });
    });
    it("extracts email from a token filename", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readdir: async () => ["user@example.com.json", ".DS_Store"] },
        };
        const result = await signals.detectGoogleTokens(fs, "/tmp/google");
        expect(result).toEqual({ connected: true, email: "user@example.com" });
    });
});

describe("detectOtplessSession", () => {
    it("returns signed-in when the prefs account is not expired", () => {
        const future = Date.now() + 60_000;
        const prefs = {
            account: {
                signedIn: true, email: "a@b.com", plan: "pro", credits: 42, expiresAt: future,
            },
        };
        const r = signals.detectOtplessSession(prefs);
        expect(r).toEqual({ signedIn: true, email: "a@b.com", plan: "pro", credits: 42 });
    });
    it("returns signed-out when expired", () => {
        const past = Date.now() - 60_000;
        const prefs = { account: { signedIn: true, email: "x@y.com", expiresAt: past } };
        expect(signals.detectOtplessSession(prefs)).toEqual({ signedIn: false });
    });
    it("returns signed-out when absent", () => {
        expect(signals.detectOtplessSession({})).toEqual({ signedIn: false });
    });
});

describe("detectNodeInstalled", () => {
    it("returns true when node --version succeeds", async () => {
        const execFn = async () => ({ stdout: "v20.11.1\n" });
        expect(await signals.detectNodeInstalled(execFn)).toBe(true);
    });
    it("returns false when node --version throws", async () => {
        const execFn = async () => { throw new Error("ENOENT"); };
        expect(await signals.detectNodeInstalled(execFn)).toBe(false);
    });
    it("returns false for Node < 20", async () => {
        const execFn = async () => ({ stdout: "v18.17.0\n" });
        expect(await signals.detectNodeInstalled(execFn)).toBe(false);
    });
});

describe("detectPlaywrightChromium", () => {
    it("returns true when the browsers dir exists", () => {
        const fs = { existsSync: (p) => p.endsWith(".local-browsers") };
        expect(signals.detectPlaywrightChromium(fs, "/bot")).toBe(true);
    });
    it("returns false otherwise", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectPlaywrightChromium(fs, "/bot")).toBe(false);
    });
});

describe("detectEmbeddingModel", () => {
    it("returns true when MiniLM cache folder exists", async () => {
        const fs = {
            existsSync: (p) => p.includes("transformers"),
            promises: { readdir: async () => ["models--Xenova--all-MiniLM-L6-v2"] },
        };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(true);
    });
    it("returns false when no MiniLM entry exists", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readdir: async () => ["models--other--model"] },
        };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(false);
    });
    it("returns false when the cache path is missing", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(false);
    });
});

describe("detectMacPermissions", () => {
    it("maps Electron statuses to granted/denied/unknown", () => {
        const sp = {
            isTrustedAccessibilityClient: () => true,
            getMediaAccessStatus: (kind) => ({
                screen: "granted", microphone: "denied", location: "not-determined",
            }[kind]),
        };
        expect(signals.detectMacPermissions(sp)).toEqual({
            accessibility: "granted",
            screen: "granted",
            microphone: "denied",
            location: "unknown",
        });
    });
});

describe("detectTheme", () => {
    it("returns dark when nativeTheme reports dark", () => {
        expect(signals.detectTheme({ shouldUseDarkColors: true })).toBe("dark");
    });
    it("returns light otherwise", () => {
        expect(signals.detectTheme({ shouldUseDarkColors: false })).toBe("light");
    });
});

describe("detectWorkspace", () => {
    it("reports existence", () => {
        const fs = { existsSync: () => true };
        expect(signals.detectWorkspace(fs, "/ws")).toEqual({ path: "/ws", exists: true });
    });
    it("reports non-existence", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectWorkspace(fs, "/ws")).toEqual({ path: "/ws", exists: false });
    });
});

describe("detectHotkeyConflict", () => {
    it("returns empty array when registration succeeds", () => {
        const gs = { register: () => true, unregister: () => {}, isRegistered: () => false };
        expect(signals.detectHotkeyConflict(gs, "Alt+Space")).toEqual([]);
    });
    it("returns a conflict reason when registration fails", () => {
        const gs = { register: () => false, unregister: () => {}, isRegistered: () => true };
        const r = signals.detectHotkeyConflict(gs, "Alt+Space");
        expect(r.length).toBeGreaterThan(0);
        expect(r[0]).toMatch(/Alt\+Space/);
    });
});

describe("detectAppVersion", () => {
    it("returns current with no previous when stored file is missing", () => {
        const fs = { existsSync: () => false, readFileSync: () => "" };
        expect(signals.detectAppVersion(fs, "1.0.0", "/tmp/v.json")).toEqual({ current: "1.0.0" });
    });
    it("returns current and previous when stored version differs", () => {
        const fs = { existsSync: () => true, readFileSync: () => JSON.stringify({ version: "0.9.0" }) };
        const r = signals.detectAppVersion(fs, "1.0.0", "/tmp/v.json");
        expect(r).toEqual({ current: "1.0.0", previous: "0.9.0" });
    });
});

describe("channel probes", () => {
    it("detectTelegram needs BOTH token and allowed IDs", () => {
        expect(signals.detectTelegram({ TELEGRAM_BOT_TOKEN: "x", ALLOWED_USER_IDS: "1" }))
            .toEqual({ connected: true });
        expect(signals.detectTelegram({ TELEGRAM_BOT_TOKEN: "x" })).toBeUndefined();
        expect(signals.detectTelegram({})).toBeUndefined();
    });
    it("detectDiscord reads DISCORD_BOT_TOKEN", () => {
        expect(signals.detectDiscord({ DISCORD_BOT_TOKEN: "x" })).toEqual({ connected: true });
        expect(signals.detectDiscord({})).toBeUndefined();
    });
    it("detectSlack finds the first workspace json", async () => {
        const fs = {
            existsSync: () => true,
            promises: {
                readdir: async () => ["team-abc.json"],
                readFile: async () => JSON.stringify({ team: { name: "Team ABC" } }),
            },
        };
        expect(await signals.detectSlack(fs, "/data/slack")).toEqual({
            connected: true, workspace: "Team ABC",
        });
    });
    it("detectSlack returns undefined when dir is empty", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        expect(await signals.detectSlack(fs, "/data/slack")).toBeUndefined();
    });
    it("detectWhatsApp returns owner when owners file is non-empty", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readFile: async () => JSON.stringify([{ jid: "123@s.whatsapp.net" }]) },
        };
        expect(await signals.detectWhatsApp(fs, "/data/wa/owners.json")).toEqual({
            connected: true, owner: "123@s.whatsapp.net",
        });
    });
    it("detectWhatsApp returns undefined on empty array", async () => {
        const fs = { existsSync: () => true, promises: { readFile: async () => "[]" } };
        expect(await signals.detectWhatsApp(fs, "/f")).toBeUndefined();
    });
    it("detectMatrix needs homeserver AND token", () => {
        expect(signals.detectMatrix({ MATRIX_HOMESERVER: "h", MATRIX_ACCESS_TOKEN: "t" }))
            .toEqual({ connected: true, homeserver: "h" });
        expect(signals.detectMatrix({ MATRIX_HOMESERVER: "h" })).toBeUndefined();
    });
    it("detectEmail needs user AND password", () => {
        expect(signals.detectEmail({ EMAIL_USER: "u@x.com", EMAIL_PASSWORD: "p" }))
            .toEqual({ connected: true, address: "u@x.com" });
        expect(signals.detectEmail({ EMAIL_USER: "u@x.com" })).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test file — expect failure (module doesn't exist yet).**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/detection/signals.test.js
```

Expect: cannot find module `../../detection/signals`.

- [ ] **Step 3: Create `desktop/detection/signals.js` with every probe.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// Pure-logic detection probes. Each takes injected dependencies so it can be
// unit-tested without Electron or the real filesystem. The orchestrator in
// ./index.js wires the real fs/electron APIs and applies a timeout wrapper.
//
// Privacy: probes NEVER return credential or token contents. They report
// presence/absence, or an email extracted from a filename.

"use strict";

const path = require("path");

function detectPlatform(proc) {
    const p = proc && proc.platform;
    if (p === "darwin" || p === "win32" || p === "linux") return p;
    return "linux";
}

function detectSetupFlag(fs, setupFlagPath) {
    try { return !!fs.existsSync(setupFlagPath); } catch { return false; }
}

function detectEnvPresent(fs, envPath) {
    // Presence-only. We do NOT read, parse, or return the file content here.
    try { return !!fs.existsSync(envPath); } catch { return false; }
}

async function detectGoogleTokens(fs, tokenDir) {
    try {
        if (!fs.existsSync(tokenDir)) return { connected: false };
        const entries = await fs.promises.readdir(tokenDir);
        const tokens = entries.filter((n) => n.endsWith(".json") && !n.startsWith("."));
        if (tokens.length === 0) return { connected: false };
        // Filename convention: <email>.json
        const email = tokens[0].replace(/\.json$/, "");
        return { connected: true, email };
    } catch {
        return { connected: false };
    }
}

function detectOtplessSession(prefs) {
    const acct = prefs && prefs.account;
    if (!acct || !acct.signedIn) return { signedIn: false };
    if (acct.expiresAt && typeof acct.expiresAt === "number" && acct.expiresAt < Date.now()) {
        return { signedIn: false };
    }
    const out = { signedIn: true };
    if (acct.email) out.email = acct.email;
    if (acct.plan) out.plan = acct.plan;
    if (typeof acct.credits === "number") out.credits = acct.credits;
    return out;
}

async function detectNodeInstalled(execFn) {
    try {
        const res = await execFn("node --version");
        const stdout = (res && res.stdout) || "";
        const m = stdout.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (!m) return false;
        return parseInt(m[1], 10) >= 20;
    } catch {
        return false;
    }
}

function detectPlaywrightChromium(fs, botDir) {
    try {
        const p = path.join(botDir, "node_modules", "playwright-core", ".local-browsers");
        return !!fs.existsSync(p);
    } catch {
        return false;
    }
}

async function detectEmbeddingModel(fs, homeDir) {
    try {
        const cacheDir = path.join(homeDir, ".cache", "huggingface", "transformers");
        if (!fs.existsSync(cacheDir)) return false;
        const entries = await fs.promises.readdir(cacheDir);
        return entries.some((n) => /MiniLM/i.test(n));
    } catch {
        return false;
    }
}

function detectMacPermissions(systemPreferences) {
    const normalize = (raw) => {
        if (raw === "granted") return "granted";
        if (raw === "denied" || raw === "restricted") return "denied";
        return "unknown";
    };
    try {
        const acc = systemPreferences.isTrustedAccessibilityClient
            ? systemPreferences.isTrustedAccessibilityClient(false)
            : false;
        return {
            accessibility: acc ? "granted" : "unknown",
            screen: normalize(systemPreferences.getMediaAccessStatus("screen")),
            microphone: normalize(systemPreferences.getMediaAccessStatus("microphone")),
            location: normalize(systemPreferences.getMediaAccessStatus("location")),
        };
    } catch {
        return { accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown" };
    }
}

function detectTheme(nativeTheme) {
    return nativeTheme && nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function detectWorkspace(fs, workspacePath) {
    let exists = false;
    try { exists = !!fs.existsSync(workspacePath); } catch { exists = false; }
    return { path: workspacePath, exists };
}

function detectHotkeyConflict(globalShortcut, combo) {
    const conflicts = [];
    try {
        const registered = globalShortcut.register(combo, () => {});
        if (!registered) {
            conflicts.push(`${combo} is already registered by another application`);
        } else {
            globalShortcut.unregister(combo);
        }
    } catch (err) {
        conflicts.push(`Hotkey probe failed for ${combo}: ${err.message || err}`);
    }
    return conflicts;
}

function detectAppVersion(fs, currentVersion, storedVersionPath) {
    try {
        if (!fs.existsSync(storedVersionPath)) return { current: currentVersion };
        const raw = fs.readFileSync(storedVersionPath, "utf8") || "";
        const parsed = JSON.parse(raw || "{}");
        if (parsed && parsed.version && parsed.version !== currentVersion) {
            return { current: currentVersion, previous: parsed.version };
        }
        return { current: currentVersion };
    } catch {
        return { current: currentVersion };
    }
}

// ── Channel probes ─────────────────────────────────
function detectTelegram(envObj) {
    const e = envObj || {};
    if (e.TELEGRAM_BOT_TOKEN && e.ALLOWED_USER_IDS) return { connected: true };
    return undefined;
}

function detectDiscord(envObj) {
    if (envObj && envObj.DISCORD_BOT_TOKEN) return { connected: true };
    return undefined;
}

async function detectSlack(fs, slackInstallsDir) {
    try {
        if (!fs.existsSync(slackInstallsDir)) return undefined;
        const entries = await fs.promises.readdir(slackInstallsDir);
        const files = entries.filter((n) => n.endsWith(".json") && !n.startsWith("."));
        if (files.length === 0) return undefined;
        try {
            const raw = await fs.promises.readFile(path.join(slackInstallsDir, files[0]), "utf8");
            const parsed = JSON.parse(raw);
            const name = (parsed && parsed.team && parsed.team.name) || files[0].replace(/\.json$/, "");
            return { connected: true, workspace: name };
        } catch {
            return { connected: true, workspace: files[0].replace(/\.json$/, "") };
        }
    } catch {
        return undefined;
    }
}

async function detectWhatsApp(fs, ownersFile) {
    try {
        if (!fs.existsSync(ownersFile)) return undefined;
        const raw = await fs.promises.readFile(ownersFile, "utf8");
        const parsed = JSON.parse(raw || "[]");
        if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
        const first = parsed[0];
        const owner = (first && (first.jid || first.id)) || "unknown";
        return { connected: true, owner };
    } catch {
        return undefined;
    }
}

function detectMatrix(envObj) {
    const e = envObj || {};
    if (e.MATRIX_HOMESERVER && e.MATRIX_ACCESS_TOKEN) {
        return { connected: true, homeserver: e.MATRIX_HOMESERVER };
    }
    return undefined;
}

function detectEmail(envObj) {
    const e = envObj || {};
    if (e.EMAIL_USER && e.EMAIL_PASSWORD) {
        return { connected: true, address: e.EMAIL_USER };
    }
    return undefined;
}

module.exports = {
    detectPlatform,
    detectSetupFlag,
    detectEnvPresent,
    detectGoogleTokens,
    detectOtplessSession,
    detectNodeInstalled,
    detectPlaywrightChromium,
    detectEmbeddingModel,
    detectMacPermissions,
    detectTheme,
    detectWorkspace,
    detectHotkeyConflict,
    detectAppVersion,
    detectTelegram,
    detectDiscord,
    detectSlack,
    detectWhatsApp,
    detectMatrix,
    detectEmail,
};
```

- [ ] **Step 4: Run the test file — expect green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/detection/signals.test.js
```

Expect: all `describe` blocks pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add detection/signals.js tests/detection/signals.test.js && git commit -m "feat(setup): add pure-logic detection signal probes with unit tests" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A2: runDetection orchestrator (TDD)

**Files:**
- `desktop/tests/detection/index.test.js`
- `desktop/detection/index.js`

- [ ] **Step 1: Failing tests for the orchestrator.**

Create `desktop/tests/detection/index.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { runDetection, withTimeout } = require("../../detection/index");

describe("withTimeout", () => {
    it("resolves with the probe result when fast", async () => {
        const r = await withTimeout(Promise.resolve("ok"), 100, "fallback");
        expect(r).toBe("ok");
    });
    it("returns fallback when the probe times out", async () => {
        const slow = new Promise((res) => setTimeout(() => res("too-late"), 200));
        const r = await withTimeout(slow, 50, "fallback");
        expect(r).toBe("fallback");
    });
    it("returns fallback when the probe rejects", async () => {
        const bad = Promise.reject(new Error("boom"));
        const r = await withTimeout(bad, 100, "fallback");
        expect(r).toBe("fallback");
    });
});

describe("runDetection", () => {
    const fakeDeps = () => ({
        proc: { platform: "darwin" },
        fs: {
            existsSync: () => false,
            readFileSync: () => "",
            promises: { readdir: async () => [], readFile: async () => "[]" },
        },
        systemPreferences: {
            isTrustedAccessibilityClient: () => false,
            getMediaAccessStatus: () => "not-determined",
        },
        nativeTheme: { shouldUseDarkColors: false },
        globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false },
        prefs: {},
        envObj: {},
        execFn: async () => { throw new Error("no node"); },
        paths: {
            setupFlag: "/tmp/SETUP",
            envFile: "/tmp/.env",
            googleTokens: "/tmp/google-tokens",
            botDir: "/tmp/bot",
            homeDir: "/tmp/home",
            workspace: "/tmp/ws",
            storedVersion: "/tmp/version.json",
            slackInstalls: "/tmp/slack",
            whatsappOwners: "/tmp/wa/owners.json",
        },
        currentVersion: "0.2.0",
        hotkey: "Alt+Space",
    });

    it("returns the full SystemState shape", async () => {
        const state = await runDetection(fakeDeps());
        expect(state).toMatchObject({
            platform: "darwin",
            isReconfigure: false,
            version: { current: "0.2.0" },
            account: { signedIn: false },
            permissions: expect.objectContaining({
                accessibility: expect.any(String),
                screen: expect.any(String),
                microphone: expect.any(String),
                location: expect.any(String),
            }),
            installed: expect.objectContaining({
                node: expect.any(Boolean),
                playwright: expect.any(Boolean),
                embeddingModel: expect.any(Boolean),
            }),
            google: { connected: false },
            channels: expect.any(Object),
            hotkey: { current: "Alt+Space", conflicts: [] },
            theme: "light",
            workspace: { path: "/tmp/ws", exists: false },
        });
    });

    it("survives a throwing probe by substituting the fail-safe", async () => {
        const deps = fakeDeps();
        deps.systemPreferences = {
            isTrustedAccessibilityClient: () => { throw new Error("nope"); },
            getMediaAccessStatus: () => { throw new Error("nope"); },
        };
        const state = await runDetection(deps);
        expect(state.permissions).toEqual({
            accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown",
        });
    });

    it("treats a slow probe as a fallback result", async () => {
        const deps = fakeDeps();
        deps.execFn = () => new Promise((res) => setTimeout(() => res({ stdout: "v20.0.0" }), 2000));
        deps.signalTimeoutMs = 50;
        const state = await runDetection(deps);
        expect(state.installed.node).toBe(false); // fallback when timeout fires
    });

    it("reports reconfigure mode when SETUP flag exists", async () => {
        const deps = fakeDeps();
        deps.fs.existsSync = (p) => p === "/tmp/SETUP";
        const state = await runDetection(deps);
        expect(state.isReconfigure).toBe(true);
    });
});
```

- [ ] **Step 2: Run — expect failure (module missing).**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/detection/index.test.js
```

- [ ] **Step 3: Implement `desktop/detection/index.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// Detection orchestrator: runs every signal in parallel, caps each at a
// timeout, and collapses to a SystemState object. Fail-safe is always
// "show the step" — errors and timeouts never abort detection.

"use strict";

const signals = require("./signals");

const DEFAULT_SIGNAL_TIMEOUT_MS = 500;

function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(fallback);
        }, ms);
        Promise.resolve(promise).then(
            (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
            () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
        );
    });
}

function safeSync(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}

async function runDetection(deps) {
    const {
        proc, fs, systemPreferences, nativeTheme, globalShortcut,
        prefs, envObj, execFn, paths, currentVersion, hotkey,
    } = deps;
    const timeoutMs = deps.signalTimeoutMs || DEFAULT_SIGNAL_TIMEOUT_MS;

    const platform = safeSync(() => signals.detectPlatform(proc), "linux");

    const [
        googleTokens,
        nodeInstalled,
        embeddingModel,
        slack,
        whatsapp,
    ] = await Promise.all([
        withTimeout(signals.detectGoogleTokens(fs, paths.googleTokens), timeoutMs, { connected: false }),
        withTimeout(signals.detectNodeInstalled(execFn), timeoutMs, false),
        withTimeout(signals.detectEmbeddingModel(fs, paths.homeDir), timeoutMs, false),
        withTimeout(signals.detectSlack(fs, paths.slackInstalls), timeoutMs, undefined),
        withTimeout(signals.detectWhatsApp(fs, paths.whatsappOwners), timeoutMs, undefined),
    ]);

    const isReconfigure = safeSync(() => signals.detectSetupFlag(fs, paths.setupFlag), false);
    const envPresent = safeSync(() => signals.detectEnvPresent(fs, paths.envFile), false);
    const account = safeSync(() => signals.detectOtplessSession(prefs), { signedIn: false });
    const playwright = safeSync(() => signals.detectPlaywrightChromium(fs, paths.botDir), false);
    const permissions = platform === "darwin"
        ? safeSync(() => signals.detectMacPermissions(systemPreferences), {
            accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown",
        })
        : { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" };
    const theme = safeSync(() => signals.detectTheme(nativeTheme), "light");
    const workspace = safeSync(() => signals.detectWorkspace(fs, paths.workspace), {
        path: paths.workspace, exists: false,
    });
    const hotkeyConflicts = safeSync(
        () => signals.detectHotkeyConflict(globalShortcut, hotkey),
        [],
    );
    const version = safeSync(
        () => signals.detectAppVersion(fs, currentVersion, paths.storedVersion),
        { current: currentVersion },
    );

    const channels = {};
    const telegram = signals.detectTelegram(envObj);       if (telegram)  channels.telegram  = telegram;
    const discord  = signals.detectDiscord(envObj);        if (discord)   channels.discord   = discord;
    if (slack)    channels.slack    = slack;
    if (whatsapp) channels.whatsapp = whatsapp;
    const matrix   = signals.detectMatrix(envObj);         if (matrix)    channels.matrix    = matrix;
    const email    = signals.detectEmail(envObj);          if (email)     channels.email     = email;

    return {
        platform,
        isReconfigure,
        version,
        envPresent,
        account,
        profile: { name: undefined, tone: undefined },
        permissions,
        installed: {
            node: nodeInstalled,
            playwright,
            embeddingModel,
            sox: false,
        },
        google: googleTokens,
        channels,
        hotkey: { current: hotkey, conflicts: hotkeyConflicts },
        theme,
        workspace,
    };
}

module.exports = { runDetection, withTimeout };
```

- [ ] **Step 4: Re-run, expect green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

- [ ] **Step 5: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add detection/index.js tests/detection/index.test.js && git commit -m "feat(setup): add parallel detection orchestrator with timeouts and fail-safes" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A3: Wire setup:detect IPC handler

**Files:**
- `desktop/main.js` (modify at line 1992)
- `desktop/preload.js` (modify at line 29)

Manual-test only — this step calls Electron APIs and cannot run in vitest.

- [ ] **Step 1: Locate current boot imports in `desktop/main.js`.**

At the top of `desktop/main.js`, ensure the imports include `systemPreferences`, `nativeTheme`, and `globalShortcut` from `electron`. If any are missing, add them to the existing `require("electron")` destructure.

Replacement import (adjust destructure to preserve existing names):

```js
const {
    app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage,
    systemPreferences, nativeTheme, globalShortcut,
} = require("electron");
```

- [ ] **Step 2: Add a helper for `setup:detect` right after `setup:is-complete` at `desktop/main.js:1992`.**

Insert (after the `setup:is-complete` handler, before the blank line preceding `app:info`):

```js
    // Setup: adaptive detection for the redesigned wizard.
    ipcMain.handle("setup:detect", async () => {
        const { runDetection } = require("./detection");
        const prefs = (() => {
            try { return typeof store !== "undefined" && store ? { account: store.get("account") } : {}; }
            catch { return {}; }
        })();
        const envObj = (() => {
            try {
                if (typeof loadEnvDecrypted === "function") return loadEnvDecrypted() || {};
            } catch {}
            return {};
        })();
        const { promisify } = require("util");
        const execFn = promisify(require("child_process").exec);
        const paths = {
            setupFlag: SETUP_FLAG,
            envFile: path.join(app.getPath("userData"), ".env"),
            googleTokens: path.join(app.getPath("userData"), "google-tokens"),
            botDir: path.join(process.resourcesPath || app.getAppPath(), "bot"),
            homeDir: app.getPath("home"),
            workspace: path.join(app.getPath("desktop"), "A.T.L.A.S Files"),
            storedVersion: path.join(app.getPath("userData"), "version.json"),
            slackInstalls: path.join(app.getPath("userData"), "slack-installs"),
            whatsappOwners: path.join(app.getPath("userData"), "whatsapp-users", "owners.json"),
        };
        return runDetection({
            proc: process,
            fs,
            systemPreferences,
            nativeTheme,
            globalShortcut,
            prefs,
            envObj,
            execFn: async (cmd) => execFn(cmd),
            paths,
            currentVersion: app.getVersion(),
            hotkey: process.platform === "win32" ? "Control+Space" : "Alt+Space",
        });
    });
```

- [ ] **Step 3: Expose it on `preload.js` around line 29 (inside the `Setup` block).**

Add (directly after the existing `isSetupComplete` line):

```js
    setupDetect: () => ipcRenderer.invoke("setup:detect"),
```

- [ ] **Step 4: Manual verification.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm start
```

Manual checklist:
- The wizard window opens.
- Open DevTools on the wizard window (Cmd+Opt+I on macOS, Ctrl+Shift+I on Windows).
- In the console, run `await atlas.setupDetect()`.
- Confirm the returned object has these top-level keys: `platform`, `isReconfigure`, `version`, `account`, `profile`, `permissions`, `installed`, `google`, `channels`, `hotkey`, `theme`, `workspace`.
- Confirm `platform` matches `process.platform`.
- Confirm `hotkey.current` is `"Alt+Space"` on macOS / `"Control+Space"` on Windows.
- Confirm the call returns in well under 1 second (≤ ~600 ms wall-clock — one timeout interval).

- [ ] **Step 5: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add main.js preload.js && git commit -m "feat(setup): wire setup:detect IPC handler for adaptive wizard" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A4: setupPollPermissions IPC for live tile updates

**Files:**
- `desktop/main.js`
- `desktop/preload.js`

- [ ] **Step 1: Add the handler directly after `setup:detect` in `desktop/main.js`.**

```js
    // Setup: re-read just the macOS permission map (for 1s live polling from the
    // permissions step of the wizard and from the Ready Hub tile).
    ipcMain.handle("setup:poll-permissions", () => {
        if (process.platform !== "darwin") {
            return { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" };
        }
        const { detectMacPermissions } = require("./detection/signals");
        return detectMacPermissions(systemPreferences);
    });
```

- [ ] **Step 2: Expose in `preload.js` directly after `setupDetect`.**

```js
    setupPollPermissions: () => ipcRenderer.invoke("setup:poll-permissions"),
```

- [ ] **Step 3: Manual verification.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm start
```

Manual checklist (macOS — on Windows this should always return all `granted`):
- Open DevTools on the wizard window.
- Run `await atlas.setupPollPermissions()`. Record the returned map.
- Open System Settings → Privacy & Security → Microphone. Toggle Electron / A.T.L.A.S off.
- Run `await atlas.setupPollPermissions()` again in DevTools.
- Confirm `microphone` flipped from `"granted"` to `"denied"` (or vice-versa).
- Toggle back to original state.

- [ ] **Step 4: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add main.js preload.js && git commit -m "feat(setup): add setup:poll-permissions IPC for live tile refresh" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task A5: Phase-A smoke gate

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite; must be green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

Expect: every test file in `tests/` passes. No failures, no unhandled rejections.

- [ ] **Step 2: Launch the app and confirm no regressions.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm start
```

Manual checklist:
- The existing wizard (`wizard.html`) still loads and displays the 6-step flow as before — Phase A did not touch the UI.
- The app quits cleanly (no lingering `electron` processes).
- In DevTools console, both `atlas.setupDetect` and `atlas.setupPollPermissions` are functions.
- `typeof atlas.isSetupComplete === "function"` still returns `true` (existing surface is intact).

- [ ] **Step 3: Gate commit (empty if nothing dirty — skip commit in that case).**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git status
```

If nothing is pending, skip. Otherwise:

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add -A && git commit -m "chore(setup): phase A gate — detection backbone verified" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Shared Components

Builds the seven Section-10 renderer components (`desktop/components/*.js`), shared `.sp-*` stylesheet, smoke page, and IPC surface (`setup:request-permission`, `setup:test-hotkey`, `setup:save-hotkey`, `setup:list-voices`, `setup:preview-voice`, `setup:test-channel`, `setup:save-channel`, `setup:slack-oauth-start`). Phase A already gave us `window.atlas.setupDetect()` + `setupPollPermissions()`, the `SystemState` shape, and a vitest runner in `desktop/`. Phase C wires these into the rewritten wizard; Phase D reuses in the Ready Hub.

Conventions: each component is ONE file running as an IIFE in the browser AND exporting pure helpers via `if (typeof module !== "undefined") module.exports = { ... }` so vitest can `require()` the same file — no duplicate logic modules. Components are classes on `window.SetupComponents.*` with `mount(container, props)` + `unmount()`; they never `require("electron")`, only `window.atlas.*`. Styles live in `desktop/components/components.css` with `.sp-*` prefix; both `wizard.html` and `panel.html` link it. TDD covers pure helpers only; DOM/IPC wiring gets a manual checklist. Commit footer: `-m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`.

### Task B0: Components directory + shared CSS + dual-page link

**Files:** `desktop/components/components.css`, `desktop/wizard.html`, `desktop/panel.html`

- [ ] **Step 1: Create dirs.**

```bash
mkdir -p /Users/user/Desktop/ATLAS/desktop/components /Users/user/Desktop/ATLAS/desktop/tests/components /Users/user/Desktop/ATLAS/desktop/assets/voices
```

- [ ] **Step 2: Create `desktop/components/components.css` (palette pulled from existing `styles.css` CSS vars so it matches the orb/glass theme).**

```css
/* Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved. */
.sp-root { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text-primary); font-size: 13px; }
.sp-tile { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: var(--radius-md, 18px); background: var(--glass-bg, rgba(255,255,255,0.65)); border: var(--glass-border, 1px solid rgba(255,255,255,0.5)); border-left-width: 4px; box-shadow: var(--shadow-glass, 0 8px 32px rgba(0,0,0,0.08)); cursor: pointer; transition: border-color 300ms ease, transform 120ms ease; }
.sp-tile:hover { transform: translateY(-1px); }
.sp-tile--green { border-left-color: var(--accent-success, #34c759); }
.sp-tile--amber { border-left-color: #ff9f0a; }
.sp-tile--neutral { border-left-color: var(--text-muted, #86868b); }
.sp-tile__label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted, #86868b); }
.sp-tile__value { font-size: 16px; font-weight: 600; color: var(--text-primary, #1d1d1f); }
.sp-tile__secondary { font-size: 12px; color: var(--text-secondary, #515154); }
.sp-tile__action { margin-top: 4px; font-size: 12px; color: var(--accent-primary, #0066cc); text-decoration: none; }
.sp-tile--pulse { animation: sp-tile-pulse 300ms ease; }
@keyframes sp-tile-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,199,89,0.6); } 100% { box-shadow: 0 0 0 6px rgba(52,199,89,0); } }
.sp-perms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.sp-perm { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-radius: var(--radius-md, 18px); background: var(--glass-bg, rgba(255,255,255,0.65)); border: var(--glass-border, 1px solid rgba(255,255,255,0.5)); }
.sp-perm__title { font-weight: 600; font-size: 14px; }
.sp-perm__why { color: var(--text-secondary, #515154); font-size: 12px; }
.sp-perm__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sp-pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.sp-pill--ok { background: rgba(52,199,89,0.15); color: #1d7a3a; }
.sp-pill--bad { background: rgba(255,59,48,0.15); color: #a8271d; }
.sp-pill--idk { background: rgba(142,142,147,0.15); color: #515154; }
.sp-btn { padding: 6px 12px; border-radius: 10px; border: none; cursor: pointer; background: var(--accent-primary, #0066cc); color: white; font-weight: 600; font-size: 12px; }
.sp-btn:hover { background: var(--accent-hover, #0055b3); }
.sp-btn--ghost { background: transparent; color: var(--accent-primary, #0066cc); border: 1px solid rgba(0,102,204,0.3); }
.sp-hotkey { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: var(--radius-md, 18px); background: var(--glass-input, rgba(255,255,255,0.5)); }
.sp-hotkey__combo { font-family: ui-monospace, Menlo, monospace; font-weight: 600; }
.sp-hotkey__status { font-size: 12px; color: var(--text-secondary, #515154); }
.sp-hotkey__conflict { color: var(--accent-danger, #ff3b30); font-weight: 600; }
.sp-hotkey--recording .sp-hotkey__combo::after { content: " ●"; color: var(--accent-danger, #ff3b30); animation: sp-blink 1s infinite; }
@keyframes sp-blink { 50% { opacity: 0; } }
.sp-voice { display: flex; align-items: center; gap: 8px; padding: 10px; }
.sp-voice select { padding: 6px 10px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: var(--glass-input, rgba(255,255,255,0.5)); font-size: 13px; }
.sp-theme { display: inline-flex; padding: 4px; background: var(--glass-input, rgba(255,255,255,0.5)); border-radius: 999px; gap: 2px; }
.sp-theme__pill { padding: 6px 14px; border: none; background: transparent; border-radius: 999px; cursor: pointer; font-size: 12px; color: var(--text-secondary, #515154); }
.sp-theme__pill--active { background: white; color: var(--text-primary, #1d1d1f); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.sp-channel { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: var(--radius-md, 18px); background: var(--glass-bg, rgba(255,255,255,0.65)); border: var(--glass-border, 1px solid rgba(255,255,255,0.5)); }
.sp-channel__title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.sp-channel__form { display: grid; gap: 8px; }
.sp-channel__form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary, #515154); }
.sp-channel__form input, .sp-channel__form select { padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: var(--glass-input, rgba(255,255,255,0.5)); font-size: 13px; font-family: inherit; }
.sp-channel__actions { display: flex; gap: 8px; justify-content: flex-end; }
.sp-channel__status { font-size: 12px; padding: 6px 8px; border-radius: 8px; }
.sp-channel__status--ok { background: rgba(52,199,89,0.12); color: #1d7a3a; }
.sp-channel__status--bad { background: rgba(255,59,48,0.12); color: #a8271d; }
.sp-channel__qr { display: flex; justify-content: center; padding: 8px; background: white; border-radius: 12px; }
.sp-log { font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 12px; border-radius: 12px; background: #0c0f14; color: #cfd8e3; max-height: 280px; overflow-y: auto; }
.sp-log__line { display: flex; gap: 8px; padding: 2px 0; }
.sp-log__line--info { color: #cfd8e3; }
.sp-log__line--ok { color: #6dd17f; }
.sp-log__line--warn { color: #f2c14e; }
.sp-log__line--err { color: #ff7b72; }
.sp-log__actions { display: inline-flex; gap: 6px; margin-left: 8px; }
.sp-log__actions button { padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: transparent; color: inherit; font-size: 11px; cursor: pointer; }
.sp-log__actions button:hover { background: rgba(255,255,255,0.08); }
```

- [ ] **Step 3: Link it.** In `desktop/wizard.html` and `desktop/panel.html`, directly after each file's existing `<link rel="stylesheet" href="styles.css">`, add:

```html
<link rel="stylesheet" href="components/components.css">
```

- [ ] **Step 4: Manual:** `npm start`; DevTools Network tab — `components.css` loads 200 on both pages.

- [ ] **Step 5: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/components.css wizard.html panel.html && git commit -m "feat(setup): add shared .sp-* component stylesheet + dual-page loader" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B1: `status-tile.js`

**Files:** `desktop/tests/components/status-tile.test.js`, `desktop/components/status-tile.js`

- [ ] **Step 1: Failing test.** Create `desktop/tests/components/status-tile.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { classForStatus } = require("../../components/status-tile");

describe("classForStatus", () => {
    it("green", () => { expect(classForStatus("green")).toBe("sp-tile sp-tile--green"); });
    it("amber", () => { expect(classForStatus("amber")).toBe("sp-tile sp-tile--amber"); });
    it("neutral", () => { expect(classForStatus("neutral")).toBe("sp-tile sp-tile--neutral"); });
    it("unknown falls back to neutral", () => {
        expect(classForStatus("weird")).toBe("sp-tile sp-tile--neutral");
        expect(classForStatus(undefined)).toBe("sp-tile sp-tile--neutral");
    });
});
```

- [ ] **Step 2: Run — expect failure.** `cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/status-tile.test.js`

- [ ] **Step 3: Create `desktop/components/status-tile.js` (dual IIFE-browser / CommonJS-vitest).**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function classForStatus(status) {
        const allowed = { green: true, amber: true, neutral: true };
        const key = allowed[status] ? status : "neutral";
        return "sp-tile sp-tile--" + key;
    }

    function StatusTile(props) { this.props = props || {}; this._el = null; this._handleClick = null; }
    StatusTile.prototype.mount = function (container) {
        if (!container) throw new Error("StatusTile.mount: container is required");
        const p = this.props;
        const el = document.createElement("div");
        el.className = classForStatus(p.status);
        el.setAttribute("role", p.onClick ? "button" : "group");
        if (p.onClick) el.setAttribute("tabindex", "0");
        const label = document.createElement("div"); label.className = "sp-tile__label"; label.textContent = p.label || ""; el.appendChild(label);
        const value = document.createElement("div"); value.className = "sp-tile__value"; value.textContent = p.value || ""; el.appendChild(value);
        if (p.secondary) { const s = document.createElement("div"); s.className = "sp-tile__secondary"; s.textContent = p.secondary; el.appendChild(s); }
        if (p.actionLabel) { const a = document.createElement("a"); a.className = "sp-tile__action"; a.href = "#"; a.textContent = p.actionLabel; el.appendChild(a); }
        if (p.onClick) {
            this._handleClick = function (e) { e.preventDefault(); p.onClick(); };
            el.addEventListener("click", this._handleClick);
            el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onClick(); } });
        }
        container.appendChild(el); this._el = el; return this;
    };
    StatusTile.prototype.update = function (nextProps) {
        this.props = Object.assign({}, this.props, nextProps || {});
        if (!this._el) return this;
        const nextClass = classForStatus(this.props.status);
        if (this._el.className !== nextClass) {
            this._el.className = nextClass + " sp-tile--pulse";
            const self = this;
            setTimeout(function () { if (self._el) self._el.className = nextClass; }, 320);
        }
        const labelEl = this._el.querySelector(".sp-tile__label");
        const valueEl = this._el.querySelector(".sp-tile__value");
        if (labelEl) labelEl.textContent = this.props.label || "";
        if (valueEl) valueEl.textContent = this.props.value || "";
        return this;
    };
    StatusTile.prototype.unmount = function () {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null; this._handleClick = null;
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.StatusTile = StatusTile; }
    if (typeof module !== "undefined") { module.exports = { classForStatus, StatusTile }; }
})();
```

- [ ] **Step 4: Run tests — expect green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/status-tile.test.js
```

- [ ] **Step 5: Manual (after Task B9 smoke page lands):** mount three tiles with `green`/`amber`/`neutral`; border colors match; click an interactive tile — `onClick` fires.

- [ ] **Step 6: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/status-tile.js tests/components/status-tile.test.js && git commit -m "feat(setup): add StatusTile component + classForStatus helper" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B2: `permissions-grid.js` + `setup:request-permission` IPC

**Files:** `desktop/tests/components/permissions-grid.test.js`, `desktop/components/permissions-grid.js`, `desktop/main.js`, `desktop/preload.js`

- [ ] **Step 1: Failing test.**

```js
// desktop/tests/components/permissions-grid.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { prefPaneUrlFor } = require("../../components/permissions-grid");

describe("prefPaneUrlFor", () => {
    it("accessibility", () => { expect(prefPaneUrlFor("accessibility")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); });
    it("screen", () => { expect(prefPaneUrlFor("screen")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"); });
    it("microphone", () => { expect(prefPaneUrlFor("microphone")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"); });
    it("location", () => { expect(prefPaneUrlFor("location")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"); });
    it("unknown → null", () => { expect(prefPaneUrlFor("bluetooth")).toBeNull(); expect(prefPaneUrlFor(undefined)).toBeNull(); });
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/permissions-grid.test.js
```

- [ ] **Step 3: Create `desktop/components/permissions-grid.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    const PREF_PANE_MAP = {
        accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        screen:        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        microphone:    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        location:      "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
    };
    function prefPaneUrlFor(name) { return Object.prototype.hasOwnProperty.call(PREF_PANE_MAP, name) ? PREF_PANE_MAP[name] : null; }

    const PERMS = [
        { key: "accessibility", title: "Accessibility",   why: "Global hotkey + overlay above other apps." },
        { key: "screen",        title: "Screen Recording", why: "Screenshots and screen-aware help." },
        { key: "microphone",    title: "Microphone",      why: "Voice messages and live voice." },
        { key: "location",      title: "Location",        why: "Location-aware reminders." },
    ];
    function pillClass(s) { return s === "granted" ? "sp-pill sp-pill--ok" : s === "denied" ? "sp-pill sp-pill--bad" : "sp-pill sp-pill--idk"; }
    function pillText(s)  { return s === "granted" ? "Granted" : s === "denied" ? "Denied" : "Not set"; }

    function PermissionsGrid(props) { this.props = props || {}; this._el = null; this._timer = null; this._state = {}; this._cards = {}; this._onChange = this.props.onChange || function(){}; }
    PermissionsGrid.prototype.mount = async function (container) {
        const isMac = (this.props.platform || "darwin") === "darwin";
        const root = document.createElement("div");
        root.className = "sp-root";
        if (!isMac) {
            const card = document.createElement("div");
            card.className = "sp-perm";
            card.innerHTML = "<div class='sp-perm__title'>Windows handles permissions at runtime</div><div class='sp-perm__why'>A.T.L.A.S will ask for mic/screen access when the feature is first used.</div>";
            root.appendChild(card); container.appendChild(root); this._el = root; return this;
        }
        const grid = document.createElement("div"); grid.className = "sp-perms";
        const self = this;
        PERMS.forEach(function (p) {
            const card = document.createElement("div");
            card.className = "sp-perm";
            card.innerHTML =
                "<div class='sp-perm__title'>" + p.title + "</div>" +
                "<div class='sp-perm__why'>" + p.why + "</div>" +
                "<div class='sp-perm__row'><span class='sp-pill sp-pill--idk' data-sp-pill>Loading…</span><button class='sp-btn' data-sp-grant>Grant</button></div>";
            card.querySelector("[data-sp-grant]").addEventListener("click", function () {
                if (window.atlas && window.atlas.setupRequestPermission) window.atlas.setupRequestPermission(p.key).catch(function(){});
            });
            self._cards[p.key] = card; grid.appendChild(card);
        });
        root.appendChild(grid); container.appendChild(root); this._el = root;
        await this._refresh();
        this._timer = setInterval(function () { self._refresh(); }, 1000);
        return this;
    };
    PermissionsGrid.prototype._refresh = async function () {
        if (!window.atlas || !window.atlas.setupPollPermissions) return;
        let next; try { next = await window.atlas.setupPollPermissions(); } catch { return; }
        if (!next) return;
        const prev = this._state; const cards = this._cards;
        Object.keys(cards).forEach(function (k) {
            const pill = cards[k].querySelector("[data-sp-pill]"); if (!pill) return;
            const s = next[k] || "unknown"; pill.className = pillClass(s); pill.textContent = pillText(s);
        });
        this._state = next;
        if (JSON.stringify(prev) !== JSON.stringify(next)) this._onChange(next);
    };
    PermissionsGrid.prototype.unmount = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null; this._cards = {};
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.PermissionsGrid = PermissionsGrid; }
    if (typeof module !== "undefined") { module.exports = { prefPaneUrlFor, PermissionsGrid, PREF_PANE_MAP }; }
})();
```

- [ ] **Step 4: Add IPC. In `desktop/main.js`, insert directly after the `setup:poll-permissions` handler from Phase A (Task A4).**

```js
    ipcMain.handle("setup:request-permission", async (_evt, name) => {
        if (process.platform !== "darwin") return { ok: true, skipped: true };
        const { prefPaneUrlFor } = require("./components/permissions-grid");
        const url = prefPaneUrlFor(name);
        if (!url) return { ok: false, error: "unknown permission: " + String(name) };
        try { await shell.openExternal(url); return { ok: true }; }
        catch (err) { return { ok: false, error: err.message || String(err) }; }
    });
```

- [ ] **Step 5: Expose in `preload.js` directly after `setupPollPermissions`.**

```js
    setupRequestPermission: (name) => ipcRenderer.invoke("setup:request-permission", name),
```

- [ ] **Step 6: Run tests.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/permissions-grid.test.js
```

- [ ] **Step 7: Manual checklist (macOS).**
1. DevTools: `const g = new window.SetupComponents.PermissionsGrid({ platform: "darwin" }); await g.mount(document.body);` — 4 cards, pills populate within 1s.
2. Click **Grant** on Microphone — System Settings opens the Privacy → Microphone pane.
3. Toggle A.T.L.A.S / Electron off — within 2s the tile pill flips to **Denied**.
4. Toggle back on — within 2s pill flips to **Granted**.
5. `g.unmount();` — polling stops (`g._timer === null`).

On Windows, only the info card renders.

- [ ] **Step 8: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/permissions-grid.js tests/components/permissions-grid.test.js main.js preload.js && git commit -m "feat(setup): add PermissionsGrid + setup:request-permission IPC" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B3: `hotkey-picker.js` + `setup:test-hotkey` / `setup:save-hotkey` IPC

**Files:** `desktop/tests/components/hotkey-picker.test.js`, `desktop/components/hotkey-picker.js`, `desktop/main.js`, `desktop/preload.js`

- [ ] **Step 1: Failing test.**

```js
// desktop/tests/components/hotkey-picker.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { parseAccelerator, isModifierKey } = require("../../components/hotkey-picker");
function evt(o){ return Object.assign({ metaKey:false, ctrlKey:false, altKey:false, shiftKey:false, code:"KeyK", key:"k" }, o||{}); }

describe("parseAccelerator", () => {
    it("Cmd+Shift+K on darwin", () => { expect(parseAccelerator(evt({ metaKey:true, shiftKey:true }), "darwin")).toBe("CmdOrCtrl+Shift+K"); });
    it("Ctrl+Shift+K on win32", () => { expect(parseAccelerator(evt({ ctrlKey:true, shiftKey:true }), "win32")).toBe("CmdOrCtrl+Shift+K"); });
    it("Alt+Space", () => { expect(parseAccelerator(evt({ altKey:true, code:"Space", key:" " }), "darwin")).toBe("Alt+Space"); });
    it("F5", () => { expect(parseAccelerator(evt({ code:"F5", key:"F5" }), "darwin")).toBe("F5"); });
    it("Alt+ArrowLeft → Alt+Left", () => { expect(parseAccelerator(evt({ altKey:true, code:"ArrowLeft", key:"ArrowLeft" }), "darwin")).toBe("Alt+Left"); });
    it("rejects modifier-only", () => { expect(parseAccelerator(evt({ metaKey:true, code:"MetaLeft", key:"Meta" }), "darwin")).toBeNull(); });
    it("uppercases letters", () => { expect(parseAccelerator(evt({ metaKey:true, code:"KeyA", key:"a" }), "darwin")).toBe("CmdOrCtrl+A"); });
});
describe("isModifierKey", () => {
    it("modifiers", () => { ["Meta","Shift","Control","Alt"].forEach(k => expect(isModifierKey(k)).toBe(true)); });
    it("letter", () => { expect(isModifierKey("a")).toBe(false); });
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/hotkey-picker.test.js
```

- [ ] **Step 3: Create `desktop/components/hotkey-picker.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Electron accelerator reference: https://www.electronjs.org/docs/latest/api/accelerator
(function () {
    "use strict";
    function isModifierKey(k) { return k === "Meta" || k === "Shift" || k === "Control" || k === "Alt" || k === "OS" || k === "Super" || k === "Hyper"; }
    function codeToKeyName(code, key) {
        const m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
        const d = /^Digit(\d)$/.exec(code);  if (d) return d[1];
        const n = /^Numpad(\d)$/.exec(code); if (n) return "num" + n[1];
        if (/^F\d{1,2}$/.test(code)) return code;
        const named = { Space:"Space", Tab:"Tab", Enter:"Return", NumpadEnter:"Return", Escape:"Escape", Backspace:"Backspace", Delete:"Delete", ArrowUp:"Up", ArrowDown:"Down", ArrowLeft:"Left", ArrowRight:"Right", Home:"Home", End:"End", PageUp:"PageUp", PageDown:"PageDown", Minus:"-", Equal:"=", BracketLeft:"[", BracketRight:"]", Semicolon:";", Quote:"'", Backquote:"`", Backslash:"\\", Comma:",", Period:".", Slash:"/" };
        if (named[code]) return named[code];
        if (key && key.length === 1) return key.toUpperCase();
        return null;
    }
    function parseAccelerator(e, platform) {
        if (!e || isModifierKey(e.key)) return null;
        const parts = [];
        if (e.metaKey || (platform !== "darwin" && e.ctrlKey)) parts.push("CmdOrCtrl");
        else if (e.ctrlKey) parts.push("Control");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        const keyName = codeToKeyName(e.code, e.key);
        if (!keyName) return null;
        parts.push(keyName);
        return parts.join("+");
    }

    function HotkeyPicker(props) {
        this.props = props || {}; this._el = null;
        this._combo = this.props.initial || "Alt+Space";
        this._platform = this.props.platform || "darwin";
        this._recording = false; this._onKeyDown = null;
    }
    HotkeyPicker.prototype.mount = function (container) {
        const root = document.createElement("div");
        root.className = "sp-hotkey";
        root.innerHTML = "<div class='sp-hotkey__combo' data-sp-combo></div><button class='sp-btn sp-btn--ghost' data-sp-record>Record new</button><span class='sp-hotkey__status' data-sp-status></span>";
        root.querySelector("[data-sp-combo]").textContent = this._combo;
        const self = this;
        root.querySelector("[data-sp-record]").addEventListener("click", function () { self._startRecording(); });
        container.appendChild(root); this._el = root; return this;
    };
    HotkeyPicker.prototype._setStatus = function (text, conflict) {
        const el = this._el && this._el.querySelector("[data-sp-status]"); if (!el) return;
        el.textContent = text || "";
        el.className = "sp-hotkey__status" + (conflict ? " sp-hotkey__conflict" : "");
    };
    HotkeyPicker.prototype._startRecording = function () {
        if (this._recording || !this._el) return;
        this._recording = true; this._el.classList.add("sp-hotkey--recording");
        this._setStatus("Press the combo you want…", false);
        const self = this;
        this._onKeyDown = function (e) {
            const combo = parseAccelerator(e, self._platform);
            if (!combo) return;
            e.preventDefault(); e.stopPropagation();
            self._stopRecording(); self._testAndCommit(combo);
        };
        window.addEventListener("keydown", this._onKeyDown, true);
    };
    HotkeyPicker.prototype._stopRecording = function () {
        this._recording = false;
        if (this._onKeyDown) { window.removeEventListener("keydown", this._onKeyDown, true); this._onKeyDown = null; }
        if (this._el) this._el.classList.remove("sp-hotkey--recording");
    };
    HotkeyPicker.prototype._testAndCommit = async function (combo) {
        if (!window.atlas || !window.atlas.setupTestHotkey) { this._commit(combo); return; }
        this._setStatus("Testing " + combo + "…", false);
        let res; try { res = await window.atlas.setupTestHotkey(combo); }
        catch (err) { this._setStatus("Error: " + (err.message || err), true); return; }
        if (res && res.ok) this._commit(combo);
        else this._setStatus((res && res.conflict) || "Combo in use by another app", true);
    };
    HotkeyPicker.prototype._commit = async function (combo) {
        this._combo = combo;
        if (this._el) this._el.querySelector("[data-sp-combo]").textContent = combo;
        this._setStatus("Saved", false);
        if (window.atlas && window.atlas.setupSaveHotkey) { try { await window.atlas.setupSaveHotkey(combo); } catch {} }
        if (typeof this.props.onChange === "function") this.props.onChange(combo);
    };
    HotkeyPicker.prototype.getValue = function () { return this._combo; };
    HotkeyPicker.prototype.unmount = function () {
        this._stopRecording();
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.HotkeyPicker = HotkeyPicker; }
    if (typeof module !== "undefined") { module.exports = { parseAccelerator, isModifierKey, codeToKeyName, HotkeyPicker }; }
})();
```

- [ ] **Step 4: Add IPC. In `desktop/main.js`, insert directly after the `setup:request-permission` handler from Task B2.**

```js
    ipcMain.handle("setup:test-hotkey", (_evt, combo) => {
        if (typeof combo !== "string" || combo.length === 0) return { ok: false, conflict: "empty combo" };
        try {
            const registered = globalShortcut.register(combo, () => {});
            if (!registered) return { ok: false, conflict: combo + " is already in use" };
            globalShortcut.unregister(combo);
            return { ok: true };
        } catch (err) { return { ok: false, conflict: err.message || String(err) }; }
    });
    ipcMain.handle("setup:save-hotkey", (_evt, combo) => {
        if (typeof combo !== "string" || !combo) return { ok: false, error: "invalid combo" };
        try {
            if (typeof prefs !== "undefined" && prefs && typeof prefs.set === "function") prefs.set("hotkey.overlay", combo);
            else if (typeof store !== "undefined" && store && typeof store.set === "function") store.set("overlayHotkey", combo);
            try { globalShortcut.unregisterAll(); } catch {}
            globalShortcut.register(combo, () => { if (typeof toggleOverlay === "function") toggleOverlay(); });
            return { ok: true };
        } catch (err) { return { ok: false, error: err.message || String(err) }; }
    });
```

`prefs`, `store`, and `toggleOverlay` are existing main.js symbols; `typeof` guards let this handler land before Phase C exercises it in production.

- [ ] **Step 5: Expose in `preload.js` directly after `setupRequestPermission`.**

```js
    setupTestHotkey: (combo) => ipcRenderer.invoke("setup:test-hotkey", combo),
    setupSaveHotkey: (combo) => ipcRenderer.invoke("setup:save-hotkey", combo),
```

- [ ] **Step 6: Run tests.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/hotkey-picker.test.js
```

- [ ] **Step 7: Manual.**
1. DevTools: `const h = new window.SetupComponents.HotkeyPicker({ platform: "darwin" }); h.mount(document.body);` — default `Alt+Space`.
2. **Record new**, press `Cmd+Shift+J` → combo becomes `CmdOrCtrl+Shift+J`, status `Saved`.
3. **Record new**, press only `Shift` — picker waits, does not commit.
4. **Record new**, press `Command+Space` (Spotlight default) → status `…is already in use`, red.
5. `h.unmount();` — keydown listener removed (press other keys, picker does not react).

- [ ] **Step 8: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/hotkey-picker.js tests/components/hotkey-picker.test.js main.js preload.js && git commit -m "feat(setup): add HotkeyPicker + setup:test-hotkey/save-hotkey IPC" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B4: `voice-picker.js` + `setup:list-voices` / `setup:preview-voice` IPC

**Files:** `desktop/tests/components/voice-picker.test.js`, `desktop/components/voice-picker.js`, `desktop/assets/voices/sample.wav`, `desktop/main.js`, `desktop/preload.js`

- [ ] **Step 1: Failing test.**

```js
// desktop/tests/components/voice-picker.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { groupVoicesByBackend } = require("../../components/voice-picker");

describe("groupVoicesByBackend", () => {
    it("indexes voices by backend label", () => {
        const r = groupVoicesByBackend([
            { backend: "gemini-live", voices: ["Aoede", "Charon"] },
            { backend: "openai-realtime", voices: ["alloy"] },
        ]);
        expect(r.labels).toEqual(["gemini-live", "openai-realtime"]);
        expect(r.byBackend["gemini-live"]).toEqual(["Aoede", "Charon"]);
        expect(r.byBackend["openai-realtime"]).toEqual(["alloy"]);
    });
    it("returns empty on malformed input", () => {
        expect(groupVoicesByBackend(null)).toEqual({ labels: [], byBackend: {} });
        expect(groupVoicesByBackend([{ backend: "x" }])).toEqual({ labels: ["x"], byBackend: { x: [] } });
    });
});
```

- [ ] **Step 2: Run — expect failure.** `cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/voice-picker.test.js`

- [ ] **Step 3: Create a placeholder sample WAV** (one 3-second audio file is enough to prove the pipeline; real per-voice samples are a follow-up item, not a placeholder plan).

```bash
cd /Users/user/Desktop/ATLAS/desktop && /usr/bin/afconvert -f WAVE -d LEI16@44100 -c 1 /System/Library/Sounds/Glass.aiff assets/voices/sample.wav 2>/dev/null || cp /System/Library/Sounds/Glass.aiff assets/voices/sample.wav
```

On Windows dev machines, substitute `powershell -Command "Copy-Item $env:WINDIR\Media\notify.wav assets\voices\sample.wav"`.

- [ ] **Step 4: Create `desktop/components/voice-picker.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function groupVoicesByBackend(list) {
        const out = { labels: [], byBackend: {} };
        if (!Array.isArray(list)) return out;
        list.forEach(function (entry) {
            if (!entry || typeof entry.backend !== "string") return;
            out.labels.push(entry.backend);
            out.byBackend[entry.backend] = Array.isArray(entry.voices) ? entry.voices.slice() : [];
        });
        return out;
    }

    function VoicePicker(props) { this.props = props || {}; this._el = null; this._audio = null; }
    VoicePicker.prototype.mount = async function (container) {
        const root = document.createElement("div"); root.className = "sp-voice";
        root.innerHTML = "<label style='font-size:12px;color:var(--text-secondary,#515154)'>Voice</label><select data-sp-select></select><button class='sp-btn sp-btn--ghost' data-sp-preview>Preview</button>";
        container.appendChild(root); this._el = root;
        const sel = root.querySelector("[data-sp-select]");
        let list = [];
        if (window.atlas && window.atlas.setupListVoices) { try { list = await window.atlas.setupListVoices(); } catch { list = []; } }
        const grouped = groupVoicesByBackend(list);
        grouped.labels.forEach(function (backend) {
            const grp = document.createElement("optgroup"); grp.label = backend;
            (grouped.byBackend[backend] || []).forEach(function (v) {
                const opt = document.createElement("option"); opt.value = backend + "::" + v; opt.textContent = v; grp.appendChild(opt);
            });
            sel.appendChild(grp);
        });
        const self = this;
        root.querySelector("[data-sp-preview]").addEventListener("click", function () { self._preview(); });
        sel.addEventListener("change", function () { if (typeof self.props.onChange === "function") { const [b,n] = sel.value.split("::"); self.props.onChange({ backend: b, name: n }); } });
        return this;
    };
    VoicePicker.prototype._preview = async function () {
        const sel = this._el.querySelector("[data-sp-select]"); if (!sel || !sel.value) return;
        const [backend, name] = sel.value.split("::");
        if (!window.atlas || !window.atlas.setupPreviewVoice) return;
        let res; try { res = await window.atlas.setupPreviewVoice(backend, name); } catch { return; }
        if (!res || !res.ok || !res.url) return;
        if (this._audio) { try { this._audio.pause(); } catch {} }
        this._audio = new Audio(res.url);
        this._audio.play().catch(function(){});
    };
    VoicePicker.prototype.getValue = function () {
        const sel = this._el && this._el.querySelector("[data-sp-select]");
        if (!sel || !sel.value) return null;
        const [backend, name] = sel.value.split("::"); return { backend, name };
    };
    VoicePicker.prototype.unmount = function () {
        if (this._audio) { try { this._audio.pause(); } catch {} this._audio = null; }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
    };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.VoicePicker = VoicePicker; }
    if (typeof module !== "undefined") { module.exports = { groupVoicesByBackend, VoicePicker }; }
})();
```

- [ ] **Step 5: Add IPC in `desktop/main.js`, after the `setup:save-hotkey` handler from Task B3.**

```js
    ipcMain.handle("setup:list-voices", () => ([
        { backend: "gemini-live",    voices: ["Aoede", "Charon", "Kore", "Fenrir", "Puck"] },
        { backend: "openai-realtime", voices: ["alloy", "shimmer", "echo"] },
    ]));
    ipcMain.handle("setup:preview-voice", (_evt, backend, name) => {
        // Ship v1: one sample WAV for all voices. Follow-up: real per-voice samples.
        const wav = path.join(__dirname, "assets", "voices", "sample.wav");
        if (!fs.existsSync(wav)) return { ok: false, error: "sample.wav missing" };
        return { ok: true, backend, name, url: "file://" + wav };
    });
```

- [ ] **Step 6: Expose in `preload.js` directly after `setupSaveHotkey`.**

```js
    setupListVoices: () => ipcRenderer.invoke("setup:list-voices"),
    setupPreviewVoice: (backend, name) => ipcRenderer.invoke("setup:preview-voice", backend, name),
```

- [ ] **Step 7: Run tests.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/voice-picker.test.js
```

- [ ] **Step 8: Manual.** DevTools: `const v = new window.SetupComponents.VoicePicker({}); await v.mount(document.body);` — dropdown renders with two optgroups (gemini-live, openai-realtime). Pick **Aoede**, click **Preview** → a ~1-3s tone plays through system audio.

Follow-up (not a placeholder — tracked as a real deferred item): replace the single `sample.wav` with per-voice 3-second renderings of each backend/voice combination and have `setup:preview-voice` return the matching file.

- [ ] **Step 9: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/voice-picker.js tests/components/voice-picker.test.js assets/voices/sample.wav main.js preload.js && git commit -m "feat(setup): add VoicePicker + list/preview voice IPC" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B5: `theme-switch.js`

**Files:** `desktop/tests/components/theme-switch.test.js`, `desktop/components/theme-switch.js`

- [ ] **Step 1: Failing test.**

```js
// desktop/tests/components/theme-switch.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { resolveTheme } = require("../../components/theme-switch");

describe("resolveTheme", () => {
    it("explicit light/dark pass through", () => {
        expect(resolveTheme("light", "dark")).toBe("light");
        expect(resolveTheme("dark", "light")).toBe("dark");
    });
    it("system follows os preference", () => {
        expect(resolveTheme("system", "dark")).toBe("dark");
        expect(resolveTheme("system", "light")).toBe("light");
    });
    it("unknown pick defaults to OS preference", () => {
        expect(resolveTheme("weird", "dark")).toBe("dark");
    });
    it("unknown os preference defaults to light", () => {
        expect(resolveTheme("system", undefined)).toBe("light");
    });
});
```

- [ ] **Step 2: Run — expect failure.** `cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/theme-switch.test.js`

- [ ] **Step 3: Create `desktop/components/theme-switch.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function resolveTheme(pick, osPref) {
        if (pick === "light" || pick === "dark") return pick;
        if (osPref === "dark" || osPref === "light") return osPref;
        return "light";
    }

    function ThemeSwitch(props) { this.props = props || {}; this._el = null; this._pick = this.props.initial || "system"; this._osPref = this.props.osPreference || "light"; }
    ThemeSwitch.prototype.mount = function (container) {
        const root = document.createElement("div"); root.className = "sp-theme";
        const opts = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];
        const self = this;
        opts.forEach(function (o) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sp-theme__pill" + (o[0] === self._pick ? " sp-theme__pill--active" : "");
            btn.textContent = o[1];
            btn.setAttribute("data-sp-pick", o[0]);
            btn.addEventListener("click", function () { self._set(o[0]); });
            root.appendChild(btn);
        });
        container.appendChild(root); this._el = root; return this;
    };
    ThemeSwitch.prototype._set = function (pick) {
        this._pick = pick;
        if (this._el) {
            const pills = this._el.querySelectorAll("[data-sp-pick]");
            for (let i = 0; i < pills.length; i++) {
                const p = pills[i]; const on = p.getAttribute("data-sp-pick") === pick;
                p.className = "sp-theme__pill" + (on ? " sp-theme__pill--active" : "");
            }
        }
        const resolved = resolveTheme(pick, this._osPref);
        try { document.dispatchEvent(new CustomEvent("theme-change", { detail: { pick: pick, resolved: resolved } })); } catch {}
        if (typeof this.props.onChange === "function") this.props.onChange({ pick: pick, resolved: resolved });
    };
    ThemeSwitch.prototype.getValue = function () { return this._pick; };
    ThemeSwitch.prototype.unmount = function () { if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el); this._el = null; };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.ThemeSwitch = ThemeSwitch; }
    if (typeof module !== "undefined") { module.exports = { resolveTheme, ThemeSwitch }; }
})();
```

- [ ] **Step 4: Run tests.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/theme-switch.test.js
```

- [ ] **Step 5: Manual (the wizard page listener is wired by Phase C; in isolation verify the event).** DevTools on smoke page: attach `document.addEventListener("theme-change", e => console.log(e.detail));`, mount `new window.SetupComponents.ThemeSwitch({ osPreference: "dark" }).mount(document.body);`, click each pill — three console events fire with `{ pick, resolved }` each time; Active pill background visually switches.

- [ ] **Step 6: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/theme-switch.js tests/components/theme-switch.test.js && git commit -m "feat(setup): add ThemeSwitch + resolveTheme helper" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B6: `channel-card.js` + validators + test-before-save IPC gate

This is the largest component. One class renders Telegram/Discord/Matrix/Email/Slack/WhatsApp forms selected by `type`. Credentials never persist before the matching Test button succeeds.

**Files:** `desktop/tests/components/channel-card.test.js`, `desktop/components/channel-card.js`, `desktop/main.js`, `desktop/preload.js`, `desktop/package.json` (add `imapflow`)

- [ ] **Step 1: Add `imapflow` dependency.** Edit `desktop/package.json` — add `"imapflow": "^1.0.171"` to `dependencies`, then `cd /Users/user/Desktop/ATLAS/desktop && npm install`.

- [ ] **Step 2: Failing test (validators + save-gate).**

```js
// desktop/tests/components/channel-card.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const cc = require("../../components/channel-card");

describe("validateTelegramToken", () => {
    it("accepts well-formed tokens", () => { expect(cc.validateTelegramToken("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk")).toBe(true); });
    it("rejects malformed", () => {
        expect(cc.validateTelegramToken("nope")).toBe(false);
        expect(cc.validateTelegramToken("12345:short")).toBe(false);
        expect(cc.validateTelegramToken("")).toBe(false);
    });
});
describe("validateDiscordToken", () => {
    it("accepts 50+ char base64-ish", () => { expect(cc.validateDiscordToken("A".repeat(55) + "._-")).toBe(true); });
    it("rejects short/empty", () => { expect(cc.validateDiscordToken("short")).toBe(false); expect(cc.validateDiscordToken("")).toBe(false); });
});
describe("validateMatrixHomeserver", () => {
    it("accepts https/http", () => { expect(cc.validateMatrixHomeserver("https://matrix.org")).toBe(true); expect(cc.validateMatrixHomeserver("http://localhost:8008")).toBe(true); });
    it("rejects bad", () => { expect(cc.validateMatrixHomeserver("matrix.org")).toBe(false); expect(cc.validateMatrixHomeserver("ftp://x")).toBe(false); });
});
describe("validateEmailConfig", () => {
    it("passes with all fields and numeric ports", () => {
        expect(cc.validateEmailConfig({ imapHost:"imap.gmail.com", imapPort:993, imapTls:true, smtpHost:"smtp.gmail.com", smtpPort:587, smtpTls:true, user:"a@b.co", password:"x" })).toBe(true);
    });
    it("fails when missing", () => { expect(cc.validateEmailConfig({ imapHost:"a" })).toBe(false); });
    it("fails on non-numeric ports", () => {
        expect(cc.validateEmailConfig({ imapHost:"h", imapPort:"x", imapTls:true, smtpHost:"h", smtpPort:587, smtpTls:true, user:"a@b.co", password:"p" })).toBe(false);
    });
});
describe("canSaveWithTestId", () => {
    const now = 1000000;
    it("matches pending id within 60s", () => {
        expect(cc.canSaveWithTestId("abc", { abc: now - 30000 }, now)).toBe(true);
    });
    it("rejects missing id", () => { expect(cc.canSaveWithTestId("xyz", {}, now)).toBe(false); });
    it("rejects expired (>60s)", () => { expect(cc.canSaveWithTestId("abc", { abc: now - 61000 }, now)).toBe(false); });
});
```

- [ ] **Step 3: Run — expect failure.** `cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/channel-card.test.js`

- [ ] **Step 4: Create `desktop/components/channel-card.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function validateTelegramToken(s) { return typeof s === "string" && /^\d+:[A-Za-z0-9_-]{35,}$/.test(s); }
    function validateDiscordToken(s) { return typeof s === "string" && s.length >= 50 && /^[A-Za-z0-9._-]+$/.test(s); }
    function validateMatrixHomeserver(s) {
        if (typeof s !== "string") return false;
        try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
    }
    function validateEmailConfig(c) {
        if (!c) return false;
        const keys = ["imapHost", "smtpHost", "user", "password"]; for (const k of keys) if (typeof c[k] !== "string" || !c[k]) return false;
        if (typeof c.imapPort !== "number" || typeof c.smtpPort !== "number") return false;
        return true;
    }
    function canSaveWithTestId(id, pendingTests, nowMs) {
        if (!id || !pendingTests || typeof pendingTests[id] !== "number") return false;
        return (nowMs - pendingTests[id]) <= 60000;
    }

    const VALIDATORS = {
        telegram: (c) => validateTelegramToken(c && c.token) && typeof c.allowedIds === "string" && c.allowedIds.length > 0,
        discord:  (c) => validateDiscordToken(c && c.token),
        matrix:   (c) => validateMatrixHomeserver(c && c.homeserver) && typeof c.token === "string" && c.token.length > 0,
        email:    validateEmailConfig,
        slack:    () => true,
        whatsapp: () => true,
    };

    function ChannelCard(props) { this.props = props || {}; this._el = null; this._testId = null; this._creds = null; }

    ChannelCard.prototype.mount = function (container) {
        const type = this.props.type;
        const root = document.createElement("div"); root.className = "sp-channel";
        root.innerHTML = "<div class='sp-channel__title' data-sp-title></div><div class='sp-channel__form' data-sp-form></div><div class='sp-channel__status' data-sp-status style='display:none'></div><div class='sp-channel__actions' data-sp-actions></div>";
        root.querySelector("[data-sp-title]").textContent = type.charAt(0).toUpperCase() + type.slice(1);
        this._el = root; container.appendChild(root);
        this._renderForm(type);
        this._renderActions(type);
        return this;
    };

    ChannelCard.prototype._renderForm = function (type) {
        const form = this._el.querySelector("[data-sp-form]");
        const H = (s) => { form.insertAdjacentHTML("beforeend", s); };
        if (type === "telegram") { H("<label>Bot token<input data-sp-field='token' type='password' autocomplete='off'></label><label>Allowed user IDs (comma-separated)<input data-sp-field='allowedIds' type='text'></label>"); }
        else if (type === "discord") { H("<label>Bot token<input data-sp-field='token' type='password' autocomplete='off'></label>"); }
        else if (type === "matrix") { H("<label>Homeserver URL<input data-sp-field='homeserver' type='text' placeholder='https://matrix.org'></label><label>Access token<input data-sp-field='token' type='password' autocomplete='off'></label>"); }
        else if (type === "email") {
            H("<label>Preset<select data-sp-field='preset'><option value=''>Custom</option><option value='gmail'>Gmail</option><option value='outlook'>Outlook</option></select></label>" +
              "<label>IMAP host<input data-sp-field='imapHost'></label><label>IMAP port<input data-sp-field='imapPort' type='number' value='993'></label>" +
              "<label>SMTP host<input data-sp-field='smtpHost'></label><label>SMTP port<input data-sp-field='smtpPort' type='number' value='587'></label>" +
              "<label>User<input data-sp-field='user' type='email'></label><label>Password<input data-sp-field='password' type='password'></label>");
            const self = this;
            form.querySelector("[data-sp-field='preset']").addEventListener("change", function (e) {
                const v = e.target.value;
                if (v === "gmail")   { form.querySelector("[data-sp-field='imapHost']").value = "imap.gmail.com"; form.querySelector("[data-sp-field='smtpHost']").value = "smtp.gmail.com"; form.querySelector("[data-sp-field='imapPort']").value = 993; form.querySelector("[data-sp-field='smtpPort']").value = 587; }
                if (v === "outlook") { form.querySelector("[data-sp-field='imapHost']").value = "outlook.office365.com"; form.querySelector("[data-sp-field='smtpHost']").value = "smtp.office365.com"; form.querySelector("[data-sp-field='imapPort']").value = 993; form.querySelector("[data-sp-field='smtpPort']").value = 587; }
            });
        }
        else if (type === "slack") { H("<div style='font-size:13px;color:var(--text-secondary,#515154)'>Connect via Slack OAuth — Atlas will install into the workspace you choose.</div>"); }
        else if (type === "whatsapp") { H("<div class='sp-channel__qr' data-sp-qr style='min-height:180px;align-items:center'><div style='color:#999'>Click \"Generate QR\" to pair your phone.</div></div>"); }
    };

    ChannelCard.prototype._renderActions = function (type) {
        const actions = this._el.querySelector("[data-sp-actions]");
        const self = this;
        if (type === "slack") {
            const btn = document.createElement("button"); btn.className = "sp-btn"; btn.textContent = "Install to workspace";
            btn.addEventListener("click", function () { if (window.atlas && window.atlas.setupSlackOAuthStart) window.atlas.setupSlackOAuthStart(); });
            actions.appendChild(btn); return;
        }
        if (type === "whatsapp") {
            const btn = document.createElement("button"); btn.className = "sp-btn"; btn.textContent = "Generate QR";
            btn.addEventListener("click", function () { self._startWhatsApp(); });
            actions.appendChild(btn); return;
        }
        const test = document.createElement("button"); test.className = "sp-btn sp-btn--ghost"; test.textContent = "Test";
        const save = document.createElement("button"); save.className = "sp-btn"; save.textContent = "Save"; save.disabled = true;
        test.addEventListener("click", function () { self._onTest(type, save); });
        save.addEventListener("click", function () { self._onSave(type); });
        actions.appendChild(test); actions.appendChild(save);
    };

    ChannelCard.prototype._readCreds = function (type) {
        const form = this._el.querySelector("[data-sp-form]");
        const out = {};
        form.querySelectorAll("[data-sp-field]").forEach(function (el) {
            const k = el.getAttribute("data-sp-field");
            let v = el.value;
            if (el.type === "number") v = Number(v);
            if (el.type === "checkbox") v = el.checked;
            out[k] = v;
        });
        if (type === "email") { out.imapTls = true; out.smtpTls = true; }
        return out;
    };

    ChannelCard.prototype._setStatus = function (text, ok) {
        const el = this._el.querySelector("[data-sp-status]"); if (!el) return;
        el.textContent = text || "";
        el.className = "sp-channel__status " + (ok ? "sp-channel__status--ok" : "sp-channel__status--bad");
        el.style.display = text ? "block" : "none";
    };

    ChannelCard.prototype._onTest = async function (type, saveBtn) {
        const creds = this._readCreds(type);
        if (!VALIDATORS[type](creds)) { this._setStatus("Credentials look invalid — check the format.", false); return; }
        this._setStatus("Testing…", true);
        let res; try { res = await window.atlas.setupTestChannel(type, creds); }
        catch (err) { this._setStatus("Test failed: " + (err.message || err), false); return; }
        if (res && res.ok) {
            this._testId = res.testId; this._creds = creds;
            saveBtn.disabled = false;
            this._setStatus("Test passed — click Save.", true);
        } else {
            saveBtn.disabled = true;
            this._setStatus((res && res.error) || "Test failed — see docs: https://atlas.app/docs/" + type, false);
        }
    };

    ChannelCard.prototype._onSave = async function (type) {
        if (!this._testId || !this._creds) { this._setStatus("Run Test first.", false); return; }
        let res; try { res = await window.atlas.setupSaveChannel(type, this._creds, this._testId); }
        catch (err) { this._setStatus("Save failed: " + (err.message || err), false); return; }
        if (res && res.ok) { this._setStatus("Saved.", true); if (typeof this.props.onSaved === "function") this.props.onSaved(type); }
        else this._setStatus((res && res.error) || "Save refused.", false);
    };

    ChannelCard.prototype._startWhatsApp = async function () {
        const qrBox = this._el.querySelector("[data-sp-qr]"); if (!qrBox) return;
        qrBox.innerHTML = "<div style='color:#666'>Generating pairing…</div>";
        if (window.atlas && window.atlas.onWhatsAppQR) {
            window.atlas.onWhatsAppQR(async function (qrString) {
                try {
                    const QR = window.QRCode || (typeof require === "function" ? require("qrcode") : null);
                    qrBox.innerHTML = ""; const canvas = document.createElement("canvas"); qrBox.appendChild(canvas);
                    if (QR && QR.toCanvas) QR.toCanvas(canvas, qrString, { width: 220 });
                    else { qrBox.innerHTML = "<code style='font-size:10px;word-break:break-all'>" + qrString + "</code>"; }
                } catch (e) { qrBox.innerHTML = "<code style='font-size:10px'>" + qrString + "</code>"; }
            });
        }
        if (window.atlas && window.atlas.waGenerateOTP) { try { await window.atlas.waGenerateOTP(); } catch {} }
    };

    ChannelCard.prototype.unmount = function () { if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el); this._el = null; };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.ChannelCard = ChannelCard; }
    if (typeof module !== "undefined") { module.exports = { validateTelegramToken, validateDiscordToken, validateMatrixHomeserver, validateEmailConfig, canSaveWithTestId, ChannelCard }; }
})();
```

- [ ] **Step 5: Add IPC handlers. In `desktop/main.js`, after the `setup:preview-voice` handler from B4, insert:**

```js
    const __pendingChannelTests = new Map(); // testId → timestamp
    const __randomId = () => require("crypto").randomBytes(8).toString("hex");

    ipcMain.handle("setup:test-channel", async (_evt, type, creds) => {
        try {
            if (type === "telegram") {
                const r = await fetch(`https://api.telegram.org/bot${creds.token}/getMe`);
                const j = await r.json();
                if (!j.ok) return { ok: false, error: j.description || "Telegram rejected token" };
            } else if (type === "discord") {
                const r = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bot " + creds.token } });
                const j = await r.json(); if (!j.id) return { ok: false, error: j.message || "Discord rejected token" };
            } else if (type === "matrix") {
                const r = await fetch(`${creds.homeserver.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`, { headers: { Authorization: "Bearer " + creds.token } });
                const j = await r.json(); if (!j.user_id) return { ok: false, error: j.error || "Matrix rejected token" };
            } else if (type === "email") {
                const { ImapFlow } = require("imapflow");
                const client = new ImapFlow({ host: creds.imapHost, port: creds.imapPort, secure: !!creds.imapTls, auth: { user: creds.user, pass: creds.password }, logger: false });
                try { await client.connect(); await client.logout(); } catch (err) { return { ok: false, error: err.message || "IMAP login failed" }; }
            } else { return { ok: false, error: "unsupported type: " + type }; }
            const testId = __randomId(); __pendingChannelTests.set(testId, Date.now());
            return { ok: true, testId };
        } catch (err) { return { ok: false, error: err.message || String(err) }; }
    });

    ipcMain.handle("setup:save-channel", async (_evt, type, creds, testId) => {
        const t = __pendingChannelTests.get(testId);
        if (!t || (Date.now() - t) > 60000) return { ok: false, error: "Test expired — re-run Test, then Save." };
        __pendingChannelTests.delete(testId);
        try {
            if (typeof saveEnvKVs === "function") {
                if (type === "telegram") saveEnvKVs({ TELEGRAM_BOT_TOKEN: creds.token, ALLOWED_USER_IDS: creds.allowedIds });
                else if (type === "discord") saveEnvKVs({ DISCORD_BOT_TOKEN: creds.token });
                else if (type === "matrix")  saveEnvKVs({ MATRIX_HOMESERVER: creds.homeserver, MATRIX_ACCESS_TOKEN: creds.token });
                else if (type === "email")   saveEnvKVs({ EMAIL_USER: creds.user, EMAIL_PASSWORD: creds.password, EMAIL_IMAP_HOST: creds.imapHost, EMAIL_IMAP_PORT: String(creds.imapPort), EMAIL_SMTP_HOST: creds.smtpHost, EMAIL_SMTP_PORT: String(creds.smtpPort) });
            }
            return { ok: true };
        } catch (err) { return { ok: false, error: err.message || String(err) }; }
    });

    ipcMain.handle("setup:slack-oauth-start", async () => {
        const clientId = process.env.SLACK_CLIENT_ID || "REPLACE_ME"; // full OAuth wiring is a followup
        const url = "https://slack.com/oauth/v2/authorize?scope=chat:write,app_mentions:read,im:history&client_id=" + encodeURIComponent(clientId);
        const popup = new BrowserWindow({ width: 520, height: 720, webPreferences: { nodeIntegration: false, contextIsolation: true } });
        popup.loadURL(url);
        return { ok: true };
    });
```

`saveEnvKVs` is the existing helper in `main.js` that writes encrypted `.env` key/value pairs. If it doesn't exist yet under that name, alias the current encrypted-env writer (grep `loadEnvDecrypted` — its sibling writer — and reuse it).

- [ ] **Step 6: Expose in `preload.js` after the other setup methods.**

```js
    setupTestChannel: (type, creds) => ipcRenderer.invoke("setup:test-channel", type, creds),
    setupSaveChannel: (type, creds, testId) => ipcRenderer.invoke("setup:save-channel", type, creds, testId),
    setupSlackOAuthStart: () => ipcRenderer.invoke("setup:slack-oauth-start"),
```

- [ ] **Step 7: Run tests — expect green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/channel-card.test.js
```

- [ ] **Step 8: Manual checklist (per channel).** For Telegram, Discord, Matrix, Email:
1. Mount: `new window.SetupComponents.ChannelCard({ type: "<type>" }).mount(document.body);`
2. Enter **bad** creds → **Test** → status shows specific error with a docs link (e.g. `https://atlas.app/docs/telegram`).
3. Enter **real** creds → **Test** → status turns green "Test passed".
4. **Save** → status "Saved"; open `~/Library/Application Support/A.T.L.A.S/.env` (decrypted via main-process handler, or inspect via `await atlas.setupDetect()`) to confirm creds recorded.
5. Email only: pick Gmail preset — ports/hosts auto-fill (993/587, imap.gmail.com / smtp.gmail.com).
6. Slack: click **Install to workspace** → a popup window opens to `slack.com/oauth/v2/authorize`.
7. WhatsApp: click **Generate QR** → a QR renders in the card within ~2s (paired with existing `wa:generate-otp` and `onWhatsAppQR` flow from `desktop/preload.js:137-144`).

**Followup (not a plan placeholder — explicit deferred item):** full Slack OAuth — redirect handler, code exchange, workspace token persistence — is out of scope for this task. The current `setup:slack-oauth-start` IPC launches the OAuth popup only; the completion callback is wired by a later phase when the Convex endpoint for Slack OAuth exchange is ready.

- [ ] **Step 9: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/channel-card.js tests/components/channel-card.test.js main.js preload.js package.json package-lock.json && git commit -m "feat(setup): add ChannelCard + test-before-save channel IPC gate" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B7: `install-log.js`

**Files:** `desktop/tests/components/install-log.test.js`, `desktop/components/install-log.js`

- [ ] **Step 1: Failing test.**

```js
// desktop/tests/components/install-log.test.js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { formatLogLine } = require("../../components/install-log");

describe("formatLogLine", () => {
    it("success line", () => {
        const r = formatLogLine({ text: "ok", severity: "ok" });
        expect(r.className).toBe("sp-log__line sp-log__line--ok");
        expect(r.hasActions).toBe(false);
        expect(r.html).toContain("ok");
    });
    it("error line with phaseId has Retry/Skip/Copy actions", () => {
        const r = formatLogLine({ text: "boom", severity: "err", phaseId: "playwright" });
        expect(r.className).toBe("sp-log__line sp-log__line--err");
        expect(r.hasActions).toBe(true);
        expect(r.html).toContain("Retry"); expect(r.html).toContain("Skip"); expect(r.html).toContain("Copy");
        expect(r.html).toContain("playwright");
    });
    it("escapes HTML in text", () => {
        const r = formatLogLine({ text: "<script>x</script>", severity: "info" });
        expect(r.html).not.toContain("<script>");
        expect(r.html).toContain("&lt;script&gt;");
    });
});
```

- [ ] **Step 2: Run — expect failure.** `cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/install-log.test.js`

- [ ] **Step 3: Create `desktop/components/install-log.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";
    function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
    function formatLogLine(line) {
        const sev = (line && line.severity) || "info";
        const cls = "sp-log__line sp-log__line--" + (["info","ok","warn","err"].indexOf(sev) >= 0 ? sev : "info");
        const text = escapeHtml(line && line.text ? line.text : "");
        const hasActions = sev === "err" && line && typeof line.phaseId === "string" && line.phaseId.length > 0;
        let html = "<span>" + text + "</span>";
        if (hasActions) {
            const pid = escapeHtml(line.phaseId);
            html += "<span class='sp-log__actions' data-sp-phase='" + pid + "'>" +
                    "<button data-sp-retry>Retry</button>" +
                    "<button data-sp-skip>Skip</button>" +
                    "<button data-sp-copy>Copy</button></span>";
        }
        return { html: html, className: cls, hasActions: hasActions };
    }

    function InstallLog(props) { this.props = props || {}; this._el = null; }
    InstallLog.prototype.mount = function (container) {
        const root = document.createElement("div"); root.className = "sp-log"; root.setAttribute("role","log");
        container.appendChild(root); this._el = root; return this;
    };
    InstallLog.prototype.addLine = function (text, severity, phaseId) {
        if (!this._el) return;
        const f = formatLogLine({ text: text, severity: severity, phaseId: phaseId });
        const row = document.createElement("div"); row.className = f.className; row.innerHTML = f.html;
        const self = this;
        if (f.hasActions) {
            row.querySelector("[data-sp-retry]").addEventListener("click", function () {
                if (window.atlas && window.atlas.setupRetryInstallPhase) window.atlas.setupRetryInstallPhase(phaseId).catch(function(){});
            });
            row.querySelector("[data-sp-skip]").addEventListener("click", function () {
                if (typeof self.props.onSkip === "function") self.props.onSkip(phaseId);
            });
            row.querySelector("[data-sp-copy]").addEventListener("click", function () {
                try { navigator.clipboard.writeText(text); } catch {}
            });
        }
        this._el.appendChild(row);
        this._el.scrollTop = this._el.scrollHeight;
    };
    InstallLog.prototype.clear = function () { if (this._el) this._el.innerHTML = ""; };
    InstallLog.prototype.unmount = function () { if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el); this._el = null; };

    if (typeof window !== "undefined") { window.SetupComponents = window.SetupComponents || {}; window.SetupComponents.InstallLog = InstallLog; }
    if (typeof module !== "undefined") { module.exports = { formatLogLine, InstallLog, escapeHtml }; }
})();
```

- [ ] **Step 4: Run tests.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- tests/components/install-log.test.js
```

Note: `window.atlas.setupRetryInstallPhase` is wired by Phase C. Retry clicks are no-ops until then (the `.catch()` guard absorbs the undefined call).

- [ ] **Step 5: Manual.** Mount on smoke page. `log.addLine("building node 20…", "info");` → gray line. `log.addLine("node installed", "ok");` → green. `log.addLine("playwright failed", "err", "playwright");` → red line with **Retry** / **Skip** / **Copy**. Click **Copy** → paste into another app, text matches the line.

- [ ] **Step 6: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/install-log.js tests/components/install-log.test.js && git commit -m "feat(setup): add InstallLog + formatLogLine helper" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B8: Smoke page `_smoke.html`

**Files:** `desktop/components/_smoke.html`, `desktop/components/README.md`

- [ ] **Step 1: Create `desktop/components/_smoke.html`.**

```html
<!-- Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved. -->
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Setup Components — Smoke</title>
<link rel="stylesheet" href="../styles.css">
<link rel="stylesheet" href="components.css">
<style> body { padding: 24px; display: flex; flex-direction: column; gap: 18px; overflow: auto; } h2 { font-size: 14px; color: var(--text-muted); margin-top: 16px; } .sp-row { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; } </style>
</head><body class="sp-root">
<h1 style="font-size:20px">Setup Components Smoke</h1>
<h2>StatusTile</h2><div class="sp-row" id="tiles"></div>
<h2>PermissionsGrid</h2><div id="perms"></div>
<h2>HotkeyPicker</h2><div id="hotkey"></div>
<h2>VoicePicker</h2><div id="voice"></div>
<h2>ThemeSwitch</h2><div id="theme"></div>
<h2>ChannelCard (telegram)</h2><div id="channel-telegram"></div>
<h2>ChannelCard (email)</h2><div id="channel-email"></div>
<h2>InstallLog</h2><div id="log"></div>

<script src="status-tile.js"></script>
<script src="permissions-grid.js"></script>
<script src="hotkey-picker.js"></script>
<script src="voice-picker.js"></script>
<script src="theme-switch.js"></script>
<script src="channel-card.js"></script>
<script src="install-log.js"></script>
<script>
  (async () => {
    const C = window.SetupComponents;
    const tiles = document.getElementById("tiles");
    new C.StatusTile({ label: "ACCOUNT", value: "dheeraj@xagi.co", secondary: "pro · 2400 credits", status: "green", onClick: () => console.log("account") }).mount(tiles);
    new C.StatusTile({ label: "PERMISSIONS", value: "2 of 4 granted", secondary: "Mic, Screen missing", status: "amber" }).mount(tiles);
    new C.StatusTile({ label: "WAKE WORD", value: "Off", status: "neutral" }).mount(tiles);
    await new C.PermissionsGrid({ platform: navigator.platform.toLowerCase().indexOf("mac") >= 0 ? "darwin" : "win32" }).mount(document.getElementById("perms"));
    new C.HotkeyPicker({ platform: "darwin", initial: "Alt+Space" }).mount(document.getElementById("hotkey"));
    await new C.VoicePicker({}).mount(document.getElementById("voice"));
    new C.ThemeSwitch({ osPreference: "light", initial: "system" }).mount(document.getElementById("theme"));
    new C.ChannelCard({ type: "telegram" }).mount(document.getElementById("channel-telegram"));
    new C.ChannelCard({ type: "email" }).mount(document.getElementById("channel-email"));
    const log = new C.InstallLog(); log.mount(document.getElementById("log"));
    log.addLine("starting install…", "info");
    log.addLine("node 20 already installed", "ok");
    log.addLine("playwright download failed: EAI_AGAIN", "err", "playwright");
  })();
</script>
</body></html>
```

- [ ] **Step 2: Create `desktop/components/README.md` with launch notes.**

```md
# Setup Components

Vanilla-JS component library for the redesigned setup wizard and Ready Hub.

## Smoke page

In dev, `npm start` to launch the desktop app, open DevTools on the main window, then navigate with:

```js
location.href = "file:///Users/user/Desktop/ATLAS/desktop/components/_smoke.html";
```

(Use the absolute path for your machine; the file:// scheme is needed so the relative `../styles.css` and `components.css` links resolve.)

Every component mounts once with plausible props. Expect zero console errors.
```

- [ ] **Step 3: Manual checklist.** Launch smoke page via the DevTools `location.href=` command above; every section renders a live component. Open DevTools Console — no red errors, no 404s. Click buttons in each section — state changes (hotkey recording, voice preview, theme toggle) work in isolation.

- [ ] **Step 4: Commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add components/_smoke.html components/README.md && git commit -m "feat(setup): add components smoke page + README" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task B9: Phase B gate — full suite green, components exported

**Files:** none (verification only)

- [ ] **Step 1: Run the whole desktop test suite; expect green.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

Every test file under `tests/components/` + everything Phase A added passes.

- [ ] **Step 2: Launch the app; confirm no regressions.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm start
```

Manual checklist:
- The existing `wizard.html` still opens normally (Phase C will rewrite it; Phase B did not).
- DevTools Console on wizard: `Object.keys(window.SetupComponents)` returns `["StatusTile","PermissionsGrid","HotkeyPicker","VoicePicker","ThemeSwitch","ChannelCard","InstallLog"]`.
- DevTools Console: every new `window.atlas.*` method (`setupRequestPermission`, `setupTestHotkey`, `setupSaveHotkey`, `setupListVoices`, `setupPreviewVoice`, `setupTestChannel`, `setupSaveChannel`, `setupSlackOAuthStart`) is a function.
- The app quits cleanly (no lingering `electron` processes after close).

- [ ] **Step 3: Gate commit (skip if nothing dirty).**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git status
```

If anything is pending (e.g., the smoke page re-run adjusted sample.wav):

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add -A && git commit -m "chore(setup): phase B gate — components + IPC verified" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Adaptive Wizard & Resumable Install

Phase C rewrites `desktop/wizard.html` as a step-router-driven adaptive flow, moves install into a phase-list-plus-runner architecture with per-phase done-markers in `data/setup-state.json`, and adds retry + resume IPCs. Pure logic (router, phase-list builder, reducer, resume logic, redactor inputs for Phase D) is covered by vitest; DOM transitions and IPC wiring are covered by manual checklists. Assumes Phase A (`window.atlas.setupDetect`, `setupPollPermissions`, `runDetection`) and Phase B (components on `window.SetupComponents.*`) are complete.

### Task C1: Wizard step router (pure logic, TDD)

**Files:**
- `desktop/wizard/router.js`
- `desktop/wizard/__tests__/router.test.js`

- [ ] **Step 1: Write the router tests first.**

Create `desktop/wizard/__tests__/router.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { getSteps, next, prev, ALL_STEPS } = require("../router.js");

const fresh = () => ({
    platform: "darwin", isReconfigure: false,
    account: { signedIn: false }, profile: {},
    permissions: { accessibility: "denied", screen: "denied", microphone: "denied", location: "denied" },
    installed: { node: false, playwright: false, embeddingModel: false, sox: false },
    hotkey: { current: "Alt+Space", conflicts: [] }, workspace: { path: "", exists: false },
});
const full = () => ({
    platform: "darwin", isReconfigure: false,
    account: { signedIn: true, email: "a@b.com" }, profile: { name: "D", tone: "friendly" },
    permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" },
    installed: { node: true, playwright: true, embeddingModel: true, sox: true },
    hotkey: { current: "Alt+Space", conflicts: [] }, workspace: { path: "/tmp/ws", exists: true },
    personalize: { hotkey: "Alt+Space", theme: "dark", voice: { backend: "gemini-live", name: "Aoede" }, wakeWord: { enabled: false, phrase: "Hey Atlas" } },
    setupFinalized: true,
});

describe("WizardRouter.getSteps", () => {
    it("fresh Mac → all 6 steps, Welcome header", () => {
        const { steps, header } = getSteps(fresh());
        expect(steps).toEqual(["welcome", "signin", "profile", "personalize", "permissions", "install"]);
        expect(header).toBe("Welcome");
    });
    it("signed in + no profile → [profile, personalize, permissions, install]", () => {
        const s = fresh(); s.account = { signedIn: true, email: "a@b.com" };
        expect(getSteps(s).steps).toEqual(["profile", "personalize", "permissions", "install"]);
    });
    it("fully configured → empty list", () => { expect(getSteps(full()).steps).toEqual([]); });
    it("reconfigure → header Reconfigure, steps shown without welcome", () => {
        const s = full(); s.isReconfigure = true;
        const { steps, header } = getSteps(s);
        expect(header).toBe("Reconfigure");
        expect(steps).toContain("profile"); expect(steps).toContain("install"); expect(steps).not.toContain("welcome");
    });
    it("Windows → permissions excluded regardless of state", () => {
        const s = fresh(); s.platform = "win32";
        expect(getSteps(s).steps).not.toContain("permissions");
    });
    it("hotkey conflict → forces personalize even if otherwise complete", () => {
        const s = full(); s.hotkey.conflicts = ["Spotlight"];
        expect(getSteps(s).steps).toContain("personalize");
    });
});

describe("WizardRouter.next/prev + ALL_STEPS", () => {
    it("next/prev walk filtered list", () => {
        const s = ["profile", "personalize", "permissions", "install"];
        expect(next(0, s)).toBe(1); expect(next(3, s)).toBe(-1);
        expect(prev(0, s)).toBe(-1); expect(prev(2, s)).toBe(1);
    });
    it("ALL_STEPS canonical order", () => {
        expect(ALL_STEPS).toEqual(["welcome", "signin", "profile", "personalize", "permissions", "install"]);
    });
});
```

- [ ] **Step 2: Implement router.js to satisfy tests.**

Create `desktop/wizard/router.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure CommonJS — shared main+renderer.
const ALL_STEPS = ["welcome", "signin", "profile", "personalize", "permissions", "install"];

function needsInstall(s) {
    const i = s.installed || {};
    if (!i.node || !i.playwright || !i.embeddingModel) return true;
    if (s.workspace && s.workspace.path && !s.workspace.exists) return true;
    return !s.setupFinalized;
}
function needsPersonalize(s) {
    if (s.hotkey && (s.hotkey.conflicts || []).length) return true;
    const p = s.personalize;
    return !p || !p.hotkey || !p.theme || !(p.voice && p.voice.backend) || !p.wakeWord;
}
function getSteps(state) {
    const s = state || {};
    const header = s.isReconfigure ? "Reconfigure" : "Welcome";
    const out = [];
    const signedIn = s.account && s.account.signedIn;
    if (!s.isReconfigure && !signedIn) out.push("welcome");
    if (!signedIn) out.push("signin");
    if (s.isReconfigure || !(s.profile && s.profile.name && s.profile.tone)) out.push("profile");
    if (s.isReconfigure || needsPersonalize(s)) out.push("personalize");
    if (s.platform !== "win32") {
        const perms = s.permissions || {};
        const all = ["accessibility", "screen", "microphone", "location"].every((k) => perms[k] === "granted");
        if (s.isReconfigure || !all) out.push("permissions");
    }
    if (s.isReconfigure || needsInstall(s)) out.push("install");
    return { steps: out, header };
}
const next = (i, s) => (i + 1 < s.length ? i + 1 : -1);
const prev = (i) => (i - 1 >= 0 ? i - 1 : -1);

const api = { getSteps, next, prev, ALL_STEPS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardRouter = api;
```

- [ ] **Step 3: Run tests and commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- router
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/router.js wizard/__tests__/router.test.js && git commit -m "feat(setup): C1 pure wizard step router with tests" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C2: Rewrite wizard.html shell

**Files:**
- `desktop/wizard.html` (full replacement)

- [ ] **Step 1: Replace `desktop/wizard.html` with the adaptive shell.**

```html
<!-- Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved. -->
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"/>
<title>A.T.L.A.S — Setup</title>
<link rel="stylesheet" href="styles.css"/><link rel="stylesheet" href="components/components.css"/>
</head>
<body class="wizard-body">
<div class="orb orb-a"></div><div class="orb orb-b"></div>
<header class="wizard-head">
    <h1 id="wizard-header">Welcome</h1>
    <div id="step-dots" class="step-dots" role="tablist" aria-label="Setup progress"></div>
</header>
<div id="already-set-strip" class="chip-strip" aria-label="Already configured"></div>
<main id="current-step" class="step-container" aria-live="polite"></main>

<script src="wizard/router.js"></script>
<script src="components/status-tile.js"></script>
<script src="components/permissions-grid.js"></script>
<script src="components/hotkey-picker.js"></script>
<script src="components/channel-card.js"></script>
<script src="components/voice-picker.js"></script>
<script src="components/theme-switch.js"></script>
<script src="components/install-log.js"></script>
<script src="wizard/chips.js"></script>
<script src="wizard/steps/welcome.js"></script>
<script src="wizard/steps/signin.js"></script>
<script src="wizard/steps/profile.js"></script>
<script src="wizard/steps/personalize.js"></script>
<script src="wizard/steps/permissions.js"></script>
<script src="wizard/steps/install.js"></script>
<script src="wizard/boot.js"></script>
</body></html>
```

- [ ] **Step 2: Create `desktop/wizard/boot.js` — renderer bootstrap.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(async function boot() {
    const headerEl = document.getElementById("wizard-header");
    const dotsEl = document.getElementById("step-dots");
    const chipsEl = document.getElementById("already-set-strip");
    const stepEl = document.getElementById("current-step");

    let state = await window.atlas.setupDetect();
    let { steps, header } = window.WizardRouter.getSteps(state);
    headerEl.textContent = header;

    function renderDots(currentId) {
        dotsEl.innerHTML = "";
        for (const id of window.WizardRouter.ALL_STEPS) {
            const d = document.createElement("span");
            d.className = "step-dot" + (id === currentId ? " active" : "") + (!steps.includes(id) ? " skipped" : "");
            d.title = id;
            d.addEventListener("click", () => { const i = steps.indexOf(id); if (i >= 0) renderIndex(i); });
            dotsEl.appendChild(d);
        }
    }
    function renderChips() {
        chipsEl.innerHTML = "";
        const chips = (window.WizardChips && window.WizardChips.buildChips(state)) || [];
        for (const c of chips) {
            const b = document.createElement("button");
            b.type = "button"; b.className = "chip"; b.textContent = `${c.label} ✓`;
            b.addEventListener("click", () => {
                const i = steps.indexOf(c.stepTarget);
                if (i >= 0) renderIndex(i);
                else window.dispatchEvent(new CustomEvent("wizard:manage", { detail: c }));
            });
            chipsEl.appendChild(b);
        }
    }
    async function advance(fromIdx) {
        const n = window.WizardRouter.next(fromIdx, steps);
        if (n === -1) {
            state = await window.atlas.setupDetect();
            ({ steps } = window.WizardRouter.getSteps(state));
            const i = steps.indexOf("install");
            if (i >= 0) return renderIndex(i);
            window.location.href = "ready-hub.html"; return;
        }
        renderIndex(n);
    }
    function goBack(fromIdx) { const p = window.WizardRouter.prev(fromIdx, steps); if (p !== -1) renderIndex(p); }
    async function refreshState() {
        state = await window.atlas.setupDetect();
        const nxt = window.WizardRouter.getSteps(state);
        steps = nxt.steps; headerEl.textContent = nxt.header; renderChips();
    }
    function renderIndex(idx) {
        const id = steps[idx];
        renderDots(id); renderChips();
        stepEl.innerHTML = "";
        const api = window.WizardSteps && window.WizardSteps[id];
        if (!api) { stepEl.textContent = `Unknown step: ${id}`; return; }
        api.render(stepEl, { state, onAdvance: () => advance(idx), onBack: () => goBack(idx), refreshState });
    }

    if (steps.length === 0) { window.location.href = "ready-hub.html"; return; }
    renderIndex(0);
})();
```

- [ ] **Step 3: Add `.chip` and `.step-dot.skipped` rules to `desktop/components/components.css`** (assume Phase B created that file — append below any existing rules):

```css
.chip-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 24px 12px; }
.chip { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #e8eaed; font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer; }
.chip:hover { background: rgba(255,255,255,0.14); }
.step-dots { display: flex; gap: 6px; }
.step-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.35); cursor: pointer; transition: background 200ms; }
.step-dot.active { background: linear-gradient(135deg, #a78bfa, #f472b6); }
.step-dot.skipped { background: rgba(255,255,255,0.12); cursor: default; }
```

**Manual checklist:** wipe `~/Library/Application Support/A.T.L.A.S`, launch — "Welcome" renders with 6 step dots. Fake a signed-in state by running `defaults write` or editing `prefs.json` to include `account: {signedIn:true,email:"x@y.com"}`, restart — boot lands on "Profile", dot 1+2 grayed.

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard.html wizard/boot.js components/components.css && git commit -m "feat(setup): C2 adaptive wizard shell + renderer bootstrap" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C3: Step — Welcome

**Files:**
- `desktop/wizard/steps/welcome.js`

- [ ] **Step 1: Create welcome step.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.welcome = {
        render(root, ctx) {
            const re = !!(ctx.state && ctx.state.isReconfigure);
            root.innerHTML = `<section class="step step-welcome">
                <h2 class="step-title">${re ? "Reconfigure A.T.L.A.S" : "Welcome to A.T.L.A.S"}</h2>
                <p class="step-sub">${re ? "Your current config will be preserved. Walk through to change anything." : "A calm, proactive personal AI. Setup takes under two minutes."}</p>
                <div class="step-actions"><button id="welcome-cta" class="btn-primary" type="button">Get Started</button></div>
            </section>`;
            root.querySelector("#welcome-cta").addEventListener("click", ctx.onAdvance);
        },
    };
})();
```

**Manual checklist:** fresh install → "Welcome to A.T.L.A.S"; inject `isReconfigure:true` via DevTools (`window.atlas` stub) → "Reconfigure A.T.L.A.S — current config will be preserved".

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/steps/welcome.js && git commit -m "feat(setup): C3 welcome step" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C4: Step — Sign in

**Files:**
- `desktop/wizard/steps/signin.js`

- [ ] **Step 1: Create signin step.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.signin = {
        render(root, ctx) {
            root.innerHTML = `<section class="step step-signin">
                <h2 class="step-title">Sign in</h2>
                <p class="step-sub">Signing in activates credits and personal memory.</p>
                <div class="step-actions"><button id="signin-btn" class="btn-primary" type="button">Sign in with OTPless</button></div>
                <p id="signin-status" class="step-note" aria-live="polite"></p>
            </section>`;
            const btn = root.querySelector("#signin-btn"), status = root.querySelector("#signin-status");
            let unlocked = false;
            btn.addEventListener("click", async () => {
                btn.disabled = true; status.textContent = "Opening secure sign-in…";
                try { await window.atlas.openAuthWindow(); }
                catch (err) { status.textContent = `Could not open auth window: ${err.message}`; btn.disabled = false; }
            });
            window.atlas.onAccountStatusChange(async (d) => {
                if (unlocked || !(d && d.signedIn)) return;
                unlocked = true; status.textContent = "Signed in ✓";
                await ctx.refreshState(); ctx.onAdvance();
            });
        },
    };
})();
```

**Manual checklist:** click Sign in, complete OTPless in popup, verify status flips to "Signed in ✓" and wizard auto-advances to Profile within 1s.

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/steps/signin.js && git commit -m "feat(setup): C4 signin step with auto-advance on account-status-change" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C5: Step — Profile (+ loosen `setup:save-profile` handler)

**Files:**
- `desktop/main.js` (modify `setup:save-profile`)
- `desktop/wizard/steps/profile.js`
- `desktop/__tests__/save-profile.test.js`

- [ ] **Step 1: TDD — pure helper for the merge shape.**

The IPC handler touches disk, so we factor the merge into a pure function.

Create `desktop/__tests__/save-profile.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { mergeProfile } = require("../wizard/profile-merge.js");

describe("mergeProfile", () => {
    it("writes name+tone", () => {
        expect(mergeProfile({}, { name: "Dheeraj", tone: "friendly" })).toMatchObject({ name: "Dheeraj", tone: "friendly" });
    });
    it("preserves legacy age/gender/extras", () => {
        const out = mergeProfile({ name: "Old", age: 40, gender: "x", extra: 7 }, { name: "New", tone: "professional" });
        expect(out).toMatchObject({ name: "New", tone: "professional", age: 40, gender: "x", extra: 7 });
    });
    it("rejects empty name", () => { expect(() => mergeProfile({}, { name: "   " })).toThrow(/name/i); });
    it("defaults tone to 'friendly'", () => { expect(mergeProfile({}, { name: "A" }).tone).toBe("friendly"); });
});
```

- [ ] **Step 2: Implement pure helper `desktop/wizard/profile-merge.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const ALLOWED_TONES = ["friendly", "professional", "playful"];
function mergeProfile(existing, update) {
    const name = (update && update.name ? String(update.name) : "").trim();
    if (!name) throw new Error("Profile name is required");
    const t = update && update.tone ? String(update.tone) : "friendly";
    return { ...(existing || {}), name, tone: ALLOWED_TONES.includes(t) ? t : "friendly" };
}
module.exports = { mergeProfile, ALLOWED_TONES };
```

- [ ] **Step 3: Modify `setup:save-profile` handler at `desktop/main.js:1501` to use the merge helper.**

```js
    ipcMain.handle("setup:save-profile", async (_, profile) => {
        try {
            const { mergeProfile } = require(path.join(__dirname, "wizard", "profile-merge.js"));
            const pp = path.join(app.getPath("userData"), ".user-profile.json");
            let existing = {}; try { existing = JSON.parse(fs.readFileSync(pp, "utf8")); } catch { /* fresh */ }
            fs.writeFileSync(pp, JSON.stringify(mergeProfile(existing, profile), null, 2));
            return { success: true };
        } catch (err) { return { success: false, error: err.message }; }
    });
```

- [ ] **Step 4: Create `desktop/wizard/steps/profile.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.profile = {
        render(root, ctx) {
            const p = (ctx.state && ctx.state.profile) || {};
            const name = (p.name || (ctx.state && ctx.state.osUserName) || "").replace(/"/g, "&quot;");
            const tone = p.tone || "friendly";
            root.innerHTML = `<section class="step step-profile">
                <h2 class="step-title">Your name & tone</h2>
                <label class="field"><span>Name</span><input id="prof-name" type="text" maxlength="64" value="${name}" placeholder="e.g. Dheeraj"/></label>
                <label class="field"><span>Tone</span><select id="prof-tone">
                    <option value="friendly">Friendly</option>
                    <option value="professional">Professional</option>
                    <option value="playful">Playful</option>
                </select></label>
                <div class="step-actions"><button id="prof-back" type="button" class="btn-ghost">Back</button><button id="prof-next" type="button" class="btn-primary">Continue</button></div>
                <p id="prof-err" class="step-error" aria-live="polite"></p>
            </section>`;
            root.querySelector("#prof-tone").value = tone;
            root.querySelector("#prof-back").addEventListener("click", ctx.onBack);
            root.querySelector("#prof-next").addEventListener("click", async () => {
                const n = root.querySelector("#prof-name").value.trim();
                const t = root.querySelector("#prof-tone").value;
                const err = root.querySelector("#prof-err");
                if (!n) { err.textContent = "Please enter a name."; return; }
                const res = await window.atlas.saveProfile({ name: n, tone: t });
                if (!res || !res.success) { err.textContent = (res && res.error) || "Save failed."; return; }
                await ctx.refreshState(); ctx.onAdvance();
            });
        },
    };
})();
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- save-profile
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/profile-merge.js wizard/steps/profile.js main.js __tests__/save-profile.test.js && git commit -m "feat(setup): C5 profile step with name+tone and backward-compatible merge" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C6: Step — Personalize (+ `setup:save-personalize` IPC)

**Files:**
- `desktop/wizard/personalize-reducer.js`
- `desktop/__tests__/personalize-reducer.test.js`
- `desktop/main.js` (add IPC handler)
- `desktop/preload.js` (expose IPC)
- `desktop/wizard/steps/personalize.js`

- [ ] **Step 1: TDD — reducer.**

`desktop/__tests__/personalize-reducer.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { mergePersonalize, VALID_VOICE_BACKENDS } = require("../wizard/personalize-reducer.js");

describe("mergePersonalize", () => {
    it("merges shallowly, keeps unrelated keys", () => {
        const out = mergePersonalize({ personalize: { hotkey: "Alt+Space" }, account: { signedIn: true }, misc: 1 }, { hotkey: "Ctrl+Space", theme: "light" });
        expect(out.personalize.hotkey).toBe("Ctrl+Space");
        expect(out.personalize.theme).toBe("light");
        expect(out.account.signedIn).toBe(true); expect(out.misc).toBe(1);
    });
    it("rejects empty hotkey", () => { expect(() => mergePersonalize({}, { hotkey: "" })).toThrow(/hotkey/i); });
    it("rejects invalid voice backend", () => { expect(() => mergePersonalize({}, { voice: { backend: "google-cloud", name: "x" } })).toThrow(/backend/i); });
    it("accepts each valid voice backend", () => {
        for (const b of VALID_VOICE_BACKENDS) expect(mergePersonalize({}, { voice: { backend: b, name: "Aoede" } }).personalize.voice.backend).toBe(b);
    });
    it("defaults wake-word phrase to 'Hey Atlas'", () => {
        const out = mergePersonalize({}, { wakeWord: { enabled: true } });
        expect(out.personalize.wakeWord).toEqual({ enabled: true, phrase: "Hey Atlas" });
    });
});
```

- [ ] **Step 2: Implement reducer.**

`desktop/wizard/personalize-reducer.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const VALID_VOICE_BACKENDS = ["gemini-live", "openai-realtime"];

function mergePersonalize(prefs, update) {
    const next = { ...(prefs || {}) };
    const p = { ...(next.personalize || {}) };
    const u = update || {};
    if ("hotkey" in u) {
        if (typeof u.hotkey !== "string" || !u.hotkey.trim()) throw new Error("hotkey must be a non-empty string");
        p.hotkey = u.hotkey.trim();
    }
    if ("theme" in u) {
        if (!["light", "dark", "system"].includes(u.theme)) throw new Error("theme must be light|dark|system");
        p.theme = u.theme;
    }
    if ("voice" in u && u.voice) {
        if (!VALID_VOICE_BACKENDS.includes(u.voice.backend)) throw new Error(`voice.backend must be one of ${VALID_VOICE_BACKENDS.join("|")}`);
        p.voice = { backend: u.voice.backend, name: String(u.voice.name || "") };
    }
    if ("wakeWord" in u && u.wakeWord) {
        const phr = u.wakeWord.phrase && String(u.wakeWord.phrase).trim();
        p.wakeWord = { enabled: !!u.wakeWord.enabled, phrase: phr || "Hey Atlas" };
    }
    next.personalize = p;
    return next;
}

module.exports = { mergePersonalize, VALID_VOICE_BACKENDS };
```

- [ ] **Step 3: Add `setup:save-personalize` IPC to `desktop/main.js`** (insert near other `setup:*` handlers, around line 1510):

```js
    ipcMain.handle("setup:save-personalize", async (_, update) => {
        try {
            const { mergePersonalize } = require(path.join(__dirname, "wizard", "personalize-reducer.js"));
            const current = store.get("prefs") || {};
            const next = mergePersonalize(current, update || {});
            store.set("prefs", next);
            return { success: true, prefs: next };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
```

- [ ] **Step 4: Expose in preload.**

Add inside `desktop/preload.js` under the `// ── Setup ──` block:

```js
    savePersonalize: (cfg) => ipcRenderer.invoke("setup:save-personalize", cfg),
    recordHotkey: () => ipcRenderer.invoke("setup:record-hotkey"),
    listVoices: (backend) => ipcRenderer.invoke("setup:list-voices", backend),
    previewVoice: (backend, name) => ipcRenderer.invoke("setup:preview-voice", backend, name),
```

(Assume `record-hotkey`, `list-voices`, `preview-voice` handlers come from Phase B components; if not present they return `{ok:false}` and the step degrades gracefully.)

- [ ] **Step 5: Create `desktop/wizard/steps/personalize.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.personalize = {
        render(root, ctx) {
            const platform = ctx.state && ctx.state.platform;
            const pz = (ctx.state && ctx.state.personalize) || {};
            const dHot = pz.hotkey || (platform === "win32" ? "Ctrl+Space" : "Alt+Space");
            const dTheme = pz.theme || ctx.state.theme || "system";
            const dVoice = pz.voice || { backend: "gemini-live", name: "Aoede" };
            const dWake = pz.wakeWord || { enabled: false, phrase: "Hey Atlas" };
            root.innerHTML = `<section class="step step-personalize">
                <h2 class="step-title">Make it yours</h2>
                <div class="card" id="card-hotkey"></div>
                <div class="card" id="card-theme"></div>
                <div class="card" id="card-voice"></div>
                <div class="card" id="card-wake">
                    <h3 class="card-title">Wake word</h3>
                    <label class="row"><input type="checkbox" id="wake-enabled" ${dWake.enabled ? "checked" : ""}/> Listen for a wake word</label>
                    <label class="field"><span>Phrase</span><input id="wake-phrase" type="text" value="${(dWake.phrase || "Hey Atlas").replace(/"/g, "&quot;")}"/></label>
                </div>
                <div class="step-actions"><button id="pz-back" type="button" class="btn-ghost">Back</button><button id="pz-next" type="button" class="btn-primary">Continue</button></div>
                <p id="pz-err" class="step-error" aria-live="polite"></p>
            </section>`;
            const C = window.SetupComponents || {};
            const hk = C.hotkeyPicker ? C.hotkeyPicker.mount(root.querySelector("#card-hotkey"), { value: dHot, platform }) : { getValue: () => dHot };
            const th = C.themeSwitch ? C.themeSwitch.mount(root.querySelector("#card-theme"), { value: dTheme }) : { getValue: () => dTheme };
            const vp = C.voicePicker ? C.voicePicker.mount(root.querySelector("#card-voice"), { value: dVoice }) : { getValue: () => dVoice };
            root.querySelector("#pz-back").addEventListener("click", ctx.onBack);
            root.querySelector("#pz-next").addEventListener("click", async () => {
                const payload = {
                    hotkey: hk.getValue(), theme: th.getValue(), voice: vp.getValue(),
                    wakeWord: { enabled: root.querySelector("#wake-enabled").checked, phrase: root.querySelector("#wake-phrase").value.trim() || "Hey Atlas" },
                };
                const res = await window.atlas.savePersonalize(payload);
                if (!res || !res.success) { root.querySelector("#pz-err").textContent = (res && res.error) || "Save failed."; return; }
                await ctx.refreshState(); ctx.onAdvance();
            });
        },
    };
})();
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- personalize-reducer
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/personalize-reducer.js wizard/steps/personalize.js __tests__/personalize-reducer.test.js main.js preload.js && git commit -m "feat(setup): C6 personalize step with reducer and IPC" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C7: Step — Permissions

**Files:**
- `desktop/wizard/steps/permissions.js`

- [ ] **Step 1: Create permissions step that hosts Phase B `permissions-grid`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.permissions = {
        render(root, ctx) {
            const isMac = ctx.state && ctx.state.platform === "darwin";
            root.innerHTML = `<section class="step step-permissions">
                <h2 class="step-title">System permissions</h2>
                <p class="step-sub">${isMac ? "Grant whatever you want now — you can come back anytime." : "Windows will prompt when features are first used."}</p>
                <div id="perm-grid"></div>
                <div class="step-actions"><button id="pm-back" type="button" class="btn-ghost">Back</button><button id="pm-next" type="button" class="btn-primary">Continue</button></div>
            </section>`;
            const host = root.querySelector("#perm-grid");
            const C = window.SetupComponents;
            if (isMac && C && C.permissionsGrid) {
                C.permissionsGrid.mount(host, { initial: ctx.state.permissions, poll: () => window.atlas.setupPollPermissions() });
            } else {
                host.innerHTML = `<div class="info-card">Nothing to configure on this platform.</div>`;
            }
            root.querySelector("#pm-back").addEventListener("click", ctx.onBack);
            root.querySelector("#pm-next").addEventListener("click", async () => { await ctx.refreshState(); ctx.onAdvance(); });
        },
    };
})();
```

**Manual checklist:** fresh Mac, open wizard, reach Permissions step, deny all — pills red/amber. Open System Settings → Privacy → Accessibility, toggle Atlas on. Within ~2s the Accessibility tile flips green with a pulse. Continue is always enabled; clicking it advances to Install with no error.

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/steps/permissions.js && git commit -m "feat(setup): C7 permissions step hosting live-polled grid" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C8: `desktop/installer/phases.js` (buildPhaseList, TDD)

**Files:**
- `desktop/installer/phases.js`
- `desktop/installer/__tests__/phases.test.js`

- [ ] **Step 1: Write phase-list builder tests.**

`desktop/installer/__tests__/phases.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { buildPhaseList, ALL_PHASE_IDS } = require("../phases.js");
const CANON = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];
const base = (o = {}) => ({ platform: "darwin", installed: { node: false, playwright: false, embeddingModel: false, sox: false }, workspace: { path: "", exists: false }, ...o });

describe("buildPhaseList", () => {
    it("fresh → all 7 in canonical order", () => { expect(buildPhaseList(base()).map((p) => p.id)).toEqual(CANON); });
    it("fully cached → [data-dir, workspace, setup-state-finalize]", () => {
        const list = buildPhaseList(base({ installed: { node: true, playwright: true, embeddingModel: true, sox: true }, workspace: { path: "/tmp/ws", exists: true } }));
        expect(list.map((p) => p.id)).toEqual(["data-dir", "workspace", "setup-state-finalize"]);
    });
    it("win32 fresh → same ids as Mac (sox runtime-branches internally)", () => {
        expect(buildPhaseList(base({ platform: "win32" })).map((p) => p.id)).toEqual(CANON);
    });
    it("phases have id, label, run fn, idempotent=true", () => {
        for (const p of buildPhaseList(base())) {
            expect(typeof p.id).toBe("string"); expect(typeof p.label).toBe("string");
            expect(typeof p.run).toBe("function"); expect(p.idempotent).toBe(true);
        }
    });
    it("workspace skipped when no path requested AND dir exists", () => {
        const list = buildPhaseList(base({ installed: { node: true, playwright: true, embeddingModel: true, sox: true }, workspace: { path: "", exists: true } }));
        expect(list.map((p) => p.id)).not.toContain("workspace");
    });
    it("ALL_PHASE_IDS equals canonical order", () => { expect(ALL_PHASE_IDS).toEqual(CANON); });
});
```

- [ ] **Step 2: Implement `desktop/installer/phases.js`.**

Each `run()` is lifted verbatim from the existing monolithic handler at `desktop/main.js:1552-1747`. The existing function references (`checkNodeInstalled`, `downloadAndInstallNode`, `runCommand`, `BOT_DIR`, `DATA_DIR`, `SETUP_FLAG`, `loadEnvDecrypted`, `saveEnvEncrypted`) are passed in via `ctx` since this module lives outside `main.js` scope.

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const path = require("path"), fs = require("fs"), os = require("os");

const ALL_PHASE_IDS = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];

const P = {
    node: () => ({ id: "node", label: "Node.js 20", idempotent: true, async run(ctx, log) {
        log("Detecting Node.js on system PATH...");
        const has = await ctx.checkNodeInstalled();
        if (!has) { log("Node.js not found — downloading..."); await ctx.downloadAndInstallNode(ctx.sendProgress); }
        else log("Node.js 20+ detected ✓");
    }}),
    playwright: () => ({ id: "playwright-chromium", label: "Browser engine", idempotent: true, async run(ctx, log) {
        log("Installing Chromium (~130MB)...");
        const cli = path.join(ctx.BOT_DIR, "node_modules", "playwright", "cli.js");
        await ctx.runCommand("node", [cli, "install", "chromium"], ctx.BOT_DIR, (l) => { if (l.trim()) log(l); });
    }}),
    embed: () => ({ id: "embedding-model", label: "AI embedding model", idempotent: true, async run(ctx, log) {
        log("Pre-warming Xenova/all-MiniLM-L6-v2 (quantized)...");
        const script = path.join(os.tmpdir(), "_atlas_warmup.mjs");
        fs.writeFileSync(script, `import("@xenova/transformers").then(t=>t.pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{quantized:true})).then(()=>console.log("done")).catch(e=>console.error(e));`);
        try { await ctx.runCommand("node", [script], ctx.BOT_DIR, (l) => { if (l.trim()) log(l); }); }
        finally { try { fs.unlinkSync(script); } catch { /* */ } }
    }}),
    sox: () => ({ id: "sox", label: "Audio toolkit (sox)", idempotent: true, async run(ctx, log) {
        // verbatim try/catch lifted from main.js:1599-1643; non-fatal
        try {
            const has = await new Promise((r) => require("child_process").exec("sox --version", (e) => r(!e)));
            if (has) { log("sox detected ✓"); return; }
            log("Installing sox (needed for live voice)...");
            if (process.platform === "darwin") {
                try { await ctx.runCommand("brew", ["install", "sox"], undefined, (l) => { if (l.trim()) log(l); }); log("sox via Homebrew ✓"); }
                catch { log("Install manually: brew install sox"); }
            } else if (process.platform === "linux") {
                try { await ctx.runCommand("sudo", ["apt-get", "install", "-y", "sox"], undefined, (l) => { if (l.trim()) log(l); }); }
                catch { log("Install manually: sudo apt install sox"); }
            } else {
                try { await ctx.runCommand("choco", ["install", "sox", "-y"], undefined, (l) => { if (l.trim()) log(l); }); }
                catch { log("sox not found — https://sox.sourceforge.net"); }
            }
        } catch { log("Audio tools check skipped (non-fatal)"); }
    }}),
    dataDir: () => ({ id: "data-dir", label: "Data directory", idempotent: true, async run(ctx, log) {
        log("Setting up data directory...");
        fs.mkdirSync(ctx.DATA_DIR, { recursive: true });
        const del = ["memory.db", "memory.db-shm", "memory.db-wal", "memory.hnsw.json", "audit.jsonl", "browser-strategies.json", "task-learnings.json"];
        const clear = ["browser-profile", "google-tokens", "research", "long-tasks", "process-logs"];
        for (const f of del) try { fs.unlinkSync(path.join(ctx.DATA_DIR, f)); } catch { /* */ }
        for (const d of clear) {
            try { fs.rmSync(path.join(ctx.DATA_DIR, d), { recursive: true, force: true }); } catch { /* */ }
            fs.mkdirSync(path.join(ctx.DATA_DIR, d), { recursive: true });
        }
        const bundled = path.join(ctx.BOT_DIR, "data", "google-credentials.json");
        if (fs.existsSync(bundled)) fs.copyFileSync(bundled, path.join(ctx.DATA_DIR, "google-credentials.json"));
    }}),
    workspace: () => ({ id: "workspace", label: "Workspace folder", idempotent: true, async run(ctx, log) {
        const ws = ctx.options && ctx.options.workspace;
        if (!ws) { log("No workspace requested — skipping"); return; }
        log(`Creating: ${ws}`);
        try { fs.mkdirSync(ws, { recursive: true }); }
        catch (err) {
            log(`Could not create ${ws}: ${err.message}`);
            const fb = path.join(ctx.documentsDir, "A.T.L.A.S Files");
            fs.mkdirSync(fb, { recursive: true }); ctx.options.workspace = fb;
            const env = ctx.loadEnvDecrypted && ctx.loadEnvDecrypted();
            if (env) ctx.saveEnvEncrypted(env.split("\n").map((l) => l.startsWith("ATLAS_WORKSPACE=") ? `ATLAS_WORKSPACE=${fb}` : l).join("\n"));
        }
    }}),
    finalize: () => ({ id: "setup-state-finalize", label: "Finalize", idempotent: true, async run(ctx, log) {
        fs.writeFileSync(ctx.SETUP_FLAG, new Date().toISOString());
        const sp = path.join(ctx.DATA_DIR, "setup-state.json");
        let st = {}; try { st = JSON.parse(fs.readFileSync(sp, "utf8")); } catch { /* */ }
        st.__version = 2; st.__finalizedAt = new Date().toISOString();
        fs.writeFileSync(sp, JSON.stringify(st, null, 2));
        log("Setup complete ✓");
    }}),
};

function buildPhaseList(state) {
    const s = state || { installed: {}, workspace: {} };
    const i = s.installed || {}, w = s.workspace || {};
    const out = [];
    if (!i.node) out.push(P.node());
    if (!i.playwright) out.push(P.playwright());
    if (!i.embeddingModel) out.push(P.embed());
    if (!i.sox) out.push(P.sox());
    out.push(P.dataDir());
    if (w.path || !w.exists) out.push(P.workspace());
    out.push(P.finalize());
    return out;
}

module.exports = { buildPhaseList, ALL_PHASE_IDS };
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- phases
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add installer/phases.js installer/__tests__/phases.test.js && git commit -m "feat(setup): C8 declarative install phase list with tests" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C9: `desktop/installer/runner.js` (sequential runner + resume, TDD)

**Files:**
- `desktop/installer/runner.js`
- `desktop/installer/__tests__/runner.test.js`

- [ ] **Step 1: Write runner tests.**

`desktop/installer/__tests__/runner.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect, beforeEach } = require("vitest");
const path = require("path"), fs = require("fs"), os = require("os");
const { runPhases, getResumeList, readSetupState, writeSetupState } = require("../runner.js");

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-runner-")); });
const ctx = () => ({ DATA_DIR: tmp, sendProgress: () => {}, sendLog: () => {} });

describe("getResumeList", () => {
    it("filters completed phases", () => {
        expect(getResumeList([{ id: "a" }, { id: "b" }, { id: "c" }], { a: { completedAt: "t", durationMs: 1 } }).map((p) => p.id)).toEqual(["b", "c"]);
    });
    it("empty when all complete", () => {
        expect(getResumeList([{ id: "a" }, { id: "b" }], { a: { completedAt: "x" }, b: { completedAt: "y" } })).toEqual([]);
    });
    it("ignores __-prefixed metadata", () => {
        expect(getResumeList([{ id: "a" }, { id: "b" }], { __version: 2, a: { completedAt: "x" } }).map((p) => p.id)).toEqual(["b"]);
    });
});

describe("runPhases", () => {
    it("runs all and writes per-phase markers", async () => {
        const res = await runPhases([{ id: "a", label: "A", run: async () => {} }, { id: "b", label: "B", run: async () => {} }], ctx());
        expect(res.status).toBe("complete");
        const s = readSetupState(tmp);
        expect(s.a.completedAt).toBeDefined(); expect(s.b.completedAt).toBeDefined();
    });
    it("pauses on error; later phases not run", async () => {
        const res = await runPhases([
            { id: "a", label: "A", run: async () => {} },
            { id: "b", label: "B", run: async () => { throw new Error("boom"); } },
            { id: "c", label: "C", run: async () => {} },
        ], ctx());
        expect(res.status).toBe("paused");
        expect(res.failedPhase.id).toBe("b");
        expect(res.error.message).toBe("boom");
        const s = readSetupState(tmp);
        expect(s.a).toBeDefined(); expect(s.b).toBeUndefined(); expect(s.c).toBeUndefined();
    });
    it("resume skips already-completed", async () => {
        writeSetupState(tmp, { a: { completedAt: "x", durationMs: 1 } });
        const full = [
            { id: "a", label: "A", run: async () => { throw new Error("should not rerun"); } },
            { id: "b", label: "B", run: async () => {} },
        ];
        const res = await runPhases(getResumeList(full, readSetupState(tmp)), ctx());
        expect(res.status).toBe("complete");
        expect(readSetupState(tmp).b).toBeDefined();
    });
});
```

- [ ] **Step 2: Implement `desktop/installer/runner.js`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const path = require("path"), fs = require("fs");

const SECRETS = [
    /TELEGRAM_BOT_TOKEN=\S+/gi, /DISCORD_BOT_TOKEN=\S+/gi,
    /MATRIX_ACCESS_TOKEN=\S+/gi, /EMAIL_PASSWORD=\S+/gi,
    /\b\d{9,10}:[A-Za-z0-9_-]{20,}\b/g,
];
function redactSecrets(line) {
    let o = String(line == null ? "" : line);
    for (const re of SECRETS) o = o.replace(re, (m) => (m.includes("=") ? `${m.split("=")[0]}=***` : "***"));
    return o;
}
const sp = (d) => path.join(d, "setup-state.json");
function readSetupState(d) { try { return JSON.parse(fs.readFileSync(sp(d), "utf8")); } catch { return {}; } }
function writeSetupState(d, s) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(sp(d), JSON.stringify(s, null, 2)); }
function getResumeList(list, st) { const s = st || {}; return list.filter((p) => !(s[p.id] && s[p.id].completedAt)); }

async function runPhases(phaseList, ctx) {
    const total = phaseList.length;
    const state = readSetupState(ctx.DATA_DIR);
    const log = (m) => { if (ctx.sendLog) ctx.sendLog(redactSecrets(m)); };
    for (let i = 0; i < total; i++) {
        const ph = phaseList[i];
        if (ctx.sendProgress) ctx.sendProgress(Math.floor((i / total) * 100), `Running: ${ph.label}`);
        const t0 = Date.now();
        try {
            await ph.run(ctx, log);
            state[ph.id] = { completedAt: new Date().toISOString(), durationMs: Date.now() - t0 };
            writeSetupState(ctx.DATA_DIR, state);
        } catch (err) {
            writeSetupState(ctx.DATA_DIR, state);
            if (ctx.sendProgress) ctx.sendProgress(-1, `Paused at ${ph.label}`);
            log(`ERROR in phase ${ph.id}: ${err.message}`);
            return { status: "paused", failedPhase: { id: ph.id, label: ph.label }, error: { message: err.message, stack: err.stack }, completed: Object.keys(state).filter((k) => !k.startsWith("__")) };
        }
    }
    if (ctx.sendProgress) ctx.sendProgress(100, "Install complete");
    return { status: "complete", completed: Object.keys(state).filter((k) => !k.startsWith("__")) };
}

module.exports = { runPhases, getResumeList, readSetupState, writeSetupState, redactSecrets };
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- runner
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add installer/runner.js installer/__tests__/runner.test.js && git commit -m "feat(setup): C9 install runner with resume and paused states" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C10: Rewire `setup:install` + add retry + resume IPCs

**Files:**
- `desktop/main.js` (replace body of `setup:install`; add two new handlers)
- `desktop/preload.js` (expose the new IPCs)

- [ ] **Step 1: Factor out a shared ctx-builder at the top of `desktop/main.js` (once, near the other helpers).**

```js
function buildInstallCtx(mainWindow, options) {
    const send = (ch, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); };
    return {
        sendProgress: (percent, message) => send("install-progress", { percent, message }),
        sendLog: (msg) => send("install-log", msg),
        BOT_DIR, DATA_DIR, SETUP_FLAG,
        checkNodeInstalled, downloadAndInstallNode, runCommand,
        loadEnvDecrypted, saveEnvEncrypted,
        documentsDir: app.getPath("documents"),
        options: options || {},
    };
}
function requireInstaller() {
    return {
        runDetection: require(path.join(__dirname, "detection.js")).runDetection,
        buildPhaseList: require(path.join(__dirname, "installer", "phases.js")).buildPhaseList,
        runPhases: require(path.join(__dirname, "installer", "runner.js")).runPhases,
        getResumeList: require(path.join(__dirname, "installer", "runner.js")).getResumeList,
        readSetupState: require(path.join(__dirname, "installer", "runner.js")).readSetupState,
    };
}
```

- [ ] **Step 2: Replace the body of `setup:install` at `desktop/main.js:1552`.**

```js
    ipcMain.handle("setup:install", async (_, options) => {
        const ctx = buildInstallCtx(mainWindow, options);
        try {
            const { runDetection, buildPhaseList, runPhases } = requireInstaller();
            const state = await runDetection({ fs, systemPreferences, nativeTheme, globalShortcut, store, app });
            const res = await runPhases(buildPhaseList(state), ctx);
            return res.status === "complete"
                ? { success: true, completed: res.completed }
                : { success: false, paused: true, failedPhase: res.failedPhase, error: res.error.message, completed: res.completed };
        } catch (err) {
            ctx.sendLog(`ERROR: ${err.message}`); ctx.sendProgress(-1, `Error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
```

- [ ] **Step 3: Add retry/resume/get-state handlers below.**

```js
    ipcMain.handle("setup:retry-install-phase", async (_, phaseId) => {
        try {
            const { runDetection, buildPhaseList, runPhases } = requireInstaller();
            const state = await runDetection({ fs, systemPreferences, nativeTheme, globalShortcut, store, app });
            const phase = buildPhaseList(state).find((p) => p.id === phaseId);
            if (!phase) return { success: false, error: `Unknown phase: ${phaseId}` };
            const res = await runPhases([phase], buildInstallCtx(mainWindow, {}));
            return { success: res.status === "complete", paused: res.status === "paused", error: res.error && res.error.message };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ipcMain.handle("setup:resume-install", async () => {
        try {
            const { runDetection, buildPhaseList, runPhases, getResumeList, readSetupState } = requireInstaller();
            const state = await runDetection({ fs, systemPreferences, nativeTheme, globalShortcut, store, app });
            const remaining = getResumeList(buildPhaseList(state), readSetupState(DATA_DIR));
            const res = await runPhases(remaining, buildInstallCtx(mainWindow, {}));
            return { success: res.status === "complete", paused: res.status === "paused", failedPhase: res.failedPhase, error: res.error && res.error.message };
        } catch (err) { return { success: false, error: err.message }; }
    });

    ipcMain.handle("setup:get-state", () => {
        try { return { success: true, state: requireInstaller().readSetupState(DATA_DIR) }; }
        catch (err) { return { success: false, error: err.message }; }
    });
```

- [ ] **Step 4: Extend `desktop/preload.js` setup block.**

```js
    retryInstallPhase: (phaseId) => ipcRenderer.invoke("setup:retry-install-phase", phaseId),
    resumeInstall: () => ipcRenderer.invoke("setup:resume-install"),
    getSetupState: () => ipcRenderer.invoke("setup:get-state"),
```

**Manual checklist:** kick off a fresh install; during the Playwright Chromium download press `Cmd+Q` to quit Electron. Relaunch the app — wizard detects `SETUP_FLAG` absent, lands on Install step; Install step calls `getSetupState()`, sees `node` completed, `playwright-chromium` absent; clicking "Resume" finishes without re-running Node.

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add main.js preload.js && git commit -m "feat(setup): C10 rewire install IPC + retry-phase + resume handlers" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C11: Step — Install UI

**Files:**
- `desktop/wizard/steps/install.js`

- [ ] **Step 1: Create install step that renders phase checklist + embedded `install-log`.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    const ICON = { pending: "○", running: "◐", done: "✓", failed: "✕" };
    const PHASE_IDS = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];
    const LABELS = { "node": "Node.js 20", "playwright-chromium": "Browser engine", "embedding-model": "AI model", "sox": "Audio toolkit", "data-dir": "Data directory", "workspace": "Workspace folder", "setup-state-finalize": "Finalize" };

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.install = {
        async render(root, ctx) {
            root.innerHTML = `<section class="step step-install">
                <h2 class="step-title">Finishing up</h2>
                <ul id="phase-list" class="phase-list"></ul>
                <div class="progress-wrap"><div id="progress-bar" class="progress-bar"></div></div>
                <div id="log-host" class="log-host"></div>
                <div class="step-actions">
                    <button id="inst-start" type="button" class="btn-primary">Begin install</button>
                    <button id="inst-resume" type="button" class="btn-ghost hidden">Resume</button>
                    <button id="inst-retry" type="button" class="btn-ghost hidden">Retry failed phase</button>
                </div>
                <p id="inst-err" class="step-error" aria-live="polite"></p>
            </section>`;
            const q = (s) => root.querySelector(s);
            const listEl = q("#phase-list"), bar = q("#progress-bar"), logHost = q("#log-host");
            const startBtn = q("#inst-start"), resumeBtn = q("#inst-resume"), retryBtn = q("#inst-retry"), errEl = q("#inst-err");
            const C = window.SetupComponents || {};
            const logApi = C.installLog ? C.installLog.mount(logHost) : { append: (m) => { const p = document.createElement("pre"); p.textContent = m; logHost.appendChild(p); } };

            const stateResp = await window.atlas.getSetupState();
            const completed = stateResp && stateResp.success ? (stateResp.state || {}) : {};
            let failedId = null;

            function renderList(running) {
                listEl.innerHTML = "";
                for (const id of PHASE_IDS) {
                    let st = "pending";
                    if (completed[id] && completed[id].completedAt) st = "done";
                    if (id === running) st = "running";
                    if (id === failedId) st = "failed";
                    const li = document.createElement("li");
                    li.className = `phase-row phase-${st}`;
                    li.innerHTML = `<span class="phase-icon">${ICON[st]}</span><span>${LABELS[id] || id}</span>`;
                    listEl.appendChild(li);
                }
            }
            const doneCount = Object.keys(completed).filter((k) => !k.startsWith("__")).length;
            if (doneCount > 0 && doneCount < PHASE_IDS.length) { resumeBtn.classList.remove("hidden"); startBtn.classList.add("hidden"); }
            if (doneCount === PHASE_IDS.length) { window.location.href = "ready-hub.html"; return; }

            window.atlas.onInstallProgress(({ percent, message }) => {
                if (percent >= 0) bar.style.width = `${Math.min(100, percent)}%`;
                const m = message && message.match(/Running: (.+)$/);
                if (m) { const id = Object.keys(LABELS).find((k) => LABELS[k] === m[1]); if (id) renderList(id); }
                if (percent === 100) setTimeout(() => { window.location.href = "ready-hub.html"; }, 500);
            });
            window.atlas.onInstallLog((msg) => logApi.append(msg));
            renderList(null);

            async function handle(res) {
                if (res && res.success) { window.location.href = "ready-hub.html"; return; }
                if (res && res.paused) {
                    failedId = res.failedPhase && res.failedPhase.id;
                    errEl.textContent = `Failed at ${res.failedPhase && res.failedPhase.label}: ${res.error || "unknown"}`;
                    retryBtn.classList.remove("hidden"); resumeBtn.classList.remove("hidden"); startBtn.classList.add("hidden");
                    const { state } = await window.atlas.getSetupState();
                    Object.assign(completed, state || {}); renderList(null);
                    return;
                }
                errEl.textContent = (res && res.error) || "Install failed.";
            }
            startBtn.addEventListener("click", async () => {
                startBtn.disabled = true; errEl.textContent = "";
                await handle(await window.atlas.startInstall({ workspace: (ctx.state && ctx.state.workspace && ctx.state.workspace.path) || "" }));
            });
            resumeBtn.addEventListener("click", async () => { resumeBtn.disabled = true; await handle(await window.atlas.resumeInstall()); resumeBtn.disabled = false; });
            retryBtn.addEventListener("click", async () => { if (!failedId) return; retryBtn.disabled = true; await handle(await window.atlas.retryInstallPhase(failedId)); retryBtn.disabled = false; });
        },
    };
})();
```

Also append to `desktop/components/components.css`:

```css
.phase-list { list-style: none; padding: 0; margin: 12px 0; }
.phase-row { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 13px; }
.phase-row .phase-icon { width: 16px; text-align: center; }
.phase-pending .phase-icon { color: rgba(255,255,255,0.35); }
.phase-running .phase-icon { color: #a78bfa; animation: spin 1s linear infinite; }
.phase-done .phase-icon { color: #4ade80; }
.phase-failed .phase-icon { color: #f87171; }
.progress-wrap { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; margin: 8px 0; }
.progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #a78bfa, #f472b6); transition: width 300ms; }
.hidden { display: none !important; }
@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
```

**Manual checklist:** fully-cached machine → install completes in <5s and navigates to Ready Hub; fresh machine → rows flip pending→running→done as log lines stream; mid-Playwright kill with Cmd+Q → relaunch, Install step auto-shows "Resume" with Node already green-checked; click Resume → completes.

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/steps/install.js components/components.css && git commit -m "feat(setup): C11 install step UI with phase checklist and resume" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C12: "Already set" chip strip

**Files:**
- `desktop/wizard/chips.js`
- `desktop/wizard/__tests__/chips.test.js`

- [ ] **Step 1: Write chip-builder tests.**

`desktop/wizard/__tests__/chips.test.js`:

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const { describe, it, expect } = require("vitest");
const { buildChips, CHIP_ORDER } = require("../chips.js");

const fully = () => ({
    account: { signedIn: true, email: "a@b.com" },
    google: { connected: true, email: "a@b.com" },
    channels: { telegram: { connected: true }, discord: { connected: true }, slack: { connected: true }, whatsapp: { connected: true }, matrix: { connected: true }, email: { connected: true } },
    workspace: { path: "/tmp/ws", exists: true },
    personalize: { hotkey: "Alt+Space", theme: "dark", voice: { backend: "gemini-live", name: "Aoede" } },
});

describe("buildChips", () => {
    it("fresh → empty", () => { expect(buildChips({})).toEqual([]); });
    it("fully configured → 12 chips in canonical order", () => {
        const chips = buildChips(fully());
        expect(chips.map((c) => c.id)).toEqual(CHIP_ORDER);
        expect(chips).toHaveLength(12);
    });
    it("every chip has id/label/value/stepTarget strings", () => {
        for (const c of buildChips(fully())) expect(["id", "label", "value", "stepTarget"].every((k) => typeof c[k] === "string")).toBe(true);
    });
    it("partial state → stable subset ordering", () => {
        expect(buildChips({ account: { signedIn: true }, channels: { telegram: { connected: true } } }).map((c) => c.id)).toEqual(["account", "telegram"]);
    });
});
```

- [ ] **Step 2: Implement chips.js.**

```js
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
const CHIP_ORDER = ["account", "google", "telegram", "discord", "slack", "whatsapp", "matrix", "email", "workspace", "hotkey", "theme", "voice"];

function buildChips(state) {
    const s = state || {}, ch = s.channels || {}, p = s.personalize || {};
    const out = [];
    const push = (id, label, value, stepTarget) => out.push({ id, label, value: String(value), stepTarget });
    if (s.account && s.account.signedIn) push("account", "Account", s.account.email || "signed in", "signin");
    if (s.google && s.google.connected) push("google", "Google", s.google.email || "connected", "step:manage-google");
    for (const k of ["telegram", "discord", "slack", "whatsapp", "matrix", "email"]) {
        if (ch[k] && ch[k].connected) push(k, k[0].toUpperCase() + k.slice(1), "connected", `step:manage-${k}`);
    }
    if (s.workspace && s.workspace.path) push("workspace", "Workspace", s.workspace.path, "install");
    if (p.hotkey) push("hotkey", "Hotkey", p.hotkey, "personalize");
    if (p.theme) push("theme", "Theme", p.theme, "personalize");
    if (p.voice && p.voice.name) push("voice", "Voice", `${p.voice.backend} · ${p.voice.name}`, "personalize");
    out.sort((a, b) => CHIP_ORDER.indexOf(a.id) - CHIP_ORDER.indexOf(b.id));
    return out;
}

const api = { buildChips, CHIP_ORDER };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardChips = api;
```

**Manual checklist:** fully-configured reconfigure flow → chip row shows all 12; click "Google ✓" → `wizard:manage` event fires routing to a Google management pane (implemented by Phase D if not in-wizard).

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test -- chips
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add wizard/chips.js wizard/__tests__/chips.test.js && git commit -m "feat(setup): C12 already-set chip strip with tests" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C13: Windows parity

**Files:**
- `desktop/wizard/router.js` (no code change — covered by existing test; add Windows defaults test)
- `desktop/installer/__tests__/phases.test.js` (extend)
- `desktop/wizard/steps/personalize.js` (already defaults hotkey by platform)

- [ ] **Step 1: Extend phases test with a Windows fresh state case.**

Append to `desktop/installer/__tests__/phases.test.js`:

```js
describe("Windows parity", () => {
    it("win32 fresh → same phase ids (sox branches at runtime)", () => {
        const list = require("../phases.js").buildPhaseList({ platform: "win32", installed: { node: false, playwright: false, embeddingModel: false, sox: false }, workspace: { path: "", exists: false } });
        expect(list.map((p) => p.id)).toEqual(["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"]);
    });
    it("win32 state → router excludes permissions", () => {
        const { getSteps } = require("../../wizard/router.js");
        const { steps } = getSteps({
            platform: "win32", account: { signedIn: true }, profile: { name: "X", tone: "friendly" },
            permissions: { accessibility: "denied", screen: "denied", microphone: "denied", location: "denied" },
            installed: { node: false, playwright: false, embeddingModel: false, sox: false },
            hotkey: { current: "Ctrl+Space", conflicts: [] },
            personalize: { hotkey: "Ctrl+Space", theme: "dark", voice: { backend: "gemini-live", name: "Aoede" }, wakeWord: { enabled: false, phrase: "Hey Atlas" } },
            workspace: { path: "", exists: false },
        });
        expect(steps).not.toContain("permissions");
        expect(steps).toContain("install");
    });
});
```

- [ ] **Step 2: Confirm `personalize.js` seeds `Ctrl+Space` on Windows** — already done via `platform === "win32" ? "Ctrl+Space" : "Alt+Space"` in Task C6. No further code change.

**Manual checklist (Windows VM, documented):** launch fresh on Windows 11 VM; wizard flows Welcome → Sign-in → Profile → Personalize (hotkey defaults to `Ctrl+Space`) → Install (no Permissions step); no `systempreferences:` URL attempts; install completes.

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

```bash
cd /Users/user/Desktop/ATLAS/desktop && git add installer/__tests__/phases.test.js && git commit -m "feat(setup): C13 Windows parity tests (router skips permissions, hotkey default Ctrl+Space)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C14: Phase-C smoke gate

**Files:** none new.

- [ ] **Step 1: Run the full desktop test suite.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm test
```

Expect: router, chips, phases, runner, save-profile, personalize-reducer, plus Phase A and Phase B tests, all green.

- [ ] **Step 2: Run the app end-to-end.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && npm start
```

Walk through:
1. Welcome shows; Get Started advances.
2. Sign in opens OTPless popup; after successful OTP, wizard auto-advances.
3. Profile pre-fills OS name; save goes through.
4. Personalize: change hotkey, theme, voice, wake word; Continue persists via `atlas.getPrefs()` in DevTools.
5. Permissions: live poll; grant Accessibility in System Settings → tile flips green within 2s; Continue always enabled.
6. Install: phase-list renders; log streams live; `percent` hits 100; navigates to `ready-hub.html`.
7. Ready Hub opens (Phase D). From hub, click Telegram tile → channel picker opens (Phase B); add a bot token; "Test" passes; chip appears on next wizard reconfigure.

- [ ] **Step 3: Tag commit.**

```bash
cd /Users/user/Desktop/ATLAS/desktop && git commit --allow-empty -m "chore(setup): phase-c complete" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Ready Hub, Settings Integration & Migration

This phase builds the Ready Hub landing surface (spec Section 7), embeds it as a new Settings → Setup tab in `desktop/panel.html`, polishes the channel sub-flow (Section 8) and visual/motion (Section 9), and ships the v1→v2 migration + rollout gate (Section 11).

Assumes Phases A, B, C are complete. Available entry points:

- `window.atlas.setupDetect()` returns `SystemState`.
- Shared components in `desktop/components/*.js`: `status-tile.js`, `channel-card.js`, `hotkey-picker.js`, `voice-picker.js`, `theme-switch.js`, `permissions-grid.js`, `install-log.js`.
- `desktop/wizard.html` is the adaptive flow; on completion it navigates to `ready-hub.html`.
- `desktop/panel.html` (3575 lines) already has a tab bar.

### Task D1 — Create `desktop/ready-hub.html`

Hub shell per Section 7. Top: breathing orb + greeting + two primary buttons. Bottom: `YOUR SETUP` header + tile grid.

**TDD first** — create `desktop/components/__tests__/tile-model.test.js` (Node's built-in `node:test`; runner: `node --test desktop/components/__tests__/*.test.js`):

```js
// desktop/components/__tests__/tile-model.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tileModel } from "../tile-model.js";

const base = {
  platform: "darwin",
  account: { signedIn: true, email: "a@b.co", plan: "pro", credits: 1200 },
  profile: { name: "Dheeraj", tone: "friendly" },
  permissions: { accessibility: "granted", screen: "granted", microphone: "denied", location: "unknown" },
  google: { connected: true, email: "a@b.co" },
  channels: { telegram: { connected: true }, email: { connected: false } },
  hotkey: { current: "Alt+Space", conflicts: [] },
  theme: "dark",
  voice: { name: "Aoede", backend: "gemini-live" },
  wakeWord: { enabled: false, phrase: "Hey Atlas" },
};

test("account tile green when signed in with credits", () => {
  const t = tileModel(base, "account");
  assert.equal(t.status, "green");
  assert.equal(t.value, "a@b.co");
  assert.match(t.secondary, /pro.*1200/);
  assert.equal(t.onClickRoute, "settings:account");
});

test("permissions tile amber when partially granted", () => {
  const t = tileModel(base, "permissions");
  assert.equal(t.status, "amber");
  assert.equal(t.value, "2 of 4 granted");
});

test("permissions tile green when all granted on macOS", () => {
  const s = { ...base, permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" } };
  assert.equal(tileModel(s, "permissions").status, "green");
});

test("permissions tile hidden on Windows", () => {
  const s = { ...base, platform: "win32" };
  assert.equal(tileModel(s, "permissions"), null);
});

test("channels tile neutral with N connected label", () => {
  const t = tileModel(base, "channels");
  assert.equal(t.status, "neutral");
  assert.equal(t.value, "1 connected");
});

test("wake word tile neutral when off", () => {
  assert.equal(tileModel(base, "wakeWord").status, "neutral");
});
```

Then implement `desktop/components/tile-model.js`:

```js
// desktop/components/tile-model.js
export function tileModel(state, name) {
  switch (name) {
    case "account": {
      const a = state.account || {};
      if (!a.signedIn) return { label: "Account", value: "Not signed in", status: "amber", onClickRoute: "settings:account" };
      return { label: "Account", value: a.email || "signed in", secondary: `${a.plan || "free"} · ${a.credits ?? 0} credits`, status: "green", onClickRoute: "settings:account" };
    }
    case "overlay":
      return { label: "Overlay", value: state.hotkey?.current || "Alt+Space", status: "green", onClickRoute: "wizard:hotkey" };
    case "permissions": {
      if (state.platform !== "darwin") return null;
      const p = state.permissions || {};
      const keys = ["accessibility", "screen", "microphone", "location"];
      const granted = keys.filter((k) => p[k] === "granted").length;
      const status = granted === 4 ? "green" : granted === 0 ? "amber" : "amber";
      return { label: "Permissions", value: `${granted} of 4 granted`, status, onClickRoute: "wizard:permissions" };
    }
    case "google":
      return state.google?.connected
        ? { label: "Google", value: state.google.email, secondary: "Calendar + Gmail", status: "green", onClickRoute: "settings:google" }
        : { label: "Google", value: "Not connected", status: "neutral", onClickRoute: "settings:google" };
    case "channels": {
      const c = state.channels || {};
      const n = Object.values(c).filter((v) => v?.connected).length;
      return { label: "Channels", value: n ? `${n} connected` : "+ Add channel", status: n ? "green" : "neutral", onClickRoute: "channels" };
    }
    case "voice":
      return state.voice?.name
        ? { label: "Voice", value: state.voice.name, secondary: state.voice.backend, status: "green", onClickRoute: "settings:voice" }
        : { label: "Voice", value: "Decide later", status: "neutral", onClickRoute: "settings:voice" };
    case "theme":
      return { label: "Theme", value: state.theme || "system", status: "green", onClickRoute: "settings:theme" };
    case "wakeWord":
      return state.wakeWord?.enabled
        ? { label: "Wake word", value: state.wakeWord.phrase || "Hey Atlas", status: "green", onClickRoute: "settings:wake" }
        : { label: "Wake word", value: "Off", status: "neutral", onClickRoute: "settings:wake" };
    default:
      return null;
  }
}

export const TILE_ORDER = ["account", "overlay", "permissions", "google", "channels", "voice", "theme", "wakeWord"];
```

`desktop/ready-hub.html` is authored here but its body comes from the shared partial written in Task D5 (`ready-hub-body.js`):

```html
<!-- desktop/ready-hub.html -->
<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>A.T.L.A.S — Ready</title>
  <link rel="stylesheet" href="styles.css" />
  <link rel="stylesheet" href="components/components.css" />
</head><body class="theme-dark">
  <div id="hub-root"></div>
  <script type="module" src="components/tile-model.js"></script>
  <script type="module" src="components/status-tile.js"></script>
  <script type="module" src="components/try-this.js"></script>
  <script type="module" src="components/ready-hub-body.js"></script>
  <script type="module">
    import { renderHubBody, mountHub } from "./components/ready-hub-body.js";
    const state = await window.atlas.setupDetect();
    document.getElementById("hub-root").innerHTML = renderHubBody(state);
    mountHub(document.getElementById("hub-root"), state);
  </script>
</body></html>
```

**Manual checklist D1:** open hub, 8 tiles render; all 8 tile `label`/`value`/`secondary`/border-color values match `tileModel(state, name)` output for current state.

### Task D2 — Live tile updates

`mountHub` subscribes to `window.atlas.onAccountStatusChange` (exists) and starts a 3s `setInterval` that re-calls `setupDetect()`. Diffs are computed via pure `diffTiles(prev, next)`.

**TDD** — `desktop/components/__tests__/diff-tiles.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTiles } from "../diff-tiles.js";

test("no changes returns empty list", () => {
  const s = { permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" }, platform: "darwin" };
  assert.deepEqual(diffTiles(s, s), []);
});

test("permissions amber→green is detected", () => {
  const prev = { platform: "darwin", permissions: { accessibility: "granted", screen: "denied", microphone: "granted", location: "granted" } };
  const next = { platform: "darwin", permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" } };
  assert.deepEqual(diffTiles(prev, next), ["permissions"]);
});

test("channel add triggers channels tile", () => {
  const prev = { platform: "darwin", channels: {} };
  const next = { platform: "darwin", channels: { telegram: { connected: true } } };
  assert.ok(diffTiles(prev, next).includes("channels"));
});
```

`desktop/components/diff-tiles.js`:

```js
import { tileModel, TILE_ORDER } from "./tile-model.js";

export function diffTiles(prev, next) {
  const changed = [];
  for (const name of TILE_ORDER) {
    const a = tileModel(prev, name);
    const b = tileModel(next, name);
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(name);
  }
  return changed;
}
```

In `ready-hub-body.js#mountHub`, on each 3s tick:

```js
const prev = this.state;
const next = await window.atlas.setupDetect();
for (const name of diffTiles(prev, next)) {
  const el = root.querySelector(`[data-tile="${name}"]`);
  if (el) {
    el.classList.remove("pulse-green");
    void el.offsetWidth; // reflow so animation restarts
    el.classList.add("pulse-green");
    setTimeout(() => el.classList.remove("pulse-green"), 350);
  }
}
this.state = next;
re_render_tile_grid(root, next);
```

**Manual checklist D2:** grant Screen Recording in System Settings while hub is open; within ~3s the Permissions tile flips green and pulses once. Window loses focus → interval pauses (`document.visibilityState` gate).

### Task D3 — "Try this" rotating strip

**TDD** — `desktop/components/__tests__/pick-prompts.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPrompts, CATALOG } from "../try-this.js";

test("google connected + no channels → calendar/email prompts", () => {
  const s = { google: { connected: true }, channels: {} };
  const got = pickPrompts(s, CATALOG, 42);
  assert.equal(got.length, 3);
  assert.ok(got.some((p) => /meeting|email|calendar/i.test(p)));
});

test("channels connected → messaging prompts included", () => {
  const s = { google: { connected: false }, channels: { telegram: { connected: true } } };
  const got = pickPrompts(s, CATALOG, 1);
  assert.ok(got.some((p) => /text|message|send/i.test(p)));
});

test("nothing connected → overlay-only prompts", () => {
  const s = { google: { connected: false }, channels: {} };
  const got = pickPrompts(s, CATALOG, 7);
  assert.equal(got.length, 3);
  assert.ok(got.every((p) => typeof p === "string" && p.length > 0));
});

test("same seed → same prompts (deterministic)", () => {
  const s = { google: { connected: true }, channels: {} };
  assert.deepEqual(pickPrompts(s, CATALOG, 99), pickPrompts(s, CATALOG, 99));
});
```

`desktop/components/try-this.js`:

```js
export const CATALOG = {
  overlay: ["What's the weather?", "Open Figma and make a new file", "Summarize this page", "Start a 25-minute focus timer"],
  google: ["Summarize today's meetings", "Find emails from Sarah this week", "What's on my calendar tomorrow?", "Draft a reply to the latest email"],
  messaging: ["Text Alex that I'm running late", "Send Mom a weather forecast", "Reply to the most recent Telegram message"],
};

// Mulberry32 PRNG — deterministic for unit tests.
function rng(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) | 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

export function pickPrompts(state, catalog, seed) {
  const pool = [...catalog.overlay];
  if (state.google?.connected) pool.push(...catalog.google);
  if (Object.values(state.channels || {}).some((c) => c?.connected)) pool.push(...catalog.messaging);
  const rand = rng(seed);
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  return shuffled.slice(0, 3);
}

export function mountTryThis(el, state) {
  let seed = Date.now() & 0xffff;
  const render = () => {
    const prompts = pickPrompts(state, CATALOG, seed++);
    el.classList.add("fade-out");
    setTimeout(() => { el.innerHTML = prompts.map((p) => `<button class="prompt-pill">${p}</button>`).join(""); el.classList.remove("fade-out"); }, 250);
  };
  render();
  return setInterval(render, 6000);
}
```

**Manual checklist D3:** open hub, three pills appear; every 6s they cross-fade to three new prompts; with Google connected they include calendar/email examples.

### Task D4 — Talk / Type buttons wire-up

`desktop/preload.js` — add the overlay show bridge (the `ipcMain` handler already exists at `desktop/main.js:1263`):

```js
// append inside contextBridge.exposeInMainWorld("atlas", { ... })
showOverlay: () => ipcRenderer.send("overlay:show"),
triggerLiveVoice: () => ipcRenderer.invoke("live-voice:trigger"),
```

`desktop/main.js` — add a handler (the existing `getLiveVoiceHotkey` fetches the combo; we add a trigger that simulates a press by calling the same function the global shortcut registers):

```js
ipcMain.handle("live-voice:trigger", () => {
  if (typeof startLiveVoiceSession === "function") {
    try { startLiveVoiceSession(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: "live-voice not available" };
});
```

In `ready-hub-body.js#mountHub` wire the two buttons:

```js
root.querySelector("[data-action=talk]").addEventListener("click", async () => {
  const r = await window.atlas.triggerLiveVoice();
  if (!r.ok) showToast(`Couldn't start voice: ${r.error}`);
});
root.querySelector("[data-action=type]").addEventListener("click", () => window.atlas.showOverlay());
```

**Manual checklist D4:** click Talk → live voice session starts (mic indicator appears); click Type → overlay window shows and focuses its input.

### Task D5 — Panel tab integration

Extract hub body into a shared module so `ready-hub.html` and `panel.html` render identical markup. Prefer inline injection over `<iframe>` (avoids focus/IPC and theming pitfalls).

`desktop/components/ready-hub-body.js`:

```js
import { tileModel, TILE_ORDER } from "./tile-model.js";
import { diffTiles } from "./diff-tiles.js";
import { mountTryThis } from "./try-this.js";

export function renderHubBody(state) {
  const name = state.profile?.name || "there";
  const hotkey = state.hotkey?.current || "Alt+Space";
  const tiles = TILE_ORDER.map((n) => tileModel(state, n)).filter(Boolean);
  const done = tiles.filter((t) => t.status === "green").length;
  return `
    <div class="hub">
      <section class="hub-hero">
        <div class="orb-avatar breathing"></div>
        <h1 class="greet">Hey ${escapeHtml(name)} 👋</h1>
        <p class="sub">Press <kbd>${escapeHtml(hotkey)}</kbd> anytime, or jump in below.</p>
        <div class="hero-actions">
          <button class="btn-primary" data-action="talk">🎙 Talk to A.T.L.A.S</button>
          <button class="btn-primary outline" data-action="type">⌨️ Type a message</button>
        </div>
      </section>
      <section class="hub-status">
        <header class="status-head"><span class="status-label">YOUR SETUP</span><span class="status-count">${done} of ${tiles.length} complete</span></header>
        <div class="tile-grid">
          ${tiles.map((t) => `
            <button data-tile="${t.label.toLowerCase().replace(/\s+/g, "")}" data-route="${t.onClickRoute}" class="status-tile tile-${t.status}">
              <div class="tile-label">${escapeHtml(t.label)}</div>
              <div class="tile-value">${escapeHtml(t.value || "")}</div>
              ${t.secondary ? `<div class="tile-secondary">${escapeHtml(t.secondary)}</div>` : ""}
            </button>`).join("")}
        </div>
      </section>
      <section class="hub-try-this"><h3>Try this</h3><div class="try-this-strip"></div></section>
    </div>`;
}

export function mountHub(root, initialState) {
  let state = initialState;
  const tryEl = root.querySelector(".try-this-strip");
  const tryTimer = mountTryThis(tryEl, state);
  root.querySelectorAll(".status-tile").forEach((el) => {
    el.addEventListener("click", () => routeTile(el.dataset.route));
  });
  root.querySelector("[data-action=talk]").addEventListener("click", () => window.atlas.triggerLiveVoice());
  root.querySelector("[data-action=type]").addEventListener("click", () => window.atlas.showOverlay());
  const poll = async () => {
    if (document.visibilityState !== "visible") return;
    const next = await window.atlas.setupDetect();
    for (const name of diffTiles(state, next)) pulse(root.querySelector(`[data-tile="${name}"]`));
    state = next;
    const fresh = renderHubBody(next);
    const newGrid = new DOMParser().parseFromString(fresh, "text/html").querySelector(".tile-grid");
    root.querySelector(".tile-grid").replaceWith(newGrid);
    newGrid.querySelectorAll(".status-tile").forEach((el) => el.addEventListener("click", () => routeTile(el.dataset.route)));
  };
  const pollTimer = setInterval(poll, 3000);
  window.atlas.onAccountStatusChange?.(poll);
  return () => { clearInterval(tryTimer); clearInterval(pollTimer); };
}

function pulse(el) { if (!el) return; el.classList.remove("pulse-green"); void el.offsetWidth; el.classList.add("pulse-green"); setTimeout(() => el.classList.remove("pulse-green"), 350); }
function routeTile(route) {
  if (route === "channels") return window.location.assign("channels.html");
  if (route.startsWith("wizard:")) return window.location.assign(`wizard.html#${route.slice(7)}`);
  if (route.startsWith("settings:")) return document.dispatchEvent(new CustomEvent("panel:navigate", { detail: route.slice(9) }));
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
```

**TDD** — `desktop/components/__tests__/render-hub-body.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHubBody } from "../ready-hub-body.js";
const s = { platform: "darwin", profile: { name: "Ava" }, hotkey: { current: "Alt+Space" }, account: { signedIn: true, email: "a@b.co", plan: "pro", credits: 5 }, permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" }, theme: "dark", google: { connected: false }, channels: {}, voice: {}, wakeWord: { enabled: false } };
test("greets by name", () => assert.match(renderHubBody(s), /Hey Ava/));
test("mentions the hotkey", () => assert.match(renderHubBody(s), /Alt\+Space/));
test("shows X of Y complete counter", () => assert.match(renderHubBody(s), /\d+ of \d+ complete/));
test("escapes HTML in profile name", () => assert.match(renderHubBody({ ...s, profile: { name: "<img>" } }), /&lt;img&gt;/));
```

`desktop/panel.html` — inject a new tab. Locate the tab-bar `<nav>` and tab-pane container, then:

```html
<!-- in the tab nav -->
<button class="tab-btn" data-tab="setup">Setup</button>

<!-- new pane at the end of the tab-pane container -->
<section class="tab-pane" data-pane="setup">
  <div id="panel-hub-root"></div>
</section>
```

Add a boot snippet near the other panel imports:

```html
<script type="module">
  import { renderHubBody, mountHub } from "./components/ready-hub-body.js";
  document.querySelector('[data-tab="setup"]').addEventListener("click", async () => {
    const el = document.getElementById("panel-hub-root");
    if (el.dataset.mounted) return;
    const s = await window.atlas.setupDetect();
    el.innerHTML = renderHubBody(s);
    mountHub(el, s);
    el.dataset.mounted = "1";
  });
  document.addEventListener("panel:navigate", (e) => activatePane(e.detail));
</script>
```

**Manual checklist D5:** open panel, click Setup tab — identical UI to end-of-wizard hub; clicking any tile dispatches `panel:navigate` and the target pane activates.

### Task D6 — Channel picker sub-flow

New `desktop/channels.html`. 6-cell grid of `channel-card` components (Phase B). Cells expand inline on click.

```html
<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>Channels — A.T.L.A.S</title>
  <link rel="stylesheet" href="styles.css" />
  <link rel="stylesheet" href="components/components.css" />
</head><body class="theme-dark">
  <header class="page-head"><a href="ready-hub.html" class="back">← Back</a><h1>Channels</h1></header>
  <main class="channels-grid" id="channels-grid"></main>
  <script type="module" src="components/channel-card.js"></script>
  <script type="module">
    import { ChannelCard } from "./components/channel-card.js";
    const state = await window.atlas.setupDetect();
    const grid = document.getElementById("channels-grid");
    for (const type of ["telegram", "discord", "slack", "whatsapp", "matrix", "email"]) {
      const card = new ChannelCard({ type, connected: !!state.channels?.[type]?.connected, detail: state.channels?.[type] });
      grid.appendChild(card.el);
    }
  </script>
</body></html>
```

Test-before-save gate is enforced in `ChannelCard` (Phase B). For this phase, confirm it holds:

**Manual checklist D6:** with `data/.env.runtime` open in another tab, enter a deliberately bad Telegram token → Test fails → `.env.runtime` unchanged. Enter a real test token → Test passes → `.env.runtime` now contains `TELEGRAM_BOT_TOKEN=...` (encrypted). Tile flips green on the hub within 3s.

### Task D7 — Motion polish (styles additions)

Append to `desktop/styles.css`:

```css
/* Breathing orb avatar */
@keyframes breathe { 0% { transform: scale(1); } 50% { transform: scale(1.04); } 100% { transform: scale(1); } }
.orb-avatar.breathing { width: 72px; height: 72px; border-radius: 50%; background: radial-gradient(circle at 30% 30%, #a855f7, #ec4899 70%); animation: breathe 3s ease-in-out infinite; margin: 0 auto 16px; box-shadow: 0 12px 48px rgba(168, 85, 247, 0.35); }

/* Orb position shift per wizard step */
.wizard-step[data-step="1"] .orb-bg { transform: translate(-6%, -4%); }
.wizard-step[data-step="2"] .orb-bg { transform: translate(4%, -6%); }
.wizard-step[data-step="3"] .orb-bg { transform: translate(6%, 2%); }
.wizard-step[data-step="4"] .orb-bg { transform: translate(-4%, 4%); }
.wizard-step[data-step="5"] .orb-bg { transform: translate(-6%, 6%); }
.wizard-step[data-step="6"] .orb-bg { transform: translate(0, 0); }
.orb-bg { transition: transform 600ms cubic-bezier(0.33, 1, 0.68, 1); }

/* Status tile border-pulse */
@keyframes borderPulseGreen { 0% { border-color: currentColor; } 50% { border-color: #10b981; box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.15); } 100% { border-color: currentColor; } }
.status-tile.pulse-green { animation: borderPulseGreen 300ms ease-out; }

/* Tile status border colors */
.status-tile { border-left: 3px solid transparent; transition: border-color 200ms; }
.tile-green  { border-left-color: #10b981; }
.tile-amber  { border-left-color: #f59e0b; }
.tile-neutral { border-left-color: #3f3f46; }

/* Live theme switch */
body, .panel, .hub { transition: background-color 200ms, color 200ms; }
.theme-switching * { transition: background-color 200ms, color 200ms, border-color 200ms; }

/* Try-this cross-fade */
.try-this-strip { transition: opacity 250ms; }
.try-this-strip.fade-out { opacity: 0; }
```

Also remove the `#acronym-wall` section from `desktop/wizard.html`'s old Step 5 (wall of LRU/HNSW/…) — content relocates to Task D8.

**Manual checklist D7:** visually eyeball: orb breathes smoothly on hub; wizard orb shifts between steps; amber→green tile transition single-pulses; theme toggle recolors live with no flash.

### Task D8 — "About Atlas → Under the hood" Settings page

Create `desktop/pages/under-the-hood.html` with the retired acronym content:

```html
<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>Under the hood — A.T.L.A.S</title>
  <link rel="stylesheet" href="../styles.css" />
</head><body class="theme-dark">
  <header class="page-head"><a href="../panel.html" class="back">← Settings</a><h1>Under the hood</h1><p class="sub">For the curious. None of this matters for using Atlas.</p></header>
  <main class="uth">
    <article><h3>LRU <span>— Least-Recently-Used cache</span></h3><p>Tool results and LLM responses are kept in memory keyed by semantic similarity. The least-recently-used entries are evicted when the cache fills.</p></article>
    <article><h3>HNSW <span>— Hierarchical Navigable Small-World graph</span></h3><p>A graph-based nearest-neighbor index used for fast semantic memory recall.</p></article>
    <article><h3>RRF <span>— Reciprocal Rank Fusion</span></h3><p>Blends BM25 keyword and vector similarity rankings into one ordering without tuning weights.</p></article>
    <article><h3>SAN <span>— Surprise-Aware Novelty gate</span></h3><p>Only memories whose content surprises the current world model get consolidated, keeping the store from bloating on routine data.</p></article>
    <article><h3>ATS <span>— Adaptive Tool Selection</span></h3><p>Embeds each tool category and picks top-K by cosine similarity, so the agent only sees relevant tools per turn.</p></article>
    <article><h3>ESM <span>— Episodic Session Memory</span></h3><p>Rolling per-session episodes feed into nightly consolidation for long-term recall.</p></article>
    <article><h3>HMC <span>— Hopfield Memory Cortex</span></h3><p>Associative recall: a partial cue retrieves the full memory pattern.</p></article>
    <article><h3>SHP <span>— Self-Healing Pipeline</span></h3><p>Errors trigger retry → rephrase → reroute → skip automatically, with per-agent escalation.</p></article>
    <article><h3>SAC-DR <span>— Soft Actor-Critic, Discounted Reward</span></h3><p>Action policy trained from stepwise reward to balance quick wins and long-term task success.</p></article>
  </main>
</body></html>
```

Link in `desktop/panel.html` Settings sidebar/menu:

```html
<a class="menu-item" href="pages/under-the-hood.html">About → Under the hood</a>
```

**Manual checklist D8:** navigate via Settings → About → Under the hood, confirm all nine acronyms render with correct expansions.

### Task D9 — Type scale retune

In `desktop/styles.css` replace the old type scale:

```css
/* was: .section-title { font-size: 32px } */
.section-title    { font-size: 24px; line-height: 1.25; font-weight: 600; }
.section-subtitle { font-size: 16px; line-height: 1.4; color: #a1a1aa; }
body, .hub, .panel, .wizard-step { font-size: 13px; line-height: 1.5; }
.hub .greet { font-size: 24px; font-weight: 600; }
.hub .sub   { font-size: 16px; color: #a1a1aa; }
.hub .tile-label     { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #71717a; }
.hub .tile-value     { font-size: 14px; font-weight: 500; }
.hub .tile-secondary { font-size: 12px; color: #a1a1aa; }
```

**Manual checklist D9:** visual regression pass — every wizard step + hub. Any clipped labels or overflowing buttons get a spacing fix in the same commit. Check at 1280×800 and 1920×1080.

### Task D10 — Rollout / migration (v1 → v2)

New file `desktop/migration/v2-setup.js`. Runs once at app boot, before the wizard gate.

**TDD** — `desktop/migration/__tests__/v2-setup.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateLegacySetup } from "../v2-setup.js";

test("adds setup-version: 2", () => {
  const out = migrateLegacySetup({ hotkey: "Alt+Space", theme: "dark" });
  assert.equal(out["setup-version"], 2);
});

test("preserves age and gender fields from legacy profile", () => {
  const legacy = { profile: { name: "Ava", age: 30, gender: "f", tone: "friendly" } };
  const out = migrateLegacySetup(legacy);
  assert.equal(out.profile.age, 30);
  assert.equal(out.profile.gender, "f");
  assert.equal(out.profile.tone, "friendly");
});

test("is idempotent on already-v2 prefs", () => {
  const v2 = { "setup-version": 2, profile: { name: "A" } };
  assert.deepEqual(migrateLegacySetup(v2), v2);
});

test("creates empty channels object when missing", () => {
  const out = migrateLegacySetup({});
  assert.deepEqual(out.channels, {});
});
```

Implementation:

```js
// desktop/migration/v2-setup.js
import fs from "node:fs";
import path from "node:path";

export function migrateLegacySetup(prefs) {
  if (prefs && prefs["setup-version"] === 2) return prefs;
  const out = { ...(prefs || {}) };
  out["setup-version"] = 2;
  out.profile = { ...(out.profile || {}) };
  out.channels = out.channels || {};
  out.permissions = out.permissions || { accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown" };
  return out;
}

export async function runMigrationIfNeeded({ userDataDir, setupFlagPath, loadEnvDecrypted, log }) {
  if (!fs.existsSync(setupFlagPath)) return { ran: false, reason: "no-setup-flag" };
  const prefsPath = path.join(userDataDir, "prefs.json");
  const statePath = path.join(userDataDir, "setup-state.json");
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")); } catch {}
  if (prefs["setup-version"] === 2) return { ran: false, reason: "already-v2" };
  const next = migrateLegacySetup(prefs);
  try { loadEnvDecrypted(); } catch (e) { log?.(`env decrypt warn: ${e.message}`); }
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ phases: { dataDir: "done", workspace: "done", seedFlag: "done", node: "done", playwright: "done", embedding: "done" }, completedAt: new Date().toISOString() }, null, 2));
  }
  fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2));
  log?.("migrated v1 → v2 setup prefs");
  return { ran: true };
}
```

Wire into `desktop/main.js` before the `SETUP_FLAG` branch at `:3601`:

```js
const { runMigrationIfNeeded } = require("./migration/v2-setup.js");
await runMigrationIfNeeded({ userDataDir: app.getPath("userData"), setupFlagPath: SETUP_FLAG, loadEnvDecrypted, log: (m) => console.log("[migrate]", m) });
```

**Manual checklist D10:** copy a v1 install's `.env` + `SETUP_FLAG` to a clean machine, launch — no wizard appears; open panel Setup tab; all tiles reflect the real migrated state; `prefs.json` now shows `"setup-version": 2`.

### Task D11 — Sensitive-value redaction

Add `redactSecrets` to `desktop/installer/runner.js` (from Phase C). Pipe every log line through it before it reaches the log stream.

**TDD** — `desktop/installer/__tests__/redact.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../runner.js";

test("redacts Telegram bot token", () => {
  assert.equal(redactSecrets("TELEGRAM_BOT_TOKEN=1234567:ABCDEF-ghijk_lmnop-qrstuv"), "TELEGRAM_BOT_TOKEN=***");
  assert.equal(redactSecrets("Bearer bot8888888:AAAAAAAAAAAAAAAAAAAA"), "Bearer bot***");
});

test("redacts Discord bot token", () => {
  assert.equal(redactSecrets("DISCORD_BOT_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCDEF.GHIJKLMNOPQRSTUVWXYZ"), "DISCORD_BOT_TOKEN=***");
});

test("redacts IMAP/SMTP password fields", () => {
  assert.equal(redactSecrets("EMAIL_PASSWORD=abc123!@#"), "EMAIL_PASSWORD=***");
  assert.equal(redactSecrets("password: hunter2"), "password: ***");
});

test("redacts Matrix access token", () => {
  assert.equal(redactSecrets("MATRIX_ACCESS_TOKEN=syt_dXNlcg_AbCdEfGh"), "MATRIX_ACCESS_TOKEN=***");
});

test("leaves non-secret lines untouched", () => {
  assert.equal(redactSecrets("Installing dependencies..."), "Installing dependencies...");
});
```

Implementation — add to top of `desktop/installer/runner.js`:

```js
const SECRET_PATTERNS = [
  { re: /\b(?:bot)?\d{6,12}:[A-Za-z0-9_-]{20,}/g, repl: "bot***" },
  { re: /(TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|MATRIX_ACCESS_TOKEN|EMAIL_PASSWORD|IMAP_PASSWORD|SMTP_PASSWORD|SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|HF_TOKEN)\s*=\s*\S+/g, repl: "$1=***" },
  { re: /(password|passwd)\s*[:=]\s*\S+/gi, repl: "$1: ***" },
  { re: /\bM[A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, repl: "***" },
  { re: /\bsyt_[A-Za-z0-9_-]+\b/g, repl: "***" },
];
export function redactSecrets(line) { let out = String(line); for (const { re, repl } of SECRET_PATTERNS) out = out.replace(re, repl); return out; }
```

Route all `log(...)` / `stdout`/`stderr` pipes through `redactSecrets` before emitting the IPC event to `install-log` component.

**Manual checklist D11:** kick off a fresh install with a real Telegram token in an env seed — open the install log view, grep the visible output, no raw token substring appears; the `.env.runtime` itself still contains the real value.

### Task D12 — End-to-end acceptance gate

Execute and record the five scenarios. This is the task that closes Phase D.

**E2E-1 — Fresh Mac clone, happy path under 2 min.**
1. On a clean macOS user (no userData dir, no `.env`): launch app, start a stopwatch.
2. Sign in with OTPless or SMS OTP.
3. Continue through every remaining wizard step accepting defaults (Profile name pre-filled from OS, Personalize untouched, Permissions click Grant-all or Skip).
4. Install phase auto-runs only the minimal phases.
5. Land on Ready Hub. Stopwatch ≤ 120s from app launch to hub visible.

**E2E-2 — Reconfigure from Settings → Setup.**
1. Open panel, click Setup tab.
2. Click the Overlay tile → hotkey picker opens pre-filled with current combo.
3. Change to `Ctrl+Alt+A`, save.
4. Close app, relaunch: hub now shows `Ctrl+Alt+A` on the Overlay tile and in the greeting subtitle.

**E2E-3 — Partial install + kill-resume.**
1. Start fresh install; during the Playwright Chromium phase kill the app process (`pkill -9 Electron`).
2. Relaunch: wizard reopens directly on the Install step with completed phases grayed and Playwright still pending.
3. Click Resume: install completes without restarting the cached phases.

**E2E-4 — About → Under the hood page.**
1. Panel → Settings → About → Under the hood.
2. Page renders, all 9 acronyms visible (LRU, HNSW, RRF, SAN, ATS, ESM, HMC, SHP, SAC-DR).
3. No console errors.

**E2E-5 — Windows VM full pass.**
1. On Windows 11 VM clone, clean install: launch app.
2. Wizard hides the macOS Permissions step; hotkey defaults to `Ctrl+Space`.
3. Install skips Swift OCR and CoreLocation phases.
4. Hub renders without a Permissions tile; all other tiles present and correctly colored.
5. Talk/Type buttons work; live voice hotkey fires.

Commit after each task with the conventional message:

```bash
git commit -m "feat(setup): D1 ready-hub shell + tile model with tests" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
# ... one commit per task D1–D12
```

## Acceptance

- [ ] E2E-1: fresh Mac clone reaches Ready Hub under 2 minutes.
- [ ] E2E-2: Settings → Setup reconfigure flow persists hotkey change across restart.
- [ ] E2E-3: mid-install kill and resume completes without re-running finished phases.
- [ ] E2E-4: About → Under the hood renders all 9 acronyms.
- [ ] E2E-5: Windows VM full pass — no permissions step, `Ctrl+Space` default, macOS-only install phases skipped.

---

## Phase E — Plan Corrections & Cross-Phase Glue

Self-review surfaced cross-phase drift between the four fragments (detection path, component API, IPC naming, test dirs, SystemState fields). This phase canonicalizes conventions and patches the gaps. **Read before starting Phase A.** Every rule here overrides conflicting text earlier in the plan.

### E1 — Canonical conventions (apply across all phases)

**File paths (canonical):**
- Detection code lives in `desktop/detection/` (a directory). `signals.js` + `index.js` as Phase A specifies. Any plan text referring to `desktop/detection.js` as a single file is wrong — always `require("./detection")` or `require("./detection/index.js")`.
- All tests live under `desktop/tests/**/*.test.js`. Any step that creates a test under `desktop/__tests__/` or `desktop/<subdir>/__tests__/` — relocate to `desktop/tests/<subdir>/<name>.test.js` instead. Phase A's `vitest.config.js` stays the single source of truth; add `include: ["tests/**/*.test.js"]` and nothing else.
- Single test runner: **vitest** across all phases. Any step in Phase D that imports `from "node:test"` or runs `node --test …` — rewrite to `import { describe, it, expect } from "vitest"` and put the file under `desktop/tests/`.

**Component API (canonical):**

Every renderer component exports a class constructor on `window.SetupComponents.<PascalCaseName>` and follows this contract:

```js
// Phase B component authoring pattern — all 7 components follow this
(function () {
  class StatusTile {
    constructor(props) { this.props = props; this.el = null; }
    mount(container) { /* build DOM, append to container */ }
    unmount() { /* detach listeners, clear polls */ }
  }
  window.SetupComponents = window.SetupComponents || {};
  window.SetupComponents.StatusTile = StatusTile;
})();
```

Phase C step modules consume them identically:

```js
// Phase C step authoring pattern — consistent consumption
const { StatusTile, HotkeyPicker, ThemeSwitch, VoicePicker,
        PermissionsGrid, ChannelCard, InstallLog } = window.SetupComponents;
const picker = new HotkeyPicker({ current: state.hotkey.current });
picker.mount(document.getElementById("hotkey-slot"));
```

Any Phase C/D text using `C.hotkeyPicker.mount(el, props)` or `C.foo?.mount(...)` fallback guards is wrong. Delete the fallback guards; fail loudly if a component is missing. Any Phase D text using ES-module `import { ChannelCard } from "..."` — replace with `const { ChannelCard } = window.SetupComponents`.

**IPC naming (canonical — match the spec Section 10 exactly):**

Exposed on `window.atlas.*` via `contextBridge` in `desktop/preload.js`. Every IPC used by renderer code in any phase must exist in this table. If a phase registers an `ipcMain.handle("setup:foo", ...)` without adding the matching `window.atlas.setupFoo` in preload.js, that step is incomplete and must also add the preload line.

| `window.atlas.*` | `ipcMain.handle` channel | Added by task | Consumed by |
|---|---|---|---|
| `setupDetect()` | `setup:detect` | A3 | C2 boot, D2 live-refresh |
| `setupPollPermissions()` | `setup:poll-permissions` | A4 | B2 grid polling |
| `setupRequestPermission(name)` | `setup:request-permission` | B2 | B2 grid Grant button |
| `setupRecordHotkey()` | `setup:record-hotkey` | B3 | B3 hotkey-picker Record button |
| `setupTestHotkey(combo)` | `setup:test-hotkey` | B3 | B3 hotkey-picker after record |
| `setupSaveHotkey(combo)` | `setup:save-hotkey` | B3 | B3, C6 personalize |
| `setupListVoices(backend)` | `setup:list-voices` | B4 | B4 voice-picker |
| `setupPreviewVoice(backend, name)` | `setup:preview-voice` | B4 | B4 voice-picker Preview |
| `setupTestChannel(type, creds)` | `setup:test-channel` | B6 | B6 channel-card Test |
| `setupSaveChannel(type, creds, testId)` | `setup:save-channel` | B6 | B6 after successful test |
| `setupSavePersonalize(config)` | `setup:save-personalize` | C6 | C6 Personalize step |
| `setupRetryInstallPhase(phaseId)` | `setup:retry-install-phase` | C10 | B7 install-log Retry, C11 |
| `setupResumeInstall()` | `setup:resume-install` | C10 | C11 Resume button |
| `setupSlackOAuthStart()` | `setup:slack-oauth-start` | B6 | B6 Slack "Install to workspace" |
| `setupSlackOAuthComplete(code, state)` | `setup:slack-oauth-complete` | E4 (this phase) | B6 popup callback |

If any phase exposes an alias name (`listVoices`, `previewVoice`, `retryInstallPhase`, `resumeInstall`, `savePersonalize`) — **rename to the `setupFoo` form**. Do not ship aliases.

### E2 — SystemState shape (canonical)

Phase A2's `runDetection` orchestrator returns exactly this shape. Every consumer in B/C/D reads from these keys only. If a key is not listed here, it is not part of SystemState — find another way to get it.

```js
{
  platform: 'darwin' | 'win32' | 'linux',
  isReconfigure: boolean,
  version: { current: string, previous?: string },
  osUserName: string,
  envPresent: boolean,
  account: { signedIn: boolean, email?: string, plan?: string, credits?: number },
  profile: { name?: string, tone?: string },
  personalize: { hotkey: string, theme: 'light'|'dark'|'system', voice: { backend, name }, wakeWord: { enabled: boolean, phrase: string } },
  permissions: { accessibility, screen, microphone, location }, // each 'granted' | 'denied' | 'unknown'
  installed: { node: boolean, playwright: boolean, embeddingModel: boolean, sox: boolean },
  google: { connected: boolean, email?: string },
  channels: { telegram?, discord?, slack?, whatsapp?, matrix?, email? }, // each present only if configured
  hotkey: { current: string, conflicts: string[] },
  theme: 'light' | 'dark',
  workspace: { path: string, exists: boolean }
}
```

**Phase A addendum — add these signal probes:**

- `detectOsUserName(os)` returns `os.userInfo().username` — added to `desktop/detection/signals.js`; `runDetection` sets `osUserName` at top level.
- `detectPersonalize(prefs)` returns `{hotkey, theme, voice, wakeWord}` reading from `prefs.personalize` with defaults `{hotkey:'Alt+Space', theme:'system', voice:{backend:'gemini-live', name:'Aoede'}, wakeWord:{enabled:false, phrase:'Hey Atlas'}}`. On Windows, default hotkey becomes `'Ctrl+Space'`. `runDetection` sets `personalize` at top level.
- `runDetection` also copies `personalize.voice` to top-level `voice` and `personalize.wakeWord` to top-level `wakeWord` for D1 `tileModel` convenience.

Add matching vitest tests under `desktop/tests/detection/signals.test.js`.

### E3 — Missing spec requirements (add these tasks)

**E3a — Hotkey conflict banner in Personalize step (spec §6 Screen 4):** In C6 Personalize step, after mounting `HotkeyPicker`, read `state.hotkey.conflicts`. If non-empty, render a red banner `"{combo} conflicts with {first-conflict}. Pick a different combo to continue."` above the hotkey card, disable the step's Continue button until the user picks a combo whose `setupTestHotkey` returns `{ok: true}`. TDD the pure `continueEnabled(state, pendingHotkey)` function in `desktop/tests/wizard/continue-gate.test.js`.

**E3b — Per-permission "Skip this" button (spec §6 Screen 5):** In B2 `permissions-grid.js`, each permission card gets a `Skip this` link next to Grant. Clicking it calls a new IPC `setup:mark-permission-skipped(name)` that writes `prefs.skippedPermissions = [...]`. The card collapses to a one-line `⚠️ {name} skipped — some features disabled`. The Ready Hub's Permissions tile counts skipped as amber (not green). TDD `isPermissionEffectivelyOk(status, skipped) → bool` and the amber logic in `tileModel` update.

**E3c — Slack OAuth completion (spec §8):** B6 ships only the launcher. Add this task to complete the loop.

- Register a custom protocol handler `atlas-setup://` in `main.js` at boot using `app.setAsDefaultProtocolClient("atlas-setup")`. On macOS, handle via `app.on("open-url", ...)`. On Windows, handle via the `second-instance` event.
- Slack app redirect URI: `atlas-setup://slack/oauth-callback`.
- New handler `setup:slack-oauth-complete` receives `{code, state}`, exchanges via `POST https://slack.com/api/oauth.v2.access` with `client_id` + `client_secret` + `code`, writes the returned `access_token` and `team` to `data/slack-installs/<team_id>.json`, triggers a `setup:detect` re-run so the Channels tile reflects the new install.
- `client_secret` ships in the bundled encrypted env (same mechanism as Google credentials) — not a user-facing field.
- Manual checklist: install to a real Slack workspace, redirect back, verify file written, Channels tile goes green.

### E4 — Known deferrals (acknowledged; not blocking)

Document these openly so consumers don't think they're bugs:

- **Voice preview uses a single `desktop/assets/voices/sample.wav` for all voices.** Per-voice real samples are a followup. Works end-to-end; just sounds the same regardless of selection. Do not hide this — show a small italic footnote in the voice-picker: `*Samples are placeholder; your selection saves correctly.*`
- **Discord test endpoint divergence** — plan hits `/users/@me`; spec suggests `gateway/bot`. Both work for verifying a token. Stick with `/users/@me` (simpler response). Update the spec on the next edit cycle.

### E5 — Pre-flight checklist before starting implementation

Before Task A0 runs, confirm the executor has:

- [ ] Read this Phase E end-to-end.
- [ ] Updated every Phase C/D component-consumption line to `const { Name } = window.SetupComponents; new Name(props).mount(container)`.
- [ ] Updated every renamed IPC to its canonical `setupFoo` form per the E1 table.
- [ ] Relocated all `__tests__/` references to `desktop/tests/<subdir>/`.
- [ ] Picked vitest as the only test runner (no `node:test`, no `node --test`).
- [ ] Confirmed the SystemState shape in E2 is what A2 returns, and every D-phase `state.<field>` read is a key that appears there.
- [ ] Queued tasks E3a / E3b / E3c to run in their respective phases (C6, B2, B6+main).

If any of these is unclear after reading the plan, stop and flag it — the issue is in the plan, not the executor.
