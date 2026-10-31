> **Status: IMPLEMENTED IN CODE, NOT IN THE FIRST-RUN FLOW.** Persona bias and wizard seeding exist (`src/prompts/persona-bias.ts`, `src/setup/wizard-seed.ts`, used by `src/agent.ts`, `src/tool-router.ts`, `src/index.ts`), but the persona/personalize wizard steps are no longer shown: first run is three screens (`desktop/wizard/router.js`, commit `fd43afb`). Whether persona is still collected elsewhere (Settings) is unverified. Tests cited as `tests/setup/wizard-seed.test.ts` are at `src/setup/wizard-seed.test.ts`; `dynamic-assembler.ts`/`dynamic-context.ts` are under `src/prompts/` and `src/social/`.

# Onboarding Reimagined — Wave 2: Persona Specialization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Profile step's tone dropdown with a five-card Persona step. Persist `profile.persona` through the existing `saveProfile` IPC → electron-store → wizard-seed → identity store. At runtime, inject a persona identity line into the dynamic prompt and apply a multiplicative bias to tool-router category scores. All wired behind `BHAI_NO_PERSONA_BIAS`.

**Architecture:** No schema changes — `accounts` table in Convex has no `profile` column; persona persists locally in `~/Library/Application Support/atlas-desktop/config.json` via the existing IPC and is mirrored to bot memory via the existing `wizard-seed.ts` "extra" payload. Three integration points: (1) new step `desktop/wizard/steps/persona.js`, (2) new pure module `src/prompts/persona-bias.ts` with the identity-line table and the category-weight table, (3) read-only consumers in `src/prompts/dynamic-context.ts` (identity line) and `src/tool-router.ts:1145` (score overlay).

**Tech Stack:** Vanilla JS (renderer), TypeScript (Node main), vitest. Existing `Copy.get()` for all strings. CJS module pattern for the new renderer step (matches W1 convention).

**Spec:** `docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md` §8

**Predecessors:** W1 has landed on main (`94a67aa..2e83772`). Persona step is inserted between `profile` and `personalize` in the router.

> ⚠️ **Before starting Task 1, read §0 below.** It corrects three errors in the spec, fixes category-name mismatches, and locks the cross-task conventions established by W1.

## Phases at a glance

- **§0 — Conventions & spec corrections.** Read before Task 1.
- **Phase A — Renderer (Tasks 1–4).** `copy.js` entries → `persona.js` step → router insert → tests.
- **Phase B — Persistence (Tasks 5–7).** Profile step trims to name-only; saveProfile passes persona through; wizard-seed propagates persona into `identity.extra`.
- **Phase C — Agent integration (Tasks 8–13).** `persona-bias.ts` with both tables + tests, dynamic-assembler identity-line module, tool-router score overlay, two integration tests, kill-switch verification.
- **Phase D — End-to-end gate (Tasks 14–16).** Manual acceptance checklist, full desktop + node test runs, smoke trip through the .app.

---

## §0 — Conventions & spec corrections

These rules override anything in the task bodies if they conflict.

### Spec corrections (the spec is wrong about three things)

1. **No Convex schema change.** Spec §8.4 says "extend `accounts.profile` validator." Reality: `convex/schema.ts` `accounts` table has NO `profile` field — it has `otplessUserId/email/phone/name/status/plan/ai_credits/activations/max_activations`. Persona persists locally in electron-store via the existing `saveProfile` IPC. This plan does NOT touch `convex/schema.ts`.

2. **Tool-router category IDs.** Spec §8.3 names `code/git/email/calendar/media/research/citation/...` — those don't exist. Real category names from `src/tool-router.ts` are: `core, memory, shell, file_system, coding, browser, web_search, os_control, system_controls, media, video_editing, presentation, communication, scheduling, app_management, research, long_tasks, google_api, github, code_execution, codebase, tool_creation, document, marketing`. The persona-bias weight maps use these real IDs.

3. **Runtime read path.** Spec §8.4 says `dynamic-assembler.ts` reads `profile.persona`. Reality: `assembleDynamicPrompt(ctx)` takes a `PromptContext` and is called via `buildDynamicContextReminder(userMessage, opts)` in `dynamic-context.ts`. The cleanest place to read `profile.persona` is `src/agent.ts:1707` where `buildDynamicContextReminder` is invoked. We extend `PromptContext` with `persona?: Persona`, extend `DynamicContextOpts` with the same, and have `agent.ts` pull `persona` from `getIdentityProfile().extra?.persona`.

### Cross-task conventions (from W1)

1. **CJS dual loading** for `desktop/wizard/*.js`: `if (typeof window !== "undefined") window.X = api; if (typeof module !== "undefined" && module.exports) module.exports = {...};`. No ESM `export const` in renderer files.

2. **Tests that touch DOM** need `// @vitest-environment jsdom` on line 1.

3. **gitignore carve-outs**: every new test file under `desktop/tests/` needs a `!desktop/tests/<file>.test.js` line in `.gitignore` next to the existing W1 entries.

4. **Persona is canonical lowercase**: `"developer" | "founder" | "creator" | "researcher" | "explorer"`. Type alias is `Persona`.

5. **Tone defaults per persona**: developer/founder/researcher → `"professional"`, creator/explorer → `"friendly"`. The Profile step computes this only when the user hasn't explicitly set tone via the Personalize → Personality preset.

6. **Kill-switch**: `BHAI_NO_PERSONA_BIAS=true` disables BOTH the identity-line injection AND the tool-router overlay. The Persona step still saves; it just doesn't get consumed.

7. **No `Co-Authored-By: Claude` attribution** in commits per user's persistent memory.

### Real category IDs for persona-bias

```
developer   → { coding: 1.35, codebase: 1.30, shell: 1.25, code_execution: 1.25, github: 1.20, browser: 1.10 }
founder     → { scheduling: 1.30, communication: 1.30, research: 1.20, document: 1.20, google_api: 1.20 }
creator     → { media: 1.30, video_editing: 1.30, presentation: 1.25, file_system: 1.15, marketing: 1.25 }
researcher  → { research: 1.40, web_search: 1.30, browser: 1.20, codebase: 1.10, memory: 1.15, document: 1.20 }
explorer    → {} (empty — no bias)
```

All weights in `[0.7, 1.4]`. Default (categories not in map) → `1.0`. Multiplied into the score AFTER cosine ranking but BEFORE final sort.

### Files this plan creates or modifies

| File | Status | Purpose |
|---|---|---|
| `desktop/wizard/copy.js` | modify | add `persona.title/sub/eyebrow` + 5 persona card entries |
| `desktop/wizard/steps/persona.js` | create | the new step renderer |
| `desktop/wizard/steps/profile.js` | modify | drop tone dropdown (it was already name-only post-W1; verify) |
| `desktop/wizard/router.js` | modify | insert `"persona"` between `profile` and `personalize` |
| `desktop/wizard.html` | modify | load `<script src="wizard/steps/persona.js">` |
| `desktop/main.js` | modify | extend `setup:save-profile` IPC handler to accept `persona` field |
| `desktop/tests/wizard.persona.test.js` | create | step renders, click writes state, tone default applied |
| `desktop/components/tile-model.js` | modify | already has persona case from W1 Task 18 — just verify, no code change |
| `src/prompts/persona-bias.ts` | create | pure module: `getPersonaIdentityLine` + `getPersonaToolWeights` + types |
| `src/prompts/persona-bias.test.ts` | create | unit tests for both functions |
| `src/prompts/dynamic-assembler.ts` | modify | extend `PromptContext` with `persona`; add persona_identity module |
| `src/prompts/dynamic-context.ts` | modify | extend `DynamicContextOpts` with `persona`; thread it into ctx |
| `src/agent.ts` | modify | pull persona from identity store; pass into `buildDynamicContextReminder` |
| `src/setup/wizard-seed.ts` | modify | add persona to the `known` set + lift it into a structured field |
| `src/tool-router.ts` | modify | apply persona weight overlay at line ~1145 (before final sort) |
| `src/tool-router.persona.test.ts` | create | persona=developer ranks coding higher; persona=null ordering unchanged |
| `.gitignore` | modify | add carve-outs for new test files |

