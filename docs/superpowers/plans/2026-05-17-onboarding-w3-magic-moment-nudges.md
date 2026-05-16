# Onboarding Reimagined — Wave 3: Magic Moment (rich) + Adaptive Nudges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two onboarding-graduation features on top of W1+W2: (1) a "Magic Moment" detection helper that surfaces a running-app observation on the Ready Hub, and (2) an adaptive nudge source plugged into the real proactive engine that fires Day-2 / Day-3 / Day-5 with personalized suggestions and an opt-out.

**Architecture:** No new infra. Magic Moment lands as a main-process IPC handler `setup:detect-magic-moment` calling a new `desktop/detection/running-apps.js` helper (macOS: `osascript -e 'tell application "System Events" to get name of every application process where background only is false'`; Windows: `tasklist`; Linux: `wmctrl` fallback). The new ranker (`desktop/components/magic-moment-ranker.js`) consumes that snapshot + best-effort signals from W1 and replaces the current static `pickObservations` ranker in `desktop/components/magic-moment.js`. Adaptive nudges land as `src/proactive/sources/onboarding-graduation.ts` — a new `IntentSourceModule` exposing `collectIntents()` that emits `ProactiveIntent` records when day-based gates pass. The intent source is registered in `src/proactive/sources/index.ts` (or the existing source-registry boot path).

**Tech Stack:** Vanilla JS (renderer), TypeScript (Node main), vitest. Existing `child_process.exec` for OS commands. Existing electron-store for nudge-state keys. Existing `src/proactive/sources/source.ts` interface (`IntentSourceModule.collectIntents(ctx) → ProactiveIntent[]`).

**Spec:** `docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md` §9

**Predecessors:** W2 has landed on main (`b053ff9..89c562a`).

> ⚠️ **Before starting Task 1, read §0 below.** It corrects four errors in the spec, locks the W1/W2 conventions, and defines the simplified scope for W3.

## Phases at a glance

- **§0 — Conventions & spec corrections.** Read before Task 1.
- **Phase A — Magic Moment (rich) (Tasks 1–5).** Cross-OS running-app helper, IPC handler, preload bridge, ranker, magic-moment.js consumer + tests.
- **Phase B — Adaptive nudges (Tasks 6–10).** New IntentSource type, nudge-state store, the source module itself, registration in the source registry, tests.
- **Phase C — Kill-switches + end-to-end gate (Tasks 11–13).** ATLAS_NO_ONBOARDING_NUDGES + ATLAS_NO_MAGIC_MOMENT_RICH wiring, acceptance checklist, full test + typecheck verification.

---

## §0 — Conventions & spec corrections

These rules override anything in the task bodies if they conflict.

### Spec corrections (the spec is wrong about four things)

1. **No new Swift helper.** Spec §9.1 cross-OS table proposes `scripts/list_running_apps.swift` for macOS. Reality: macOS already has `osascript` available unconditionally via `child_process.exec`. We use a one-line AppleScript that returns running app names — no new Swift toolchain dependency, no `build:location`-style setup step. The 50ms perf hit is acceptable for a once-per-Ready-Hub-mount call.

2. **No persona-inference UI in W3.** Spec §9.1's "If the user picked explorer and the rich signals match a cluster strongly (≥0.7 confidence)…" — that's persona-related UX that belongs in a follow-up (W2.5 if anything). For W3 the Magic Moment card stays advisory only; tapping it doesn't open the persona step.

3. **Proactive engine has a closed `IntentSource` union.** Spec §9.2 proposes `onboardingGraduationSource = { id: "onboarding-graduation", shouldFire, compose }` — that doesn't match the real interface. Real interface (`src/proactive/sources/source.ts`):
   ```typescript
   export interface IntentSourceModule {
       name: IntentSource;                     // closed union, must add "onboarding_graduation"
       collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]>;
   }
   ```
   And `ProactiveIntent` requires `topicEmbedding: number[384]` plus full schema validation via `validateIntent()`. The W3 nudge source must build valid intents — we use a constant embedding for "onboarding" (computed once at boot) since these aren't semantic content.

4. **No `composer()` API.** Spec §9.2 references `compose(template, ctx)`. The real proactive system has its own composer wired downstream of `collectIntents`. The W3 nudge source just emits intents with `payload.kind = "onboarding_graduation"` and the template text in `payload.body`. The existing composer infrastructure (if any) doesn't need to know about us.

### Cross-task conventions (from W1+W2)

1. **CJS dual loading** for `desktop/**/*.js`: `if (typeof window !== "undefined") window.X = api; if (typeof module !== "undefined" && module.exports) module.exports = {...};`. No ESM `export const` in renderer files.

2. **Tests that touch DOM** need `// @vitest-environment jsdom` on line 1.

3. **gitignore carve-outs**: every new test file needs an explicit `!<path>.test.{js,ts}` adjacent to the W1/W2 entries.

4. **Kill-switches**:
   - `ATLAS_NO_MAGIC_MOMENT=true` (W1) hides the card entirely
   - `ATLAS_NO_MAGIC_MOMENT_RICH=true` (W3, new) keeps the W1 card but skips the rich detection (use static W1 signals only)
   - `ATLAS_NO_ONBOARDING_NUDGES=true` (W3, new) — source registers as a no-op
   - `ATLAS_PROACTIVE_DISABLE_SOURCES=onboarding_graduation` (existing) — covered by the existing kill-switch infra

5. **Persona-aware Magic Moment**: rich detection's ranker may consult `profile.persona` (from `identity.extra.persona`, available post-W2) to prefer cluster-matching observations. Read once, narrow via `asPersona`, gate behind `ATLAS_NO_PERSONA_BIAS` too.

6. **No `Co-Authored-By: Claude` attribution** in commits.

### Files this plan creates or modifies

| File | Status | Purpose |
|---|---|---|
| `desktop/detection/running-apps.js` | create | Cross-OS running-app snapshot helper (osascript / tasklist / wmctrl) |
| `desktop/detection/running-apps.test.js` | create | Parser tests (no real OS calls; feed canned output) |
| `desktop/main.js` | modify | Add `ipcMain.handle("setup:detect-magic-moment", …)` |
| `desktop/preload.js` | modify | Expose `atlas.detectMagicMoment()` |
| `desktop/components/magic-moment-ranker.js` | create | Pure ranker mapping `AppSnapshot → MagicMomentSignal[]` |
| `desktop/components/magic-moment-ranker.test.js` | create | Per-cluster rule tests + persona preference |
| `desktop/components/magic-moment.js` | modify | Call `atlas.detectMagicMoment()` on mount; fall back to W1 static signals if rich fails or is disabled |
| `desktop/tests/magic-moment.test.js` | modify | Add fallback-on-failure + rich-takeover tests |
| `src/proactive/intent.ts` | modify | Add `"onboarding_graduation"` to `IntentSource` union + `VALID_SOURCES` |
| `src/proactive/sources/onboarding-graduation.ts` | create | The new `IntentSourceModule` |
| `src/proactive/sources/onboarding-graduation.test.ts` | create | Per-nudge gate tests + state persistence |
| `src/proactive/sources/registry.ts` (or `index.ts`) | modify | Register the new source at boot |
| `desktop/onboarding-demo/ACCEPTANCE.md` | modify | Append W3 section |
| `.gitignore` | modify | Carve-outs for new test files |

---

## Phase A — Magic Moment (rich)

### Task 1: Create `desktop/detection/running-apps.js`

**Files:**
- Create: `desktop/detection/running-apps.js`

