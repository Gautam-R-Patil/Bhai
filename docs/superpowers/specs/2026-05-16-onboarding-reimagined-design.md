> **Status: PARTLY IMPLEMENTED, PARTLY SUPERSEDED.** Verified 2026-10-30. The first-run wizard was later cut to **three screens** (sign in with terms inline → connect Chrome, installing in the background → Ready Hub; permissions moved to the Hub) per commit `fd43afb` and the comment in `desktop/wizard/router.js`. Name, persona, hotkey, theme and voice now default and live in Settings; there is no vision-tier step (`vision-tier.js` is gone). Step files `persona.js`/`personalize.js`/`profile.js`/`awakening.js` still exist under `desktop/wizard/steps/` but `ALL_STEPS` is only `signin`, `connect`. Shipped pieces still in tree: `src/prompts/persona-bias.ts`, `src/setup/wizard-seed.ts` (called from `src/index.ts`), `desktop/components/{magic-moment,magic-moment-ranker,try-this,tile-model,hub-boot,ready-hub-body}.js`, `desktop/detection/running-apps.js`. `src/setup/magic-moment.ts` does not exist (the magic moment lives in `desktop/components/magic-moment.js`). The referenced `2026-04-18-setup-wizard-redesign-design.md` is not in the repo. The cinematic multi-step flow described here is **not** the current first run.

# Onboarding Reimagined — Design Spec

**Date:** 2026-05-16
**Author:** brainstormed with Dheeraj
**Status:** approved for plan
**Builds on:** [`2026-04-18-setup-wizard-redesign-design.md`](2026-04-18-setup-wizard-redesign-design.md)

---

## 1. Context

The April 2026 wizard redesign shipped the right *structure*: detect-don't-assume, an "already set" chip strip, account sign-in in the flow, permissions as a first-class step, a Ready Hub. What it preserved — and what the user has now flagged as a problem — was the *feel*: orbs, glass, purple-pink gradients, monospace boot logs, generic AI-app cliché.

The complaint, in the user's words: *"this is an onboarding screen to a futuristic AI platform — not a website, not an editorial magazine, not consciousness booting."* The reference is Apple's first-run experiences (iOS 17, Vision Pro setup, macOS Sonoma setup), Linear's onboarding, Things 3 — confident, minimal, quietly futuristic, motion-rich without being neon. A.T.L.A.S should feel less like an AI demo and more like a piece of hardware booting itself in.

This spec covers a full re-imagining of the onboarding from awakening to ready-hub, plus three downstream extensions (persona specialization, magic moment, adaptive nudges) that turn the wizard from a one-shot setup into a relationship that starts on first launch and continues for the first week.

The visual source of truth for this spec is `desktop/onboarding-demo/` — a standalone HTML/CSS/JS prototype that exercises every beat with mock data, theme switching, and the full motion timeline. **Read it before writing code.**

## 2. Goals

- Replace the orb-and-gradient aesthetic with Apple-quiet-futurism: warm near-black (or near-white in light mode), SF Pro, a single iridescent hairline accent, smooth Apple-curve motion.
- Add a pre-welcome **Awakening** cinematic that greets the user by name within 3 seconds of opening the app, using OS-detected identity.
- Replace the tone-only dropdown with a **Persona** step that meaningfully changes how the agent operates (system-prompt + tool-router weights), not just how it talks.
- Add a **Magic Moment** card on the Ready Hub that surfaces one observation about the user's workspace.
- Add a **Day-2 / Day-3 / Day-5 adaptive nudge** system that finishes onboarding gradually, plugged into the existing proactive engine.
- Honour the user's system theme: detect `prefers-color-scheme` and adopt the matching palette without prompting.
- Ship in three reviewable waves that each leave the wizard in a shippable state.

## 3. Non-goals