---

## Phase A — Renderer (Tasks 1–4)

### Task 1: Add persona copy entries to `desktop/wizard/copy.js`

**Files:**
- Modify: `desktop/wizard/copy.js`

- [ ] **Step 1: Read the existing copy.js to confirm format.**

Run: `grep -A 5 '"persona":' desktop/wizard/copy.js`

Expected output: the existing persona block from W1 with `eyebrow`, `title`, `sub` — nothing else.

- [ ] **Step 2: Replace the persona block with the full set of card strings.**

Open `desktop/wizard/copy.js`. Find the `"persona": {` block (it's a small 3-key object from W1) and replace its body with this expanded version:

```javascript
    "persona": {
        "eyebrow": "How you work",
        "title": "Pick a starting shape.",
        "sub": "Shapes the examples I show, the tools I prioritize, and the way I talk. You can change this anytime.",

        // Developer
        "developer_title":  "Developer",
        "developer_desc":   "Terminal-first. Code-aware. Speaks git.",
        "developer_cap_1":  "Codebase memory across sessions",
        "developer_cap_2":  "Shell + IDE awareness",
        "developer_cap_3":  "Debug, review, and ship faster",

        // Founder
        "founder_title":    "Founder",
        "founder_desc":     "Calendar, comms, decisions. Move fast.",
        "founder_cap_1":    "Meeting summaries + decision log",
        "founder_cap_2":    "Calendar + email orchestration",
        "founder_cap_3":    "Research → decision in minutes",

        // Creator
        "creator_title":    "Creator",
        "creator_desc":     "Ideas, media, drafts. Make things.",
        "creator_cap_1":    "References + mood organized",
        "creator_cap_2":    "Script + caption generation",
        "creator_cap_3":    "Asset corral across tools",

        // Researcher
        "researcher_title": "Researcher",
        "researcher_desc":  "Sources, citations, synthesis.",
        "researcher_cap_1": "Deep research across 500+ sources",
        "researcher_cap_2": "Credibility-scored citations",
        "researcher_cap_3": "Hypothesis tracking",

        // Explorer — the no-bias option
        "explorer_title":   "Explorer",
        "explorer_desc":    "Not sure yet — I'll learn as we go.",
        "explorer_cap_1":   "No bias applied",
        "explorer_cap_2":   "Adapts from your behavior",
        "explorer_cap_3":   "You can pick a path later",
    },
```

- [ ] **Step 3: Run the copy test.**

Run: `cd desktop && npm test -- copy`

Expected: all 4 tests pass (the existing tests don't check persona-specific keys, just structure).

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard/copy.js
git commit -m "feat(wizard): persona copy — 5 cards × (title, desc, 3 capability lines)

Expands the persona block in copy.js with five complete personas:
developer / founder / creator / researcher / explorer. Each card has
a title, one-line description, and three capability previews.
Consumed by desktop/wizard/steps/persona.js in Task 2."
```

---

### Task 2: Create the persona step renderer

**Files:**
- Create: `desktop/wizard/steps/persona.js`

- [ ] **Step 1: Write the step file.**

Create `desktop/wizard/steps/persona.js`:

```javascript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Persona step — five cards in a 2×3 grid (explorer spans both columns
// at the bottom). Selecting a card writes profile.persona via
// bhai.saveProfile. Tone defaults to professional or friendly per
// persona, but only if the user hasn't explicitly set tone in
// Personalize → Personality (preserved in profile.tone if present).
(function () {
    "use strict";

    /* Persona definitions — IDs match the canonical Persona type in
       src/prompts/persona-bias.ts. Add a new persona here AND in
       persona-bias.ts (identity line + weight map). */
    const PERSONAS = ["developer", "founder", "creator", "researcher", "explorer"];

    /* Tone defaults — developer/founder/researcher feel professional;
       creator/explorer feel friendly. Used only when profile.tone isn't
       already set by the Personalize → Personality step. */
    const TONE_DEFAULTS = {
        developer:  "professional",
        founder:    "professional",
        researcher: "professional",
        creator:    "friendly",
        explorer:   "friendly",
    };

    function svgChev() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>';
    }

    function buildCard(personaId, isSelected) {
        const Copy = window.Copy;
        const wrap = document.createElement("button");
        wrap.type = "button";
        wrap.className = "persona-card" + (isSelected ? " active" : "")
                       + (personaId === "explorer" ? " persona-explorer" : "");
        wrap.setAttribute("data-persona-id", personaId);

        const title = document.createElement("h3");
        title.className = "persona-card-title";
        title.textContent = Copy.get("persona", personaId + "_title") || personaId;
        wrap.appendChild(title);

        const desc = document.createElement("p");
        desc.className = "persona-card-desc";
        desc.textContent = Copy.get("persona", personaId + "_desc") || "";
        wrap.appendChild(desc);

        const caps = document.createElement("ul");
        caps.className = "persona-card-caps";
        for (let i = 1; i <= 3; i++) {
            const li = document.createElement("li");
            li.textContent = Copy.get("persona", personaId + "_cap_" + i) || "";
            caps.appendChild(li);
        }
        wrap.appendChild(caps);

        return wrap;
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const state = (ctx && ctx.state) || {};
        const profile = state.profile || {};
        const currentPersona = profile.persona || null;

        const section = document.createElement("section");
        section.className = "step step-persona";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + (Copy.get("persona", "eyebrow") || "How you work");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("persona", "title") || "Pick a starting shape.";
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("persona", "sub") || "";
        section.appendChild(sub);

        // Grid of cards. State lives in `selected`. Click handlers rerender
        // by toggling active class — no full re-render needed since the
        // grid structure is fixed.
        let selected = currentPersona;
        const grid = document.createElement("div");
        grid.className = "persona-grid";

        const cardEls = {};
        for (const pid of PERSONAS) {
            const card = buildCard(pid, selected === pid);
            card.addEventListener("click", function () {
                if (selected === pid) return;
                // Clear previous active
                if (selected && cardEls[selected]) cardEls[selected].classList.remove("active");
                selected = pid;
                card.classList.add("active");
                cta.disabled = false;
            });
            cardEls[pid] = card;
            grid.appendChild(card);
        }
        section.appendChild(grid);

        // Action row
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-text";
        back.textContent = "Back";
        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });
        const grow = document.createElement("div");
        grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev">' + svgChev() + '</span>';
        cta.disabled = !selected;
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
            if (!selected) return;
            cta.disabled = true;
            err.textContent = "";

            const existingTone = profile.tone;
            const tone = existingTone || TONE_DEFAULTS[selected] || "friendly";
            const existingName = profile.name || "";

            if (!window.bhai || typeof window.bhai.saveProfile !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                cta.disabled = false;
                return;
            }

            const payload = {
                name: existingName,
                tone: tone,
                persona: selected,
                personaConfidence: 1.0,
                personaSelectedAt: Date.now(),
            };

            let res;
            try { res = await window.bhai.saveProfile(payload); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); cta.disabled = false; return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                cta.disabled = false;
                return;
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    if (typeof window !== "undefined") {
        window.WizardSteps = window.WizardSteps || {};
        window.WizardSteps.persona = { render: render };
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, _internals: { PERSONAS: PERSONAS, TONE_DEFAULTS: TONE_DEFAULTS, buildCard: buildCard } };
    }
})();
```

- [ ] **Step 2: Verify syntax.**

Run: `node -c desktop/wizard/steps/persona.js`

Expected: silent (no errors).

- [ ] **Step 3: Commit.**

```bash
git add desktop/wizard/steps/persona.js
git commit -m "feat(wizard): persona step renderer