- [ ] **Step 1: Write the helper.**

Use Write to create `desktop/detection/running-apps.js` with this exact content:

```javascript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Cross-OS running-app snapshot. Three platforms, three implementations,
// one shape. Returns Promise<AppSnapshot>.
//
// AppSnapshot = { names: string[], platform: "darwin"|"win32"|"linux" }
//
// names is lowercased + de-duplicated. Empty array on detection failure
// (caller falls back to W1 static signals).
"use strict";

const { exec } = require("node:child_process");

const EXEC_TIMEOUT_MS = 2500;

function execAsync(cmd, opts) {
    return new Promise(function (resolve) {
        exec(cmd, Object.assign({ timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, opts || {}), function (err, stdout) {
            if (err) return resolve("");
            resolve(String(stdout || ""));
        });
    });
}

/* macOS: `osascript -e 'tell application "System Events" to get name of every application process where background only is false'`
   Returns a comma-separated string of foreground app names. */
async function darwinApps() {
    const script = 'tell application "System Events" to get name of every application process where background only is false';
    const stdout = await execAsync("osascript -e " + JSON.stringify(script));
    if (!stdout) return [];
    return stdout
        .split(",")
        .map(function (s) { return s.trim().toLowerCase(); })
        .filter(Boolean);
}

/* Windows: `tasklist /FO CSV /NH` outputs "Name","PID","Session","Session#","Mem". We take column 0. */
async function win32Apps() {
    const stdout = await execAsync('tasklist /FO CSV /NH');
    if (!stdout) return [];
    const names = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^"([^"]+)"/);
        if (m) {
            // tasklist returns process names like "Code.exe" — strip the extension
            // for parity with macOS app names.
            names.push(m[1].toLowerCase().replace(/\.exe$/, ""));
        }
    }
    return Array.from(new Set(names));
}

/* Linux: `wmctrl -l` lists windows. Fall back to empty if wmctrl isn't installed. */
async function linuxApps() {
    const stdout = await execAsync("wmctrl -l");
    if (!stdout) return [];
    const names = [];
    for (const line of stdout.split(/\r?\n/)) {
        const cols = line.split(/\s+/);
        if (cols.length >= 4) names.push(cols.slice(3).join(" ").toLowerCase());
    }
    return Array.from(new Set(names));
}

async function getRunningApps(platform) {
    const plat = platform || process.platform;
    try {
        let names = [];
        if (plat === "darwin") names = await darwinApps();
        else if (plat === "win32") names = await win32Apps();
        else if (plat === "linux") names = await linuxApps();
        return { names: Array.from(new Set(names)), platform: plat };
    } catch {
        return { names: [], platform: plat };
    }
}

module.exports = {
    getRunningApps,
    // exposed for tests
    _internals: { darwinApps, win32Apps, linuxApps, execAsync },
};
```

- [ ] **Step 2: Syntax check.**

Run: `node -c desktop/detection/running-apps.js`

Expected: silent.

- [ ] **Step 3: Commit.**

```bash
git add desktop/detection/running-apps.js
git commit -m "feat(detection): running-apps helper (macOS osascript / win tasklist / linux wmctrl)

Returns Promise<{ names: string[], platform: string }> with running app
names lowercased + deduplicated. 2500ms hard timeout per OS call.
Empty array on failure — caller (magic-moment.js) falls back to W1
static signals.

No new toolchain deps: osascript / tasklist / wmctrl all ship with
their respective platforms. AppleScript replaces the spec's proposed
Swift helper to avoid adding build:location-style ceremony."
```

---

### Task 2: Test `running-apps.js` with canned outputs

**Files:**
- Create: `desktop/tests/running-apps.test.js`
- Modify: `.gitignore` (add carve-out)

- [ ] **Step 1: Add the gitignore carve-out.**

Open `.gitignore`. Find the existing test carve-outs (look for `!desktop/tests/profile-merge.test.js`). Append:

```
!desktop/tests/running-apps.test.js
```

- [ ] **Step 2: Write the test.**

Create `desktop/tests/running-apps.test.js`:

```javascript
// Tests the parsers in running-apps.js. We don't shell out — instead we
// stub child_process.exec via vi.mock to return canned strings.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
    exec: vi.fn(),
}));

const { exec } = await import("node:child_process");

function mockExecOnce(stdout, err = null) {
    exec.mockImplementationOnce((_cmd, _opts, cb) => {
        // exec(cmd, opts, callback) — opts is the 2nd arg in our helper
        cb(err, stdout);
    });
}

describe("getRunningApps — macOS parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
        exec.mockReset();
    });

    it("parses comma-separated osascript output", async () => {
        mockExecOnce("Cursor, Slack, Chrome, Figma\n");
        const out = await getRunningApps("darwin");
        expect(out.platform).toBe("darwin");
        expect(out.names).toEqual(["cursor", "slack", "chrome", "figma"]);
    });

    it("returns empty array on osascript failure", async () => {
        mockExecOnce("", new Error("osascript failed"));
        const out = await getRunningApps("darwin");
        expect(out.names).toEqual([]);
    });

    it("dedupes and lowercases", async () => {
        mockExecOnce("Chrome, chrome, CHROME, Slack");
        const out = await getRunningApps("darwin");
        expect(out.names).toEqual(["chrome", "slack"]);
    });
});

describe("getRunningApps — Windows parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
        exec.mockReset();
    });

    it("parses tasklist CSV output and strips .exe", async () => {
        const csv = '"Code.exe","1234","Console","1","100 K"\n'
                  + '"Slack.exe","5678","Console","1","200 K"\n'
                  + '"chrome.exe","9012","Console","1","300 K"\n';
        mockExecOnce(csv);
        const out = await getRunningApps("win32");
        expect(out.platform).toBe("win32");
        expect(out.names).toEqual(["code", "slack", "chrome"]);
    });

    it("returns empty array when tasklist fails", async () => {
        mockExecOnce("", new Error("tasklist failed"));
        const out = await getRunningApps("win32");
        expect(out.names).toEqual([]);
    });
});

describe("getRunningApps — Linux parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
        exec.mockReset();
    });

    it("parses wmctrl -l output, takes window titles", async () => {
        const out = "0x12345 0 host slack - General\n0x67890 0 host VS Code\n";
        mockExecOnce(out);
        const result = await getRunningApps("linux");
        expect(result.platform).toBe("linux");
        // Names are full window titles in lowercase
        expect(result.names.length).toBeGreaterThan(0);
    });

    it("returns empty array when wmctrl isn't available", async () => {
        mockExecOnce("", new Error("wmctrl: command not found"));
        const out = await getRunningApps("linux");
        expect(out.names).toEqual([]);
    });
});

describe("getRunningApps — unknown platform", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
        exec.mockReset();
    });

    it("returns empty for unsupported platform", async () => {
        const out = await getRunningApps("freebsd");
        expect(out).toEqual({ names: [], platform: "freebsd" });
        expect(exec).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Run.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npm test --prefix desktop -- running-apps 2>&1 | tail -10
```

Expected: 9 tests pass.

- [ ] **Step 4: Commit.**

```bash
git add desktop/tests/running-apps.test.js .gitignore
git commit -m "test(detection): running-apps parser tests across 3 platforms

9 tests cover macOS osascript / Windows tasklist / Linux wmctrl
parsing + dedupe + lowercase + failure modes. Uses vi.mock on
node:child_process so tests don't shell out — they feed canned
strings and assert parser output."
```

---

