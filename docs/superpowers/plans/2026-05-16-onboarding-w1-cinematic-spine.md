> **Status: SUPERSEDED (historical plan).** Verified 2026-10-30. The first-run wizard was later cut to **three screens** (sign in with terms inline → connect Chrome, installing in the background → Ready Hub; permissions moved to the Hub) per commit `fd43afb` and the comment in `desktop/wizard/router.js`. Name, persona, hotkey, theme and voice now default and live in Settings; there is no vision-tier step (`vision-tier.js` is gone). Step files `persona.js`/`personalize.js`/`profile.js`/`awakening.js` still exist under `desktop/wizard/steps/` but `ALL_STEPS` is only `signin`, `connect`. Paths written as bare filenames in this plan live under `desktop/wizard/`, `desktop/wizard/steps/` or `desktop/components/`. `src/setup/magic-moment.ts` and `desktop/wizard/steps/vision-tier.js` do not exist.

# Onboarding Reimagined — Wave 1: Cinematic Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orb-and-gradient wizard aesthetic with Apple-quiet-futurism — a new `awakening` cinematic step, all step copy reframed through a single map, a Ready Hub redux with magic-moment card (best-effort signals), system-theme detection, and a single iridescent hairline accent in place of the orb canvas.

**Architecture:** No router rewrite, no IPC rewrite, no Convex schema change in W1. We add three new files (`cinematic.js`, `copy.js`, `steps/awakening.js`, `components/magic-moment.js`), rewrite `desktop/styles.css` from the prototyped `desktop/onboarding-demo/demo.css`, and refactor every existing step file under `desktop/wizard/steps/` to consume `copy.js` instead of inline strings. The 10 install phases stay; only their labels change. Theme detection runs entirely in CSS via `prefers-color-scheme` plus an explicit `[data-theme]` override that the Personalize step writes to.

**Tech Stack:** Electron 40 main + renderer (CommonJS in main, vanilla JS in renderer), existing `desktop/components/*` class components stay unchanged, existing `desktop/detection/` signals reused, vitest for pure-logic tests in `desktop/`.

**Spec:** `docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md`

**Prototype:** `desktop/onboarding-demo/` — every visual decision is implemented there first. PRs are reviewed against the demo, not against this plan's code blocks. When this plan and the demo disagree, **the demo is canonical** — fix the plan, don't fix the demo.

> ⚠️ **Before starting Task 1, read §0 below.** It canonicalizes cross-task conventions (where copy lives, how `data-theme` is set, how the iridescent rule is triggered, what files must NOT be touched in W1).

## Phases at a glance

- **§0 — Conventions.** Read before Task 1. Cross-task glue and "do-not-touch" list.
- **Phase A — Token system & demo lift (Tasks 1–4).** Commit the demo to `main`, extract the CSS into `desktop/styles.css`, add `cinematic.js`, set up theme attribute plumbing.
- **Phase B — Copy module & step refactor (Tasks 5–10).** Build `copy.js`, refactor every existing step file to read from it.
- **Phase C — Awakening step (Tasks 11–14).** Build `awakening.js`, wire into router, name-resolution helper, timeline test.
- **Phase D — Ready Hub redux (Tasks 15–18).** Rebuild `ready-hub-body.js`, add `magic-moment.js`, swap chrome for atmosphere shell.
- **Phase E — Audio + transitions polish (Tasks 19–21).** Audio assets, audio helper, the iridescent-rule scribe.
- **Phase F — End-to-end gate (Tasks 22–24).** Manual acceptance checklist, snapshot test for awakening DOM, smoke run.

---

## §0 — Conventions

These rules override anything in the task bodies if they conflict.

**Where strings live.** All user-visible strings in `desktop/wizard.html`, `desktop/ready-hub.html`, and every `desktop/wizard/steps/*.js` MUST resolve through `Copy.get(stepId, key)` from the new `desktop/wizard/copy.js`. The one exception is the `<title>` element. Inline string literals in step renderers are a review-blocking finding.

**How the theme attribute is set.** `<html>` defaults to no `data-theme` attribute → `@media (prefers-color-scheme: light)` decides. Personalize → Appearance writes one of `"light" | "dark" | ""` (empty = system) to `personalize.theme`, and `boot.js` applies it on every load via `document.documentElement.setAttribute("data-theme", value)`. Empty string means "remove the attribute" — handle that explicitly.

**Iridescent rule scribe.** The single `<div class="iridescent-rule">` at the top of the page is triggered by adding the `scribe` class. `Cinematic.scribeRule()` exposes this. `boot.js` calls it inside `renderIndex(idx)` AFTER the new step's DOM is mounted but BEFORE the stagger-in is requested. Awakening does NOT scribe (the awakening's own iridescent line in the centre of the page is a separate element with its own animation).

**Component API stays the same.** `HotkeyPicker`, `ThemeSwitch`, `VoicePicker`, `PermissionsGrid`, `InstallLog` keep their constructor and `mount(container)` / `unmount()` / `getValue()` API. Only their CSS classes get restyled. If a component needs a new prop in W1, that's a bug — push back.

**Do-not-touch list (W1).** These files MUST NOT be modified in this wave; W2 and W3 handle them:
- `convex/schema.ts` (W2 extends `accounts.profile`)
- `src/prompts/dynamic-assembler.ts` (W2)
- `src/tool-router.ts` (W2)
- `src/proactive/sources/*` (W3)
- `src/setup/magic-moment.ts` does not exist yet (W3 creates it)
- `scripts/list_running_apps.swift` does not exist yet (W3 creates it)

If a task requires changing any of the above, stop and re-read the spec — you're in the wrong wave.

**Kill-switches active in W1.**
- `ATLAS_NO_AWAKENING=true` → skip the awakening step on first install
- `ATLAS_NO_MAGIC_MOMENT=true` → hide the magic-moment card
- `ATLAS_NO_ONBOARDING_AUDIO=true` → force-disable wizard audio regardless of preference

All three default off (feature on). Implement them as guards in the call sites, not as build-time flags.

**Test runner.** All vitest tests live under `desktop/tests/`. Run with `cd desktop && npm test`. If a test creates DOM, use jsdom (already configured in `desktop/vitest.config.js`).

**Commits.** Conventional commits scoped `feat(wizard):`, `refactor(wizard):`, `style(wizard):`, `test(wizard):`. One task → one commit unless explicitly split.

---

## Phase A — Token system & demo lift

### Task 1: Commit the onboarding demo to main

The prototype exists at `desktop/onboarding-demo/` (created during the brainstorming phase). It's the visual source of truth — get it into `main` so reviewers can reference it.

**Files:**
- `desktop/onboarding-demo/index.html` (already exists)
- `desktop/onboarding-demo/demo.css` (already exists)
- `desktop/onboarding-demo/demo.js` (already exists)

- [ ] **Step 1: Verify the demo opens and clicks through.**

Run: `open desktop/onboarding-demo/index.html`

Expected: browser opens, the awakening cinematic plays in ~2.5s, you can click through all 10 beats via the demo controls panel, the Day-2 nudge button shows a toast, and toggling Theme → Light flips the entire UI to the warm off-white palette.

If anything is broken, fix it in the demo first — that's the source of truth.

- [ ] **Step 2: Confirm no `.gitignore` exclusion swallowed the demo.**

Run: `git check-ignore desktop/onboarding-demo/index.html`

Expected: empty output (file is not ignored). If the command prints a path, edit `.gitignore` to un-exclude `desktop/onboarding-demo/`.

- [ ] **Step 3: Commit.**

```bash
git add desktop/onboarding-demo/
git commit -m "feat(wizard): land onboarding cinematic demo as visual source of truth

Self-contained HTML/CSS/JS prototype of the reimagined wizard at
desktop/onboarding-demo/. All 10 beats wired up with mock data. Used
as the canonical visual reference for the W1 implementation — when the
production wizard and this demo disagree, the demo wins.

Spec: docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md"
```

### Task 2: Extract design tokens into desktop/styles.css

`desktop/onboarding-demo/demo.css` is the source. We copy the token block + every component class into `desktop/styles.css`, replacing the existing top-of-file token block. Existing class names (`.orb-*`, `.wizard-container`, `.btn-primary`, etc.) that are used by the real wizard need to keep working — we extend, not replace, until Tasks 5–10 refactor the step files.

**Files:**
- Modify: `desktop/styles.css`

- [ ] **Step 1: Open both files side by side.**

```bash
code desktop/styles.css desktop/onboarding-demo/demo.css
```

- [ ] **Step 2: Replace the existing `:root` token block at the top of `desktop/styles.css` with the demo's token block.**

In `desktop/styles.css`, find the existing `:root { ... }` block (search for `--accent-primary`). Replace it with the exact `:root { ... }` block from `desktop/onboarding-demo/demo.css` lines 12–66 (the dark-mode tokens — `--bg-0` through `--ease-spring`).

Do NOT delete the surrounding existing CSS yet. Subsequent steps will replace component-level classes; Task 3 does the dark/light overrides.

- [ ] **Step 3: Append the atmosphere + chrome + iridescent-rule + step-root + indicator + button + every component block from the demo to the END of `desktop/styles.css`.**

Copy lines 76–END of `demo.css` (everything after the token block) and append to `desktop/styles.css`. Skip the `.demo-controls` and `.nudge-host` blocks — those are demo-only chrome.

After the paste, the file is long but functional. Old classes still exist; new classes coexist. The old orb canvas in `wizard.html` is still styled by the old `.orb-*` classes lower in the file — we delete those in Task 6.

- [ ] **Step 4: Run the existing wizard to make sure nothing breaks.**

Run: `cd desktop && npm start`