- Not a React/SwiftUI rewrite. Stay in the existing Electron + native HTML wizard stack.
- Not new install phases. The 10 install phases stay; only their labels change.
- Not replacing the existing router (`desktop/wizard/router.js`) — extend it.
- Not new IPC for theme detection — `prefers-color-scheme` plus an explicit override is enough.
- Not changing what gets stored on Convex (we extend `accounts.profile`, we don't restructure).
- Not browser-tab inspection during the Magic Moment — too brittle, defers to the Chrome extension that already ships.

## 4. Aesthetic Direction

**Direction: Apple-quiet-futurism.** The reference points are Apple Vision Pro setup, Linear's onboarding, iOS 17 first-run. Confident, modern, minimal, with smooth choreographed motion. Not "sci-fi consciousness booting" (orbs, glow halos, terminal logs) and not "editorial atelier" (serif italics, paper textures, marginalia) — both directions were tried during brainstorming and rejected by the user.

### Visual primitives

- **Surface (dark mode)**: warm near-black `#08090b`, soft warm wash `radial-gradient(rgba(80,60,140,0.10) → transparent)`. No orbs. Minimal grain at 0.4 opacity, overlay blend.
- **Surface (light mode)**: clean warm off-white `#f8f7f3`, subtle violet/blue/warm-orange washes echoing the accent gradient. Grain at 0.32 opacity, multiply blend.
- **Type stack**: SF Pro Display / SF Pro Text via `-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif`. No third-party fonts loaded. Type does the work via size and weight contrast (44–80px display @ 600 → 13px caption @ 500).
- **Accent — singular**: one iridescent linear gradient is the *only* "AI" tell. Dark: cyan → violet → amber. Light: deep-blue → violet → burnt-orange. Used for: the awakening rule, eyebrow dots, the magic-moment dot, the persona-active glow, the install progress fill, focus rings. Nothing else gets color.
- **Hairlines**: dark mode 6 / 10 / 14% white; light mode 9 / 17 / 28% black. Borders are thin and earn their pixels.
- **Cards**: surfaces at 3.5 / 6 / 9% white (dark) or black (light). Rounded `12–18px`. No glow halos. No blur excess.
- **Buttons — exactly one primary per screen**: a pill — white-on-near-black in dark mode, near-black-on-cream in light mode. Secondary actions are borderless text links. No bordered ghost buttons.
- **Icons**: inline SVG, 1.5px stroke, SF-Symbols-style geometry. No emoji.

### Motion

All motion uses Apple curves:

- **Standard ease** `cubic-bezier(0.16, 1, 0.3, 1)` — the SwiftUI "smooth out". Used for fade-ups, step transitions, hover responses.
- **Spring** `cubic-bezier(0.34, 1.45, 0.64, 1)` — gentle overshoot. Used for the awakening glyph scale-in and CTA arrival.
- **Tap compression** `transform: scale(0.97)` over 80–140ms on every interactive press.

Step transitions are crossfades, not directional slides: `220ms leave (opacity 1→0, translateY 0→−6px, blur 0→4px) → 60ms reflow → 700ms stagger-in`. Each step's children fade up with a 70ms stagger, each animating opacity + translateY(12→0) + blur(6→0) together. The single iridescent hairline at the top of the page scribes left→right→retreat over 1.4s on every step transition — the only ambient "alive" signal that runs continuously.

### Theme

Driven by `prefers-color-scheme` with explicit override via `data-theme="light" | "dark"` on `<html>`. The user's choice in Personalize → Appearance writes to the same `data-theme` attribute and persists to `personalize.theme`. "System" sets `data-theme=""` so the media query takes over. Default on first launch: follow system. No need for the user to pick before they see the wizard.

## 5. Wave Plan

The full vision is one design but ships in three reviewable PRs. Each wave leaves the wizard in a shippable state.

| Wave | Scope | Surface | Risk |
|---|---|---|---|
| **W1 — Cinematic spine** | New `awakening` step, copy reframe across all steps, Ready Hub redux, magic-moment card (best-effort signals only), theme detection | New step file + components + copy module; CSS rewrite; no new IPC | Low–med. CSS rewrite touches all step files. |
| **W2 — Persona specialization** | New `persona` step, `profile.persona` flows into agent identity + tool router | New step file, `persona-bias.ts` module, edits to `dynamic-assembler.ts` + `tool-router.ts` + `convex/schema.ts` | Med. Touches running-agent code paths. |
| **W3 — Magic Moment rich + Adaptive nudges** | Post-permissions running-app detection (mac + Windows), Day-2/3/5 graduation nudges via proactive engine | `src/setup/magic-moment.ts`, Swift helper, `src/proactive/sources/onboarding-graduation.ts`, memory keys | Med. Cross-OS detection + proactive integration. |

The 10-beat flow lands in W1. W2 swaps the tone-only profile for the persona step. W3 layers intelligence on top.

## 6. Beat Flow

10 beats on first install. Reconfigure skips `awakening` and `persona` unless re-entered via a chip.

```
awakening*  →  terms  →  signin  →  profile  →  persona*  →
personalize  →  permissions  →  vision-tier  →  install  →  ready-hub

(* = new in this spec)
```

### Beat-by-beat copy (the source of truth lives in `desktop/wizard/copy.js`)

| Beat | Eyebrow | Title | Sub |
|---|---|---|---|
| awakening | — | "{TOD-greeting}, {name}." (per-word reveal) | rotating: *reading the room* → *setting the table* → *ready when you are* |
| terms | Trust | "Read once. We won't ask again." | "A short set of terms covering what A.T.L.A.S can do, what it stores, and how to back out." |
| signin | Identity | "Make this yours." | "One tap to sync preferences and credits across your devices. No password to remember." |
| profile | You | "What should I call you?" | "Used in greetings and when I get your attention. You can change it anytime in Settings." |
| persona | How you work | "Pick a starting shape." | "Shapes the examples I show, the tools I prioritize, and the way I talk. You can change this anytime." |
| personalize | Ritual | "How A.T.L.A.S shows up." | "Small choices that shape every interaction — what summons it, how it sounds, the mood." |
| permissions | Capabilities | "Unlock what I can do." | "Each one is a capability, not a checkbox. Grant whatever feels right — you can revisit anytime." |
| vision-tier | Sight | "How sharp should my eyes be?" | "On-device vision lets me see your screen and reason about UI. Heavier tiers see more but take longer to install." |
| install | Assembly | "Setting things up." | live status: *Runtime…* / *Browser engine…* / *Semantic memory…* etc. |
| ready-hub | — | "Ready, *{name}*." | "Press **{hotkey}** anywhere on your computer. I'll be there." |

Reframed copy from the old wizard is captured in `desktop/wizard/copy.js` as a single map — easy to A/B, easy to localize.

## 7. Wave 1 — Cinematic Spine

### 7.1. Files to create

- **`desktop/wizard/steps/awakening.js`** — the new opening cinematic.
- **`desktop/wizard/copy.js`** — single map of `(stepId, key) → string`. All UI copy reads through this. Eases A/B and localization. Replaces inline strings across `desktop/wizard/steps/*.js`.
- **`desktop/components/magic-moment.js`** — Ready Hub card. Best-effort signals only in W1; W3 swaps the data source for the rich detection.
- **`desktop/wizard/cinematic.js`** — pure helper exposing `applyConfidence(stepIndex, totalSteps)` for the AI-confidence orb-speed/accent-alpha ramp. The wizard `boot.js` calls it from `renderIndex(idx)`.
- **`desktop/onboarding-demo/`** — the prototype already exists; check it into `main` so designers and reviewers have a live reference.

### 7.2. Files to modify

- **`desktop/wizard.html`** — drop the orb-canvas DOM, add a single `<div class="atmosphere">` with grain + wash divs and a single `<div class="iridescent-rule">` that scribes on transitions.
- **`desktop/wizard/router.js`** — insert `awakening` at the head of `ALL_STEPS`. Add `needsAwakening(state)` helper: shown only on first install, never on reconfigure.
- **`desktop/wizard/boot.js`** — call `Cinematic.applyConfidence(...)` and trigger the iridescent-rule scribe in `renderIndex()`. Run cleanup hook from outgoing step (`root._cleanup?.()`).
- **Every existing step file** under `desktop/wizard/steps/` — pull all UI strings out into `copy.js`, swap DOM classes to match the new design tokens. The underlying component (HotkeyPicker, ThemeSwitch, VoicePicker, PermissionsGrid, InstallLog) stays unchanged in W1.
- **`desktop/styles.css`** — full rewrite. Tokens at top, then components. See `desktop/onboarding-demo/demo.css` for the working version. Includes `@media (prefers-color-scheme: light)` plus `:root[data-theme="light"|"dark"]` overrides.
- **`desktop/ready-hub.html`** — replace orb shell with the same atmosphere/chrome/indicator structure.
- **`desktop/components/ready-hub-body.js`** — render the magic-moment card before the tile grid, plus the broadsheet hero. Status tiles become a 3-column grid of `hub-cell` rows.
- **`desktop/components/permissions-grid.js`** — same component, new visual chrome. Card becomes a row in a list, granted = green tint, skipped = amber tint, both inline pills become small `perm-status` tags.

### 7.3. Awakening timeline

Single timeline owned by `awakening.js`. Total 2.5s, ESC fast-forwards to the final state.

| t (ms) | Beat |
|---|---|
| 60 | `document.body` gets `atmosphere-on` — wash fades in |
| 120 | Glyph spring-scales from `scale(0.3) blur(10px)` → `scale(1) blur(0)` over 1100ms with `cubic-bezier(0.34, 1.45, 0.64, 1)` |
| 280 | Greeting reveal starts. Each word is a `<span class="word">` with `--word-delay` set 110ms apart, animating `opacity 0→1`, `translateY(28px → 0)`, `filter blur(14px → 0)` over 950ms |
| 1100 | Iridescent rule draws from centre: `transform: scaleX(0 → 1); transform-origin: center` over 1050ms |
| 1450 | Rule flares: brightness 1 → 1.5 with `drop-shadow(0 0 14px violet)` for 1.4s |
| 1500 | Status text gentle-blurs in over 800ms (`blur 6→0, translateY 6→0`) |
| 1900 | CTA springs up from `scale(0.94) translateY(14px) opacity 0` |
| 2300 | "Press ESC to skip" hint joins |
| 2700 | First status crossfade: *reading the room* → *setting the table* |
| 3900 | Second crossfade: → *ready when you are* |

### 7.4. Name resolution

The awakening greeting reads from a three-tier lookup, identical to what `desktop/wizard/steps/profile.js:18` already uses for the name input default:

1. **`state.profile.name`** if present (returning user or signed-in account).
2. **`state.osUserName`** otherwise — already populated by `desktop/detection/`. On macOS via `dscl . -read /Users/$USER RealName` falling back to `os.userInfo().username`; on Windows via `USERNAME` env then registry. Lower-cased OS logins get auto-capitalized.
3. **No name** — fall back to "{TOD-greeting}." with a period. Never "Good evening, User."

The Profile step still asks for the name afterwards — the user can correct what the OS told us.

### 7.5. Magic Moment (W1 — best-effort signals only)

In W1 the magic-moment card runs entirely on signals available without prompts:
- OS, default browser, monitor count, dark/light, hour of day, persona (if W2 already shipped).
- A small rule table (in `magic-moment.js`) picks an observation and follow-up.
- Crossfades every 7s with three rotating observations.

Example outputs:
- *"Late-night session and dark mode? I'll keep things minimal."*
- *"Three monitors detected. I'll spread out when I need to."*
- *"Chrome's your daily driver. I'll learn its tabs first."*

W3 swaps in richer signals after permissions are granted.

### 7.6. Audio (W1)

Two assets shipped in `desktop/audio/`:
- `confirm.ogg` — one-shot felt-piano note (-32 dBFS, ~600ms) played on each `onAdvance`.
- `awakening-chime.ogg` — single short bell on the iridescent-rule flare (~1450ms into the cinematic).

No hum loop, no ambient bed — they get stale fast. Audio routes through `desktop/wizard/audio.js` with one preference: `personalize.audio.enabled`, default `false`. A small 🔊/🔇 toggle lives in the chrome bar (already present in the demo). Disabling sets `data-audio="off"`.

### 7.7. Step transitions

```css
.step-root.leaving  { opacity: 0; transform: translateY(-6px); filter: blur(4px); }
.step-root.entering { opacity: 0; transform: translateY(10px); filter: blur(6px); }
.step-root > *      { opacity: 0; transform: translateY(12px); filter: blur(6px);
                      transition-delay: var(--enter-delay); }
.step-root.ready > *{ opacity: 1; transform: translateY(0); filter: blur(0); }
```

`boot.js` assigns `--enter-delay: calc(60ms + idx * 70ms)` to each direct child of `#step-root` when a step renders. Awakening overrides with its own bespoke timeline.

### 7.8. Theme integration

- `<html>` has no `data-theme` by default — `@media (prefers-color-scheme: light)` decides.
- Personalize → Appearance writes one of `light | dark | system` to `personalize.theme`. The wizard applies it via `document.documentElement.setAttribute("data-theme", value)` (empty string for `system`).
- The OS preference is also synced into the Personalize step's default on first render via `nativeTheme.shouldUseDarkColors` (already in `setupDetect()` per the prior wizard spec).

## 8. Wave 2 — Persona Specialization

The Persona step replaces today's "tone" dropdown on the Profile step. Profile becomes name-only.

### 8.1. New step

**`desktop/wizard/steps/persona.js`** — five cards in a 2×3 grid:

| Persona | Title | Description | Capability previews |
|---|---|---|---|
| developer | Developer | Terminal-first. Code-aware. Speaks git. | Codebase memory, shell/IDE awareness, debug + review acceleration |
| founder | Founder | Calendar, comms, decisions. Move fast. | Meeting summaries + decision log, calendar/email orchestration, research-to-decision |
| creator | Creator | Ideas, media, drafts. Make things. | Reference + mood organization, script + caption generation, asset corral |
| researcher | Researcher | Sources, citations, synthesis. | Deep research, credibility-scored citations, hypothesis tracking |
| explorer | Explorer | Not sure yet — I'll learn as we go. | No bias applied, adapts from your behavior, you can pick a path later |

The fifth — Explorer — is the "no bias" option. It still writes `profile.persona = "explorer"` so we know the user actively opted out of specialization.

### 8.2. State delta

Extends `profile` (additive — no migration needed):

```ts
profile: {
  name: string,
  tone: "friendly" | "professional" | "playful",  // derived from persona, overridable in Personalize → Personality
  persona: "developer" | "founder" | "creator" | "researcher" | "explorer",
  personaConfidence: 1.0,           // 1.0 when user-selected; lower if inferred
  personaSelectedAt: number,        // ms timestamp
}
```

Tone defaults per persona:
- developer / founder / researcher → `professional`
- creator / explorer → `friendly`

The Personalize → Personality preset (`casual_playful` / `professional_concise` / `warm_supportive` / `direct_terse`) remains and overrides tone if explicitly set.

### 8.3. `src/prompts/persona-bias.ts` (new)

Single source of truth for what each persona means to the agent. Pure functions, no side effects.

```ts
export function getPersonaIdentityLine(persona: Persona): string | null;
// e.g. developer → "The user identifies as a developer. Bias toward terminal
//                   output, code-level explanations, and assume familiarity with git/CLI."

export function getPersonaToolWeights(persona: Persona): Record<CategoryId, number>;
// developer  → { code: 1.35, git: 1.30, shell: 1.25, browser: 1.15, memory: 1.10 }
// founder    → { calendar: 1.30, email: 1.25, research: 1.20, meeting: 1.30 }
// creator    → { media: 1.30, files: 1.25, browser: 1.20, image: 1.30 }
// researcher → { research: 1.40, browser: 1.30, citation: 1.40, memory: 1.20 }
// explorer   → {} (no bias)
```

All weights in `[0.7, 1.4]` so they nudge, not override. Default weight is `1.0`; categories not in the map are untouched.

### 8.4. Integration points

- **`src/prompts/dynamic-assembler.ts`** — read `profile.persona` and inject `getPersonaIdentityLine()` into the dynamic-context block. Gated by `BHAI_NO_PERSONA_BIAS=true`.
- **`src/tool-router.ts`** — after cosine scoring, before top-K selection, multiply each category's score by `getPersonaToolWeights(persona)[cat.id] ?? 1.0`. Same gate.
- **`convex/schema.ts`** — extend `accounts.profile` validator with optional `persona`, `personaConfidence`, `personaSelectedAt`. Backfill is no-op.

### 8.5. Tests (new)

- `desktop/tests/wizard.persona.test.js` — selection writes correct state; tone defaults; reconfigure shows the persona chip.
- `src/prompts/persona-bias.test.ts` — every persona returns a finite weight map; every weight in `[0.7, 1.4]`; identity-line is non-empty for non-explorer; empty for explorer.
- `src/tool-router.persona.test.ts` — with `persona=developer`, "deploy this branch" ranks `code`/`git` higher than the same query with `persona=null`. Without persona, ordering unchanged.

## 9. Wave 3 — Magic Moment (rich) + Adaptive Nudges

### 9.1. Magic Moment, rich pass

**Trigger:** Ready Hub mount, *after* permissions step recorded `accessibility=granted` AND `screen=granted`. Best-effort signals (W1) keep rendering until rich signals arrive — no flicker, just a higher-signal replacement.

#### New: `src/setup/magic-moment.ts`

```ts
export async function detectMagicMoment(): Promise<MagicMomentSignal[]>;

type MagicMomentSignal = {
  id: string;             // "vscode+github+figma", "chrome-many-tabs", "slack-active"
  observation: string;    // "Looks like you're building something."
  followup: string;       // "Want me to optimize for development workflows?"
  confidence: number;     // 0..1
  source: "running-apps" | "system" | "ambient";
  ttl_ms: number;         // re-detect after this; default 60_000
};
```

#### Cross-OS detection

| OS | Source | Mechanism |
|---|---|---|
| macOS | running apps | New helper `scripts/list_running_apps.swift` — `NSWorkspace.runningApplications` → JSON `{bundleId, name, activationPolicy}`. Builds with existing `npm run build:location` Swift toolchain. |
| Windows | running apps | `tasklist /FO CSV /NH` via existing main-process child_process helper. |
| Both | system | Existing detection: monitor count, dark mode, default browser. |
| Both | browser tabs | **Skipped in W3.** AppleScript per-browser triggers Automation permission; the Chrome extension we already ship is a better path when it's connected. Defer. |

#### Ranker

Small rule table in `magic-moment.ts`, no LLM call. Ordered patterns; first match wins:

```ts
const PATTERNS: Array<{ match: (apps: AppSnapshot) => boolean, signal: MagicMomentSignal }> = [
  { match: hasAny(["vscode","cursor"]) && hasAny(["figma","slack"]),
    signal: { id: "dev-cluster", observation: "Looks like you're building something.",
              followup: "Want me to optimize for development workflows?", ... } },
  { match: hasAny(["figma","photoshop","premiere","davinci","ableton","logic"]),
    signal: { id: "creator-cluster", observation: "Creative tools open. I can keep references organized.", ... } },
  { match: hasAny(["calendar","slack","notion","linear"]),
    signal: { id: "coord-cluster", observation: "You're in coordination mode. I'll watch your calendar.", ... } },
  { match: () => true,
    signal: { id: "ambient", observation: "Workspace mapped. Ready when you are.", ... } },
];
```

#### IPC contract

```js
bhai.detectMagicMoment() → Promise<MagicMomentSignal[]>
```

Called once on Ready Hub mount. Result feeds the existing `magic-moment.js` component built in W1.

#### Persona inference (advisory only)

If the user picked `explorer` and the rich signals match a cluster strongly (≥0.7 confidence), the magic moment surfaces a one-time card:

> *"Looks like you're working on {dev/creative/coordination}. Want me to specialize?"*

Tapping opens the persona step pre-selected. If the user picked any other persona, the inference is informational only — no override, no prompt.

### 9.2. Adaptive nudges (Day 2 / 3 / 5)

#### New: `src/proactive/sources/onboarding-graduation.ts`

Plugs into the existing proactive engine. Owns three nudges. Each is a function that, given the user's session telemetry, decides whether to fire today:

```ts
export const onboardingGraduationSource = {
  id: "onboarding-graduation",
  shouldFire(ctx) {
    const days = daysSince(ctx.profile.firstLaunchAt);
    if (days < 2) return null;
    if (alreadyFired("personalize-shortcuts", ctx)) return null;
    if (days >= 2 && days < 3) return maybeFire("personalize-shortcuts", ctx);
    if (days >= 3 && days < 5) return maybeFire("browser-memory",        ctx);
    if (days >= 5)             return maybeFire("voice-speed",           ctx);
    return null;
  },
  compose(template, ctx) { /* template → composer.ts → final text */ },
};
```

#### Nudge table

| Nudge ID | Day | Fires only if… | Action it offers |
|---|---|---|---|
| `personalize-shortcuts` | 2 | Hotkey used ≥3 times AND user hasn't customized hotkey | "I noticed you've been using {hotkey} a lot. Want me to personalize shortcuts based on your workflow?" → opens Personalize step |
| `browser-memory` | 3 | Browser tool used ≥5 times AND `browserMemory.enabled !== true` | "You spend a lot of time in Chrome. Want me to remember the tabs you keep open?" → toggles setting |
| `voice-speed` | 5 | Voice channel used ≥3 times | "Want faster voice responses? I can switch to a leaner backend." → opens voice picker |

Counters come from `src/tool-router-analytics.ts` — no new instrumentation, just new reads.

#### State

New memory keys via existing SQLite memory store:

```
onboarding.firstLaunchAt              → ms timestamp (set at install-complete)
onboarding.nudges.{nudgeId}.firedAt   → ms timestamp
onboarding.nudges.{nudgeId}.acted     → boolean
onboarding.graduatedAt                → set when all three fire OR user opts out
```

#### Dispatch

Existing `src/proactive/dispatch.ts`. Posture rules:
- Nudges go out only in `active` posture, never in DND, never during the night window.
- Existing kill switches apply (`BHAI_PROACTIVE_DISABLE`, `BHAI_PROACTIVE_DISABLE_SOURCES=onboarding-graduation`).
- New dedicated switch: `BHAI_NO_ONBOARDING_NUDGES=true` → source registers as a no-op.

#### Opt-out

Each nudge carries a "Don't suggest more" dismissal that sets `onboarding.graduatedAt = now()` and the source returns `null` forever after. The visual is the bottom-right toast already prototyped in `desktop/onboarding-demo/demo.js` (`showDay2Nudge`).

### 9.3. Reconfigure path

When the user re-enters via Reconfigure or a chip:
- `awakening` skipped (no re-cinematic).
- `persona` shown only if explicitly entered via the persona chip.
- Magic Moment card on Ready Hub: still active. Re-runs detection on each mount.
- Adaptive nudges: independent — they fire from session telemetry, not from wizard re-entry.

## 10. Telemetry

One new event stream `onboarding.beat`, written to the existing analytics file (`data/analytics.log`):

```jsonc
{ "beat": "awakening_seen" | "persona_selected" | "magic_moment_rendered"
        | "nudge_fired" | "nudge_acted" | "nudge_dismissed",
  "persona": "developer | ...",          // when applicable
  "nudgeId": "personalize-shortcuts | ...",
  "ts": 1715800000000 }
```

No PII. No identifiers. The point is to measure conversion through the cinematic and which nudges land.

## 11. Env kill-switches

All default to off (feature on) unless noted. Set `"true"` to disable.

| Switch | Effect |
|---|---|
| `BHAI_NO_AWAKENING` | Skip the awakening step on first install. Goes straight to terms. |
| `BHAI_NO_PERSONA_BIAS` | Disable identity-line injection AND tool-router overlay. Persona still stored, just not consumed. |
| `BHAI_NO_MAGIC_MOMENT` | Hide the magic-moment card on Ready Hub. |
| `BHAI_NO_MAGIC_MOMENT_RICH` | Use best-effort signals only; never call `detectMagicMoment()`. |
| `BHAI_NO_ONBOARDING_NUDGES` | Adaptive nudge source registers as a no-op. |
| `BHAI_NO_ONBOARDING_AUDIO` | Force-disable wizard audio regardless of `personalize.audio.enabled`. |

These follow the existing pattern documented in `CLAUDE.md` → "Env Kill-Switches".

## 12. Migration / reconfigure behavior

- **First install**: full 10-beat flow.
- **Reconfigure (existing user)**: skips `awakening` and `persona` by default. Persona chip in the "already set" strip allows re-entry.
- **Existing users with no `profile.persona`**: on next launch, `profile.persona` is null. The magic-moment card surfaces the "Want me to specialize?" prompt the first time the user lands on Ready Hub (one-time, dismissible). Tapping opens the persona step.
- **Existing users with `profile.tone` but no `profile.persona`**: persona defaults to `explorer` in memory but is NOT persisted until the user actively picks. Tone is preserved.

## 13. Demo as visual source of truth

`desktop/onboarding-demo/` is checked in and treated as a living mockup, not throwaway code. Every visual decision (token values, motion timing, gradient stops, hairline weights) is implemented there first and copied into the production wizard during W1. Reviewers compare PRs against the demo, not against this spec — the demo is more precise than the prose.

The demo file structure:
- `index.html` — page shell with chrome, atmosphere divs, indicator strip, demo controls panel, nudge host.
- `demo.css` — full token system + every component. Both themes, with `@media (prefers-color-scheme: light)` and `:root[data-theme]` overrides.
- `demo.js` — state machine, 10 step renderers, awakening timeline, install progress simulation, magic-moment rotation, Day-2 nudge trigger.

The demo runs offline by opening `index.html` in any browser. No build step. No dependencies.

## 14. Open questions

1. **Sign-in deferral**: the current `signin` step accepts "Continue with email" / "Continue with phone" as the primary action, and the skip button has been removed. If the user clicks neither and hits Back, they re-enter the wizard signed-out. Acceptable? *Assumption: yes — the wizard still completes, the Ready Hub shows "Signed out" on the Account tile, and they can sign in later from Settings.*
2. **Magic Moment in light mode**: the iridescent gradient is muted in light mode (deeper blue → violet → burnt-orange). On a near-white background the rule and dots read fine, but the magic-moment card's left-border (`border-left: 2px solid var(--accent-soft)`) was tuned for dark. May need a slightly heavier 3px stroke in light mode. *To verify in the demo.*
3. **Audio default**: should `personalize.audio.enabled` default `true` or `false` on first install? *Going with `false` — fewer surprises. The 🔊/🔇 toggle in the chrome lets the user opt in within the first beat if they want.*

## 15. Implementation order

1. **W1**:
   a. Land `desktop/onboarding-demo/` in `main` (already exists, just commit).
   b. Rewrite `desktop/styles.css` from `demo.css`.
   c. Extract `desktop/wizard/copy.js`. Rewire every existing step file to read from it.
   d. Add `desktop/wizard/steps/awakening.js`.
   e. Add `desktop/wizard/cinematic.js` and wire from `boot.js`.
   f. Rebuild `desktop/components/ready-hub-body.js` (broadsheet hero + magic-moment + index + Try this).
   g. Add `desktop/components/magic-moment.js` (best-effort signals only).
   h. Ship audio assets in `desktop/audio/`.
2. **W2**:
   a. Add `desktop/wizard/steps/persona.js`. Insert in router between `profile` and `personalize`.
   b. Trim `profile.js` to name-only.
   c. Add `src/prompts/persona-bias.ts`.
   d. Wire into `dynamic-assembler.ts` and `tool-router.ts`.
   e. Extend `convex/schema.ts` validator.
   f. Tests.
3. **W3**:
   a. Add `scripts/list_running_apps.swift` + Windows `tasklist` parser.
   b. Add `src/setup/magic-moment.ts` + IPC exposure.
   c. Swap `magic-moment.js` data source.
   d. Add `src/proactive/sources/onboarding-graduation.ts`.
   e. Wire memory keys + dispatch posture.
   f. Tests.

Each step in each wave is a separate commit. Each wave is a separate PR.