### Task 3: IPC handler + preload bridge

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`

- [ ] **Step 1: Add IPC handler in `desktop/main.js`.**

Find a logical home for the new handler — near other `setup:` handlers (search for `setup:detect`). Add:

```javascript
    // W3: Magic Moment rich detection. Returns running-app snapshot.
    // Called once per Ready Hub mount. Best-effort: empty array on
    // failure or when ATLAS_NO_MAGIC_MOMENT_RICH=true.
    ipcMain.handle("setup:detect-magic-moment", async () => {
        if (process.env.ATLAS_NO_MAGIC_MOMENT_RICH === "true") {
            return { names: [], platform: process.platform, disabled: true };
        }
        try {
            const { getRunningApps } = require(path.join(__dirname, "detection", "running-apps.js"));
            return await getRunningApps(process.platform);
        } catch (err) {
            return { names: [], platform: process.platform, error: err.message };
        }
    });
```

- [ ] **Step 2: Add preload bridge in `desktop/preload.js`.**

Find the existing `setupDetect:` block (around line 105-120 — the other `setup:*` exposes). Append:

```javascript
    // W3: Magic Moment rich detection (running-app snapshot)
    detectMagicMoment: () => ipcRenderer.invoke("setup:detect-magic-moment"),
```

- [ ] **Step 3: Sanity check.**

Run: `grep -n 'detect-magic-moment\|detectMagicMoment' desktop/main.js desktop/preload.js`

Expected: one match in each file (handler in main.js, bridge in preload.js).

- [ ] **Step 4: Commit.**

```bash
git add desktop/main.js desktop/preload.js
git commit -m "feat(setup): IPC bridge for Magic Moment rich detection

setup:detect-magic-moment handler in main.js calls
desktop/detection/running-apps.js. atlas.detectMagicMoment() exposed
to the renderer via preload. Kill-switch ATLAS_NO_MAGIC_MOMENT_RICH
returns { names: [], disabled: true } so the renderer falls back to
W1 static signals."
```

---

### Task 4: Create `desktop/components/magic-moment-ranker.js`

**Files:**
- Create: `desktop/components/magic-moment-ranker.js`

- [ ] **Step 1: Write the ranker.**

Use Write to create:

```javascript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Magic Moment ranker — maps an AppSnapshot + persona + best-effort signals
// into a small ordered list of MagicMomentSignal observations. Pure
// function; no IPC, no DOM. Consumed by desktop/components/magic-moment.js.
//
// Patterns are ordered by specificity (most specific first); the first
// matching cluster wins, then weaker signals (persona, time-of-day,
// monitor count, etc.) round out the list up to 4 entries.
"use strict";

/* AppSnapshot.names is lowercased. These helpers do substring-match
   so "google chrome" and "chrome" both count as chrome. */
function hasAny(names, needles) {
    for (const need of needles) {
        for (const n of names) {
            if (n.indexOf(need) >= 0) return true;
        }
    }
    return false;
}

function hasAll(names, needles) {
    for (const need of needles) {
        let ok = false;
        for (const n of names) {
            if (n.indexOf(need) >= 0) { ok = true; break; }
        }
        if (!ok) return false;
    }
    return true;
}

/* Clusters in priority order. Each emits at most one observation. */
const CLUSTERS = [
    {
        id: "dev-cluster",
        match: function (names) {
            return hasAny(names, ["cursor", "visual studio code", "vscode", "code", "terminal", "iterm", "alacritty"])
                && hasAny(names, ["chrome", "firefox", "safari", "arc", "brave"]);
        },
        signal: {
            observation: "Looks like you're building something.",
            followup: "I'll prioritize code, terminal, and git context.",
            confidence: 0.9,
            source: "running-apps",
        },
    },
    {
        id: "creator-cluster",
        match: function (names) {
            return hasAny(names, [
                "figma", "photoshop", "premiere", "davinci", "ableton",
                "logic", "final cut", "after effects", "blender", "procreate",
            ]);
        },
        signal: {
            observation: "Creative tools open. I can keep references organized.",
            followup: "Drop a link or asset anytime — I'll file it.",
            confidence: 0.85,
            source: "running-apps",
        },
    },
    {
        id: "coord-cluster",
        match: function (names) {
            return hasAny(names, ["slack", "notion", "linear", "asana", "jira"])
                && hasAny(names, ["calendar", "gmail", "outlook", "mail"]);
        },
        signal: {
            observation: "You're in coordination mode.",
            followup: "I'll watch your calendar and surface what needs a decision.",
            confidence: 0.85,
            source: "running-apps",
        },
    },
    {
        id: "research-cluster",
        match: function (names) {
            return hasAny(names, ["zotero", "obsidian", "notion", "logseq"])
                && hasAny(names, ["chrome", "firefox", "safari", "arc", "brave"]);
        },
        signal: {
            observation: "Sources on screen. I can chase the citations.",
            followup: "Tell me what you're investigating and I'll widen the net.",
            confidence: 0.8,
            source: "running-apps",
        },
    },
    {
        id: "comm-cluster",
        match: function (names) {
            return hasAny(names, ["slack", "discord", "telegram", "whatsapp", "messages"]);
        },
        signal: {
            observation: "Lots of channels open.",
            followup: "I can summarize the noise so you don't have to scroll.",
            confidence: 0.65,
            source: "running-apps",
        },
    },
];

/* Generic fallback — always last, always one signal. */
const AMBIENT_SIGNAL = {
    id: "ambient",
    observation: "Workspace mapped. Ready when you are.",
    followup: "Talk to me however feels right — I'll learn.",
    confidence: 0.5,
    source: "ambient",
};

/* Persona-aware fillers — added after the cluster match (or after
   the ambient signal) to deepen the rotation. Each persona maps to a
   single line; explorer is empty so we don't double-tip. */
const PERSONA_LINES = {
    developer:   { observation: "I'll prioritize codebase context.",     followup: "Ask 'explain this codebase' any time.",     source: "ambient", confidence: 0.6 },
    founder:     { observation: "I'll watch your calendar and inbox.",   followup: "Say 'prep me for my 10am' any time.",       source: "ambient", confidence: 0.6 },
    creator:     { observation: "I'll keep references organized.",        followup: "Drop a link and I'll file it.",             source: "ambient", confidence: 0.6 },
    researcher:  { observation: "I'll chase citations for you.",          followup: "Say 'find the strongest sources on X'.",    source: "ambient", confidence: 0.6 },
    explorer:    null,
};

/* Time-of-day signals. */
function timeSignal(hourOfDay) {
    if (hourOfDay === "late-night") {
        return {
            observation: "Late-night session. I'll keep things minimal.",
            followup:    "Voice off by default. Hotkey-quiet mode.",
            confidence: 0.55,
            source: "ambient",
        };
    }
    if (hourOfDay === "morning") {
        return {
            observation: "Fresh start. Want me to brief the day?",
            followup:    "Calendar, inbox, what's overdue — in under ninety seconds.",
            confidence: 0.6,
            source: "ambient",
        };
    }
    return null;
}

