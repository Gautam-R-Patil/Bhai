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
- [ ] Toggling the speaker in the chrome enables confirm chimes on advance.
- [ ] With audio enabled, the awakening plays a bell ~1.45s in.
- [ ] `ATLAS_NO_ONBOARDING_AUDIO=true` silences everything regardless of toggle.

## Kill-switches
- [ ] `ATLAS_NO_AWAKENING=true` → awakening skipped, welcome is first.
- [ ] `ATLAS_NO_MAGIC_MOMENT=true` → magic-moment card hidden on Ready Hub.

## Comparison to demo
- [ ] Open `desktop/onboarding-demo/index.html` side by side. The production wizard's visuals match the demo within ~2% (font sizes, weights, padding, motion timing). Any divergence is a bug in the production code, not the demo.

---

# W2 Persona Specialization — Acceptance Checklist

> Walk on a clean `~/Library/Application Support/bhai-desktop/config.json`.

## Persona step renders
- [ ] After Profile (name), the wizard shows the new Persona step with five cards.
- [ ] Continue button is disabled until a card is selected.
- [ ] Clicking a card highlights it; clicking another moves the highlight.

## Selection persists
- [ ] Selecting Developer + Continue lands on Personalize.
- [ ] Quit and relaunch from setup-state: the Persona step pre-selects Developer.

## Tone defaults work
- [ ] Fresh state + Developer → profile.tone becomes "professional" (verify via `cat ~/Library/Application\ Support/bhai-desktop/config.json | jq .prefs.profile` or the equivalent `.user-profile.json` in userData).
- [ ] Fresh state + Creator → profile.tone becomes "friendly".
- [ ] If you set Personalize → Personality preset first and then change Persona, the existing tone wins (NOT overridden by persona default).

## Identity-line injection
- [ ] With persona=developer set and bot running, send any message via Telegram or overlay.
- [ ] Check the log: the dynamic-context block should contain a line starting "The user describes themselves as a developer."
- [ ] Set `ATLAS_NO_PERSONA_BIAS=true` and restart. Send a message. The line should NOT appear.

## Tool-router overlay
- [ ] With persona=developer set, send "explain my codebase" — agent should choose code-cluster tools.
- [ ] Set `ATLAS_NO_PERSONA_BIAS=true` and restart — the overlay block should be skipped (confirm via absence of related entries in tool-router logs).

## Comparison to demo
- [ ] Open `desktop/onboarding-demo/index.html` — the persona step in the demo and the production wizard should match within ~2% (sizes, padding, hover behaviour).

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