Five-card grid (developer/founder/creator/researcher/explorer).
Click selects; Continue calls bhai.saveProfile with {name, tone,
persona, personaConfidence, personaSelectedAt}. Tone defaults to
'professional' for developer/founder/researcher, 'friendly' for
creator/explorer — but only if profile.tone isn't already set.
Pure renderer; no state held outside the closure."
```

---

### Task 3: Insert persona into the router + load script tag

**Files:**
- Modify: `desktop/wizard/router.js`
- Modify: `desktop/wizard.html`

- [ ] **Step 1: Edit `desktop/wizard/router.js`.**

Open the file and find the `ALL_STEPS` constant near the top. Replace it:

```javascript
const ALL_STEPS = ["awakening", "welcome", "terms", "signin", "profile", "persona", "personalize", "permissions", "vision-tier", "install"];
```

Then find `getSteps(state)`. Add a line for persona between profile and personalize:

```javascript
function getSteps(state) {
    const s = state || {};
    const header = s.isReconfigure ? "Reconfigure" : "Welcome";
    const out = [];
    const signedIn = s.account && s.account.signedIn;

    if (needsAwakening(s)) out.push("awakening");
    if (needsTerms(s) || s.isReconfigure) out.push("terms");
    if (!signedIn || s.isReconfigure) out.push("signin");
    out.push("profile");
    out.push("persona");       // ← NEW: Wave 2 persona step
    out.push("personalize");
    if (s.platform !== "win32") out.push("permissions");
    out.push("vision-tier");
    if (s.isReconfigure || needsInstall(s)) out.push("install");
    return { steps: out, header };
}
```

- [ ] **Step 2: Edit `desktop/wizard.html` — add a script tag for persona.js.**

Find the block of `<script src="wizard/steps/*.js">` tags. Add the persona line BETWEEN `profile.js` and `personalize.js`:

```html
<script src="wizard/steps/profile.js"></script>
<script src="wizard/steps/persona.js"></script>
<script src="wizard/steps/personalize.js"></script>
```

- [ ] **Step 3: Sanity check.**

Run: `grep -n 'persona' desktop/wizard.html desktop/wizard/router.js`

Expected: `persona.js` shows in wizard.html; `"persona"` in both `ALL_STEPS` and `getSteps` in router.js.

- [ ] **Step 4: Commit.**

```bash
git add desktop/wizard/router.js desktop/wizard.html
git commit -m "feat(wizard): insert persona step in router + load script

ALL_STEPS now includes 'persona' between 'profile' and 'personalize'.
getSteps emits it on every install (first-install + reconfigure)
since 'show every step' is the W1-established cadence."
```

---

### Task 4: Test the persona step renderer

**Files:**
- Create: `desktop/tests/wizard.persona.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Add the gitignore carve-out.**

Open `.gitignore`. Find the existing carve-outs for desktop tests (around line 185 — `!desktop/tests/cinematic.test.js` etc.). Add a new line adjacent to them:

```
!desktop/tests/wizard.persona.test.js
```

- [ ] **Step 2: Write the test.**

Create `desktop/tests/wizard.persona.test.js`:

```javascript
// @vitest-environment jsdom
// Tests the persona step renderer + selection state + payload shape.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Helper: load the IIFE-wrapped step into the jsdom window.
async function loadPersonaStep() {
    document.body.innerHTML = '<div id="step-root"></div>';
    window.Copy = {
        _data: {
            persona: {
                eyebrow: "How you work",
                title: "Pick a starting shape.",
                sub: "Shapes the examples I show.",
                developer_title: "Developer", developer_desc: "Terminal-first.",
                developer_cap_1: "Codebase memory", developer_cap_2: "Shell + IDE", developer_cap_3: "Debug fast",
                founder_title: "Founder", founder_desc: "Calendar, comms.",
                founder_cap_1: "Meeting summaries", founder_cap_2: "Calendar + email", founder_cap_3: "Research to decision",
                creator_title: "Creator", creator_desc: "Ideas, media.",
                creator_cap_1: "References", creator_cap_2: "Script generation", creator_cap_3: "Asset corral",
                researcher_title: "Researcher", researcher_desc: "Sources.",
                researcher_cap_1: "Deep research", researcher_cap_2: "Citations", researcher_cap_3: "Hypothesis",
                explorer_title: "Explorer", explorer_desc: "Not sure yet.",
                explorer_cap_1: "No bias", explorer_cap_2: "Adapts", explorer_cap_3: "Pick later",
            },
        },
        get(stepId, key) { return (this._data[stepId] && this._data[stepId][key]) || null; },
    };
    window.WizardSteps = {};
    // Re-import so the IIFE re-registers (the IIFE runs on module load).
    delete require.cache[require.resolve("../wizard/steps/persona.js")];
    await import("../wizard/steps/persona.js?" + Date.now());
}

describe("persona step — render", () => {
    beforeEach(async () => { await loadPersonaStep(); });

    it("renders five persona cards", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const cards = root.querySelectorAll(".persona-card");
        expect(cards.length).toBe(5);
        const ids = Array.from(cards).map((c) => c.getAttribute("data-persona-id"));
        expect(ids).toEqual(["developer", "founder", "creator", "researcher", "explorer"]);
    });

    it("Continue is disabled until a card is selected", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const cta = root.querySelector(".step-actions .btn-primary");
        expect(cta.disabled).toBe(true);
        const devCard = root.querySelector('[data-persona-id="developer"]');
        devCard.click();
        expect(cta.disabled).toBe(false);
        expect(devCard.classList.contains("active")).toBe(true);
    });

    it("clicking a different card moves active state", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: {} } });
        const dev = root.querySelector('[data-persona-id="developer"]');
        const founder = root.querySelector('[data-persona-id="founder"]');
        dev.click(); founder.click();
        expect(dev.classList.contains("active")).toBe(false);
        expect(founder.classList.contains("active")).toBe(true);
    });

    it("pre-selects the persona from state.profile.persona", () => {
        const root = document.getElementById("step-root");
        window.WizardSteps.persona.render(root, { state: { profile: { persona: "researcher" } } });
        const researcher = root.querySelector('[data-persona-id="researcher"]');
        expect(researcher.classList.contains("active")).toBe(true);
    });
});

describe("persona step — Continue payload", () => {
    beforeEach(async () => { await loadPersonaStep(); });

    it("calls bhai.saveProfile with the expected shape", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        const onAdvance = vi.fn();
        const refreshState = vi.fn().mockResolvedValue(undefined);
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: { name: "Dheeraj" } },
            onAdvance, refreshState,
        });
        root.querySelector('[data-persona-id="developer"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        // Wait one microtask for the async handler
        await new Promise((r) => setTimeout(r, 10));
        expect(saveProfile).toHaveBeenCalledTimes(1);
        const payload = saveProfile.mock.calls[0][0];
        expect(payload.name).toBe("Dheeraj");
        expect(payload.persona).toBe("developer");
        expect(payload.tone).toBe("professional");   // developer default
        expect(payload.personaConfidence).toBe(1.0);
        expect(typeof payload.personaSelectedAt).toBe("number");
        expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    it("preserves existing tone if profile.tone is already set", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: { name: "X", tone: "playful" } },
            onAdvance: () => {}, refreshState: async () => {},
        });
        root.querySelector('[data-persona-id="developer"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        await new Promise((r) => setTimeout(r, 10));
        expect(saveProfile.mock.calls[0][0].tone).toBe("playful");  // NOT overridden
    });

    it("creator defaults tone to friendly", async () => {
        const root = document.getElementById("step-root");
        const saveProfile = vi.fn().mockResolvedValue({ success: true });
        window.bhai = { saveProfile };
        window.WizardSteps.persona.render(root, {
            state: { profile: {} },
            onAdvance: () => {}, refreshState: async () => {},
        });
        root.querySelector('[data-persona-id="creator"]').click();
        root.querySelector(".step-actions .btn-primary").click();
        await new Promise((r) => setTimeout(r, 10));
        expect(saveProfile.mock.calls[0][0].tone).toBe("friendly");
    });
});

describe("persona step — _internals export", () => {
    it("exposes PERSONAS and TONE_DEFAULTS", async () => {
        const mod = await import("../wizard/steps/persona.js");
        const internals = mod.default._internals || mod._internals;
        expect(internals.PERSONAS).toEqual(["developer", "founder", "creator", "researcher", "explorer"]);
        expect(internals.TONE_DEFAULTS.developer).toBe("professional");
        expect(internals.TONE_DEFAULTS.creator).toBe("friendly");
    });
});
```