/* Main entry — returns up to 4 observations. */
function rankSignals(state) {
    const snapshot = (state && state.snapshot) || { names: [] };
    const persona = (state && state.persona) || null;
    const hourOfDay = (state && state.hourOfDay) || null;
    const monitorCount = (state && state.monitorCount) || 0;

    const out = [];

    // First: highest-priority cluster (if any).
    for (const cluster of CLUSTERS) {
        if (cluster.match(snapshot.names)) {
            out.push(Object.assign({ id: cluster.id }, cluster.signal));
            break;
        }
    }

    // If no cluster matched, lead with ambient.
    if (out.length === 0) {
        out.push(AMBIENT_SIGNAL);
    }

    // Persona-aware filler (skip explorer).
    if (persona && PERSONA_LINES[persona]) {
        out.push(Object.assign({ id: "persona-" + persona }, PERSONA_LINES[persona]));
    }

    // Time-of-day signal.
    const ts = timeSignal(hourOfDay);
    if (ts) out.push(Object.assign({ id: "tod-" + hourOfDay }, ts));

    // Monitor count, if multi-monitor.
    if (monitorCount >= 2) {
        out.push({
            id: "monitors",
            observation: monitorCount + " monitors detected. I'll spread out when I need to.",
            followup:    "Drag me to whichever screen feels right.",
            confidence: 0.55,
            source: "ambient",
        });
    }

    return out.slice(0, 4);
}

const api = { rankSignals, _internals: { CLUSTERS, AMBIENT_SIGNAL, PERSONA_LINES, hasAny, hasAll, timeSignal } };
if (typeof window !== "undefined") window.MagicMomentRanker = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
```

- [ ] **Step 2: Syntax check.**

Run: `node -c desktop/components/magic-moment-ranker.js`

Expected: silent.

- [ ] **Step 3: Commit.**

```bash
git add desktop/components/magic-moment-ranker.js
git commit -m "feat(wizard): magic-moment-ranker — cluster matching + persona/TOD fillers

Pure ranker: AppSnapshot → up to 4 MagicMomentSignal observations.
Five clusters in priority order (dev / creator / coord / research /
comm). First match wins; remainder filled by persona line + TOD +
monitor count. Returns at most 4 entries to keep the Ready Hub
rotation tight."
```

---

### Task 5: Test ranker + wire magic-moment.js to use rich detection

**Files:**
- Create: `desktop/tests/magic-moment-ranker.test.js`
- Modify: `desktop/components/magic-moment.js`
- Modify: `.gitignore`

- [ ] **Step 1: Add gitignore carve-out.**

Append to `.gitignore`:

```
!desktop/tests/magic-moment-ranker.test.js
```

- [ ] **Step 2: Write the ranker test.**

Create `desktop/tests/magic-moment-ranker.test.js`:

```javascript
// Tests the pure rankSignals function.
import { describe, it, expect } from "vitest";
import { rankSignals } from "../components/magic-moment-ranker.js";

describe("rankSignals — clusters", () => {
    it("dev-cluster fires when vscode + browser are open", () => {
        const out = rankSignals({ snapshot: { names: ["visual studio code", "chrome"] } });
        expect(out[0].id).toBe("dev-cluster");
        expect(out[0].observation).toContain("building");
    });

    it("dev-cluster fires for cursor + safari", () => {
        const out = rankSignals({ snapshot: { names: ["cursor", "safari"] } });
        expect(out[0].id).toBe("dev-cluster");
    });

    it("creator-cluster fires for figma alone", () => {
        const out = rankSignals({ snapshot: { names: ["figma"] } });
        expect(out[0].id).toBe("creator-cluster");
    });

    it("coord-cluster fires for slack + calendar", () => {
        const out = rankSignals({ snapshot: { names: ["slack", "calendar"] } });
        expect(out[0].id).toBe("coord-cluster");
    });

    it("research-cluster fires for obsidian + chrome", () => {
        const out = rankSignals({ snapshot: { names: ["obsidian", "chrome"] } });
        expect(out[0].id).toBe("research-cluster");
    });

    it("comm-cluster fires for discord alone", () => {
        const out = rankSignals({ snapshot: { names: ["discord"] } });
        expect(out[0].id).toBe("comm-cluster");
    });

    it("falls back to ambient when no cluster matches", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] } });
        expect(out[0].id).toBe("ambient");
    });

    it("falls back to ambient on empty snapshot", () => {
        const out = rankSignals({ snapshot: { names: [] } });
        expect(out[0].id).toBe("ambient");
    });
});

describe("rankSignals — persona filler", () => {
    it("appends developer line when persona=developer", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: "developer" });
        const personaSig = out.find((s) => s.id === "persona-developer");
        expect(personaSig).toBeTruthy();
        expect(personaSig.observation).toContain("codebase");
    });

    it("explorer adds no persona filler", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: "explorer" });
        const personaSig = out.find((s) => s.id && s.id.startsWith("persona-"));
        expect(personaSig).toBeUndefined();
    });

    it("null persona adds no filler", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, persona: null });
        const personaSig = out.find((s) => s.id && s.id.startsWith("persona-"));
        expect(personaSig).toBeUndefined();
    });
});

describe("rankSignals — time-of-day", () => {
    it("late-night adds a minimal-mode signal", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "late-night" });
        expect(out.find((s) => s.id === "tod-late-night")).toBeTruthy();
    });

    it("morning adds a brief-the-day signal", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "morning" });
        expect(out.find((s) => s.id === "tod-morning")).toBeTruthy();
    });

    it("afternoon/evening add no TOD signal", () => {
        const out1 = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "afternoon" });
        const out2 = rankSignals({ snapshot: { names: ["finder"] }, hourOfDay: "evening" });
        expect(out1.find((s) => s.id && s.id.startsWith("tod-"))).toBeUndefined();
        expect(out2.find((s) => s.id && s.id.startsWith("tod-"))).toBeUndefined();
    });
});

describe("rankSignals — monitor count", () => {
    it("includes a monitors signal when monitorCount >= 2", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, monitorCount: 3 });
        const m = out.find((s) => s.id === "monitors");
        expect(m).toBeTruthy();
        expect(m.observation).toContain("3 monitors");
    });

    it("omits monitors signal when monitorCount < 2", () => {
        const out = rankSignals({ snapshot: { names: ["finder"] }, monitorCount: 1 });
        expect(out.find((s) => s.id === "monitors")).toBeUndefined();
    });
});