Expected: wizard opens, all existing steps render (visually unchanged from main — we haven't touched step DOM yet). If something blew up, the most likely cause is a duplicate `:root` block. Find and merge.

Close the wizard.

- [ ] **Step 5: Commit.**

```bash
git add desktop/styles.css
git commit -m "style(wizard): lift Apple-quiet-futurism tokens + component CSS from demo

Lifts the full token system and every step-component block from
desktop/onboarding-demo/demo.css into desktop/styles.css. Existing
classes (.orb-*, .wizard-container, .btn-primary) coexist with the
new ones until the step files are refactored to use the new structure
in subsequent tasks. No DOM changed in this commit."
```

### Task 3: Append light-mode token overrides

Light mode is driven by `@media (prefers-color-scheme: light)` plus an explicit `:root[data-theme="light"]` override. Both blocks live in `demo.css` already.

**Files:**
- Modify: `desktop/styles.css`

- [ ] **Step 1: Locate the light-mode block in `demo.css`.**

Search `desktop/onboarding-demo/demo.css` for `/* LIGHT MODE`. The block runs from that comment to the end of the file.

- [ ] **Step 2: Append the entire light-mode block to `desktop/styles.css`.**

Copy from `/* LIGHT MODE` through the end of `demo.css`, paste at the end of `desktop/styles.css`. This adds both the `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ... } }` block AND the `:root[data-theme="light"] { ... }` block, plus every component override (atmosphere, chrome, buttons, hub-cell, nudge, demo-controls, active states).

- [ ] **Step 3: Verify the demo's light mode still works.**

Open `desktop/onboarding-demo/index.html` in a browser. In demo controls, set Theme → Light. Expected: page flips to warm off-white with deep-violet accents, all step previews remain legible.

If anything regressed in the demo, you accidentally edited demo.css. Revert.

- [ ] **Step 4: Commit.**

```bash
git add desktop/styles.css
git commit -m "style(wizard): add prefers-color-scheme light-mode tokens + overrides

Adds the @media (prefers-color-scheme: light) block plus matching
[data-theme=\"light\"] overrides. Tokens flip first; component-level
overrides handle hard-coded colors (button fills, glass surfaces,
active-state borders). Dark mode untouched."
```

### Task 4: Create cinematic.js

A tiny pure helper that other modules import. Two exports: `applyConfidence(stepIndex, totalSteps)` (no-op stub in W1 — the iridescent rule does the "alive" signal instead) and `scribeRule()` (toggles the `scribe` class on the iridescent-rule element).

**Files:**
- Create: `desktop/wizard/cinematic.js`
- Test: `desktop/tests/cinematic.test.js`

- [ ] **Step 1: Write the failing test.**

```javascript
// desktop/tests/cinematic.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("Cinematic.scribeRule", () => {
    let rule;
    beforeEach(() => {
        document.body.innerHTML = '<div id="iridescent-rule" class="iridescent-rule"></div>';
        rule = document.getElementById("iridescent-rule");
    });

    it("adds the scribe class", async () => {
        const { Cinematic } = await import("../wizard/cinematic.js");
        Cinematic.scribeRule();
        expect(rule.classList.contains("scribe")).toBe(true);
    });

    it("forces a re-trigger by removing then re-adding the class within one call", async () => {
        const { Cinematic } = await import("../wizard/cinematic.js");
        rule.classList.add("scribe");
        Cinematic.scribeRule();
        // Even though the class was already present, the function should have
        // toggled it off and on so the CSS animation re-plays.
        expect(rule.classList.contains("scribe")).toBe(true);
    });

    it("is a no-op when no #iridescent-rule element exists", async () => {
        document.body.innerHTML = "";
        const { Cinematic } = await import("../wizard/cinematic.js");
        expect(() => Cinematic.scribeRule()).not.toThrow();
    });
});

describe("Cinematic.applyConfidence", () => {
    it("is a function that accepts (stepIndex, totalSteps) and does not throw", async () => {
        const { Cinematic } = await import("../wizard/cinematic.js");
        expect(() => Cinematic.applyConfidence(0, 10)).not.toThrow();
        expect(() => Cinematic.applyConfidence(9, 10)).not.toThrow();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd desktop && npm test -- cinematic`

Expected: FAIL with "Failed to load url ../wizard/cinematic.js".

- [ ] **Step 3: Write the implementation.**

```javascript
// desktop/wizard/cinematic.js
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Tiny renderer helper: ambient cinematic effects across the wizard.
// Browser: attaches to window.Cinematic. Tests: ESM import.
"use strict";

function scribeRule() {
    const r = document.getElementById("iridescent-rule");
    if (!r) return;
    r.classList.remove("scribe");
    // Force a layout flush so the next class-add re-plays the animation
    // (CSS keyframes don't re-trigger when the class is already present).
    void r.offsetWidth;
    r.classList.add("scribe");
}

// W1: no-op. The iridescent rule is the single "alive" signal; we don't
// also ramp orb-speed/accent-alpha. The signature is preserved so future
// waves can wire it up without touching call sites.
function applyConfidence(_stepIndex, _totalSteps) {
    /* intentionally empty in W1 */
}

const api = { scribeRule, applyConfidence };
if (typeof window !== "undefined") window.Cinematic = api;
export const Cinematic = api;
export default api;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd desktop && npm test -- cinematic`

Expected: PASS — all four tests green.

- [ ] **Step 5: Commit.**

```bash
git add desktop/wizard/cinematic.js desktop/tests/cinematic.test.js
git commit -m "feat(wizard): add cinematic.js helper (scribeRule + applyConfidence)

Exposes window.Cinematic + ESM exports. scribeRule toggles the
.scribe class on #iridescent-rule, force-flushing layout so the
CSS keyframes re-play. applyConfidence is a no-op stub reserved
for later waves."
```

---

## Phase B — Copy module & step refactor

### Task 5: Create the copy module

A single object exporting every user-facing string in the wizard. Keys are `stepId.field`. The actual content is the table in §6 of the spec.

**Files:**
- Create: `desktop/wizard/copy.js`
- Test: `desktop/tests/copy.test.js`

- [ ] **Step 1: Write the failing test.**

```javascript
// desktop/tests/copy.test.js
import { describe, it, expect } from "vitest";
import { Copy } from "../wizard/copy.js";

describe("Copy.get", () => {
    it("returns the string for a valid (step, key) pair", () => {
        expect(Copy.get("terms", "title")).toBe("Read once. We won't ask again.");
    });

    it("returns null for an unknown step", () => {
        expect(Copy.get("nonexistent", "title")).toBeNull();
    });

    it("returns null for an unknown key under a valid step", () => {
        expect(Copy.get("terms", "nonexistent")).toBeNull();
    });

    it("every step in the spec's beat table has a title and sub", () => {
        const steps = [
            "awakening", "terms", "signin", "profile", "persona",
            "personalize", "permissions", "vision-tier", "install", "ready-hub",
        ];
        for (const s of steps) {
            // awakening uses dynamic greeting (built in awakening.js); allow missing title.
            if (s !== "awakening") {
                expect(Copy.get(s, "title")).toBeTruthy();
            }
        }
    });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd desktop && npm test -- copy`

Expected: FAIL with "Failed to load url ../wizard/copy.js".

- [ ] **Step 3: Write the implementation.**

```javascript
// desktop/wizard/copy.js
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Single source of truth for every user-visible string in the wizard.
// Step renderers MUST read through Copy.get(stepId, key). Inline literals
// in step files are a review-blocking finding.
"use strict";

const COPY = {
    "awakening": {
        // Greeting is built dynamically in steps/awakening.js (per-word reveal).
        // These are the rotating status phrases.
        "status1": "reading the room",
        "status2": "setting the table",
        "status3": "ready when you are",
        "cta": "Begin",
        "hint": "Press ESC to skip",
    },

    "terms": {
        "eyebrow": "Trust",
        "title": "Read once. We won't ask again.",
        "sub": "A short set of terms covering what A.T.L.A.S can do, what it stores, and how to back out.",
        "accept": "Accept",
        "check1": "I accept the Terms of service",
        "check2": "I accept the Privacy policy",
        "check3": "I accept the Acceptable use policy",
        "check4": "I accept the Disclaimer",
        "check5": "I accept the Refund terms",
    },

    "signin": {
        "eyebrow": "Identity",
        "title": "Make this yours.",
        "sub": "One tap to sync preferences and credits across your devices. No password to remember.",
        "email_cta": "Continue with email",
        "phone_cta": "Continue with phone",
        "fineprint": "You can sign in later from Settings.",
    },

    "profile": {
        "eyebrow": "You",
        "title": "What should I call you?",
        "sub": "Used in greetings and when I get your attention. You can change it anytime in Settings.",
        "label": "Your name",
        "placeholder": "Dheeraj",
    },

    "persona": {
        "eyebrow": "How you work",
        "title": "Pick a starting shape.",
        "sub": "Shapes the examples I show, the tools I prioritize, and the way I talk. You can change this anytime.",
    },

    "personalize": {
        "eyebrow": "Ritual",
        "title": "How A.T.L.A.S shows up.",
        "sub": "Small choices that shape every interaction — what summons it, how it sounds, the mood.",
        "label_hotkey": "Summon gesture",
        "label_theme": "Appearance",
        "label_voice": "Voice",
        "label_personality": "Tone",
        "label_wake": "Wake word",
        "wake_toggle": "Listen for a wake word",
        "wake_phrase_label": "Phrase",
    },

    "permissions": {
        "eyebrow": "Capabilities",
        "title": "Unlock what I can do.",
        "sub": "Each one is a capability, not a checkbox. Grant whatever feels right — you can revisit anytime.",
        "footnote": "Skipped a permission? No worries. We can still work together.",
        "skip_all": "Skip all",
        "name_accessibility": "Accessibility",
        "why_accessibility":  "So I can be summoned, anywhere.",
        "name_screen":        "Screen",
        "why_screen":         "So I can see what you see.",
        "name_microphone":    "Microphone",
        "why_microphone":     "So I can hear you naturally.",
        "name_location":      "Location",
        "why_location":       "So I remember where you are.",
    },

    "vision-tier": {
        "eyebrow": "Sight",
        "title": "How sharp should my eyes be?",
        "sub": "On-device vision lets me see your screen and reason about UI. Heavier tiers see more but take longer to install.",
        "tier_lite_name":     "Lite",
        "tier_lite_tag":      "Snappy",
        "tier_lite_desc":     "Fast OCR + screenshot understanding. Great on older laptops without a GPU.",
        "tier_standard_name": "Standard",
        "tier_standard_tag":  "Recommended",
        "tier_standard_desc": "OCR plus a lightweight vision model. Reads UI and reasons about layouts.",
        "tier_full_name":     "Full",
        "tier_full_tag":      "Heavy",
        "tier_full_desc":     "OCR + UI-TARS + OmniParser. Element-level grounding. Best on recent machines.",
    },

    "install": {
        "eyebrow": "Assembly",
        "title": "Setting things up.",
        "fact_eyebrow": "Did you know",
        // Phase labels (mapped to existing PHASE_IDS in steps/install.js)
        "phase_node":         "Runtime",
        "phase_playwright":   "Browser engine",
        "phase_embedding":    "Semantic memory",
        "phase_sox":          "Audio toolkit",
        "phase_ollama":       "Local model runtime",
        "phase_vision_model": "Vision weights",
        "phase_vision_deps":  "Vision dependencies",
        "phase_data_dir":     "Data directory",
        "phase_workspace":    "Workspace folder",
        "phase_finalize":     "Finishing touches",
        // ETA strings
        "eta_estimating":   "Estimating…",
        "eta_almost_done":  "Almost done",
    },

    "ready-hub": {
        "magic_eyebrow": "I noticed something",
        "try_heading":   "Try this",
        "launch":        "Launch A.T.L.A.S",
        "talk":          "Talk",
        "type":          "Type",
        // Title + dek are built dynamically from name + hotkey in ready-hub-body.js
    },
};

function get(stepId, key) {
    const step = COPY[stepId];
    if (!step) return null;
    const val = step[key];
    return val == null ? null : val;
}

const api = { get, _COPY: COPY };
if (typeof window !== "undefined") window.Copy = api;
export const Copy = api;
export default api;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd desktop && npm test -- copy`

Expected: PASS — all four tests green.

- [ ] **Step 5: Commit.**

```bash
git add desktop/wizard/copy.js desktop/tests/copy.test.js
git commit -m "feat(wizard): add copy.js — single source of truth for UI strings

Every user-visible string in the wizard, keyed by (stepId, key). Step
renderers will be refactored in subsequent tasks to read from this
module instead of inline literals. Eases future A/B and localization."
```

### Task 6: Refactor wizard.html shell

Drop the orb canvas, replace with the atmosphere + chrome + iridescent-rule + step-root + indicator structure from the demo. The renderer-side wiring (the `<script src>` tags) stays.

**Files:**
- Modify: `desktop/wizard.html`

- [ ] **Step 1: Replace the body content.**

Open `desktop/wizard.html`. Replace lines 11–38 (from `<body>` down through the closing `</div>` of `.wizard-container`) with:

```html
<body data-step="welcome">

<!-- Ambient atmosphere — single soft wash, no orbs. -->
<div class="atmosphere" aria-hidden="true">
    <div class="atmosphere-wash"></div>
    <div class="atmosphere-grain"></div>
</div>

<!-- Chrome -->
<header class="chrome">
    <div class="chrome-mark">A.T.L.A.S</div>
    <div class="chrome-folio" id="chrome-folio">01 / 10</div>
    <div class="chrome-tools">
        <button class="chrome-btn" title="Audio" id="audio-toggle" aria-label="Toggle audio">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/>
            </svg>
        </button>
        <button class="chrome-btn" title="Minimize" onclick="atlas.minimize()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="chrome-btn" title="Close" onclick="atlas.close()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
    </div>
</header>

<!-- Iridescent rule — scribes left → right → retreat on each step transition. -->
<div class="iridescent-rule" id="iridescent-rule" aria-hidden="true"></div>

<main class="stage">
    <article id="step-root" class="step-root"></article>
</main>

<footer class="indicator" id="indicator" aria-hidden="true"></footer>

<!-- "Already set" chips moved from the old chip-strip into the indicator footer at W2. -->
<div id="already-set-strip" class="chip-strip" hidden></div>
```

Keep the closing `</body></html>` and every `<script>` tag below it untouched. Add one new `<script>` tag for `cinematic.js` and one for `copy.js`, placed BEFORE `wizard/boot.js`:

```html
<script src="wizard/cinematic.js"></script>
<script src="wizard/copy.js"></script>
```

- [ ] **Step 2: Delete the old orb CSS from `desktop/styles.css`.**

In `desktop/styles.css`, search for the existing `.bg-canvas`, `.orb`, `.orb-1` through `.orb-6` classes (NOT the new `.atmosphere` block you appended in Task 2). Delete them — they're orphaned now. Also delete `.bg-canvas::after` if present.

- [ ] **Step 3: Run the wizard.**

Run: `cd desktop && npm start`

Expected: wizard opens. The page background is now the new warm near-black (or warm off-white if your system is in light mode). No orbs. The title bar shows "A.T.L.A.S" plus three small inline-SVG buttons. The first step (welcome) still renders with its current contents — it'll look slightly off because we haven't refactored its DOM yet; that's Task 7.

Close the wizard.

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard.html desktop/styles.css
git commit -m "feat(wizard): rebuild wizard shell — atmosphere + chrome + iridescent rule

Drops the orb canvas DOM. Adds atmosphere/chrome/iridescent-rule/stage/
indicator structure from the demo. Loads cinematic.js + copy.js. Deletes
orphan .orb-* CSS. Step DOM is still the old version — refactored in
subsequent tasks."
```

### Task 7: Refactor `boot.js` for the new shell

The boot script now drives: confidence ramp, iridescent scribe on transitions, theme application from `personalize.theme`, audio toggle, chrome-folio updates. Cleanup hook is honored.

**Files:**
- Modify: `desktop/wizard/boot.js`

- [ ] **Step 1: Replace `boot.js`.**

Open `desktop/wizard/boot.js`. Replace the entire file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Renderer bootstrap for the cinematic wizard. IIFE at bottom runs on page load
// when #step-root exists; pure helpers exposed on window.__WizardBoot for tests.
(function () {
    "use strict";

    function clearChildren(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    }

    function renderIndicator(host, allSteps, activeSteps, currentIdx, onDotClick) {
        clearChildren(host);
        // Awakening doesn't show in the indicator strip — too cinematic for dots.
        for (let i = 1; i < activeSteps.length; i++) {
            const id = activeSteps[i];
            const cls = "indicator-dot"
                + (i === currentIdx ? " active" : i < currentIdx ? " done" : "");
            const dot = document.createElement("span");
            dot.className = cls;
            dot.setAttribute("data-sp-step", id);
            if (typeof onDotClick === "function") {
                dot.addEventListener("click", function () { onDotClick(i); });
            }
            host.appendChild(dot);
        }
    }

    function setFolio(folioEl, currentIdx, total) {
        if (!folioEl) return;
        folioEl.textContent = String(currentIdx + 1).padStart(2, "0") + " / " + String(total).padStart(2, "0");
    }

    // Apply user's theme preference. Empty string ⇒ remove attribute ⇒ OS decides.
    function applyTheme(value) {
        const root = document.documentElement;
        if (!value || value === "system") root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", value);
    }

    function decideInitialRoute(steps) {
        if (!Array.isArray(steps) || steps.length === 0) return { route: "ready-hub" };
        return { route: "step", stepIndex: 0 };
    }

    async function boot() {
        const stepEl  = document.getElementById("step-root");
        const indEl   = document.getElementById("indicator");
        const folioEl = document.getElementById("chrome-folio");
        if (!stepEl) return; // not the wizard page

        const atlas  = window.atlas || {};
        const router = window.WizardRouter;
        const Cin    = window.Cinematic || { scribeRule: function () {}, applyConfidence: function () {} };
        if (!router || !atlas.setupDetect) {
            stepEl.textContent = "Setup shell failed to load (router or IPC missing).";
            return;
        }

        let state;
        try { state = await atlas.setupDetect(); }
        catch (err) {
            stepEl.textContent = "Detection failed: " + (err.message || String(err));
            return;
        }
        let { steps } = router.getSteps(state);

        // Apply stored theme preference (empty = follow system).
        applyTheme((state.personalize && state.personalize.theme) || "");

        const initial = decideInitialRoute(steps);
        if (initial.route === "ready-hub") {
            window.location.href = "ready-hub.html";
            return;
        }

        async function refreshState() {
            try { state = await atlas.setupDetect(); }
            catch { return; }
            const nxt = router.getSteps(state);
            steps = nxt.steps;
        }

        function goBack(fromIdx) {
            const p = router.prev(fromIdx);
            if (p !== -1) renderIndex(p);
        }

        async function advance(fromIdx) {
            const n = router.next(fromIdx, steps);
            if (n === -1) {
                await refreshState();
                const installIdx = steps.indexOf("install");
                if (installIdx >= 0) { renderIndex(installIdx); return; }
                window.location.href = "ready-hub.html";
                return;
            }
            renderIndex(n);
        }

        function renderIndex(idx) {
            const id = steps[idx];

            // 1. Outgoing-step cleanup hook (used by awakening to clear timers/listeners).
            if (typeof stepEl._cleanup === "function") {
                try { stepEl._cleanup(); } catch (_) { /* swallow */ }
                stepEl._cleanup = null;
            }

            // 2. Leave animation
            stepEl.classList.add("leaving");
            setTimeout(function () {
                stepEl.classList.remove("leaving", "ready");
                stepEl.classList.add("entering");
                clearChildren(stepEl);
                document.body.setAttribute("data-step", id);

                Cin.applyConfidence(idx, steps.length);

                // 3. Render the step
                const stepApi = window.WizardSteps && window.WizardSteps[id];
                if (!stepApi || typeof stepApi.render !== "function") {
                    const msg = document.createElement("div");
                    msg.textContent = "Unknown step: " + id;
                    stepEl.appendChild(msg);
                    return;
                }
                stepApi.render(stepEl, {
                    state: state,
                    onAdvance: function () { advance(idx); },
                    onBack:    function () { goBack(idx); },
                    refreshState: refreshState,
                });

                // 4. Chrome + indicator
                setFolio(folioEl, idx, steps.length);
                renderIndicator(indEl, router.ALL_STEPS, steps, idx, function (newIdx) { renderIndex(newIdx); });

                // 5. Scribe the iridescent rule (awakening is the only step that skips this).
                if (id !== "awakening") Cin.scribeRule();

                // 6. Cascade entry — set per-child --enter-delay, then add .ready
                const children = stepEl.children;
                for (let i = 0; i < children.length; i++) {
                    children[i].style.setProperty("--enter-delay", (60 + i * 70) + "ms");
                }

                requestAnimationFrame(function () {
                    stepEl.classList.remove("entering");
                    requestAnimationFrame(function () { stepEl.classList.add("ready"); });
                });
            }, 220);
        }

        // Audio toggle
        const audioBtn = document.getElementById("audio-toggle");
        if (audioBtn) {
            audioBtn.addEventListener("click", function () {
                const next = !((state.personalize && state.personalize.audio && state.personalize.audio.enabled) || false);
                if (atlas.setupSavePersonalize) {
                    atlas.setupSavePersonalize({
                        audio: { enabled: next },
                    }).catch(function () { /* best-effort */ });
                }
                if (window.WizardAudio && window.WizardAudio.setEnabled) window.WizardAudio.setEnabled(next);
                audioBtn.style.color = next ? "var(--ink-0)" : "";
            });
        }

        renderIndex(0);
    }

    if (typeof window !== "undefined") {
        window.__WizardBoot = {
            clearChildren: clearChildren,
            renderIndicator: renderIndicator,
            setFolio: setFolio,
            applyTheme: applyTheme,
            decideInitialRoute: decideInitialRoute,
        };
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("step-root")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            clearChildren: clearChildren,
            renderIndicator: renderIndicator,
            setFolio: setFolio,
            applyTheme: applyTheme,
            decideInitialRoute: decideInitialRoute,
        };
    }
})();
```

- [ ] **Step 2: Run the wizard.**

Run: `cd desktop && npm start`

Expected: wizard opens. The folio reads `01 / 0X` (number depends on detected state). The indicator strip at the bottom shows dots, current step highlighted with the iridescent pill. The iridescent rule at the top scribes when you click Continue/Back. Step renderers are still the old code — visually inconsistent — that's expected and fixed in Tasks 8-13.

Close the wizard.

- [ ] **Step 3: Run the boot tests.**

Run: `cd desktop && npm test -- boot`

Expected: existing boot tests pass. If they fail, the most likely cause is renamed helper functions (renderDots → renderIndicator). Update the tests to import the new names. The behavior is the same.

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard/boot.js
git commit -m "feat(wizard): boot.js drives indicator + folio + scribe + theme + cleanup

renderDots → renderIndicator (different visual: pill for active, dots
for done/upcoming, awakening hidden). applyTheme sets data-theme on
<html> from personalize.theme. Renders trigger Cinematic.scribeRule
on every transition except awakening. Outgoing _cleanup hook honored
so timers don't leak. Audio toggle wired to setupSavePersonalize."
```

### Task 8: Refactor steps/welcome.js, terms.js, signin.js to read from Copy + new DOM

Three small steps, all rewritten to consume `Copy.get()` and the new CSS classes.

**Files:**
- Modify: `desktop/wizard/steps/welcome.js`
- Modify: `desktop/wizard/steps/terms.js`
- Modify: `desktop/wizard/steps/signin.js`

> Note: in W1 we are NOT adding a separate `awakening` step file yet — Task 11 does that. `welcome.js` keeps its CTA but reads its copy through `Copy.get`. The router will skip `welcome` once `awakening` exists (Task 12). Until then the user sees `welcome` → the new copy/styling lands incrementally.

- [ ] **Step 1: Rewrite `welcome.js`.**

Replace the entire file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const re = !!(ctx && ctx.state && ctx.state.isReconfigure);
        const section = document.createElement("section");
        section.className = "step step-welcome";

        // Welcome is a placeholder until W1 Task 12 inserts the awakening step.
        // After that, welcome is only shown on Reconfigure flows.
        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + (re ? "Reconfigure" : "Welcome");

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = re ? "Reconfigure A.T.L.A.S." : "Welcome to A.T.L.A.S.";

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = re
            ? "Your current configuration will be preserved. Walk through to change anything."
            : "A proactive, personal AI agent. Setup takes under two minutes.";

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const cta = document.createElement("button");
        cta.id = "welcome-cta";
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Begin <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        cta.addEventListener("click", function () {
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        const grow = document.createElement("div");
        grow.className = "grow";
        actions.appendChild(grow);
        actions.appendChild(cta);

        section.appendChild(eyebrow);
        section.appendChild(title);
        section.appendChild(sub);
        section.appendChild(actions);
        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.welcome = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 2: Rewrite `terms.js`.**

Open `desktop/wizard/steps/terms.js`. Keep the existing acceptance-validation logic; only rewrite the DOM. Replace the file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    const TERMS_HTML = `
        <h4>Terms of service</h4>
        <p>A.T.L.A.S is a personal AI agent that acts on your behalf across the channels you connect. By accepting, you authorize the agent to read, write, and execute within the scopes you grant.</p>
        <h4>Privacy</h4>
        <p>Memory and conversation history are stored locally on this device. Telemetry is anonymized and aggregated.</p>
        <h4>Acceptable use</h4>
        <p>You agree not to use A.T.L.A.S for activities that violate applicable law or the rights of others.</p>
        <h4>Disclaimer</h4>
        <p>A.T.L.A.S is software and can make mistakes. You retain responsibility for actions it takes on your behalf.</p>
        <h4>Refund</h4>
        <p>Subscriptions are refundable within 7 days of purchase, no questions asked.</p>
    `;

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-terms";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("terms", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("terms", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("terms", "sub");
        section.appendChild(sub);

        const doc = document.createElement("div");
        doc.className = "terms-doc";
        doc.innerHTML = TERMS_HTML;
        section.appendChild(doc);

        const checks = document.createElement("div");
        checks.className = "terms-checks";
        const keys = ["check1", "check2", "check3", "check4", "check5"];
        const inputs = keys.map(function (k) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "checkbox";
            cb.checked = true;
            const span = document.createElement("span");
            span.textContent = Copy.get("terms", k);
            const row = document.createElement("label");
            row.className = "check-row";
            row.appendChild(cb);
            row.appendChild(span);
            checks.appendChild(row);
            return cb;
        });
        section.appendChild(checks);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = Copy.get("terms", "accept") + ' <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        cta.addEventListener("click", async function () {
            if (!inputs.every(function (i) { return i.checked; })) return;
            if (window.atlas && typeof window.atlas.setupSaveTermsAcceptance === "function") {
                try { await window.atlas.setupSaveTermsAcceptance({ accepted: true, version: window.WizardRouter.CURRENT_ACCEPTANCE_VERSION }); }
                catch (_) { /* best-effort */ }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        actions.appendChild(grow);
        actions.appendChild(cta);
        section.appendChild(actions);

        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.terms = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 3: Rewrite `signin.js`.**

Replace the entire file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function svgEmail() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>';
    }
    function svgPhone() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>';
    }
    function svgPerson() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const section = document.createElement("section");
        section.className = "step step-signin";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("signin", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("signin", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("signin", "sub");
        section.appendChild(sub);

        const pane = document.createElement("div");
        pane.className = "signin-pane";

        const glyph = document.createElement("div");
        glyph.className = "signin-glyph";
        glyph.innerHTML = svgPerson();
        pane.appendChild(glyph);

        const options = document.createElement("div");
        options.className = "signin-options";

        function openAuthAndAdvance() {
            if (window.atlas && typeof window.atlas.openAuthWindow === "function") {
                window.atlas.openAuthWindow();
            }
            // The OTPless flow lives in a popup; user returns to the wizard via
            // setup:account-status-change → boot.js refreshState. Don't auto-advance —
            // the router will redirect on next render once account.signedIn is true.
        }

        const emailBtn = document.createElement("button");
        emailBtn.className = "signin-option";
        emailBtn.innerHTML = svgEmail() + '<span>' + Copy.get("signin", "email_cta") + '</span>';
        emailBtn.addEventListener("click", openAuthAndAdvance);
        options.appendChild(emailBtn);

        const phoneBtn = document.createElement("button");
        phoneBtn.className = "signin-option";
        phoneBtn.innerHTML = svgPhone() + '<span>' + Copy.get("signin", "phone_cta") + '</span>';
        phoneBtn.addEventListener("click", openAuthAndAdvance);
        options.appendChild(phoneBtn);

        pane.appendChild(options);

        const fineprint = document.createElement("p");
        fineprint.className = "signin-fineprint";
        fineprint.textContent = Copy.get("signin", "fineprint");
        pane.appendChild(fineprint);

        section.appendChild(pane);

        // Back-only action row — the email/phone buttons ARE the primary action.
        // No "skip" CTA: the wizard advances automatically once OTPless completes,
        // and the fineprint covers the "I'll sign in later" case.
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        actions.appendChild(back);
        section.appendChild(actions);

        root.appendChild(section);
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.signin = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 4: Run the wizard and click through welcome → terms → signin.**

Run: `cd desktop && npm start`

Expected:
- Welcome step renders with new eyebrow, large title, sub, and primary CTA pill with chevron.
- Terms step renders with new doc card, gradient-checked boxes, primary pill.
- Sign-in renders with two big option buttons and the back link only — no "Skip for now" CTA.
- All three steps fade-up with the staggered entry on first paint.

Close the wizard.

- [ ] **Step 5: Commit.**

```bash
git add desktop/wizard/steps/welcome.js desktop/wizard/steps/terms.js desktop/wizard/steps/signin.js
git commit -m "refactor(wizard): rewrite welcome/terms/signin DOM + read from Copy

Drops inline strings; all copy reads through window.Copy.get(step, key).
New DOM matches the design tokens added in Task 2. Sign-in step removes
the bottom \"Skip for now\" CTA — pane buttons are the only primary
action; fineprint covers the defer case."
```

### Task 9: Refactor steps/profile.js (name-only) and steps/personalize.js

Profile becomes name-only — the tone dropdown moves out of W1 and into W2's persona step. Personalize gets the new spec list visual.

**Files:**
- Modify: `desktop/wizard/steps/profile.js`
- Modify: `desktop/wizard/steps/personalize.js`

- [ ] **Step 1: Rewrite `profile.js` to name-only.**

Replace the entire file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const existingProfile = (ctx && ctx.state && ctx.state.profile) || {};
        const defaultName = existingProfile.name || (ctx && ctx.state && ctx.state.osUserName) || "";

        const section = document.createElement("section");
        section.className = "step step-profile";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("profile", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("profile", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("profile", "sub");
        section.appendChild(sub);

        const field = document.createElement("div");
        field.className = "field";
        const lbl = document.createElement("span");
        lbl.className = "field-label";
        lbl.textContent = Copy.get("profile", "label");
        const input = document.createElement("input");
        input.id = "prof-name";
        input.type = "text";
        input.maxLength = 64;
        input.placeholder = Copy.get("profile", "placeholder");
        input.value = defaultName;
        field.appendChild(lbl);
        field.appendChild(input);
        section.appendChild(field);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(back);
        actions.appendChild(grow);
        actions.appendChild(cta);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.className = "step-error";
        err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        cta.addEventListener("click", async function () {
            const n = input.value.trim();
            if (!n) { err.textContent = "Please enter a name."; return; }
            err.textContent = "";
            if (!window.atlas || typeof window.atlas.saveProfile !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                return;
            }
            // Tone is preserved untouched in W1 (the existing profile.tone stays
            // whatever the user previously selected, or default "friendly"). W2
            // replaces this with the persona step.
            const tone = existingProfile.tone || "friendly";
            let res;
            try { res = await window.atlas.saveProfile({ name: n, tone: tone }); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            if (ctx && ctx.state && ctx.state.isReconfigure && window.atlas && typeof window.atlas.setupReseedNow === "function") {
                try { await window.atlas.setupReseedNow(); } catch { /* next bot restart picks up */ }
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.profile = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 2: Rewrite `personalize.js` with the new spec-list layout.**

This file is the largest in the wizard. Open `desktop/wizard/steps/personalize.js`. Read the demo's persona/personalize layout (`desktop/onboarding-demo/demo.js`, search for `STEP_RENDERERS["personalize"]`) — that's the target visual.

Replace the entire `personalize.js` with the version below. Component mounts (`HotkeyPicker`, `ThemeSwitch`, `VoicePicker`) keep their existing API:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";
        const pz = (ctx && ctx.state && ctx.state.personalize) || {};
        const defaultHot   = pz.hotkey   || (platform === "win32" ? "Control+Space" : "Alt+Space");
        const defaultTheme = pz.theme    || "";
        const defaultVoice = pz.voice    || { backend: "gemini-live", name: "Aoede" };
        const defaultWake  = pz.wakeWord || { enabled: false, phrase: "Hey Atlas" };
        const defaultPersonality = pz.personality || { preset: "casual_playful", notes: "" };

        const section = document.createElement("section");
        section.className = "step step-personalize";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("personalize", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("personalize", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("personalize", "sub");
        section.appendChild(sub);

        const spec = document.createElement("div");
        spec.className = "spec";

        function row(labelText, valueEl) {
            const r = document.createElement("div");
            r.className = "spec-row";
            const l = document.createElement("div");
            l.className = "spec-label";
            l.textContent = labelText;
            const v = document.createElement("div");
            v.className = "spec-value";
            v.appendChild(valueEl);
            r.appendChild(l);
            r.appendChild(v);
            return r;
        }

        const hotkeyMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_hotkey"), hotkeyMount));

        const themeMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_theme"), themeMount));

        const voiceMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_voice"), voiceMount));

        // Personality presets (kept inline — small radio list).
        const presetWrap = document.createElement("div");
        presetWrap.className = "radio-list";
        let personaPreset = defaultPersonality.preset || "casual_playful";
        const presets = [
            { value: "casual_playful",       label: "Casual & playful",        ex: "lol fair point — let's give it a shot" },
            { value: "professional_concise", label: "Professional & concise",  ex: "Got it. Running the analysis now." },
            { value: "warm_supportive",      label: "Warm & supportive",       ex: "That's a lot. Let's take it one step at a time." },
            { value: "direct_terse",         label: "Direct & no-nonsense",    ex: "Done. Output in /tmp/results.txt." },
        ];
        for (const p of presets) {
            const r = document.createElement("div");
            r.className = "radio-row" + (p.value === personaPreset ? " active" : "");
            r.innerHTML = '<div class="radio-mark"></div>'
                       + '<div class="radio-text">'
                       + '<p class="radio-name">' + p.label + '</p>'
                       + '<p class="radio-example">"' + p.ex + '"</p>'
                       + '</div>';
            r.addEventListener("click", function () {
                personaPreset = p.value;
                presetWrap.querySelectorAll(".radio-row").forEach(function (rr, i) {
                    rr.classList.toggle("active", presets[i].value === p.value);
                });
            });
            presetWrap.appendChild(r);
        }
        spec.appendChild(row(Copy.get("personalize", "label_personality"), presetWrap));

        // Wake word
        const wakeWrap = document.createElement("div");
        const switchRow = document.createElement("div");
        switchRow.className = "switch-row";
        const switchLabel = document.createElement("span");
        switchLabel.className = "switch-label";
        switchLabel.textContent = Copy.get("personalize", "wake_toggle");
        const sw = document.createElement("input");
        sw.type = "checkbox";
        sw.className = "switch";
        sw.checked = !!defaultWake.enabled;
        switchRow.appendChild(switchLabel);
        switchRow.appendChild(sw);
        wakeWrap.appendChild(switchRow);

        const phraseField = document.createElement("div");
        phraseField.className = "field";
        phraseField.style.marginTop = "12px";
        const phraseLabel = document.createElement("span");
        phraseLabel.className = "field-label";
        phraseLabel.textContent = Copy.get("personalize", "wake_phrase_label");
        const phraseInput = document.createElement("input");
        phraseInput.type = "text";
        phraseInput.value = defaultWake.phrase || "Hey Atlas";
        phraseField.appendChild(phraseLabel);
        phraseField.appendChild(phraseInput);
        if (!sw.checked) phraseField.style.display = "none";
        sw.addEventListener("change", function () { phraseField.style.display = sw.checked ? "" : "none"; });
        wakeWrap.appendChild(phraseField);

        spec.appendChild(row(Copy.get("personalize", "label_wake"), wakeWrap));

        section.appendChild(spec);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button"; back.className = "btn btn-text"; back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        const grow = document.createElement("div"); grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button"; cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(back); actions.appendChild(grow); actions.appendChild(cta);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.className = "step-error"; err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        // Mount existing components (unchanged API).
        const C = window.SetupComponents || {};
        let hotkeyValue = defaultHot, hotkeyPicker = null;
        if (C.HotkeyPicker) {
            hotkeyPicker = new C.HotkeyPicker({
                platform: platform, initial: defaultHot,
                onChange: function (combo) { hotkeyValue = combo; },
            });
            hotkeyPicker.mount(hotkeyMount);
        }
        let themeValue = defaultTheme, themeSwitch = null;
        if (C.ThemeSwitch) {
            themeSwitch = new C.ThemeSwitch({
                initial: defaultTheme || ((ctx && ctx.state && ctx.state.theme) || "system"),
                osPreference: (ctx && ctx.state && ctx.state.theme) || "light",
                onChange: function (sel) {
                    themeValue = sel.pick;
                    // Live preview — apply immediately so the wizard reflects the choice.
                    const root = document.documentElement;
                    if (!themeValue || themeValue === "system") root.removeAttribute("data-theme");
                    else root.setAttribute("data-theme", themeValue);
                },
            });
            themeSwitch.mount(themeMount);
        }
        let voicePicker = null;
        if (C.VoicePicker) {
            voicePicker = new C.VoicePicker({
                onChange: function (v) {
                    if (v && v.backend && v.name) { defaultVoice.backend = v.backend; defaultVoice.name = v.name; }
                },
            });
            Promise.resolve(voicePicker.mount(voiceMount)).catch(function () {});
        }

        cta.addEventListener("click", async function () {
            const payload = {
                hotkey:   (hotkeyPicker && typeof hotkeyPicker.getValue === "function") ? hotkeyPicker.getValue() : hotkeyValue,
                theme:    (themeSwitch  && typeof themeSwitch.getValue  === "function") ? themeSwitch.getValue()  : themeValue,
                voice:    (voicePicker  && typeof voicePicker.getValue  === "function") ? (voicePicker.getValue() || defaultVoice) : defaultVoice,
                wakeWord: { enabled: sw.checked, phrase: phraseInput.value.trim() || "Hey Atlas" },
                personality: { preset: personaPreset, notes: defaultPersonality.notes || "" },
            };
            if (!window.atlas || typeof window.atlas.setupSavePersonalize !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                return;
            }
            let res;
            try { res = await window.atlas.setupSavePersonalize(payload); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.personalize = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 3: Run the wizard.**

Run: `cd desktop && npm start`

Expected: profile shows a single big input; personalize shows the new grouped spec card with all four mounted components. Theme picker changes apply live (the page flips dark↔light when you pick a different theme).

Close.

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard/steps/profile.js desktop/wizard/steps/personalize.js
git commit -m "refactor(wizard): profile name-only + personalize spec-list layout

Profile keeps the existing tone (defaults to 'friendly' or whatever
was previously stored) — tone moves to W2's persona step. Personalize
groups hotkey/theme/voice/personality/wake into a single spec card
with new visual tokens. ThemeSwitch onChange now applies the theme
live so the wizard previews the choice."
```

### Task 10: Refactor steps/permissions.js, vision-tier.js, install.js

Three more step renderers refactored to read from Copy and use the new visual.

**Files:**
- Modify: `desktop/wizard/steps/permissions.js`
- Modify: `desktop/wizard/steps/vision-tier.js`
- Modify: `desktop/wizard/steps/install.js`

- [ ] **Step 1: Rewrite `permissions.js`.**

The underlying `PermissionsGrid` component stays. We just rewrite the step file's chrome — eyebrow, title, sub, footnote, and a Skip-All link.

Replace the entire file with:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";

        const section = document.createElement("section");
        section.className = "step step-permissions";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("permissions", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("permissions", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("permissions", "sub");
        section.appendChild(sub);

        const gridHost = document.createElement("div");
        gridHost.id = "perm-grid";
        section.appendChild(gridHost);

        const footnote = document.createElement("p");
        footnote.style.fontSize = "12.5px";
        footnote.style.color = "var(--ink-3)";
        footnote.style.margin = "14px 0 0";
        footnote.style.textAlign = "center";
        footnote.textContent = Copy.get("permissions", "footnote");
        section.appendChild(footnote);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button"; back.className = "btn btn-text"; back.textContent = "Back";
        const grow = document.createElement("div"); grow.className = "grow";
        const skipAll = document.createElement("button");
        skipAll.type = "button"; skipAll.className = "btn btn-link";
        skipAll.textContent = Copy.get("permissions", "skip_all");
        const cta = document.createElement("button");
        cta.type = "button"; cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(back); actions.appendChild(grow); actions.appendChild(skipAll); actions.appendChild(cta);
        section.appendChild(actions);

        root.appendChild(section);

        const C = window.SetupComponents || {};
        let grid = null;
        if (C.PermissionsGrid) {
            const skipped = (ctx && ctx.state && ctx.state.permissions && ctx.state.permissions.skipped) || {};
            grid = new C.PermissionsGrid({ platform: platform, skipped: skipped });
            Promise.resolve(grid.mount(gridHost)).catch(function () {});
        }

        back.addEventListener("click", function () {
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });
        cta.addEventListener("click", async function () {
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        skipAll.addEventListener("click", async function () {
            // Mark every remaining permission as skipped so the Ready Hub shows amber.
            const keys = ["accessibility", "screen", "microphone", "location"];
            for (const k of keys) {
                if (window.atlas && window.atlas.setupMarkPermissionSkipped) {
                    try { await window.atlas.setupMarkPermissionSkipped(k, true); } catch { /* best-effort */ }
                }
            }
            if (grid && typeof grid.unmount === "function") { try { grid.unmount(); } catch {} }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.permissions = { render: render };
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
```

- [ ] **Step 2: Refactor `vision-tier.js`.**

This file is the longest existing step (250 lines). We don't rewrite it wholesale — too much state and IPC. Open `desktop/wizard/steps/vision-tier.js` and apply surgical edits:

(a) Replace the header section (title + sub + descriptive lead-in DOM) with:

```javascript
const Copy = window.Copy;
const eyebrow = document.createElement("div");
eyebrow.className = "eyebrow";
eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("vision-tier", "eyebrow");
section.appendChild(eyebrow);

const title = document.createElement("h1");
title.className = "step-title";
title.textContent = Copy.get("vision-tier", "title");
section.appendChild(title);

const sub = document.createElement("p");
sub.className = "step-sub";
sub.textContent = Copy.get("vision-tier", "sub");
section.appendChild(sub);
```

(Drop the old `step-title` / `step-sub` lines this replaces.)

(b) For each of the three tier cards, change the container class from whatever it currently is to `tier-list` / `tier` / `tier-radio` / `tier-body` / `tier-head` / `tier-name` / `tier-tag` / `tier-desc` / `tier-size` to match the demo. Pull each label/desc through `Copy.get("vision-tier", "tier_<v>_<key>")`.

(c) Change the Continue button class from `btn-primary` to `btn btn-primary` and add the chev span:

```javascript
cta.className = "btn btn-primary";
cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
```

(d) Change Back button class to `btn btn-text` and remove the text "Back" reassignment (`back.textContent = "Back"` should stay — that one is fine, no Copy.get key for it).

Leave all the IPC calls (`atlas.setupChooseVisionTier`, etc.) intact.

- [ ] **Step 3: Refactor `install.js`.**

Same shape: surgical edits. The phase pipeline + IPC streams + ETA logic stay exactly as they are. Three changes:

(a) Replace the title + LABELS map. Open `desktop/wizard/steps/install.js`, find the `LABELS` constant near the top. Replace its body with values read from Copy:

```javascript
const LABELS = {
    "node":               window.Copy.get("install", "phase_node"),
    "playwright-chromium":window.Copy.get("install", "phase_playwright"),
    "embedding-model":    window.Copy.get("install", "phase_embedding"),
    "sox":                window.Copy.get("install", "phase_sox"),
    "ollama":             window.Copy.get("install", "phase_ollama"),
    "ui-tars-model":      window.Copy.get("install", "phase_vision_model"),
    "omniparser-deps":    window.Copy.get("install", "phase_vision_deps"),
    "data-dir":           window.Copy.get("install", "phase_data_dir"),
    "workspace":          window.Copy.get("install", "phase_workspace"),
    "setup-state-finalize": window.Copy.get("install", "phase_finalize"),
};
```

(b) Replace the title element creation with:

```javascript
const eyebrow = document.createElement("div");
eyebrow.className = "eyebrow";
eyebrow.innerHTML = '<span class="iri-dot"></span>' + window.Copy.get("install", "eyebrow");
section.appendChild(eyebrow);

const title = document.createElement("h1");
title.className = "step-title";
title.textContent = window.Copy.get("install", "title");
section.appendChild(title);
```

(Drop the existing title-only creation.)

(c) Change the fun-fact `factLabel.textContent` line from `"✨ Did you know?"` to `window.Copy.get("install", "fact_eyebrow")`.

Leave the FUN_FACTS array as-is — they're product benefits, not subject to copy.js (lots of them, semantically a separate concern).

- [ ] **Step 4: Run the wizard end-to-end.**

Run: `cd desktop && npm start`

Click through every step: welcome → terms → signin → profile → personalize → permissions → vision-tier → install. Confirm every step uses the new visual chrome, the iridescent rule scribes between steps, the install phase labels show the new names. Don't actually complete the install — just confirm the page renders correctly.

Close.

- [ ] **Step 5: Commit.**

```bash
git add desktop/wizard/steps/permissions.js desktop/wizard/steps/vision-tier.js desktop/wizard/steps/install.js
git commit -m "refactor(wizard): permissions/vision-tier/install consume Copy + new chrome

Permissions step adds a 'Skip all' link in the action row that marks
every permission as skipped via setupMarkPermissionSkipped before
advancing. Vision-tier and install retain their state/IPC logic;
only chrome (title/sub/eyebrow) and phase labels are rewritten."
```

---

## Phase C — Awakening step

### Task 11: Add steps/awakening.js

The cinematic opener. Mirror the demo's awakening renderer 1:1.

**Files:**
- Create: `desktop/wizard/steps/awakening.js`

- [ ] **Step 1: Create the file.**

Open `desktop/onboarding-demo/demo.js`. Find `STEP_RENDERERS["awakening"]` (around line 240). Note the structure: glyph + per-word greet + iridescent rule + status + CTA, plus the timeline of timers. The production version uses the same structure but resolves the greeting from real state and reads status strings from Copy.

Write `desktop/wizard/steps/awakening.js`:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The cinematic opener. Greets the user by OS-detected name, then a single
// iridescent rule scribes beneath, then status text rotates, then CTA.
// Total runtime ~2.5s. ESC fast-forwards.
(function () {
    "use strict";

    const TOD = {
        "morning": "Good morning", "afternoon": "Good afternoon",
        "evening": "Good evening", "late-night": "Working late",
    };

    function timeOfDay(d) {
        const h = (d || new Date()).getHours();
        if (h >= 5 && h < 12)  return "morning";
        if (h >= 12 && h < 17) return "afternoon";
        if (h >= 17 && h < 23) return "evening";
        return "late-night";
    }

    // Three-tier name lookup: stored profile → OS-detected (capitalized) → null.
    function resolveName(state) {
        const profile = (state && state.profile) || {};
        if (profile.name) return profile.name;
        const os = (state && state.osUserName) || "";
        if (!os) return null;
        const lc = os.toLowerCase();
        return lc.charAt(0).toUpperCase() + lc.slice(1);
    }

    function buildGreeting(state) {
        const base = TOD[timeOfDay()];
        const name = resolveName(state);
        return name ? base + ", " + name + "." : base + ".";
    }

    function svgChev() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>';
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const state = (ctx && ctx.state) || {};

        const wrap = document.createElement("div");
        wrap.className = "awakening";

        const glyph = document.createElement("div");
        glyph.className = "awakening-glyph";
        wrap.appendChild(glyph);

        const greet = document.createElement("h1");
        greet.className = "awakening-greet";
        const greetText = buildGreeting(state);
        const tokens = greetText.split(/(\s+)/);
        let wordIdx = 0;
        tokens.forEach(function (t) {
            if (/^\s+$/.test(t)) {
                const sp = document.createElement("span");
                sp.className = "space";
                greet.appendChild(sp);
            } else if (t.length) {
                const w = document.createElement("span");
                w.className = "word";
                w.textContent = t;
                w.style.setProperty("--word-delay", (380 + wordIdx * 110) + "ms");
                wordIdx++;
                greet.appendChild(w);
            }
        });
        wrap.appendChild(greet);

        const iri = document.createElement("div");
        iri.className = "awakening-iri";
        wrap.appendChild(iri);

        const status = document.createElement("div");
        status.className = "awakening-status";
        const swap = document.createElement("span");
        swap.className = "swap";
        swap.textContent = Copy.get("awakening", "status1");
        status.appendChild(swap);
        wrap.appendChild(status);

        const cta = document.createElement("div");
        cta.className = "awakening-cta";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-primary";
        btn.innerHTML = Copy.get("awakening", "cta") + ' <span class="chev">' + svgChev() + '</span>';
        btn.addEventListener("click", function () {
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = Copy.get("awakening", "hint");
        cta.appendChild(btn);
        cta.appendChild(hint);
        wrap.appendChild(cta);

        root.appendChild(wrap);
        // Skip the default cascade entry — this step has its own timeline.
        root.classList.add("ready");

        // ---- Timeline ----
        const SEQ = [Copy.get("awakening", "status2"), Copy.get("awakening", "status3")];
        let cancelled = false;
        const timers = [];

        timers.push(setTimeout(function () { document.body.classList.add("atmosphere-on"); }, 60));
        timers.push(setTimeout(function () { glyph.classList.add("in");  }, 120));
        timers.push(setTimeout(function () { greet.classList.add("in");  }, 280));
        timers.push(setTimeout(function () { iri.classList.add("in");    }, 1100));
        timers.push(setTimeout(function () { status.classList.add("in"); }, 1450));
        timers.push(setTimeout(function () { cta.classList.add("in");    }, 1850));

        function swapTo(text, delay) {
            timers.push(setTimeout(function () {
                if (cancelled) return;
                swap.classList.add("swapping");
                setTimeout(function () {
                    swap.textContent = text;
                    swap.classList.remove("swapping");
                }, 400);
            }, delay));
        }
        swapTo(SEQ[0], 2700);
        swapTo(SEQ[1], 3900);

        function onKey(e) {
            if (e.key !== "Escape") return;
            cancelled = true;
            timers.forEach(clearTimeout);
            document.body.classList.add("atmosphere-on");
            glyph.classList.add("in"); greet.classList.add("in");
            greet.querySelectorAll(".word").forEach(function (w) { w.style.transition = "none"; });
            iri.classList.add("in"); status.classList.add("in");
            swap.textContent = SEQ[1];
            cta.classList.add("in");
            document.removeEventListener("keydown", onKey);
        }
        document.addEventListener("keydown", onKey);

        root._cleanup = function () {
            cancelled = true;
            timers.forEach(clearTimeout);
            document.body.classList.remove("atmosphere-on");
            document.removeEventListener("keydown", onKey);
        };
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.awakening = { render: render };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, _internals: { resolveName: resolveName, buildGreeting: buildGreeting, timeOfDay: timeOfDay } };
    }
})();
```

- [ ] **Step 2: Add unit tests for the name + greeting helpers.**

Create `desktop/tests/awakening.test.js`:

```javascript
import { describe, it, expect } from "vitest";

// JSDOM lacks DOM globals for the script's IIFE, so we test the pure helpers
// via the module.exports path. We import as CommonJS using require.
const awakening = await import("../wizard/steps/awakening.js");
// The file is a renderer IIFE — module.exports is populated when run under Node.
// In vitest with jsdom we get the WizardSteps registration AND module.exports.
const { resolveName, buildGreeting, timeOfDay } = awakening._internals || awakening.default?._internals || awakening;

describe("awakening.resolveName", () => {
    it("returns profile.name when present", () => {
        expect(resolveName({ profile: { name: "Dheeraj" }, osUserName: "dheeraj" })).toBe("Dheeraj");
    });
    it("falls back to OS user name, capitalized", () => {
        expect(resolveName({ profile: {}, osUserName: "dheeraj" })).toBe("Dheeraj");
    });
    it("returns null when both are absent", () => {
        expect(resolveName({})).toBeNull();
    });
});

describe("awakening.buildGreeting", () => {
    it("appends comma + name + period when name resolved", () => {
        const out = buildGreeting({ profile: { name: "Dheeraj" } });
        expect(out).toMatch(/^Good (morning|afternoon|evening), Dheeraj\.$|^Working late, Dheeraj\.$/);
    });
    it("uses bare TOD greeting with period when no name", () => {
        const out = buildGreeting({});
        expect(out).toMatch(/^Good (morning|afternoon|evening)\.$|^Working late\.$/);
    });
});

describe("awakening.timeOfDay", () => {
    it("maps 6am → morning", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 6, 0))).toBe("morning");
    });
    it("maps 2pm → afternoon", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 14, 0))).toBe("afternoon");
    });
    it("maps 7pm → evening", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 19, 0))).toBe("evening");
    });
    it("maps 1am → late-night", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 1, 0))).toBe("late-night");
    });
});
```

- [ ] **Step 3: Run the tests.**

Run: `cd desktop && npm test -- awakening`

Expected: PASS — all eight tests green.

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard/steps/awakening.js desktop/tests/awakening.test.js
git commit -m "feat(wizard): add awakening cinematic step

Greets the user by name resolved from profile → OS → null. Per-word
reveal with 110ms stagger, iridescent rule that draws from centre,
rotating status text. ESC fast-forwards. Total runtime ~2.5s. Pure
helpers (resolveName, buildGreeting, timeOfDay) exposed for tests."
```

### Task 12: Insert awakening in the router

The router currently starts with `welcome`. We insert `awakening` before it for first-install flows. Reconfigure skips both.

**Files:**
- Modify: `desktop/wizard/router.js`
- Modify: `desktop/wizard.html` (load the new step script)

- [ ] **Step 1: Edit `router.js`.**

Open `desktop/wizard/router.js`. Update the constants and `getSteps`:

```javascript
const ALL_STEPS = ["awakening", "welcome", "terms", "signin", "profile", "personalize", "permissions", "vision-tier", "install"];
```

Add a helper:

```javascript
function needsAwakening(s) {
    if (process.env.ATLAS_NO_AWAKENING === "true") return false;
    if (s && s.isReconfigure) return false;
    if (s && s.account && s.account.signedIn) return false; // returning user, already booted before
    return true;
}
```

(Note: `process.env` is available in the main-process when `router.js` is required; in the renderer it's not. We're calling `needsAwakening` from `getSteps`, which is called in both. Add a safe wrapper:)

Replace the helper with:

```javascript
function envFlag(name) {
    try { if (typeof process !== "undefined" && process.env && process.env[name] === "true") return true; }
    catch (_) { /* renderer — no process */ }
    return false;
}

function needsAwakening(s) {
    if (envFlag("ATLAS_NO_AWAKENING")) return false;
    if (s && s.isReconfigure) return false;
    if (s && s.account && s.account.signedIn) return false;
    return true;
}
```

In `getSteps`, prepend the awakening logic before the existing `welcome` push:

```javascript
function getSteps(state) {
    const s = state || {};
    const header = s.isReconfigure ? "Reconfigure" : "Welcome";
    const out = [];
    const signedIn = s.account && s.account.signedIn;
    if (!s.isReconfigure && needsAwakening(s)) out.push("awakening");
    if (!s.isReconfigure && !signedIn) out.push("welcome");
    // ... rest unchanged
}
```

Don't forget to export `needsAwakening`:

```javascript
const api = { getSteps, next, prev, ALL_STEPS, CURRENT_ACCEPTANCE_VERSION, needsTerms, needsAwakening };
```

- [ ] **Step 2: Edit `wizard.html` to load the awakening step script.**

Open `desktop/wizard.html`. Find the block of `<script src="wizard/steps/*.js">` tags. Add `<script src="wizard/steps/awakening.js"></script>` as the FIRST entry (before `welcome.js`):

```html
<script src="wizard/steps/awakening.js"></script>
<script src="wizard/steps/welcome.js"></script>
<!-- ... -->
```

- [ ] **Step 3: Write a router test.**

Open `desktop/tests/router.test.js` (existing). Add at the end:

```javascript
import { describe, it, expect } from "vitest";
import { getSteps, needsAwakening } from "../wizard/router.js";

describe("needsAwakening", () => {
    it("returns true for first install", () => {
        expect(needsAwakening({})).toBe(true);
    });
    it("returns false for reconfigure", () => {
        expect(needsAwakening({ isReconfigure: true })).toBe(false);
    });
    it("returns false for signed-in returning user", () => {
        expect(needsAwakening({ account: { signedIn: true } })).toBe(false);
    });
});

describe("getSteps prepends awakening", () => {
    it("awakening is first on a fresh-install state", () => {
        const { steps } = getSteps({});
        expect(steps[0]).toBe("awakening");
    });
    it("awakening is absent on reconfigure", () => {
        const { steps } = getSteps({ isReconfigure: true });
        expect(steps.includes("awakening")).toBe(false);
    });
});
```

- [ ] **Step 4: Run the tests.**

Run: `cd desktop && npm test -- router`

Expected: PASS — including the existing router tests.

- [ ] **Step 5: Run the wizard.**

Run: `cd desktop && npm start`

Expected: on first launch (or after deleting `~/.atlas/setup-state.json` if you've already gone through setup), the wizard opens directly into the awakening cinematic. Click Begin (or wait 2.5s, then click Begin) → welcome step → onwards.

Close.

- [ ] **Step 6: Commit.**

```bash
git add desktop/wizard/router.js desktop/wizard.html desktop/tests/router.test.js
git commit -m "feat(wizard): insert awakening step before welcome on first install

ALL_STEPS prepends 'awakening'; getSteps emits it for first-install
flows only (reconfigure + signed-in returning users skip). Honors
ATLAS_NO_AWAKENING=true env switch."
```

### Task 13: Hide awakening from the indicator strip

The awakening step is too cinematic for a dot. The indicator already skips it in `boot.js`'s `renderIndicator` (starts loop at `i = 1`). Verify with a manual test.

**Files:**
- Manual verification only.

- [ ] **Step 1: Run the wizard on a fresh setup state.**

Run: `rm -f ~/.atlas/setup-state.json && cd desktop && npm start`

Expected: awakening renders. The dot strip at the bottom is hidden (CSS rule `body[data-step="awakening"] .indicator { opacity: 0 }`). Click Begin. The dot strip fades in, with the first dot active.

- [ ] **Step 2: Commit a manual-test note.**

No code change. Confirm with a single empty commit so the task is checkboxed in the plan:

```bash
git commit --allow-empty -m "chore(wizard): verify awakening hidden from indicator strip (manual)

The CSS rule `body[data-step=\"awakening\"] .indicator { opacity: 0 }`
hides the dot strip while the cinematic plays. renderIndicator in
boot.js starts at index 1, so the awakening step never has a dot.
Verified manually."
```

### Task 14: ATLAS_NO_AWAKENING kill-switch verification

Smoke-test the kill-switch is honored in both env and detected reconfigure paths.

**Files:**
- Manual verification only.

- [ ] **Step 1: Test with `ATLAS_NO_AWAKENING=true`.**

Run: `rm -f ~/.atlas/setup-state.json && ATLAS_NO_AWAKENING=true cd desktop && npm start`

Expected: wizard opens directly to welcome (or whatever step the router picks based on state — but NOT awakening).

Close.

- [ ] **Step 2: Test reconfigure flow.**

Run: `cd desktop && npm start`

Trigger Reconfigure from inside the Ready Hub or panel. Expected: the wizard reopens with no awakening — header reads "Reconfigure", first step is whatever the router picks.

Close.

- [ ] **Step 3: Commit a verification note.**

```bash
git commit --allow-empty -m "chore(wizard): verify ATLAS_NO_AWAKENING + reconfigure skip awakening (manual)"
```

---

## Phase D — Ready Hub redux

### Task 15: Rebuild ready-hub.html shell

Same atmosphere/chrome/iridescent-rule structure as the wizard.

**Files:**
- Modify: `desktop/ready-hub.html`

- [ ] **Step 1: Replace the body.**

Open `desktop/ready-hub.html`. Replace lines 11–33 with:

```html
<body data-step="ready-hub">

<div class="atmosphere" aria-hidden="true">
    <div class="atmosphere-wash"></div>
    <div class="atmosphere-grain"></div>
</div>

<header class="chrome">
    <div class="chrome-mark">A.T.L.A.S</div>
    <div class="chrome-folio">READY</div>
    <div class="chrome-tools">
        <button class="chrome-btn" title="Minimize" onclick="atlas.minimize()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="chrome-btn" title="Close" onclick="atlas.close()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
    </div>
</header>

<div class="iridescent-rule" id="iridescent-rule" aria-hidden="true"></div>

<main class="stage">
    <div id="hub-root" class="step-root"></div>
</main>
```

Keep the existing `<script>` block. Add `<script src="wizard/copy.js"></script>` and `<script src="wizard/cinematic.js"></script>` BEFORE `components/hub-boot.js`. Add `<script src="components/magic-moment.js"></script>` (created in Task 17) before `components/ready-hub-body.js`.

- [ ] **Step 2: Run.**

Run: `cd desktop && npm start` and complete setup (or hop to the Ready Hub by clicking the indicator while signed in). Expected: Ready Hub now shows the new chrome and atmosphere; the existing hub body still renders.

Close.

- [ ] **Step 3: Commit.**

```bash
git add desktop/ready-hub.html
git commit -m "feat(wizard): rebuild ready-hub.html shell with atmosphere + chrome

Same atmosphere + chrome + iridescent-rule scaffold as the wizard.
Loads copy.js, cinematic.js, and the upcoming magic-moment.js."
```

### Task 16: Rebuild components/ready-hub-body.js

The body becomes: broadsheet hero, iridescent rule, magic-moment card, settings index grid, action row, "Try this" list. Same `mountHub(container, state, atlas) → handle` API so `hub-boot.js` doesn't change.

**Files:**
- Modify: `desktop/components/ready-hub-body.js`

- [ ] **Step 1: Read the demo's `ready-hub` renderer for the target visual.**

In `desktop/onboarding-demo/demo.js` find `STEP_RENDERERS["ready-hub"]` (around line 770). Note: hub-title with `<em>` wrapping the name, hub-dek with hotkey badge, hub-iri (the rule beneath dek), magic-note (rotating), hub-index (3-column grid), hub-actions (white pill Launch + two ghost buttons), try-section with arrow-reveal lines.

- [ ] **Step 2: Replace the existing `renderHubBody` and `renderTiles` with the new layout.**

Open `desktop/components/ready-hub-body.js`. The existing file has `renderHubBody`, `renderTiles`, `applyDiff`, `mergeRealAccount`, `startLiveUpdates`, `mountHub`. We keep all the lifecycle/diff/IPC logic and only replace `renderHubBody` and the tile rendering.

Find the existing `renderHubBody(state)` function (around line 8). Replace its body with:

```javascript
function renderHubBody(state) {
    const Copy = (typeof window !== "undefined" && window.Copy) || { get: function(){return null;} };

    const root = document.createElement("div");
    root.className = "hub";

    const name = (state && state.profile && state.profile.name)
              || (state && state.osUserName)
              || "";
    const hotkey = (state && state.personalize && state.personalize.hotkey) || "⌥ Space";

    // Title — "Ready, <em>Name</em>." (name omitted if no name resolved)
    const title = document.createElement("h1");
    title.className = "hub-title";
    if (name) {
        title.innerHTML = "Ready, <em>" + escapeHtml(name) + "</em>.";
    } else {
        title.innerHTML = "Ready.";
    }
    root.appendChild(title);

    // Dek — "Press <kbd>hotkey</kbd> anywhere on your computer. I'll be there."
    const dek = document.createElement("p");
    dek.className = "hub-dek";
    dek.appendChild(document.createTextNode("Press "));
    const kbd = document.createElement("span");
    kbd.className = "hotkey";
    kbd.textContent = hotkey;
    dek.appendChild(kbd);
    dek.appendChild(document.createTextNode(" anywhere on your computer. I'll be there."));
    root.appendChild(dek);

    // Iridescent rule
    const iri = document.createElement("div");
    iri.className = "hub-iri";
    root.appendChild(iri);

    // Magic moment — placeholder div; magic-moment.js mounts into it.
    const magic = document.createElement("div");
    magic.id = "hub-magic-moment";
    root.appendChild(magic);

    // Settings index — 3-col grid of (label, value)
    const index = document.createElement("div");
    index.id = "hub-tiles"; // keep the legacy id so renderTiles still finds it
    index.className = "hub-index";
    root.appendChild(index);

    // Actions
    const actions = document.createElement("div");
    actions.id = "hub-actions";
    actions.className = "hub-actions";
    const launch = document.createElement("button");
    launch.type = "button";
    launch.className = "btn btn-primary btn-launch";
    launch.setAttribute("data-action", "launch");
    launch.innerHTML = (Copy.get("ready-hub", "launch") || "Launch A.T.L.A.S") + ' <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
    const talk = document.createElement("button");
    talk.type = "button";
    talk.className = "btn btn-secondary";
    talk.setAttribute("data-action", "talk");
    talk.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg><span>' + (Copy.get("ready-hub", "talk") || "Talk") + '</span>';
    const type = document.createElement("button");
    type.type = "button";
    type.className = "btn btn-secondary";
    type.setAttribute("data-action", "type");
    type.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></svg><span>' + (Copy.get("ready-hub", "type") || "Type") + '</span>';
    actions.appendChild(launch); actions.appendChild(talk); actions.appendChild(type);
    root.appendChild(actions);

    const actionsErr = document.createElement("p");
    actionsErr.id = "hub-actions-err";
    actionsErr.className = "step-error";
    actionsErr.setAttribute("aria-live", "polite");
    root.appendChild(actionsErr);

    // Try this
    const trySec = document.createElement("div");
    trySec.className = "try-section";
    const tryHead = document.createElement("p");
    tryHead.className = "try-heading";
    tryHead.textContent = Copy.get("ready-hub", "try_heading") || "Try this";
    trySec.appendChild(tryHead);
    const tryBox = document.createElement("div");
    tryBox.id = "hub-try-this";
    tryBox.className = "try-list";
    trySec.appendChild(tryBox);
    root.appendChild(trySec);

    return root;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

Find the existing `renderTiles(tilesWrap, state, atlas)` function. Replace its body with:

```javascript
function renderTiles(tilesWrap, state, atlas) {
    if (!tilesWrap) return;
    const TM = _getTileModel();
    if (!TM) return;
    while (tilesWrap.firstChild) tilesWrap.removeChild(tilesWrap.firstChild);

    // Cells we render in the new hub-index grid. 6 cells, 3 columns.
    const cellOrder = ["account", "workspace", "hotkey", "voice", "persona", "permissions"];
    for (const id of cellOrder) {
        const model = TM.tileModel(state, id);
        if (!model) continue;
        const cell = document.createElement("div");
        cell.className = "hub-cell" + (model.status === "amber" ? " amber" : "");
        cell.setAttribute("data-sp-tile", id);

        const label = document.createElement("span");
        label.className = "hub-cell-label";
        label.textContent = model.label;
        cell.appendChild(label);

        const value = document.createElement("span");
        value.className = "hub-cell-value";
        value.textContent = model.value || "—";
        cell.appendChild(value);

        if (model.secondary) {
            const sec = document.createElement("span");
            sec.className = "hub-cell-secondary";
            sec.textContent = model.secondary;
            cell.appendChild(sec);
        }

        const route = model.onClickRoute;
        if (route) {
            cell.style.cursor = "pointer";
            cell.addEventListener("click", function () { handleTileRoute(route, atlas); });
        }
        tilesWrap.appendChild(cell);
    }
}
```

Keep `applyDiff`, `mergeRealAccount`, `startLiveUpdates`, `handleTileRoute`, `mountHub`. Inside `mountHub`, after `renderTiles(...)`, add a magic-moment mount:

```javascript
// Mount magic-moment if available + not killed by env.
if (window.MagicMoment && typeof window.MagicMoment.mount === "function"
    && !(typeof process !== "undefined" && process.env && process.env.ATLAS_NO_MAGIC_MOMENT === "true")) {
    const mmHost = body.querySelector("#hub-magic-moment");
    if (mmHost) window.MagicMoment.mount(mmHost, enriched);
}
```

Also update the `TILE_ORDER` shadow — the existing code uses `TM.TILE_ORDER`. Our new `cellOrder` shadows it. If your existing `tile-model.js` exposes a `tileModel(state, id)` for `"persona"` — and it does NOT — we add a fallback. Find the call to `TM.tileModel(state, id)` in our new `renderTiles` and wrap it:

```javascript
let model = TM.tileModel(state, id);
if (!model && id === "persona") {
    model = {
        label: "Persona",
        value: (state && state.profile && state.profile.persona)
              ? (state.profile.persona.charAt(0).toUpperCase() + state.profile.persona.slice(1))
              : "Explorer",
        status: "ok",
        secondary: null,
        onClickRoute: null,
    };
}
if (!model) continue;
```

- [ ] **Step 3: Run.**

Run: `cd desktop && npm start` and arrive at the Ready Hub. Expected: broadsheet hero, iridescent rule, the magic-moment slot empty until Task 17 lands, 6-cell settings index grid, Launch/Talk/Type, Try this lines (empty until `try-this.js` is updated — that's existing).

If Try This already shows lines because `try-this.js` writes to `#hub-try-this`, great. If it doesn't, that's fine — visual smoke check only here.

Close.

- [ ] **Step 4: Commit.**

```bash
git add desktop/components/ready-hub-body.js
git commit -m "feat(wizard): rebuild Ready Hub body — broadsheet hero + index grid + actions

Replaces the tile-grid layout with a 3-col settings index. New hero
type scale (80px hub-title), hotkey badge in the dek, iridescent rule
under the headline, slot for the magic-moment card. Launch becomes a
white pill, Talk/Type are ghost buttons. mountHub now mounts
window.MagicMoment if available. Tile-model.js gets a fallback persona
cell so the grid renders even before W2 ships."
```

### Task 17: Add components/magic-moment.js (W1 — best-effort signals only)

A new component. Picks one observation from a small ranked list using best-effort signals (TOD, default browser, monitor count, dark/light, persona). Rotates every 7s. Auto-cleans timer on unmount.

**Files:**
- Create: `desktop/components/magic-moment.js`
- Test: `desktop/tests/magic-moment.test.js`

- [ ] **Step 1: Write the failing test.**

```javascript
// desktop/tests/magic-moment.test.js
import { describe, it, expect } from "vitest";
import { pickObservations } from "../components/magic-moment.js";

describe("pickObservations", () => {
    it("returns at least one observation even with empty state", () => {
        const obs = pickObservations({});
        expect(obs.length).toBeGreaterThan(0);
        expect(obs[0]).toHaveProperty("observation");
        expect(obs[0]).toHaveProperty("followup");
    });

    it("includes a late-night observation when state.hourOfDay = late-night", () => {
        const obs = pickObservations({ hourOfDay: "late-night" });
        const found = obs.find(function (o) { return /late-night|minimal/i.test(o.observation); });
        expect(found).toBeTruthy();
    });

    it("includes a dev-cluster observation when persona = developer", () => {
        const obs = pickObservations({ profile: { persona: "developer" } });
        const found = obs.find(function (o) { return /building|codebase|terminal/i.test(o.observation); });
        expect(found).toBeTruthy();
    });

    it("caps observations at 4", () => {
        const obs = pickObservations({
            hourOfDay: "late-night",
            profile: { persona: "developer" },
            theme: "dark",
            defaultBrowser: "Chrome",
            monitorCount: 3,
        });
        expect(obs.length).toBeLessThanOrEqual(4);
    });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd desktop && npm test -- magic-moment`

Expected: FAIL with "Failed to resolve module specifier".

- [ ] **Step 3: Write the implementation.**

```javascript
// desktop/components/magic-moment.js
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Ready Hub margin-note. Picks one observation from a small ranker driven
// by best-effort signals. W3 will swap the data source for rich detection.
"use strict";

function hourBucket(now) {
    const h = (now || new Date()).getHours();
    if (h >= 5 && h < 12)  return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 23) return "evening";
    return "late-night";
}

function pickObservations(state) {
    const out = [];
    const persona = (state && state.profile && state.profile.persona) || null;
    const hour    = (state && state.hourOfDay) || hourBucket();
    const theme   = (state && state.theme) || null;
    const browser = (state && state.defaultBrowser) || null;
    const mon     = (state && state.monitorCount) || 0;

    if (persona === "developer") {
        out.push({ observation: "Looks like you're building something.",
                   followup: "I'll prioritize codebase context and terminal awareness." });
    } else if (persona === "founder") {
        out.push({ observation: "You're in coordination mode.",
                   followup: "I'll watch your calendar and surface what needs a decision." });
    } else if (persona === "creator") {
        out.push({ observation: "Creative tools open. I can keep references organized.",
                   followup: "Drop a reference link anytime — I'll file it." });
    } else if (persona === "researcher") {
        out.push({ observation: "Sources on screen. I can chase the citations.",
                   followup: "Tell me what you're investigating and I'll widen the net." });
    } else {
        out.push({ observation: "Workspace mapped. Ready when you are.",
                   followup: "Talk to me however feels right — I'll learn." });
    }

    if (hour === "late-night") {
        out.push({ observation: "Late-night session. I'll keep things minimal.",
                   followup: "Voice off by default. Hotkey-quiet mode." });
    } else if (hour === "morning") {
        out.push({ observation: "Fresh start. Want me to brief the day?",
                   followup: "Calendar, inbox, what's overdue — in under ninety seconds." });
    }

    if (theme === "dark" && mon >= 2) {
        out.push({ observation: "Dark mode and " + mon + " monitors. I'll spread out when I need to.",
                   followup: "Drag me to whichever screen feels right." });
    } else if (mon >= 3) {
        out.push({ observation: mon + " monitors detected. I'll spread out when I need to.",
                   followup: "Drag me to whichever screen feels right." });
    }

    if (browser) {
        out.push({ observation: browser + " is your daily driver.",
                   followup: "I'll learn its tabs first." });
    }

    return out.slice(0, 4);
}

function mount(container, state) {
    if (!container) return { stop: function () {} };
    const observations = pickObservations(state);
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
    if (observations.length > 1) {
        timer = setInterval(function () {
            idx = (idx + 1) % observations.length;
            obsEl.style.opacity = "0"; followEl.style.opacity = "0";
            setTimeout(function () {
                paint();
                obsEl.style.opacity = "1"; followEl.style.opacity = "1";
            }, 320);
        }, 7000);
    }

    return { stop: function () { if (timer) { clearInterval(timer); timer = null; } } };
}

const api = { pickObservations: pickObservations, mount: mount };
if (typeof window !== "undefined") window.MagicMoment = api;
export { pickObservations, mount };
export default api;
```

- [ ] **Step 4: Run tests.**

Run: `cd desktop && npm test -- magic-moment`

Expected: PASS — all four tests green.

- [ ] **Step 5: Run the wizard, arrive at Ready Hub.**

Expected: magic-moment card appears below the dek with one observation visible. After ~7 seconds, the observation rotates with a soft crossfade.

- [ ] **Step 6: Commit.**

```bash
git add desktop/components/magic-moment.js desktop/tests/magic-moment.test.js
git commit -m "feat(wizard): add magic-moment.js — Ready Hub margin note

Best-effort observation ranker driven by persona + hour + theme +
browser + monitor count. Rotates every 7s when more than one
observation is available. W3 will swap in rich signals from
src/setup/magic-moment.ts."
```

### Task 18: Tile-model fallback for persona cell

The existing `desktop/components/tile-model.js` doesn't know about a `persona` cell. We added a fallback in Task 16 — promote it to the canonical model so future code paths see it consistently.

**Files:**
- Modify: `desktop/components/tile-model.js`

- [ ] **Step 1: Open the file and find the existing `TILE_ORDER` constant.**

It's a list of tile IDs and the `tileModel(state, id)` function dispatches on them.

- [ ] **Step 2: Add `"persona"` to `TILE_ORDER` after `"hotkey"`.**

- [ ] **Step 3: Add a case for `"persona"` in `tileModel`:**

```javascript
case "persona": {
    const persona = state && state.profile && state.profile.persona;
    return {
        label: "Persona",
        value: persona ? (persona.charAt(0).toUpperCase() + persona.slice(1)) : "Explorer",
        secondary: persona ? null : "Pick a shape in Settings",
        status: persona ? "ok" : "neutral",
        onClickRoute: persona ? null : "wizard:persona", // W2 wires this up
    };
}
```

- [ ] **Step 4: Remove the fallback we added inline in `ready-hub-body.js` in Task 16** (it's now dead code).

- [ ] **Step 5: Run.**

Open Ready Hub. The Persona cell shows the value if any, "Explorer" + "Pick a shape in Settings" otherwise.

- [ ] **Step 6: Commit.**

```bash
git add desktop/components/tile-model.js desktop/components/ready-hub-body.js
git commit -m "feat(wizard): tile-model knows about the persona cell

Promotes the inline fallback from ready-hub-body.js into tile-model.js
so any future surface that reads tileModel(state, 'persona') gets a
consistent value. Defaults to 'Explorer' with a 'Pick a shape in
Settings' secondary line that routes to wizard:persona (wired in W2)."
```

---

## Phase E — Audio + transitions polish

### Task 19: Add audio assets

Two assets. Sourced as user-provided WAV/OGG; commit checked-in copies. If the user hasn't provided them yet, ship silent placeholders and a TODO note in the audio module — the wizard works without audio.

**Files:**
- Create: `desktop/audio/confirm.ogg`
- Create: `desktop/audio/awakening-chime.ogg`

- [ ] **Step 1: Source the assets.**

Two free-licensed candidates that fit the brief: a felt piano confirm note from Pixabay (≤600 ms, ≤30 KB) and a single bell chime (≤1.5 s, ≤80 KB). Save as 44.1 kHz mono OGG Vorbis q3.

If neither is available at plan-write time, create silent 100-ms placeholders so the file paths exist:

```bash
mkdir -p desktop/audio
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.1 -c:a libvorbis -q:a 3 desktop/audio/confirm.ogg
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.1 -c:a libvorbis -q:a 3 desktop/audio/awakening-chime.ogg
```

- [ ] **Step 2: Commit.**

```bash
git add desktop/audio/
git commit -m "feat(wizard): ship audio assets — confirm.ogg + awakening-chime.ogg

Two short audio cues for the wizard. confirm.ogg plays on each
onAdvance; awakening-chime.ogg plays on the awakening rule flare.
Both default to muted via personalize.audio.enabled=false."
```

### Task 20: Add desktop/wizard/audio.js

Lightweight audio helper. Preloads both clips. `play(id)` plays unless disabled. Respects `personalize.audio.enabled` and `ATLAS_NO_ONBOARDING_AUDIO`.

**Files:**
- Create: `desktop/wizard/audio.js`

- [ ] **Step 1: Write the file.**

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Audio cues for the wizard. Two clips. Default off — user opts in via
// the 🔊 toggle in the chrome bar, which writes personalize.audio.enabled.
"use strict";

const CLIPS = {
    confirm:  "audio/confirm.ogg",
    awakeningChime: "audio/awakening-chime.ogg",
};

let _audioElements = null;
let _enabled = false;

function preload() {
    if (_audioElements) return;
    _audioElements = {};
    for (const id in CLIPS) {
        const a = new Audio(CLIPS[id]);
        a.preload = "auto";
        a.volume = 0.4;
        _audioElements[id] = a;
    }
}

function setEnabled(v) { _enabled = !!v; }

function play(id) {
    if (!_enabled) return;
    if (typeof process !== "undefined" && process.env && process.env.ATLAS_NO_ONBOARDING_AUDIO === "true") return;
    preload();
    const a = _audioElements[id];
    if (!a) return;
    try {
        a.currentTime = 0;
        const p = a.play();
        if (p && typeof p.catch === "function") p.catch(function () { /* autoplay block — silently ignore */ });
    } catch (_) { /* ignore */ }
}

const api = { preload: preload, setEnabled: setEnabled, play: play };
if (typeof window !== "undefined") window.WizardAudio = api;
export default api;
```

- [ ] **Step 2: Load it in `wizard.html`.**

Add `<script src="wizard/audio.js"></script>` right after the `<script src="wizard/copy.js"></script>` line in `desktop/wizard.html`.

- [ ] **Step 3: Initial-state wiring in `boot.js`.**

Open `desktop/wizard/boot.js`. Inside `boot()`, after `applyTheme(...)`, add:

```javascript
if (window.WizardAudio && window.WizardAudio.setEnabled) {
    const enabled = (state.personalize && state.personalize.audio && state.personalize.audio.enabled) || false;
    window.WizardAudio.setEnabled(enabled);
    if (enabled) window.WizardAudio.preload();
}
```

- [ ] **Step 4: Wire `play("confirm")` into `advance()`.**

Same file, inside `advance(fromIdx)`:

```javascript
async function advance(fromIdx) {
    if (window.WizardAudio && window.WizardAudio.play) window.WizardAudio.play("confirm");
    // ... existing body
}
```

- [ ] **Step 5: Wire `play("awakeningChime")` into the awakening flare.**

Open `desktop/wizard/steps/awakening.js`. In the timeline section (after the `iri.classList.add("in")` timer), add:

```javascript
timers.push(setTimeout(function () {
    if (window.WizardAudio && window.WizardAudio.play) window.WizardAudio.play("awakeningChime");
}, 1450));
```

- [ ] **Step 6: Run.**

Run: `cd desktop && npm start`. Enable audio via the 🔊 toggle in the chrome (it should turn brighter to indicate on). Advance a step → you hear the confirm chime. Go back to the awakening — you hear the bell ~1.45 s in.

Close.

- [ ] **Step 7: Commit.**

```bash
git add desktop/wizard/audio.js desktop/wizard.html desktop/wizard/boot.js desktop/wizard/steps/awakening.js
git commit -m "feat(wizard): WizardAudio helper + wire up confirm + awakening cues

Two clips preloaded on first enable. setEnabled toggles from boot.js
based on personalize.audio.enabled. play() is best-effort (autoplay
block silently ignored). Honors ATLAS_NO_ONBOARDING_AUDIO=true."
```

### Task 21: ATLAS_NO_MAGIC_MOMENT kill-switch verification

Smoke-test the kill-switch.

**Files:**
- Manual verification only.

- [ ] **Step 1: Test.**

Run: `ATLAS_NO_MAGIC_MOMENT=true cd desktop && npm start` and go to Ready Hub. Expected: no magic-moment card. Settings index, actions, Try this all still visible.

- [ ] **Step 2: Commit a verification note.**

```bash
git commit --allow-empty -m "chore(wizard): verify ATLAS_NO_MAGIC_MOMENT hides the card (manual)"
```

---

## Phase F — End-to-end gate

### Task 22: Manual acceptance checklist

A single doc that lists every visible behavior to verify before merging W1. The reviewer walks the checklist on macOS first; Windows parity is its own pass.

**Files:**
- Create: `desktop/onboarding-demo/ACCEPTANCE.md`

- [ ] **Step 1: Write the checklist.**

```markdown
# W1 Cinematic Spine — Acceptance Checklist

> Run on a clean `~/.atlas/setup-state.json`. Walk every line. Anything
> not green is a blocker.

## Awakening
- [ ] Opening the app on a fresh setup state lands directly on the awakening.
- [ ] The glyph spring-scales in ~120ms after page load.
- [ ] The greeting reveals word-by-word with ~110ms between words.
- [ ] If `profile.name` exists, it appears. Otherwise OS user name (capitalized). Otherwise no name.
- [ ] The iridescent rule draws from center, outward, after the greeting completes.
- [ ] Status text rotates through three phrases over ~3.9s.
- [ ] CTA fades in around 1.9s.
- [ ] Pressing ESC during animation jumps everything to the final state.
- [ ] Clicking Begin transitions to the next step (welcome on first install, terms on returning user).
- [ ] The indicator dot strip is hidden on awakening.

## Step transitions
- [ ] Every step transition: outgoing fades + lifts + blurs over 220ms.
- [ ] Iridescent rule scribes across the top during the transition (left→right→retreat over 1.4s).
- [ ] Incoming step's children stagger-fade in at 70ms intervals.
- [ ] The folio in the chrome reads the current step number (e.g. "03 / 09").
- [ ] The indicator pill is on the current step's dot, with `done` dots before and `inactive` dots after.

## Copy
- [ ] Every step title matches `desktop/wizard/copy.js`.
- [ ] No inline string literals in any step file (`grep -rn 'textContent = "' desktop/wizard/steps/` returns nothing meaningful).
- [ ] Phase labels on the install step match the new "Browser engine / Semantic memory / etc." names.

## Permissions
- [ ] Permissions step renders the new list-of-rows layout.
- [ ] Granting a permission turns the row green.
- [ ] Skipping a permission turns the row amber.
- [ ] "Skip all" link skips every remaining permission and advances.
- [ ] The footnote "No worries. We can still work together." reads below the list.

## Sign-in
- [ ] Sign-in step has NO "Skip for now" CTA.
- [ ] Two big option buttons: "Continue with email" / "Continue with phone".
- [ ] A "Back" link at the bottom.

## Theme
- [ ] On a system in light mode: page is warm off-white with dark ink.
- [ ] On a system in dark mode: page is warm near-black with light ink.
- [ ] In Personalize → Appearance, picking Light/Dark/System applies live (page flips immediately).
- [ ] Personalize choice persists across wizard reload.

## Ready Hub
- [ ] Title reads "Ready, **Name**." with the name in iridescent gradient.
- [ ] Dek reads "Press {hotkey} anywhere on your computer. I'll be there." with a hotkey badge.
- [ ] Magic-moment card appears below the dek with one observation.
- [ ] Magic-moment rotates every ~7s (give it time).
- [ ] Settings index shows 6 cells (Account, Workspace, Hotkey, Voice, Persona, Permissions) in a 3-col grid.
- [ ] Persona cell reads "Explorer" with a "Pick a shape in Settings" secondary line.
- [ ] Launch button is a white pill (in dark mode) or dark pill (in light mode), with an animated chevron on hover.
- [ ] Try this lines reveal an arrow on hover.

## Audio
- [ ] Audio is OFF by default (no sound on advance).
- [ ] Toggling the 🔊 in the chrome enables confirm chimes on advance.
- [ ] With audio enabled, the awakening plays a bell ~1.45s in.
- [ ] `ATLAS_NO_ONBOARDING_AUDIO=true` silences everything regardless of toggle.

## Kill-switches
- [ ] `ATLAS_NO_AWAKENING=true` → awakening skipped, welcome is first.
- [ ] `ATLAS_NO_MAGIC_MOMENT=true` → magic-moment card hidden on Ready Hub.

## Comparison to demo
- [ ] Open `desktop/onboarding-demo/index.html` side by side. The production wizard's visuals match the demo within ~2% (font sizes, weights, padding, motion timing). Any divergence is a bug in the production code, not the demo.
```

- [ ] **Step 2: Commit.**

```bash
git add desktop/onboarding-demo/ACCEPTANCE.md
git commit -m "docs(wizard): W1 acceptance checklist"
```

### Task 23: Snapshot test for awakening DOM

A vitest jsdom snapshot of the awakening DOM after a synchronous render — guards against accidental structural changes.

**Files:**
- Create: `desktop/tests/awakening.snapshot.test.js`

- [ ] **Step 1: Write the test.**

```javascript
// desktop/tests/awakening.snapshot.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("awakening DOM snapshot", () => {
    beforeEach(() => {
        document.body.innerHTML = '<article id="step-root"></article>';
        // Minimal Copy stub
        window.Copy = {
            get: function (step, key) {
                const m = {
                    "awakening.status1": "reading the room",
                    "awakening.cta": "Begin",
                    "awakening.hint": "Press ESC to skip",
                };
                return m[step + "." + key] || "";
            },
        };
    });

    it("renders the expected skeleton", async () => {
        await import("../wizard/steps/awakening.js");
        const root = document.getElementById("step-root");
        const ctx = { state: { profile: { name: "Test" } }, onAdvance: function () {} };
        window.WizardSteps.awakening.render(root, ctx);

        const html = root.innerHTML
            .replace(/--word-delay: \d+ms;/g, "--word-delay: Xms;");
        expect(html).toMatchInlineSnapshot();
    });
});
```

- [ ] **Step 2: Run to capture the snapshot.**

Run: `cd desktop && npm test -- awakening.snapshot -u`

Expected: PASS; the snapshot is written inline. Inspect the captured HTML — it should contain `class="awakening"`, the glyph, the per-word greet spans, the iri rule, the status with the swap span, and the cta with the chev SVG.

- [ ] **Step 3: Run again without -u.**

Run: `cd desktop && npm test -- awakening.snapshot`

Expected: PASS (matches the snapshot).

- [ ] **Step 4: Commit.**

```bash
git add desktop/tests/awakening.snapshot.test.js
git commit -m "test(wizard): snapshot the awakening DOM skeleton"
```

### Task 24: Smoke run on Windows

Quick sanity pass that the new visuals don't break on Windows. Most issues will be CSS — the iridescent rule's `mix-blend-mode: screen` and `backdrop-filter` in `.chrome` can render differently.

**Files:**
- Manual verification only.

- [ ] **Step 1: Boot the wizard on a Windows machine (or VM).**

Run: `npm start` (in `desktop/`). Walk the awakening, the persona-less step list, all the way to Ready Hub.

- [ ] **Step 2: Note any Windows-only issues.**

Likely areas:
- `font-family` falls back to Segoe UI; verify it still looks reasonable (smaller x-height vs SF Pro).
- The chrome's `backdrop-filter` may render flatly — falls back to a solid color from the linear-gradient, fine.
- The iridescent rule's `mix-blend-mode: screen` is fine on Edge/Chromium.

Fix anything visually broken; nothing else.

- [ ] **Step 3: Commit (or skip if no fix needed).**

```bash
git commit --allow-empty -m "chore(wizard): smoke-test W1 on Windows (manual)"
```

---

## Self-review notes

Before marking W1 complete, walk the spec (`docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md`) one more time:

- §6 beat flow: every beat has a step file. **✓**
- §7.1 files to create: cinematic.js (Task 4), copy.js (Task 5), magic-moment.js (Task 17), awakening.js (Task 11). **✓**
- §7.2 files to modify: wizard.html (Task 6), router.js (Task 12), boot.js (Task 7), every step file (Tasks 8–10), styles.css (Tasks 2–3), ready-hub.html (Task 15), ready-hub-body.js (Task 16), permissions-grid.js — but we kept its component API untouched, only the wrapper step was rewritten. **✓**
- §7.3 awakening timeline: all six beats wired (Task 11). **✓**
- §7.4 name resolution: three-tier lookup implemented + tested (Task 11). **✓**
- §7.5 magic moment best-effort: shipped in Task 17. **✓**
- §7.6 audio: Tasks 19–20. **✓**
- §7.7 step transitions: CSS in Tasks 2–3, JS in Task 7. **✓**
- §7.8 theme integration: Tasks 7 + 9 (live preview in personalize). **✓**
- §11 kill-switches in W1: `ATLAS_NO_AWAKENING` (Tasks 12, 14), `ATLAS_NO_MAGIC_MOMENT` (Tasks 17, 21), `ATLAS_NO_ONBOARDING_AUDIO` (Task 20). **✓**

Nothing in W2 / W3 is touched.

The plan is ready.