- [ ] **Step 3: Run the test.**

Run: `cd desktop && npm test -- wizard.persona`

Expected: all 8 tests pass (5 render, 3 payload, 1 internals).

- [ ] **Step 4: Run the full desktop test suite to confirm no regressions.**

Run: `cd desktop && npm test`

Expected: total = 35 (W1) + 8 (new persona) = 43 tests passing.

- [ ] **Step 5: Commit.**

```bash
git add desktop/tests/wizard.persona.test.js .gitignore
git commit -m "test(wizard): persona step — render, selection, payload shape

9 tests: 4 render (card count, disabled CTA, click cycling,
pre-select from state), 3 payload (full shape, tone preservation,
creator → friendly default), 1 internals export. Adds gitignore
carve-out adjacent to existing W1 test files."
```

---

## Phase B — Persistence (Tasks 5–7)

### Task 5: Verify profile.js is name-only (it already should be from W1)

**Files:**
- Inspect: `desktop/wizard/steps/profile.js` (no change expected)

- [ ] **Step 1: Confirm profile.js holds no tone selector.**

Run: `grep -nE "tone|select|TONE" desktop/wizard/steps/profile.js`

Expected: at most a few references to `existingTone` or similar pass-through code, but NO `<select>` element, NO `ALLOWED_TONES` constant, NO tone radio buttons. The W1 Task 9 commit dropped the tone dropdown.

- [ ] **Step 2: If non-empty output above shows actual UI for tone, stop and read the W1 plan §Task 9 to confirm the expected post-state.**

If profile.js is in the expected post-W1 state (name input + Back/Continue only), proceed. If somehow the tone UI is still there, restore profile.js to its expected state by copying the contents from the W1 plan's Task 9 Step 1 verbatim (the plan is at `docs/superpowers/plans/2026-05-16-onboarding-w1-cinematic-spine.md`).

- [ ] **Step 3: No commit needed (verification only).**

Move directly to Task 6.

---

### Task 6: Wire the saveProfile IPC handler to accept persona fields

**Files:**
- Modify: `desktop/main.js` (the `setup:save-profile` or `saveProfile` IPC handler)

- [ ] **Step 1: Locate the saveProfile handler.**

Run: `grep -n 'saveProfile\|setup:save-profile\|"save-profile"' desktop/main.js | head -10`

Expected: shows an `ipcMain.handle("save-profile", ...)` or similar registration, and the `prefs.profile` write inside it.

- [ ] **Step 2: Read the handler and extend the persisted shape.**

Open `desktop/main.js`. Find the handler that responds to the `saveProfile` IPC. It currently writes `{name, tone}` to `electron-store` under `prefs.profile`. We extend it to also accept and persist `persona`, `personaConfidence`, `personaSelectedAt`.

Locate the block (it will look something like this — exact line numbers vary):

```javascript
ipcMain.handle("save-profile", async (_e, payload) => {
    const profile = store.get("prefs.profile") || {};
    if (payload && typeof payload.name === "string") profile.name = payload.name.trim();
    if (payload && typeof payload.tone === "string") profile.tone = payload.tone.trim();
    store.set("prefs.profile", profile);
    // Mirror to bot via wizard-seed reseed if running
    return { success: true };
});
```

Replace its body with:

```javascript
ipcMain.handle("save-profile", async (_e, payload) => {
    const profile = store.get("prefs.profile") || {};
    if (payload && typeof payload.name === "string") profile.name = payload.name.trim();
    if (payload && typeof payload.tone === "string") profile.tone = payload.tone.trim();

    // ── W2: persona is a stable enum; validate before persisting so a
    //         garbage write can't poison the agent's tool-router weights.
    const VALID_PERSONAS = ["developer", "founder", "creator", "researcher", "explorer"];
    if (payload && typeof payload.persona === "string"
        && VALID_PERSONAS.indexOf(payload.persona) >= 0) {
        profile.persona = payload.persona;
        profile.personaConfidence = typeof payload.personaConfidence === "number"
            ? Math.max(0, Math.min(1, payload.personaConfidence))
            : 1.0;
        profile.personaSelectedAt = typeof payload.personaSelectedAt === "number"
            ? payload.personaSelectedAt
            : Date.now();
    }

    store.set("prefs.profile", profile);
    return { success: true };
});
```