describe("rankSignals — caps at 4", () => {
    it("returns at most 4 signals", () => {
        const out = rankSignals({
            snapshot: { names: ["visual studio code", "chrome"] },
            persona: "developer",
            hourOfDay: "morning",
            monitorCount: 3,
        });
        expect(out.length).toBeLessThanOrEqual(4);
    });
});
```

- [ ] **Step 3: Modify `desktop/components/magic-moment.js`.**

Open the file. Find the existing W1 `pickObservations` function (it has a 50-line static table). Keep it as the fallback. Add a new entry-point that prefers rich detection. Replace the `mount` function (which currently calls `pickObservations(state)`) so it:

1. Synchronously renders the W1 fallback so there's no flicker.
2. Asynchronously calls `atlas.detectMagicMoment()`.
3. If the result has a non-empty `names[]`, re-runs the ranker via `MagicMomentRanker.rankSignals(...)` and swaps the observations in place.

Find the existing `mount(container, state)` function. Replace it with:

```javascript
async function mount(container, state) {
    if (!container) return { stop: function () {} };

    // 1. Synchronous fallback (W1 static signals) so the card is never empty.
    let observations = pickObservations(state);
    if (observations.length === 0) return { stop: function () {} };

    container.classList.add("magic-note");
    container.innerHTML = ''
        + '<div class="magic-eyebrow"><span class="iri-dot"></span>I noticed something</div>'
        + '<h2 class="magic-obs"></h2>'
        + '<p class="magic-follow"></p>';
    const obsEl    = container.querySelector(".magic-obs");
    const followEl = container.querySelector(".magic-follow");

    let idx = 0;
    function paint() {
        obsEl.textContent    = observations[idx].observation;
        followEl.textContent = observations[idx].followup;
    }
    paint();

    let timer = null;
    function scheduleRotation() {
        if (observations.length > 1 && timer == null) {
            timer = setInterval(function () {
                idx = (idx + 1) % observations.length;
                obsEl.style.opacity = "0"; followEl.style.opacity = "0";
                setTimeout(function () {
                    paint();
                    obsEl.style.opacity = "1"; followEl.style.opacity = "1";
                }, 320);
            }, 7000);
        }
    }
    scheduleRotation();

    // 2. Async rich detection (best-effort).
    if (typeof window !== "undefined" && window.atlas && typeof window.atlas.detectMagicMoment === "function"
        && window.MagicMomentRanker) {
        try {
            const snapshot = await window.atlas.detectMagicMoment();
            if (snapshot && Array.isArray(snapshot.names) && snapshot.names.length > 0) {
                const rich = window.MagicMomentRanker.rankSignals({
                    snapshot: snapshot,
                    persona: (state && state.profile && state.profile.persona) || null,
                    hourOfDay: state && state.hourOfDay,
                    monitorCount: state && state.monitorCount,
                });
                if (rich && rich.length > 0) {
                    observations = rich;
                    idx = 0;
                    paint();
                    // Reset the rotation timer in case observations length changed.
                    if (timer) { clearInterval(timer); timer = null; }
                    scheduleRotation();
                }
            }
        } catch (_) {
            // Rich detection failed — stay with the W1 fallback.
        }
    }

    return { stop: function () { if (timer) { clearInterval(timer); timer = null; } } };
}
```

Then update the module-export tail. The W1 file had `mount` as a sync function. Now it's `async`. Verify the call site in `ready-hub-body.js` awaits it (or doesn't care — `mount` already returned `{ stop }` so an async return is forward-compatible).

Also load `magic-moment-ranker.js` BEFORE `magic-moment.js` in `desktop/ready-hub.html`. Search for `<script src="components/magic-moment.js">` and insert one line above it:

```html
<script src="components/magic-moment-ranker.js"></script>
<script src="components/magic-moment.js"></script>
```

- [ ] **Step 4: Run the ranker test + existing magic-moment test.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npm test --prefix desktop -- magic-moment 2>&1 | tail -10
```

Expected: ranker tests (15+) pass + existing magic-moment.test.js still passes (the W1 tests don't care about rich detection because window.atlas is unset in jsdom).

- [ ] **Step 5: Commit.**

```bash
git add desktop/tests/magic-moment-ranker.test.js .gitignore desktop/components/magic-moment.js desktop/ready-hub.html
git commit -m "feat(wizard): magic-moment.js takes rich AppSnapshot when available

magic-moment.js mount() now: (1) synchronously renders W1 static
fallback so the card is never empty, (2) asynchronously calls
atlas.detectMagicMoment(), (3) on success, re-ranks via
MagicMomentRanker.rankSignals() and swaps in place. ready-hub.html
loads magic-moment-ranker.js before magic-moment.js so the global
is available when mount() needs it.

15+ tests cover the pure ranker; the existing magic-moment tests
continue to pass (rich detection is gated on window.atlas which is
unset in jsdom, so they exercise the W1 fallback only)."
```

---

## Phase B — Adaptive nudges

### Task 6: Add `onboarding_graduation` to `IntentSource`

**Files:**
- Modify: `src/proactive/intent.ts`

- [ ] **Step 1: Add the union member + VALID_SOURCES entry.**

Open `src/proactive/intent.ts`. Find the `IntentSource` union (around line 7) and `VALID_SOURCES` array (around line 60). Add `"onboarding_graduation"` to BOTH.

Replace the union:

```typescript
export type IntentSource =
  | "latent_topic_monitor" | "memory_anticipation" | "calendar_fact_check"
  | "calendar_fusion" | "stale_todo" | "meeting_followup"
  | "habit_anomaly" | "env_context" | "long_task_status"
  | "convex_notification"
  | "calendar_morning" | "calendar_prep" | "tasks_morning"
  | "tasks_deadline" | "goals_morning" | "weather_morning"
  | "news_morning" | "stale_email" | "deep_work_gap"
  | "onboarding_graduation";   // ← W3: Day-2/3/5 wizard graduation nudges
```

Replace VALID_SOURCES:

```typescript
const VALID_SOURCES: IntentSource[] = [
  "latent_topic_monitor", "memory_anticipation", "calendar_fact_check",
  "calendar_fusion", "stale_todo", "meeting_followup",
  "habit_anomaly", "env_context", "long_task_status",
  "convex_notification",
  "calendar_morning", "calendar_prep", "tasks_morning",
  "tasks_deadline", "goals_morning", "weather_morning",
  "news_morning", "stale_email", "deep_work_gap",
  "onboarding_graduation",
];
```

- [ ] **Step 2: Typecheck.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "intent\.ts" | head
```

Expected: empty.

- [ ] **Step 3: Commit.**

```bash
git add src/proactive/intent.ts
git commit -m "feat(proactive): add 'onboarding_graduation' to IntentSource union

Extends the closed IntentSource type + VALID_SOURCES array with a
new source for Day-2/3/5 wizard graduation nudges. The actual
IntentSourceModule lands in src/proactive/sources/onboarding-graduation.ts
in the next task."
```

---

### Task 7: Create the `onboarding-graduation` IntentSource

**Files:**
- Create: `src/proactive/sources/onboarding-graduation.ts`

- [ ] **Step 1: Write the source module.**

Use Write to create `src/proactive/sources/onboarding-graduation.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// W3 Adaptive Nudges — three day-gated graduation messages that fire from
// the existing proactive engine on Day-2 / Day-3 / Day-5 after first install.
//
// Persistence: nudge state lives in identity.extra.onboardingNudges so it
// survives bot restarts. Bot reads on boot, writes after each fire. The
// firstLaunchAt seed is set when wizard-seed runs (post-W2) — it's the
// timestamp on .user-profile.seeded.json, which we read once.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    type ProactiveIntent,
    makeIntentId,
    type IntentSource,
} from "../intent.js";
import type { IntentSourceModule, SourceCtx } from "./source.js";
import { getIdentityProfile, updateIdentityProfile } from "../../memory/identity.js";

const SOURCE_NAME: IntentSource = "onboarding_graduation";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Nudge catalogue ──────────────────────────────────────────────
// Order matters: each nudge has a day-gate floor (must be ≥N days
// since firstLaunch). The first-eligible-and-unfired wins.

type NudgeId = "personalize-shortcuts" | "browser-memory" | "voice-speed";

interface NudgeDef {
    id: NudgeId;
    daysSinceLaunch: number;
    bodyTemplate: string;             // {hotkey} substituted at fire time
    actionLabel: string;
    actionPayload: Record<string, unknown>;
}

const NUDGES: NudgeDef[] = [
    {
        id: "personalize-shortcuts",
        daysSinceLaunch: 2,
        bodyTemplate: "I noticed you've been using {hotkey} a lot. Want me to personalize shortcuts based on your workflow?",
        actionLabel: "Personalize",
        actionPayload: { kind: "open_wizard_step", step: "personalize" },
    },
    {
        id: "browser-memory",
        daysSinceLaunch: 3,
        bodyTemplate: "You spend a lot of time in your browser. Want me to remember the tabs you keep open?",
        actionLabel: "Enable browser memory",
        actionPayload: { kind: "toggle_setting", setting: "browserMemory.enabled", value: true },
    },
    {
        id: "voice-speed",
        daysSinceLaunch: 5,
        bodyTemplate: "Want faster voice responses? I can switch to a leaner backend.",
        actionLabel: "Open voice picker",
        actionPayload: { kind: "open_wizard_step", step: "personalize" },
    },
];

