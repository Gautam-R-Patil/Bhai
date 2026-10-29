---
name: Web Browsing Expert
role: web_browsing
description: Reliable, fast browser automation for complex multi-step web tasks, dynamic UIs, video players, and hover-revealed controls.
triggers:
  - open youtube
  - play video
  - watch
  - browse
  - open website
  - click on
  - fill form
  - search on
  - log in
  - sign in
  - navigate to
  - scroll down
  - web scrape
  - extract from website
  - video player
  - mute
  - skip to
  - captions
  - subtitles
  - hover
  - dropdown
  - menu
  - control bar
---

## Tool Priority

| Situation | Best tool |
|---|---|
| **Design tools (Figma, Canva, Miro)** | `browser_scan(visual:true)` → click by (x,y) coordinates |
| Video player control (YouTube, Vimeo, HTML5) | `browser_video_control` |
| CAPTCHA / "I'm not a robot" blocking the page | `browser_handle_captcha` (solves it; asks the owner only if it can't) |
| Cookie/consent banner blocking | Auto-handled — popup guard fires on every page load |
| Hover-hidden controls (nav dropdowns, video bars) | `browser_hover` with `wait_for` + `rescan:true` |
| Scan page + reveal hidden controls in one call | `browser_scan` with `hover_at` |
| Multi-step workflows (navigate → click → type) | `browser_multi_action` |
| Direct JS/DOM access or API calls | `browser_run_js` |
| Known page, re-run previously successful flow | `browser_replay_actions` |

## Figma / Canva / Design Tools

These are **canvas-based apps** with minimal DOM. The accessibility tree is nearly empty. The agent auto-detects them on navigation and switches to visual mode.

**Rules for design tools:**
1. ALWAYS call `browser_scan(visual:true)` before every action — the screenshot is how you see the canvas
2. Click by EXACT (x,y) pixel coordinates from the screenshot, NOT by label numbers
3. Use keyboard shortcuts — they're the primary way to select tools and objects
4. The model automatically escalates to Opus for design tools (visual reasoning required)

**Figma keyboard shortcuts:**
- `v` = Select/Move, `r` = Rectangle, `t` = Text, `h` = Hand/Pan
- `f` = Frame, `l` = Line, `p` = Pen, `i` = Eyedropper
- `Escape` = Deselect / exit current tool
- `Cmd+Z` = Undo, `Cmd+S` = Save, `Cmd+D` = Duplicate
- `Cmd+G` = Group, `Cmd+Shift+G` = Ungroup
- `Cmd++/-` = Zoom in/out, `Cmd+0` = Fit to page
- `Space` + drag = Pan canvas

**Canva keyboard shortcuts:**
- `t` = Text tool, `r` = Rectangle, `l` = Line
- `Cmd+Z` = Undo, `Cmd+S` = Save/Download
- `Escape` = Deselect

**Example Figma flow:**
```
browser_navigate(url: "https://www.figma.com/file/...")
→ auto-detects design tool, attaches screenshot
browser_scan(visual: true)  ← see current canvas state
browser_click_at(x: 340, y: 420)  ← click exact pixel from screenshot
browser_keyboard(combo: "r")  ← activate rectangle tool
```

After every action that changes the canvas, call `browser_scan(visual:true)` to see the updated state.

## YouTube and Video Player Playbook

**Always use `browser_video_control` first** — it has automatic 3-tier fallback:
1. YouTube JS Player API (`#movie_player`) — no hover needed, instant
2. Keyboard shortcuts — `m`=mute, `c`=captions, `k`=play/pause, `f`=fullscreen
3. Hover + click `.ytp-*` buttons — final fallback

```
browser_video_control(action: "seek", seek_to_seconds: 300)   // skip to 5 min
browser_video_control(action: "mute")                          // mute
browser_video_control(action: "captions")                      // toggle captions
browser_video_control(action: "get_info")                      // get current state
```

**Only use keyboard if video_control fails:**
1. Click `#movie_player` to focus the player
2. Press the key: `m` (mute), `c` (captions), `k` (play/pause), `j`/`l` (±10s), `f` (fullscreen), number keys 0-9 (jump to % of video)

**Only hover+click as last resort:**
```
browser_scan(hover_at: {x: 640, y: 400})       // hover center + scan in one call
→ look for .ytp-mute-button in element list → click it
```

## Hover-Hidden UI (dropdowns, nav menus, tooltips)

YouTube-style controls are `opacity:0` at rest — they need interpolated mouse movement to trigger CSS `:hover` transitions.

**Pattern A: Reveal + scan in one call (preferred)**
```
browser_scan(hover_at: {x: CX, y: CY, wait_ms: 700})
→ look for newly revealed items in returned elements
```

**Pattern B: Hover then act**
```
browser_hover(x: CX, y: CY, steps: 8, wait_for: ".dropdown-menu", rescan: true)
→ read interactive_elements_text from result → click the target
```

**Pattern C: Multi-action sequence**
```
browser_multi_action(actions: [
  {action: "hover_reveal", selector: "#nav-trigger", wait_for: ".nav-dropdown"},
  {action: "click", selector: ".nav-dropdown a:nth-child(2)"}
])
```

Key parameters:
- `steps: 8` (default) — interpolated mouse movement, triggers CSS transitions
- `wait_for: "selector"` — waits up to 3s for element to become visible
- `rescan: true` (default) — returns newly visible elements after hover

## Multi-Step Tasks

**Always batch with `browser_multi_action`** — reduce API calls and be atomic:
```
browser_multi_action(actions: [
  {action: "navigate", url: "https://..."},
  {action: "wait", wait_ms: 1500},
  {action: "type", selector: "input[name=q]", text: "search query"},
  {action: "keyboard", combo: "Enter"},
  {action: "wait_for_opacity", selector: ".results", opacity_threshold: 0.8},
  {action: "extract", selector: ".result-title"}
])
```

**New action types in `browser_multi_action`:**
- `hover_reveal`: hover + wait for selector + rescan (for hidden controls)
- `js_eval`: run arbitrary JavaScript, e.g. `code: "return document.title"`
- `wait_for_opacity`: wait until element CSS opacity ≥ threshold

For complex reasoning + dynamic pages — use sequential tool calls with intermediate `browser_scan` to verify state.

## Direct JavaScript Execution

Use `browser_run_js` or `browser_multi_action` `js_eval` for:
- YouTube Player API: `return document.getElementById('movie_player')?.getCurrentTime()`
- HTML5 video: `return document.querySelector('video')?.duration`
- Reading DOM state: `return document.querySelector('.price')?.textContent`
- Checking computed styles: `const el = document.querySelector('.ctrl'); return getComputedStyle(el).opacity`

## Waiting for Dynamic Content

Use **condition-based waits** — never raw `timeout` delays alone:
```
browser_wait(type: "selector", value: ".results-container")      // element appears
browser_wait(type: "opacity", value: ".controls", threshold: 0.5) // fade-in complete
browser_multi_action with wait_for_opacity action                  // inline in sequence
```

Avoid `browser_wait(type: "timeout", value: "3000")` unless you have no other option.

## Verification After Actions

After key actions, verify they worked:
- After muting: `browser_video_control(action: "get_info")` → check `isMuted: true`
- After seeking: `browser_video_control(action: "get_info")` → check `currentTime ≈ target`
- After clicking: check returned `interactive_elements_text` for state change
- After form fill: `browser_run_js(code: "return document.querySelector('input').value")`

## CAPTCHA Handling

If a page shows a human-verification check ("I'm not a robot", reCAPTCHA, hCaptcha, Cloudflare Turnstile):
1. Call `browser_handle_captcha`. Bhai solves it (Turnstile wait and click, reCAPTCHA audio, picture grids and drag puzzles by vision, solver APIs); only if all fail does it ask the owner and wait (~5 min)
2. On `success: true`, carry on with the original task from where you stopped
3. On `requires_user: true`, tell the owner the page is still waiting for them and stop; don't call it again in a loop

```
browser_handle_captcha()
→ { success: true, captcha_type: "hcaptcha", method: "vision" }
→ now navigate/click as normal
```

## Cookie Banners & Popups

Cookie consent banners and modal overlays are **automatically dismissed** on every page load by the popup guard. You do NOT need to manually click "Accept" — it fires 800ms after `domcontentloaded` on every page.

If a banner persists unusually (unusual CMP), you can manually trigger:
```
browser_run_js(code: "document.querySelector('#onetrust-accept-btn-handler')?.click()")
```

## Error Recovery

1. **Element not found in scan** → try `browser_scan(hover_at: {x: 640, y: 400})` first
2. **Click misses hidden element** → `browser_hover` with `wait_for` → then click
3. **`browser_video_control` fails** → try `method: "keyboard"` or `method: "ui_click"` explicitly
4. **JS API unavailable** → fall back to keyboard shortcuts (focus player first)
5. **Overlay blocking click** → `browser_keyboard(combo: "Escape")` to dismiss, retry
6. **Stale element labels** → re-run `browser_scan` to get fresh labels before clicking

## Speed Tips

- `browser_multi_action` over individual tool calls — one round-trip vs many
- `browser_scan(hover_at: {...})` — reveal + scan in one call instead of hover → rescan
- Cached actions: if `browser_scan` reports `cached_actions_available`, use `browser_replay_actions`
- Network blockers + `bypassCSP` are already active — pages load faster automatically
- Use `browser_run_js` for read-only state checks — faster than visual scanning

## Common Patterns by Site

**YouTube:**
- Play/pause/mute/seek/captions → `browser_video_control` (always first)
- Get video title/duration/time → `browser_video_control(action: "get_info")`
- Navigate to video → `browser_navigate` → wait for `#movie_player` to be visible → control

**Google Search:**
- `browser_navigate("https://google.com")` → `browser_type` on search box → Enter

**Forms:**
- `browser_multi_action` with navigate → type → select → keyboard Enter

**Login flows:**
- `browser_scan` → identify username/password labels → `browser_type` for each → click submit
- Never guess coordinates — always use labels from `browser_scan`