(If the existing handler has additional post-save logic — e.g. calling `setupReseedNow()` or `kickWizardSeed()` — preserve that AFTER the `store.set`. Don't drop existing behavior.)

- [ ] **Step 3: Sanity check.**

Run: `node -c desktop/main.js`

Expected: silent.

- [ ] **Step 4: Commit.**

```bash
git add desktop/main.js
git commit -m "feat(setup): saveProfile IPC accepts persona fields

Extends the existing save-profile handler to also persist
profile.persona / personaConfidence / personaSelectedAt to
electron-store. Validates persona against a fixed enum so a bad
payload can't poison runtime tool-router weights. No new IPC
channel — same handler, same shape, additive fields."
```

---

### Task 7: Propagate persona through wizard-seed → identity.extra

**Files:**
- Modify: `src/setup/wizard-seed.ts`

- [ ] **Step 1: Read the current wizard-seed.**

Run: `grep -A 15 'buildIdentityUpdate' src/setup/wizard-seed.ts | head -30`

Expected: the `buildIdentityUpdate` function which already passes unknown keys into `extra`. We make `persona` a known structured field instead of falling through into `extra` (cleaner: lets the agent read `identity.persona` directly).

- [ ] **Step 2: Edit `src/setup/wizard-seed.ts`.**

Find the `buildIdentityUpdate` function. It currently has:

```typescript
const known = new Set(["name", "tone"]);
```

Replace that line and the surrounding block with the persona-aware version:

```typescript
// W2: persona is a stable enum that affects runtime prompt + tool-router.
// Pull it out of the "extra" bucket so consumers can read identity.persona
// directly via getIdentityProfile().
const PERSONA_VALUES = new Set(["developer", "founder", "creator", "researcher", "explorer"]);
if (typeof profile.persona === "string" && PERSONA_VALUES.has(profile.persona)) {
    update.persona = profile.persona;
}
if (typeof profile.personaConfidence === "number") {
    update.personaConfidence = profile.personaConfidence;
}
if (typeof profile.personaSelectedAt === "number") {
    update.personaSelectedAt = profile.personaSelectedAt;
}

const known = new Set(["name", "tone", "persona", "personaConfidence", "personaSelectedAt"]);
```

Also extend the `buildIdentityUpdate` return-type:

```typescript
export function buildIdentityUpdate(profile: WizardProfileShape): {
    name?: string;
    preferences?: { communication_style?: string };
    persona?: string;
    personaConfidence?: number;
    personaSelectedAt?: number;
    extra?: Record<string, unknown>;
} {
```

And extend `WizardProfileShape` near the top of the file to declare the new fields:

```typescript
export interface WizardProfileShape {
    name?: string;
    tone?: string;
    persona?: string;
    personaConfidence?: number;
    personaSelectedAt?: number;
    [key: string]: unknown;
}
```

(If `WizardProfileShape` already has `[key: string]: unknown` it will compile without the explicit fields — but listing them makes the contract obvious to readers.)

- [ ] **Step 3: Run the existing wizard-seed tests.**

Run: `npm test -- wizard-seed 2>&1 | tail -10`

Expected: existing tests pass (the new fields are additive).

If `npm test` requires root deps and you don't have them, run `npx vitest run --root . tests/setup/wizard-seed.test.ts` directly — but `npm test` is the supported entrypoint per CLAUDE.md. If the env blocks tests due to the `~/.npm` cache permission issue from W1 build-mac, fall back to syntax check only: `node --check src/setup/wizard-seed.ts` (note: `tsc --noEmit` is more thorough — `npm run typecheck`).

- [ ] **Step 4: Add a wizard-seed unit test for the persona case.**

Find the existing `wizard-seed.test.ts` (probably `tests/setup/wizard-seed.test.ts` or similar). Add to it:

```typescript
describe("buildIdentityUpdate — persona", () => {
    it("lifts persona out of extra and into a structured field", () => {
        const out = buildIdentityUpdate({
            name: "Dheeraj",
            tone: "professional",
            persona: "developer",
            personaConfidence: 1.0,
            personaSelectedAt: 1715800000000,
        });
        expect(out.persona).toBe("developer");
        expect(out.personaConfidence).toBe(1.0);
        expect(out.personaSelectedAt).toBe(1715800000000);
        // Persona should NOT also appear in extra (we lifted it out).
        expect(out.extra?.persona).toBeUndefined();
    });

    it("ignores invalid persona values", () => {
        const out = buildIdentityUpdate({
            name: "X",
            persona: "totally-bogus" as string,
        });
        expect(out.persona).toBeUndefined();
    });

    it("works without persona (W1-only profile shape)", () => {
        const out = buildIdentityUpdate({ name: "X", tone: "friendly" });
        expect(out.persona).toBeUndefined();
        expect(out.name).toBe("X");
        expect(out.preferences?.communication_style).toBe("friendly");
    });
});
```

- [ ] **Step 5: Run the new tests.**

Run: `npm test -- wizard-seed`

Expected: 3 new tests pass, plus all existing.

- [ ] **Step 6: Commit.**

```bash
git add src/setup/wizard-seed.ts tests/setup/wizard-seed.test.ts
git commit -m "feat(setup): wizard-seed propagates persona to identity store

buildIdentityUpdate now lifts persona / personaConfidence /
personaSelectedAt out of the extra bucket into structured fields so
runtime consumers (dynamic-assembler, tool-router) can read
identity.persona directly. Validates persona against the canonical
enum; bad values are dropped. Backwards compatible: profiles
without persona behave exactly as before."
```

---

## Phase C — Agent integration (Tasks 8–13)

### Task 8: Create `src/prompts/persona-bias.ts` (the canonical persona effects)

**Files:**
- Create: `src/prompts/persona-bias.ts`

- [ ] **Step 1: Write the module.**

Create `src/prompts/persona-bias.ts`:

```typescript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

/**
 * ── Persona Bias ────────────────────────────────────────────────
 * Canonical source of truth for how each onboarding-selected persona
 * affects runtime behaviour. Two pure functions, both no-side-effects:
 *
 *   getPersonaIdentityLine(p)   → string injected into dynamic prompt
 *   getPersonaToolWeights(p)    → category → multiplier map for tool router
 *
 * Both consumers gate their use behind BHAI_NO_PERSONA_BIAS=true.
 * Persona is stored in identity profile (set during wizard) and read
 * once per agent turn — see src/agent.ts and src/tool-router.ts.
 */

export type Persona = "developer" | "founder" | "creator" | "researcher" | "explorer";

export const PERSONA_VALUES: readonly Persona[] = [
    "developer", "founder", "creator", "researcher", "explorer",
];

/** Narrow a possibly-unknown value to a Persona. Returns null if invalid. */
export function asPersona(v: unknown): Persona | null {
    if (typeof v !== "string") return null;
    return (PERSONA_VALUES as readonly string[]).indexOf(v) >= 0
        ? (v as Persona)
        : null;
}

// ── Identity lines ──────────────────────────────────────────────
// One-sentence soft preferences injected into the dynamic-context block
// on the first iteration of each conversation. Each line is < 30 tokens
// to keep the prompt budget tight (assembleDynamicPrompt has a 500-token
// total budget; this module reserves ~30).

const IDENTITY_LINES: Record<Persona, string> = {
    developer:
        "The user describes themselves as a developer. Bias toward terminal output, code-level explanations, and assume git/CLI familiarity.",
    founder:
        "The user describes themselves as a founder. Prefer concise, decision-oriented answers; surface tradeoffs early; keep emails and calendar work tight.",
    creator:
        "The user describes themselves as a creator. Be visually fluent, suggest concrete creative angles, and treat references and assets as first-class objects.",
    researcher:
        "The user describes themselves as a researcher. Cite sources, flag confidence, prefer breadth then depth, and surface contradictions and gaps.",
    explorer:
        "",  // Explorer means "no bias" — empty string signals "skip injection".
};

export function getPersonaIdentityLine(persona: Persona | null | undefined): string | null {
    if (!persona) return null;
    const line = IDENTITY_LINES[persona];
    return line && line.length > 0 ? line : null;
}

// ── Tool-router weights ─────────────────────────────────────────
// Multiplicative bias applied AFTER cosine scoring, BEFORE the final
// top-K sort. Category IDs MUST match those in src/tool-router.ts
// (real names — verified against the registry on 2026-05-17). All
// weights in [0.7, 1.4]; default for unlisted categories is 1.0.

type CategoryId = string;
type WeightMap = Readonly<Record<CategoryId, number>>;

const EMPTY: WeightMap = Object.freeze({});

const WEIGHTS: Readonly<Record<Persona, WeightMap>> = {
    developer: Object.freeze({
        coding:         1.35,
        codebase:       1.30,
        shell:          1.25,
        code_execution: 1.25,
        github:         1.20,
        browser:        1.10,
    }),
    founder: Object.freeze({
        scheduling:     1.30,
        communication:  1.30,
        research:       1.20,
        document:       1.20,
        google_api:     1.20,
    }),
    creator: Object.freeze({
        media:          1.30,
        video_editing:  1.30,
        presentation:   1.25,
        file_system:    1.15,
        marketing:      1.25,
    }),
    researcher: Object.freeze({
        research:       1.40,
        web_search:     1.30,
        browser:        1.20,
        codebase:       1.10,
        memory:         1.15,
        document:       1.20,
    }),
    explorer: EMPTY,
};

export function getPersonaToolWeights(persona: Persona | null | undefined): WeightMap {
    if (!persona) return EMPTY;
    return WEIGHTS[persona] || EMPTY;
}

/** Convenience: multiply a single category's score by the persona's weight. */
export function applyPersonaWeight(
    persona: Persona | null | undefined,
    category: CategoryId,
    score: number,
): number {
    const weights = getPersonaToolWeights(persona);
    const w = weights[category];
    return typeof w === "number" ? score * w : score;
}
```

- [ ] **Step 2: Type-check.**

Run: `npm run typecheck 2>&1 | grep -E "persona-bias\.ts" | head -5`

Expected: no errors involving `persona-bias.ts`.

- [ ] **Step 3: Commit.**

```bash
git add src/prompts/persona-bias.ts
git commit -m "feat(prompts): persona-bias module — identity lines + weight maps

Pure module. Two consumers will land in subsequent tasks:
dynamic-assembler injects getPersonaIdentityLine() into the prompt,
tool-router multiplies category scores by getPersonaToolWeights().
Category IDs verified against src/tool-router.ts registry — uses
real names (coding/codebase/scheduling/communication/etc.), NOT
the spec's invented names (code/git/email/calendar)."
```

---

### Task 9: Test `persona-bias.ts`

**Files:**
- Create: `src/prompts/persona-bias.test.ts`

- [ ] **Step 1: Write the test.**

Create `src/prompts/persona-bias.test.ts`:

```typescript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import {
    asPersona,
    getPersonaIdentityLine,
    getPersonaToolWeights,
    applyPersonaWeight,
    PERSONA_VALUES,
    type Persona,
} from "./persona-bias.js";

describe("asPersona", () => {
    it("returns the value when it's a valid persona", () => {
        expect(asPersona("developer")).toBe("developer");
        expect(asPersona("explorer")).toBe("explorer");
    });
    it("returns null for unknown strings", () => {
        expect(asPersona("manager")).toBeNull();
        expect(asPersona("")).toBeNull();
    });
    it("returns null for non-strings", () => {
        expect(asPersona(42)).toBeNull();
        expect(asPersona(null)).toBeNull();
        expect(asPersona(undefined)).toBeNull();
        expect(asPersona({ persona: "developer" })).toBeNull();
    });
});

describe("getPersonaIdentityLine", () => {
    it("returns a non-empty string for every persona except explorer", () => {
        for (const p of PERSONA_VALUES) {
            const line = getPersonaIdentityLine(p);
            if (p === "explorer") {
                expect(line).toBeNull();
            } else {
                expect(line).toBeTruthy();
                expect(typeof line).toBe("string");
                expect((line as string).length).toBeGreaterThan(20);
            }
        }
    });
    it("returns null for null/undefined", () => {
        expect(getPersonaIdentityLine(null)).toBeNull();
        expect(getPersonaIdentityLine(undefined)).toBeNull();
    });
    it("explorer is intentionally a no-op", () => {
        expect(getPersonaIdentityLine("explorer")).toBeNull();
    });
});

describe("getPersonaToolWeights", () => {
    it("every persona returns a weight map", () => {
        for (const p of PERSONA_VALUES) {
            const w = getPersonaToolWeights(p);
            expect(typeof w).toBe("object");
            expect(w).not.toBeNull();
        }
    });

    it("every weight is in [0.7, 1.4]", () => {
        for (const p of PERSONA_VALUES) {
            const w = getPersonaToolWeights(p);
            for (const [cat, weight] of Object.entries(w)) {
                expect(weight, `persona=${p} cat=${cat}`).toBeGreaterThanOrEqual(0.7);
                expect(weight, `persona=${p} cat=${cat}`).toBeLessThanOrEqual(1.4);
                expect(weight, `persona=${p} cat=${cat}`).not.toBe(1.0);  // default → omit
            }
        }
    });

    it("explorer returns an empty map", () => {
        expect(Object.keys(getPersonaToolWeights("explorer"))).toHaveLength(0);
    });

    it("null / undefined return empty", () => {
        expect(Object.keys(getPersonaToolWeights(null))).toHaveLength(0);
        expect(Object.keys(getPersonaToolWeights(undefined))).toHaveLength(0);
    });

    it("developer biases toward coding categories", () => {
        const w = getPersonaToolWeights("developer");
        expect(w.coding).toBeGreaterThanOrEqual(1.2);
        expect(w.codebase).toBeGreaterThanOrEqual(1.2);
        expect(w.shell).toBeGreaterThanOrEqual(1.2);
    });

    it("researcher biases toward research + sources", () => {
        const w = getPersonaToolWeights("researcher");
        expect(w.research).toBeGreaterThanOrEqual(1.3);
        expect(w.web_search).toBeGreaterThanOrEqual(1.2);
    });

    it("uses real category names from src/tool-router.ts", () => {
        // Smoke check — none of the spec's invented names appear.
        const all = [...PERSONA_VALUES].flatMap((p) => Object.keys(getPersonaToolWeights(p)));
        const forbidden = ["code", "git", "email", "calendar", "image", "citation", "meeting"];
        for (const f of forbidden) {
            expect(all, `forbidden invented name "${f}" found`).not.toContain(f);
        }
    });
});

describe("applyPersonaWeight", () => {
    it("multiplies score by the weight when category matches", () => {
        // developer.coding = 1.35
        expect(applyPersonaWeight("developer", "coding", 0.5)).toBeCloseTo(0.675);
    });
    it("returns score unchanged when category isn't biased", () => {
        expect(applyPersonaWeight("developer", "marketing", 0.5)).toBe(0.5);
    });
    it("returns score unchanged for null/explorer persona", () => {
        expect(applyPersonaWeight(null, "coding", 0.5)).toBe(0.5);
        expect(applyPersonaWeight("explorer", "coding", 0.5)).toBe(0.5);
    });
});
```

- [ ] **Step 2: Run the test.**

Run: `npm test -- persona-bias`

Expected: all tests pass (4 asPersona + 3 identity-line + 7 weights + 3 applyPersonaWeight = 17).

- [ ] **Step 3: Commit.**

```bash
git add src/prompts/persona-bias.test.ts
git commit -m "test(prompts): persona-bias — narrow, identity, weights, real cat IDs

17 tests. asPersona narrows unknowns; identity lines non-empty for
4 personas + null for explorer; every weight in [0.7, 1.4] with no
1.0 stragglers (omit instead); explorer is empty; developer favors
coding/codebase/shell; researcher favors research/web_search;
forbidden-name smoke check confirms no spec-invented IDs slipped in."
```

---

### Task 10: Inject persona identity line into dynamic-assembler

**Files:**
- Modify: `src/prompts/dynamic-assembler.ts`
- Modify: `src/prompts/dynamic-context.ts`

- [ ] **Step 1: Extend `PromptContext` in `dynamic-assembler.ts`.**

Open `src/prompts/dynamic-assembler.ts`. Find the `PromptContext` interface (line ~14). Add a `persona` field:

```typescript
export interface PromptContext {
    taskType: "chat" | "coding" | "research" | "browsing" | "system" | "planning" | "tool_use";
    userEmotionalState?: string;
    relationshipDepth?: number;
    preferredLength?: "terse" | "normal" | "detailed";
    activeSkills?: string[];
    hour?: number;
    isProactive?: boolean;
    persona?: import("./persona-bias.js").Persona;   // ← W2
}
```

- [ ] **Step 2: Add a persona_identity prompt module.**

Find the `MODULES` array (line ~32). Append a new module at the end of the array. The module reads `getPersonaIdentityLine` at runtime so it picks up any updates without rebuilds:

```typescript
import { getPersonaIdentityLine } from "./persona-bias.js";

// ... inside MODULES, append:
    {
        name: "persona_identity",
        condition: (ctx) => {
            if (process.env.BHAI_NO_PERSONA_BIAS === "true") return false;
            return ctx.persona != null && getPersonaIdentityLine(ctx.persona) != null;
        },
        // content is computed at filter time, but MODULES has static content
        // strings. To avoid restructuring the whole assembler we encode the
        // dynamic part as a placeholder and substitute below.
        content: "__PERSONA_IDENTITY_LINE__",
        priority: 9,         // higher than tone modules — persona is a stronger signal
        tokenEstimate: 35,
    },
```

(Add the `import` near the top alongside the other internal imports.)

- [ ] **Step 3: Substitute the placeholder in `assembleDynamicPrompt`.**

In the same file, find `assembleDynamicPrompt`. Inside the `for (const mod of matching)` loop, after the budget check and before `parts.push(mod.content)`, add the substitution:

```typescript
    for (const mod of matching) {
        if (tokensUsed + mod.tokenEstimate > tokenBudget) continue;

        // ── W2: substitute the persona placeholder ──
        let content = mod.content;
        if (content === "__PERSONA_IDENTITY_LINE__" && ctx.persona) {
            const line = getPersonaIdentityLine(ctx.persona);
            if (!line) continue;   // explorer / null — skip the module entirely
            content = line;
        }

        parts.push(content);
        tokensUsed += mod.tokenEstimate;
    }
```

- [ ] **Step 4: Extend `DynamicContextOpts` + thread through.**

Open `src/prompts/dynamic-context.ts`. Add `persona` to the opts and pass it into `ctx`:

```typescript
import type { Persona } from "./persona-bias.js";

export interface DynamicContextOpts {
    hour?: number;
    isProactive?: boolean;
    relationshipDepth?: number;
    activeSkills?: string[];
    preferredLength?: "terse" | "normal" | "detailed";
    persona?: Persona;          // ← W2
}

export function buildDynamicContextReminder(
    userMessage: string,
    opts: DynamicContextOpts = {},
): string {
    const hour = opts.hour ?? new Date().getHours();
    const emotion = userMessage ? detectEmotion(userMessage) : null;
    const primary = emotion?.primary ?? "neutral";

    const ctx: PromptContext = {
        taskType: detectTaskType(userMessage ?? ""),
        userEmotionalState: EMOTION_TO_PROMPT_STATE[primary] ?? primary,
        hour,
        isProactive: opts.isProactive,
        relationshipDepth: opts.relationshipDepth,
        activeSkills: opts.activeSkills,
        preferredLength: opts.preferredLength,
        persona: opts.persona,    // ← W2
    };

    return assembleDynamicPrompt(ctx);
}
```

- [ ] **Step 5: Type-check.**

Run: `npm run typecheck 2>&1 | grep -E "(dynamic-assembler|dynamic-context|persona-bias)" | head -10`

Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add src/prompts/dynamic-assembler.ts src/prompts/dynamic-context.ts
git commit -m "feat(prompts): inject persona identity line into dynamic context

PromptContext gains an optional persona field. New persona_identity
MODULE entry uses a placeholder content string substituted at
assembly time so the assembler stays declarative. Module condition
honors BHAI_NO_PERSONA_BIAS=true — kill-switch disables injection
without removing the module wiring."
```

---

### Task 11: Have `agent.ts` pull persona from identity and pass it through

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Find the dynCtx call site.**

Run: `grep -n 'buildDynamicContextReminder' src/agent.ts`

Expected: one line, around 1707.

- [ ] **Step 2: Read identity profile once per turn and pass persona.**

In `src/agent.ts`, find the existing call at line 1707:

```typescript
const dynCtx = buildDynamicContextReminder(rawUserMessage, {
    hour: localHour,
});
```

Replace it with:

```typescript
let _personaForCtx: import("./prompts/persona-bias.js").Persona | undefined;
try {
    const idProfile = (await import("./memory/identity.js")).getIdentityProfile();
    const { asPersona } = await import("./prompts/persona-bias.js");
    const p = asPersona((idProfile as { persona?: unknown }).persona);
    if (p) _personaForCtx = p;
} catch {
    /* persona injection is a nicety — skip on failure */
}
const dynCtx = buildDynamicContextReminder(rawUserMessage, {
    hour: localHour,
    persona: _personaForCtx,
});
```

(The dynamic `await import` matches the file's existing lazy-loading pattern for `getProspectiveSnippet` etc. and avoids a hard dependency on identity init order.)

- [ ] **Step 3: Type-check.**

Run: `npm run typecheck 2>&1 | grep -E "agent\.ts" | head -5`

Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/agent.ts
git commit -m "feat(agent): pass persona into dynamic-context

Reads identity.persona once per turn, narrows via asPersona, and
threads it through buildDynamicContextReminder. Wrapped in try/catch
so a missing or malformed identity store doesn't block the turn —
matches the same pattern used for prospective + spreading snippets."
```

---

### Task 12: Apply persona weight overlay in tool-router

**Files:**
- Modify: `src/tool-router.ts`

- [ ] **Step 1: Locate the scoring loop.**

Run: `grep -n 'scores.sort\|sc.score = Math' src/tool-router.ts | head -5`

Expected: shows `sc.score = Math.max(sc.score, 0.5)` (recent-tool boost loop) around line ~1140, and `scores.sort` around line ~1147.

- [ ] **Step 2: Apply weight multiplier between the recent-tool boost and the sort.**

Open `src/tool-router.ts`. Find the block:

```typescript
    // ── Boost categories in active use ──
    if (recentToolCalls && recentToolCalls.length > 0) {
        const recentCategories = getUsedCategories(recentToolCalls);
        for (const sc of scores) {
            if (recentCategories.has(sc.category)) {
                sc.score = Math.max(sc.score, 0.5);
            }
        }
    }

    scores.sort((a, b) => b.score - a.score);
```

Replace it with:

```typescript
    // ── Boost categories in active use ──
    if (recentToolCalls && recentToolCalls.length > 0) {
        const recentCategories = getUsedCategories(recentToolCalls);
        for (const sc of scores) {
            if (recentCategories.has(sc.category)) {
                sc.score = Math.max(sc.score, 0.5);
            }
        }
    }

    // ── W2: persona-bias overlay. Multiplies each category's score by
    //         the persona-specific weight (~0.7–1.4). Default = 1.0
    //         (unbiased). Kill-switch: BHAI_NO_PERSONA_BIAS=true. Read
    //         persona lazily from identity so a cold tool-router call
    //         (before identity init) just skips the overlay.
    if (process.env.BHAI_NO_PERSONA_BIAS !== "true") {
        try {
            const { getIdentityProfile } = await import("./memory/identity.js");
            const { asPersona, getPersonaToolWeights } = await import("./prompts/persona-bias.js");
            const persona = asPersona((getIdentityProfile() as { persona?: unknown }).persona);
            if (persona) {
                const weights = getPersonaToolWeights(persona);
                for (const sc of scores) {
                    const w = weights[sc.category];
                    if (typeof w === "number") sc.score *= w;
                }
            }
        } catch {
            /* persona overlay is best-effort — never block tool routing */
        }
    }

    scores.sort((a, b) => b.score - a.score);
```

- [ ] **Step 3: Type-check.**

Run: `npm run typecheck 2>&1 | grep -E "tool-router\.ts" | head -5`

Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/tool-router.ts
git commit -m "feat(tool-router): persona weight overlay before final sort

After recent-tool boost, before sort, multiplies each category's
score by getPersonaToolWeights(persona)[cat] when persona is set
in identity. Reads persona lazily so cold-path tool-routing
(before identity init) is unaffected. BHAI_NO_PERSONA_BIAS=true
short-circuits the entire block. Best-effort: a thrown identity
read never breaks routing."
```

---

### Task 13: Integration test — persona changes tool-router ordering

**Files:**
- Create: `src/tool-router.persona.test.ts`

- [ ] **Step 1: Write the test.**

Create `src/tool-router.persona.test.ts`:

```typescript
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Persona overlay integration test for the tool-router scoring loop.
// Doesn't run the full router (LLM + embeddings); validates the pure
// overlay behaviour by exercising getPersonaToolWeights against the
// real category names from tool-router.ts.

import { describe, it, expect } from "vitest";
import { getPersonaToolWeights, applyPersonaWeight } from "./prompts/persona-bias.js";

// These are the real category IDs from src/tool-router.ts. Listed here
// to lock the integration contract — if any of these names change in
// tool-router.ts, persona-bias.ts must change in lockstep.
const REAL_CATEGORIES = [
    "core", "memory", "shell", "file_system", "coding", "browser",
    "web_search", "os_control", "system_controls", "media",
    "video_editing", "presentation", "communication", "scheduling",
    "app_management", "research", "long_tasks", "google_api",
    "github", "code_execution", "codebase", "tool_creation",
    "document", "marketing",
];

describe("persona overlay — score reordering", () => {
    it("developer reorders [coding, marketing] when scores are close", () => {
        // Mimic the relevant slice of tool-router state.
        const scores = [
            { category: "marketing", score: 0.55 },
            { category: "coding",    score: 0.50 },
        ];
        // No persona: marketing wins (higher base score).
        const noPersona = [...scores].sort((a, b) => b.score - a.score);
        expect(noPersona[0].category).toBe("marketing");

        // Developer persona: coding gets ×1.35, marketing untouched.
        const withDev = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("developer", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withDev[0].category).toBe("coding");
    });

    it("explorer is a no-op (ordering unchanged)", () => {
        const scores = [
            { category: "marketing", score: 0.55 },
            { category: "coding",    score: 0.50 },
        ];
        const withExplorer = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("explorer", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withExplorer[0].category).toBe("marketing");
        expect(withExplorer.map((s) => s.score)).toEqual([0.55, 0.50]);
    });

    it("researcher boosts research-cluster scores over creative ones", () => {
        const scores = [
            { category: "media",      score: 0.60 },
            { category: "research",   score: 0.55 },
            { category: "web_search", score: 0.50 },
        ];
        // Without persona, ordering is media > research > web_search.
        // With researcher, research (×1.4) and web_search (×1.3) overtake media.
        const withResearcher = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("researcher", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withResearcher[0].category).toBe("research");
        // web_search at 0.50 * 1.3 = 0.65 also beats media at 0.60.
        expect(withResearcher[1].category).toBe("web_search");
        expect(withResearcher[2].category).toBe("media");
    });

    it("every weighted category in every persona maps to a real tool-router category", () => {
        const realSet = new Set(REAL_CATEGORIES);
        const personas = ["developer", "founder", "creator", "researcher", "explorer"] as const;
        for (const p of personas) {
            const w = getPersonaToolWeights(p);
            for (const cat of Object.keys(w)) {
                expect(realSet, `persona=${p} cat=${cat} is not a real tool-router category`).toContain(cat);
            }
        }
    });
});
```

- [ ] **Step 2: Run the test.**

Run: `npm test -- tool-router.persona`

Expected: 4 tests pass.

- [ ] **Step 3: Commit.**

```bash
git add src/tool-router.persona.test.ts
git commit -m "test(tool-router): persona overlay reorders scores correctly

4 tests: developer flips [marketing > coding] → [coding > marketing]
when scores are close; explorer is a no-op; researcher promotes
research-cluster over creative; every weighted category in every
persona's map exists in the real tool-router registry (locks the
two-file contract)."
```

---

## Phase D — End-to-end gate (Tasks 14–16)

### Task 14: Manual acceptance checklist

**Files:**
- Modify: `desktop/onboarding-demo/ACCEPTANCE.md` (append a W2 section)

- [ ] **Step 1: Append the W2 section.**

Open `desktop/onboarding-demo/ACCEPTANCE.md`. Append at the end:

```markdown