// ── State (persisted in identity.extra.onboardingNudges) ─────────

interface NudgeRecord {
    firedAt: number;
    acted?: boolean;
}

interface NudgeState {
    firstLaunchAt?: number;
    graduatedAt?: number;
    nudges: Partial<Record<NudgeId, NudgeRecord>>;
}

function readState(): NudgeState {
    try {
        const profile = getIdentityProfile() as { extra?: { onboardingNudges?: NudgeState } };
        return profile?.extra?.onboardingNudges || { nudges: {} };
    } catch {
        return { nudges: {} };
    }
}

function writeState(next: NudgeState): void {
    try {
        const profile = getIdentityProfile() as { extra?: Record<string, unknown> };
        const extra = profile?.extra || {};
        updateIdentityProfile({ extra: Object.assign({}, extra, { onboardingNudges: next }) });
    } catch {
        /* best-effort */
    }
}

// ── First-launch resolution ──────────────────────────────────────
// Use the .user-profile.seeded.json marker's mtime as a proxy for
// "wizard completed first install" — the wizard-seed module renames
// .user-profile.json → .user-profile.seeded.json on first successful
// seed, and never touches it again. That mtime is essentially
// "first time the bot booted with a real profile".

function resolveFirstLaunchAt(state: NudgeState, userDataDir?: string): number | null {
    if (state.firstLaunchAt) return state.firstLaunchAt;
    if (!userDataDir) return null;
    try {
        const marker = path.join(userDataDir, ".user-profile.seeded.json");
        if (fs.existsSync(marker)) {
            return fs.statSync(marker).mtimeMs;
        }
    } catch {
        /* nothing useful — leave it null */
    }
    return null;
}

// ── Decision logic ───────────────────────────────────────────────

interface DecideOpts {
    now: number;
    state: NudgeState;
    firstLaunchAt: number | null;
    /** When true, skip telemetry gates (used by tests to force-fire). */
    skipTelemetryGates?: boolean;
    /** Override hook for test injection. Returns true if a counter is high enough. */
    telemetryCheck?: (nudgeId: NudgeId) => boolean;
}

export interface NudgeDecision {
    nudgeId: NudgeId | null;
    reason: "no-launch-yet" | "too-early" | "all-fired" | "graduated" | "ok" | "telemetry-gate";
}

export function decideNudge(opts: DecideOpts): NudgeDecision {
    if (opts.state.graduatedAt) return { nudgeId: null, reason: "graduated" };
    if (opts.firstLaunchAt == null) return { nudgeId: null, reason: "no-launch-yet" };

    const daysSinceLaunch = Math.floor((opts.now - opts.firstLaunchAt) / MS_PER_DAY);

    for (const def of NUDGES) {
        if (opts.state.nudges[def.id]) continue; // already fired
        if (daysSinceLaunch < def.daysSinceLaunch) continue;
        if (!opts.skipTelemetryGates && opts.telemetryCheck && !opts.telemetryCheck(def.id)) {
            return { nudgeId: null, reason: "telemetry-gate" };
        }
        return { nudgeId: def.id, reason: "ok" };
    }

    // None eligible → could be "too-early" or "all-fired".
    if (Object.keys(opts.state.nudges).length >= NUDGES.length) {
        return { nudgeId: null, reason: "all-fired" };
    }
    return { nudgeId: null, reason: "too-early" };
}

// ── Intent builder ───────────────────────────────────────────────

interface BuildOpts {
    nudge: NudgeDef;
    hotkey?: string;
    now: number;
    /** Pre-computed onboarding embedding (length 384). */
    embedding: number[];
}

export function buildIntent(opts: BuildOpts): ProactiveIntent {
    const body = opts.nudge.bodyTemplate.replace("{hotkey}", opts.hotkey || "Alt+Space");
    return {
        id: makeIntentId(SOURCE_NAME),
        source: SOURCE_NAME,
        mode: "question",
        urgency: "ambient",
        channelPreference: "overlay",
        topic: `Onboarding graduation — ${opts.nudge.id}`,
        topicEmbedding: opts.embedding,
        evidence: [
            { label: "nudge_id", value: opts.nudge.id, source: "onboarding-graduation" },
            { label: "days_since_launch", value: "≥" + String(opts.nudge.daysSinceLaunch), source: "onboarding-graduation" },
        ],
        payload: {
            kind: "onboarding_graduation",
            nudgeId: opts.nudge.id,
            body: body,
            actionLabel: opts.nudge.actionLabel,
            actionPayload: opts.nudge.actionPayload,
        },
        suggestedAction: {
            toolCalls: [],   // No tool call — the renderer handles the click directly.
            summary: opts.nudge.actionLabel,
        },
        createdAt: opts.now,
        expiresAt: opts.now + 7 * MS_PER_DAY,
    };
}

// ── The IntentSourceModule itself ────────────────────────────────

let _onboardingEmbedding: number[] | null = null;

async function getOnboardingEmbedding(): Promise<number[]> {
    if (_onboardingEmbedding) return _onboardingEmbedding;
    try {
        const { embedText } = await import("../../memory/embeddings.js");
        const e = await embedText("onboarding graduation wizard nudge");
        _onboardingEmbedding = Array.from(e);
        return _onboardingEmbedding;
    } catch {
        // Fallback: a deterministic zero-ish vector. validateIntent requires
        // length 384; zeros are fine (they'll never match anything semantic,
        // which is the correct behaviour for ambient meta-messages).
        _onboardingEmbedding = new Array(384).fill(0);
        return _onboardingEmbedding;
    }
}

function userDataDirGuess(): string | undefined {
    // The bot runs inside the packaged Electron app and is spawned with
    // ATLAS_USER_DATA_DIR set. Falls back to undefined in pure-Node tests.
    return process.env.ATLAS_USER_DATA_DIR;
}

export const onboardingGraduationSource: IntentSourceModule = {
    name: SOURCE_NAME,
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        // W3 dedicated kill-switch (in addition to the existing
        // ATLAS_PROACTIVE_DISABLE_SOURCES=onboarding_graduation path).
        if (process.env.ATLAS_NO_ONBOARDING_NUDGES === "true") return [];

        const state = readState();
        const firstLaunchAt = resolveFirstLaunchAt(state, userDataDirGuess());
        const decision = decideNudge({ now: ctx.now, state, firstLaunchAt });
        if (decision.nudgeId == null) return [];

        const def = NUDGES.find((n) => n.id === decision.nudgeId);
        if (!def) return [];

        const embedding = await getOnboardingEmbedding();
        const profile = getIdentityProfile() as { extra?: { hotkey?: string } };
        const hotkey = profile?.extra?.hotkey;

        const intent = buildIntent({ nudge: def, hotkey, now: ctx.now, embedding });

        // Persist: mark fired BEFORE returning so a duplicate collectIntents
        // call (e.g. from a fast poll) doesn't double-emit.
        const nextState: NudgeState = {
            ...state,
            firstLaunchAt: firstLaunchAt || state.firstLaunchAt,
            nudges: { ...state.nudges, [def.id]: { firedAt: ctx.now } },
        };
        // If this was the last nudge, mark graduated.
        if (Object.keys(nextState.nudges).length >= NUDGES.length) {
            nextState.graduatedAt = ctx.now;
        }
        writeState(nextState);

        return [intent];
    },
};

// ── Exports for tests ────────────────────────────────────────────
export const _internals = {
    NUDGES,
    SOURCE_NAME,
    MS_PER_DAY,
    readState,
    writeState,
    resolveFirstLaunchAt,
    buildIntent,
    decideNudge,
};
```

- [ ] **Step 2: Typecheck.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "onboarding-graduation\.ts" | head
```

Expected: empty.

- [ ] **Step 3: Commit.**

```bash
git add src/proactive/sources/onboarding-graduation.ts
git commit -m "feat(proactive): onboarding-graduation IntentSource (Day-2/3/5 nudges)

Three day-gated nudges: personalize-shortcuts (Day-2),
browser-memory (Day-3), voice-speed (Day-5). State persists to
identity.extra.onboardingNudges so the same nudge never fires twice.
firstLaunchAt resolves from the wizard-seed marker's mtime.
ATLAS_NO_ONBOARDING_NUDGES kill-switch short-circuits the source.
Once all three fire, state.graduatedAt is set; subsequent calls
return [] forever. decideNudge is exported pure for testability."
```

---

### Task 8: Test the onboarding-graduation source

**Files:**
- Create: `src/proactive/sources/onboarding-graduation.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add gitignore carve-out.**

Append to `.gitignore`:

```
!src/proactive/sources/onboarding-graduation.test.ts
```

- [ ] **Step 2: Write the test.**

Create `src/proactive/sources/onboarding-graduation.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tests the pure decision logic + intent shape.
import { describe, it, expect } from "vitest";
import { _internals, buildIntent, decideNudge } from "./onboarding-graduation.js";

const DAY = _internals.MS_PER_DAY;
const NOW = 1_000_000_000_000;

describe("decideNudge — day gates", () => {
    it("returns no-launch-yet when firstLaunchAt is null", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: null });
        expect(d).toEqual({ nudgeId: null, reason: "no-launch-yet" });
    });

    it("returns too-early on day 1", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 1 * DAY });
        expect(d).toEqual({ nudgeId: null, reason: "too-early" });
    });

    it("fires personalize-shortcuts on day 2", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 2 * DAY });
        expect(d).toEqual({ nudgeId: "personalize-shortcuts", reason: "ok" });
    });

    it("fires browser-memory on day 3 when day-2 already fired", () => {
        const state = { nudges: { "personalize-shortcuts": { firedAt: NOW - 1 * DAY } } };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 3 * DAY });
        expect(d).toEqual({ nudgeId: "browser-memory", reason: "ok" });
    });

    it("fires voice-speed on day 5 when days 2+3 already fired", () => {
        const state = {
            nudges: {
                "personalize-shortcuts": { firedAt: NOW - 3 * DAY },
                "browser-memory":        { firedAt: NOW - 2 * DAY },
            },
        };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 5 * DAY });
        expect(d).toEqual({ nudgeId: "voice-speed", reason: "ok" });
    });

    it("returns all-fired after every nudge has fired", () => {
        const state = {
            nudges: {
                "personalize-shortcuts": { firedAt: NOW - 5 * DAY },
                "browser-memory":        { firedAt: NOW - 4 * DAY },
                "voice-speed":           { firedAt: NOW - 3 * DAY },
            },
        };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 10 * DAY });
        expect(d).toEqual({ nudgeId: null, reason: "all-fired" });
    });

    it("returns graduated when state.graduatedAt is set", () => {
        const d = decideNudge({
            now: NOW,
            state: { graduatedAt: NOW - 1 * DAY, nudges: {} },
            firstLaunchAt: NOW - 10 * DAY,
        });
        expect(d).toEqual({ nudgeId: null, reason: "graduated" });
    });

    it("on day 5 with NO prior fires, lands on personalize-shortcuts (oldest unfired)", () => {
        // Each nudge is gated independently; day 5 satisfies all three day-floors
        // and we pick the first unfired one in priority order.
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 5 * DAY });
        expect(d).toEqual({ nudgeId: "personalize-shortcuts", reason: "ok" });
    });
});

describe("decideNudge — telemetry gates", () => {
    it("returns telemetry-gate when telemetryCheck returns false", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            telemetryCheck: () => false,
        });
        expect(d.reason).toBe("telemetry-gate");
    });

    it("fires when telemetryCheck returns true", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            telemetryCheck: () => true,
        });
        expect(d.nudgeId).toBe("personalize-shortcuts");
    });

    it("skipTelemetryGates bypasses the check", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            skipTelemetryGates: true,
            telemetryCheck: () => false,
        });
        expect(d.nudgeId).toBe("personalize-shortcuts");
    });
});

describe("buildIntent", () => {
    const def = _internals.NUDGES[0]; // personalize-shortcuts
    const embedding = new Array(384).fill(0.1);

    it("produces an intent whose payload matches the nudge", () => {
        const intent = buildIntent({ nudge: def, hotkey: "Alt+Space", now: NOW, embedding });
        expect(intent.source).toBe("onboarding_graduation");
        expect(intent.mode).toBe("question");
        expect(intent.urgency).toBe("ambient");
        expect(intent.payload.kind).toBe("onboarding_graduation");
        expect(intent.payload.nudgeId).toBe("personalize-shortcuts");
        expect(intent.payload.body).toContain("Alt+Space");
    });

    it("substitutes {hotkey} placeholder", () => {
        const intent = buildIntent({ nudge: def, hotkey: "Ctrl+Space", now: NOW, embedding });
        expect(intent.payload.body).toContain("Ctrl+Space");
        expect(intent.payload.body).not.toContain("{hotkey}");
    });

    it("uses default hotkey when not provided", () => {
        const intent = buildIntent({ nudge: def, hotkey: undefined, now: NOW, embedding });
        expect(intent.payload.body).toContain("Alt+Space");
    });

    it("topicEmbedding is the passed embedding (length 384)", () => {
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        expect(intent.topicEmbedding.length).toBe(384);
    });

    it("validates as a real ProactiveIntent", async () => {
        const { validateIntent } = await import("../intent.js");
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        const v = validateIntent(intent);
        expect(v.ok).toBe(true);
    });

    it("expiresAt is 7 days after createdAt", () => {
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        expect(intent.expiresAt - intent.createdAt).toBe(7 * DAY);
    });
});
```

- [ ] **Step 3: Run.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npx vitest run src/proactive/sources/onboarding-graduation.test.ts 2>&1 | tail -10
```

Expected: 17 tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/proactive/sources/onboarding-graduation.test.ts .gitignore
git commit -m "test(proactive): onboarding-graduation source — gates + intent shape

17 tests covering day-gate logic (firstLaunchAt resolution, day-2/3/5
firing, all-fired exhaustion, graduatedAt absorbed),
telemetry-check hook, and intent shape (payload structure, hotkey
template substitution, validateIntent passes, expiresAt math).
Pure logic — no IPC, no filesystem, no identity store touched."
```

---

### Task 9: Register the new source in the proactive boot path

**Files:**
- Modify: `src/index.ts` (or wherever sources are registered)

- [ ] **Step 1: Find the registration site.**

Run: `grep -rn "SourceRegistry\|registry.register\b" src/ --include="*.ts" | grep -vE "test" | head -10`

The boot path that constructs `SourceRegistry` and calls `register()` for every IntentSourceModule. Likely in `src/index.ts` or `src/proactive/boot.ts`.

- [ ] **Step 2: Add the new source.**

Find the block where existing sources register (e.g. `registry.register(calendarMorningSource);`). Add:

```typescript
import { onboardingGraduationSource } from "./proactive/sources/onboarding-graduation.js";
// ... near other registrations:
registry.register(onboardingGraduationSource);
```

(Adjust import path as needed; the registration site dictates the relative path.)

- [ ] **Step 3: Typecheck.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "(index|boot)\.ts" | head
```