---

# W2 Persona Specialization — Acceptance Checklist

> Walk on a clean `~/Library/Application Support/atlas-desktop/config.json`.

## Persona step renders
- [ ] After Profile (name), the wizard shows the new Persona step with five cards in a 2×3 grid.
- [ ] Explorer card spans both columns at the bottom.
- [ ] Continue button is disabled until a card is selected.
- [ ] Clicking a card highlights it; clicking another moves the highlight.

## Selection persists
- [ ] Selecting Developer + Continue lands on Personalize.
- [ ] Quit and relaunch from setup-state: the Persona step pre-selects Developer.

## Tone defaults work
- [ ] Fresh state + Developer → profile.tone becomes "professional" (verify via `cat ~/Library/Application\ Support/atlas-desktop/config.json | jq .prefs.profile`).
- [ ] Fresh state + Creator → profile.tone becomes "friendly".
- [ ] If you set Personalize → Personality first (custom preset) and then change Persona, the personality preset wins (tone NOT overridden).

## Identity-line injection
- [ ] With persona=developer set and bot running, send any message via Telegram or overlay.
- [ ] Check the log: the dynamic-context block should contain a line starting "The user describes themselves as a developer."
- [ ] Set `BHAI_NO_PERSONA_BIAS=true` and restart. Send a message. The line should NOT appear.

## Tool-router overlay
- [ ] With persona=developer set, send "explain my codebase" — agent should choose code-cluster tools.
- [ ] With persona=null (delete the field in config.json) — same query may route the same way (semantic match is strong here); confirm via logs that the persona-weight block is skipped (look for the absence of the lazy-import log line or just confirm absence of errors).
- [ ] `BHAI_NO_PERSONA_BIAS=true` short-circuits the block entirely.

## Comparison to demo
- [ ] Open `desktop/onboarding-demo/index.html` — the persona step in the demo and the production wizard should match within ~2% (sizes, padding, hover behaviour).
```

- [ ] **Step 2: Commit.**

```bash
git add desktop/onboarding-demo/ACCEPTANCE.md
git commit -m "docs(wizard): W2 acceptance checklist appended"
```

---

### Task 15: Full test suite + typecheck gate

**Files:**
- No code changes; verification only.

- [ ] **Step 1: Run desktop tests.**

Run: `cd desktop && npm test 2>&1 | tail -8`

Expected: 35 (W1) + 8 (persona step) = 43 tests passing across 8 files.

- [ ] **Step 2: Run node tests (root).**

Run: `npm test 2>&1 | tail -10`

Expected: existing tests pass + 17 (persona-bias) + 4 (tool-router.persona) + 3 (wizard-seed persona) new. Total depends on baseline.

If root tests can't run (the `~/.npm` cache permission issue from W1), skip this step and rely on the targeted runs above + typecheck. Note the skip in the commit message.

- [ ] **Step 3: Run typecheck.**

Run: `npm run typecheck 2>&1 | tail -20`

Expected: zero errors. If pre-existing errors exist in unrelated files, list them and confirm they don't reference any W2 file.

- [ ] **Step 4: Commit (verification trailer).**

```bash
git commit --allow-empty -m "chore(wizard): W2 full-suite verification