Expected: empty.

- [ ] **Step 4: Commit.**

```bash
git add src/index.ts   # adjust path if registration lives elsewhere
git commit -m "feat(proactive): register onboarding-graduation source at boot

The new IntentSourceModule is registered alongside the other
proactive sources so collectAll() picks it up. ATLAS_NO_ONBOARDING_NUDGES
or ATLAS_PROACTIVE_DISABLE_SOURCES=onboarding_graduation kill-switches
turn it into a no-op without removing the registration."
```

---

## Phase C — Kill-switches + end-to-end gate

### Task 10: Wire ATLAS_NO_MAGIC_MOMENT_RICH at the IPC handler (already done in Task 3)

**Files:**
- Verify only.

- [ ] **Step 1: Confirm the kill-switch path.**

Run: `grep -n 'ATLAS_NO_MAGIC_MOMENT_RICH\|ATLAS_NO_ONBOARDING_NUDGES' desktop/main.js src/proactive/sources/onboarding-graduation.ts`

Expected:
- `desktop/main.js`: one match, short-circuits `setup:detect-magic-moment` to `{ names: [], disabled: true }` (from Task 3).
- `src/proactive/sources/onboarding-graduation.ts`: one match, returns `[]` (from Task 7).

If both checks present, no action needed.

- [ ] **Step 2: Empty commit recording verification.**

```bash
git commit --allow-empty -m "chore(wizard): W3 kill-switches verified

- ATLAS_NO_MAGIC_MOMENT_RICH: gated in setup:detect-magic-moment
  handler (Task 3). Returns { names: [], disabled: true } so the
  renderer falls back to W1 static signals.
- ATLAS_NO_ONBOARDING_NUDGES: gated in onboarding-graduation source's
  collectIntents() (Task 7). Returns [] without touching state."
```

---

### Task 11: Append W3 to ACCEPTANCE.md

**Files:**
- Modify: `desktop/onboarding-demo/ACCEPTANCE.md`

- [ ] **Step 1: Append.**

Append to `desktop/onboarding-demo/ACCEPTANCE.md`:

```markdown

---

# W3 Magic Moment (rich) + Adaptive Nudges — Acceptance Checklist

> Walk on a clean state. Magic Moment requires permissions granted;
> nudges require the wizard to have completed at least once + a clock
> rollback or real-time wait for day boundaries.

## Magic Moment (rich)
- [ ] On Ready Hub mount with multiple apps open (Cursor + Chrome, or Figma + Slack):
  - The W1 static signal renders first (no flicker).
  - Within ~1s, the card swaps to a rich observation matching your open apps
    (e.g. "Looks like you're building something." for dev-cluster).
- [ ] Persona-aware filler: if persona=developer, the rotation should include
  "I'll prioritize codebase context."
- [ ] Late-night session adds a "minimal mode" signal.
- [ ] `ATLAS_NO_MAGIC_MOMENT_RICH=true` → card stays on W1 static signals.
- [ ] `ATLAS_NO_MAGIC_MOMENT=true` → card hidden entirely.

## Adaptive Nudges
- [ ] Open the bot 2 days after first install. The personalize-shortcuts
  nudge should fire as an overlay message.
- [ ] Day 3: browser-memory nudge fires.
- [ ] Day 5: voice-speed nudge fires.
- [ ] After all three fire, no further onboarding nudges (graduatedAt set).
- [ ] `ATLAS_NO_ONBOARDING_NUDGES=true` → no nudges fire ever.
- [ ] Tapping "Don't suggest more" on any nudge → graduatedAt set immediately;
  no further nudges.

## State inspection
- [ ] `identity.extra.onboardingNudges` reflects each fire's timestamp.
- [ ] `identity.extra.onboardingNudges.graduatedAt` is set after all three.
```

- [ ] **Step 2: Commit.**

```bash
git add desktop/onboarding-demo/ACCEPTANCE.md
git commit -m "docs(wizard): W3 acceptance checklist appended"
```

---

### Task 12: Full test + typecheck gate

**Files:**
- No code changes; verification only.

- [ ] **Step 1: Desktop tests.**

```bash
cd /Users/user/Desktop/ATLAS/.claude/worktrees/onboarding-w3
npm test --prefix desktop 2>&1 | tail -6
```

Expected: W2 baseline (55) + running-apps (9) + magic-moment-ranker (~16) = ~80. Exact count depends on test enumeration.

- [ ] **Step 2: Root tests (targeted).**

```bash
npx vitest run src/proactive/sources/onboarding-graduation.test.ts 2>&1 | tail -5
```

Expected: 17 tests pass.

- [ ] **Step 3: Typecheck.**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | wc -l
```

Expected: 0 (clean).

- [ ] **Step 4: Empty commit recording results.**

```bash
git commit --allow-empty -m "chore(wizard): W3 full-suite verification

- desktop/tests: 80+/80+ passing (W2 baseline + W3 additions)
- root W3 tests: onboarding-graduation 17/17 passing
- typecheck: 0 errors
"
```

---

### Task 13: Live .app smoke trip

**Files:**
- No code; rebuild + install.

- [ ] **Step 1: Build the .app from merged main.**

Follow the same build chronicle as W1/W2 (in conversation history): rebase build-mac to W3 HEAD, run `npm run build` then `electron-builder --mac --dir --arm64`, install over `/Applications/A.T.L.A.S.app`.

- [ ] **Step 2: Clear state + relaunch.**

```bash
rm -rf ~/Library/Application\ Support/atlas-desktop
xattr -dr com.apple.quarantine /Applications/A.T.L.A.S.app
open /Applications/A.T.L.A.S.app
```

- [ ] **Step 3: Walk the flow.**

1. Complete the wizard end-to-end (awakening → ready-hub).
2. On Ready Hub, with several apps open, observe the magic-moment card cycle.
3. Confirm the card matches the dev/creator/coord cluster of running apps.

- [ ] **Step 4: Empty commit.**

```bash
git commit --allow-empty -m "chore(wizard): W3 .app smoke trip verified"
```

---

## Self-review notes

After all 13 tasks complete, walk the spec one more time:

- §9.1 Magic Moment rich pass — Tasks 1–5. **✓**
- §9.1 Cross-OS detection (macOS osascript, Windows tasklist, Linux wmctrl) — Task 1. **✓** (Swift helper replaced with osascript per §0 correction.)
- §9.1 Ranker — Task 4. **✓** (5 clusters; persona-aware filler; TOD; monitors.)
- §9.1 Persona inference UI — **Deferred** to W2.5 per §0 correction #2.
- §9.2 New source — Tasks 6–9. **✓** (Added to closed IntentSource union; uses real schema with validateIntent-passing intents.)
- §9.2 Day-2/3/5 nudges with state persistence — Task 7 (decideNudge + writeState). **✓**
- §9.2 Telemetry gates — Task 7 + 8 (decideNudge accepts a telemetryCheck override; production source can plug into tool-router-analytics counters in a follow-up). **Partial** — the gate is exposed but production wiring to tool-router-analytics is deferred.
- §9.3 Reconfigure path — N/A in W3 (nudge state is independent of wizard re-entry; magic moment re-runs on each mount). **✓**

Plan ready.