- desktop/tests: 43/43 passing
- node tests targeted (persona-bias, tool-router.persona,
  wizard-seed): all passing
- typecheck: clean for all W2 files"
```

---

### Task 16: Live .app smoke trip

**Files:**
- No code changes. Build + install + walk the wizard.

- [ ] **Step 1: Build the .app from the merged main.**

Per the W1 build chronicle (in conversation history) — fast-forward main to W2 HEAD, then in a fresh build worktree, symlink node_modules from the main checkout, run `npm run build` + `electron-builder --mac --dir --arm64`, then install over `/Applications/A.T.L.A.S.app`.

- [ ] **Step 2: Clear setup state and launch.**

```bash
rm -rf ~/Library/Application\ Support/atlas-desktop/config.json
open /Applications/A.T.L.A.S.app
```

- [ ] **Step 3: Walk the wizard.**

Awakening → Terms → Sign in → Profile (name) → **Persona (NEW)** → Personalize → Permissions → Vision tier → Install → Ready Hub.

- [ ] **Step 4: Confirm persisted state.**

```bash
cat ~/Library/Application\ Support/atlas-desktop/config.json | python3 -m json.tool | grep -A 3 persona
```

Expected: persona / personaConfidence / personaSelectedAt all present.

- [ ] **Step 5: Empty commit recording the smoke result.**

```bash
git commit --allow-empty -m "chore(wizard): W2 .app smoke trip — persona persists end-to-end"
```

---

## Self-review notes

After all 16 tasks complete, walk the spec (`docs/superpowers/specs/2026-05-16-onboarding-reimagined-design.md` §8) one more time:

- §8.1 Persona step renderer — Task 2. **✓**
- §8.2 State delta (name/tone/persona/personaConfidence/personaSelectedAt) — Task 6 saveProfile handler + Task 7 wizard-seed propagation. **✓**
- §8.3 `persona-bias.ts` (identity-line + weights) — Tasks 8–9. **✓**
- §8.4 Integration: dynamic-assembler injects identity-line — Task 10. tool-router applies weights — Task 12. Convex schema — **NOT changed** per §0 spec correction (no `accounts.profile` field exists in the real schema). **✓**
- §8.5 Tests — wizard step (Task 4), persona-bias unit (Task 9), tool-router integration (Task 13). **✓**
- Kill-switch `BHAI_NO_PERSONA_BIAS` — Tasks 10 + 12 both gate. **✓**

Plan ready.
