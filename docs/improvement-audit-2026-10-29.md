# Improvement audit — 2026-10-29

> **Status (2026-10-30):** the "Do first" table has a status column checked against current code. Round 2, ideas and roadmap sections below were not re-verified (**Unverified**). Many reliability items were since shipped as the Oct 2026 reliability layer (see CLAUDE.md).

Five parallel code audits (browser, computer use, memory, personality, agent loop + proactive). Every item below was verified at the cited `file:line`; the top claims were re-checked by hand. Impact/effort are relative. S = under an hour, M = half a day.

## Do first (highest impact, small diffs)

| # | Area | Finding | Where | Effort | Status (2026-10-30) |
|---|------|---------|-------|--------|---|
| 1 | Browser | `accessibility_tree` is dead: `page.accessibility` no longer exists in Playwright 1.58, so it always returns `""`. Playwright now ships `page._snapshotForAI()` + `aria-ref=` selectors, which is exactly the ref-based snapshot the aria scan re-implements with 4 racing `getByRole` lookups per element. | `src/tools/browser/core.ts:1520`, `:1197-1241` | M | Fixed (`_snapshotForAI` path in core.ts) |
| 2 | Browser | Only 23 tool names are in the sequential `BROWSER_TOOLS` set; the router offers 48. `browser_click`, `browser_wait_for_selector`, `browser_scroll_element`, `browser_handle_captcha` etc. run in the parallel lane and race on one page. Fix: `name.startsWith("browser_")`. | `src/agent.ts:230-254`, `:862` | S | Fixed (`isBrowserTool` = `startsWith("browser_")`) |
| 3 | Browser | Post-action rescan returns the pre-action element map (6s cache) because click/type/select never call `invalidateCache()`. On SPAs the model clicks labels that no longer exist. | `core.ts:1148`, `interaction.ts:270,770` | S | Likely fixed (`invalidateCache` now called in interaction.ts; unverified per-action) |
| 4 | Browser | `prompts/browsing.md` tells the model to send `text="Enter"`, which types the letters E-n-t-e-r; the key press is `combo:"Enter"`. Breaks every chat/search flow. Also says "no screenshots" (wrong), cites `close_current` (param is `close_active`). | `prompts/browsing.md:13,19,44,84`, `interaction.ts:1026` | S | Fixed (prompt no longer has `text="Enter"`/`close_current`) |
| 5 | Browser | Popup guard hides anything with `class*='backdrop'`, which matches Tailwind `backdrop-blur-*` — sticky headers vanish on most modern sites before the first scan. | `popup-guard.ts:196-223` | S | Fixed (backdrop-blur comment in popup-guard.ts) |
| 6 | Computer use | `os_screenshot` captures the main display, but click scaling uses the focused window's monitor. On a second display the model sees display 1 and clicks on display 2. 10 call sites. Use `-R x,y,w,h` like `captureWindowRegion` already does. | `src/tools/macos.ts:191-203` + 9 others | S | Unverified |
| 7 | Computer use | Cascade miss returns bare `null`; AX element count, nearest labels, and cloud-grounding error (`timeout`, `disabled`, `unparseable`) are all swallowed. The model gets `cascade_miss` whether it's a permission problem or a bad label. | `perception-router.ts:161-325`, `os-smart-click.ts:448` | S | Unverified |
| 8 | Computer use | Click memory never un-learns: memory hits skip verification and nothing calls `recordClickMiss` outside the vision branch. After 4 hits a coordinate replays blindly for 90 days. | `os-smart-click.ts:239-254`, `:389-394` | M | Unverified (click-miss recorded in vision branch only as far as checked) |
| 9 | Memory | 8K injection cap truncates in push order; repo_map/architecture (~6K) are pushed first, so core memory, recall, session, credits, background-task state get evicted on coding turns. Fix: move two `parts.push` calls. | `src/agent.ts:1709,1751,2230-2241` | S | Open (cap still truncates in push order) |
| 10 | Memory | Shadow mode (default on) inserts even on `threat`/`binary`/`oversize` hard rejects. Prompt-injection-flagged text lands in `memories` and gets recalled. | `src/memory/sqlite.ts:1098` | S | Fixed (gate rejects now honored in shadow mode) |
| 11 | Memory | Surprise gate predicts a constant 0.5, so "boring" importance-5 memories get `decay_score = 1.5` (above the 1.0 cap) and outrank importance-7 rows. Nightly `batchSurpriseAnalysis` has the mirror bug. Delete both blocks. | `sqlite.ts:1149-1153`, `reflection.ts:578` | S | Unverified |
| 12 | Agent loop | 402 out-of-credits is thrown without `status`, so the non-retryable check never matches: ~18 HTTP calls and three junk system messages before the user is told. | `src/llm.ts:364-366`, `:443-446`, `agent.ts:2791-2848` | S | Fixed (402 thrown with `status`) |
| 13 | Agent loop | Main agent call has a 25s per-attempt deadline regardless of thinking effort (`max` allows 65K tokens). Long Sonnet/Opus reasoning gets aborted, misreported as a network error, and silently answered by Haiku. Derive timeout from effort. | `llm.ts:168-172,226-229`, `crypto-transport.ts:202` | S | Fixed (per-effort attempt timeout in llm.ts) |
| 14 | Agent loop | Steering nudges (`[Memory nudge]`, `[VERIFICATION REQUIRED]`, `[CIRCUIT BREAKER]`, "LLM call failed") are pushed into the global history and re-sent forever; the hard cap keeps all system messages. | `agent.ts:1538,1396,1461,2844,2914,3723,3735` | S | Fixed (`pushNudge`, stripped at turn end; see CLAUDE.md reliability layer) |
| 15 | Proactive | macOS DND reads pre-Monterey keys, so `isDNDActive()` is always false. Read `~/Library/DoNotDisturb/DB/Assertions.json` directly. | `src/proactive/dnd.ts:21-41` | S | Fixed (reads Assertions.json) |
| 16 | Proactive | `recordResponse(0, …)` updates row id 0 (never real), so engagement is never recorded, `isFatigued()` becomes true after 5 sends, and proactive goes silent exactly when active. `recordFirstMessageOfDay` has no callers, so wake-time never learns. | `telegram.ts:601`, `notification-tracker.ts:84-102,178-192` | S | Fixed (notification-tracker comment notes the id-0 bug) |
| 17 | Personality | Proactive templates are hard-coded casual English and bypass the Settings preset and the user's language. Professional/Direct users get "how'd X go? want me to jot notes?" verbatim. | `src/proactive/composer.ts:37-45`, `composer-templates.ts`, `prompts/proactive-composer.md:19-30` | S | Fixed (composer uses Settings tone via `getToneReminder`) |
| 18 | Personality | Hinglish detection ignores messages under 20 chars (where Hinglish lives), needs 2 keyword hits, counts `bhai`/`yaar` as Hindi, and keys language on one process-wide global so a WhatsApp contact flips the owner's Telegram reply. | `src/language.ts:71-117,145-149` | M | Likely fixed (commits fe38217, f026abf: owner-only language, everyday Hinglish) |

## Browser (`src/tools/browser/`)

- **Element lists are emitted in two formats, verbose, and ahead of what truncation eats.** Seven hand-rolled `[label] tag 'text'` copies (`navigation.ts:164,328,439,578,632`, `interaction.ts:282`) vs the compact `buildElementsText()` the other tools use. `agent.ts:340` caps `browser_scan` at 2000 chars and the list precedes `captcha_detected`/`status`/`tip`, so those are what gets cut. Use `buildElementsText()` everywhere, put the list last, raise scan cap to ~6000. S.
- **Aria scan silently stops at the first 80 nodes in document order** (`core.ts:1209`) while the DOM path labels 400; on content pages that's header/nav/footer and the real links never get labels. Drop the cap once #1 lands, or sort in-viewport first. S.
- **Chrome-mode page proxy caches `url`/`title` forever** after construction/goto (`chrome-backend.ts:64-73`), so `initialUrl !== finalUrl` is never true: no `waitForPageReady`, no captcha check, model told it's still on the old page. Refresh from `getActiveExtensionTab()` after click/Enter. S.
- **`ChromeLocatorProxy` breaks `.first()` (appends `:first-of-type` to an xpath), `boundingBox` ignores the `xpath=` prefix (so `browser_click {text}` always "Text not found" in Chrome mode), lacks `count()` (upload throws), and `setFileInput` has zero callers.** `chrome-backend.ts:342-355,423-433,653-672`. M.
- **Fixed 300ms sleeps instead of settle-waits; `browser_scroll` returns no elements**, forcing an extra model round-trip per scroll (`interaction.ts:210,263,625`; prompt mandates "scan after each scroll"). Call `waitForPageReady(page, 1500)` after every mutation and rescan in scroll. S.
- **Dead code:** `stagehand-bridge.ts` (no importers, second action cache), `PlaywrightPassthroughBackend` 15 empty stubs, `ChromeExtensionBackend.clickAt/typeText/...` never called, `getBrowser()` returns `pages: () => []` in Chrome mode so tab counts are always 0. Delete. S.

## Computer use (`src/screen/`, `src/tools/os-*`, `macos.ts`)

- **`os_click` "Phase 8" diff compares a 1280px grid-JPEG to a raw Retina PNG byte-for-byte** (`macos.ts:499-514`): verdict is noise, `screen_changed: true` always, ~600ms per click. Delete or use `classifyOutcomeFromImages`. S.
- **`os_smart_click` pays a window `screencapture` plus a second dims probe on every click**, including the AX-hit majority that never uses the image (`os-smart-click.ts:299-317`, `computer-action.ts:261`). Lazy screenshot thunk + pass `dims` through. Saves 300-600ms per click. S.
- **Off-screen AX elements are clamped to the monitor edge and clicked as "trusted" success** (`ax-dump.ts:345`, `computer-action.ts:271-275`). Filter by window rect; error when clamp moves >2px. S.
- **`findElementByLabel` clicks disabled elements and strips positional words** (`left/right/top/toolbar` are stopwords, `ax-dump.ts:437-497`), so "Save in the top-right toolbar" picks the first "Save" in tree order. Skip `!enabled`, break ties by position, return `ambiguous:[…]`. M.
- **Vision-tier verification counts the hover highlight as success** because the mouse moves onto the target before the `before` frame (`os-smart-click.ts:382`, `outcome-classifier.ts:87`), then writes the possibly-wrong coord to click memory. Move first, wait 80ms, capture, then click. S.
- **`os_computer_action key` types the literal word for home/end/pageup/f-keys** (12-entry table at `os-computer-action.ts:685`); `macos.ts:626` already has the full `KEY_CODES` table. Export and reuse. S.
- **Fixed sleeps at every settle point** (350/250/300/500/800ms) — too long on fast machines, too short after `open -a` so the AX dump hits the previous app. Poll frontmost process; diff two captures 100ms apart. M.
- **`os_click_id` replays 30s-old coordinates with no check the same app is still in front** (`os-inspect.ts:32-38,179-211`). Compare pid; re-resolve by label after 3s. S.

## Memory (`src/memory/`, first-iteration block in `agent.ts`)

- **Memory briefing overwrites operational context** (`agent.ts:2260-2277`): above 6000 chars, CURRENT CONTEXT, `<platform_capabilities>`, `<coding_complexity>`, CREDITS, BACKGROUND TASKS are fed to a 400-token nano summarizer told to "omit irrelevant memories" and `activeInjection` is replaced. Also `rawMemories` keys on the first header line, so two `📚 PAST LEARNINGS` parts collide. Partition memory vs operational parts; brief only the former. S/M.
- **`memory_store` has no dedup below importance 7** (`memory-tools.ts:43`, `sqlite.ts:1115`); default is 5, so the same fact stored three days running is three rows. `context-pruning.ts:53` already has `alreadyKnown()` via FTS. Call it in `_rememberDirect`. S.
- **`recall()` has write side-effects** (access_count, decay bump, importance+1 at 10/25/50) and is used as a read API by nightly reflection, dreaming, error-recovery, so `session_summary` rows self-inflate and crowd out user facts. Add `{touch:false}`; exclude `session_summary` from first-iteration recall. S.
- **Knowledge-graph lookup runs the whole user message as `LIKE %…%` on entity name** (`agent.ts:1966`, `knowledge-graph.ts:120`); entity names are full episode sentences. RELATED ENTITIES and recall Layer 1c never fire, yet cost 1+5 queries per turn. Tokenize or drop. S.
- **Hopfield layer is seeded with the oldest 500 rows, never updated, never pruned** (`index.ts:478`, no `ORDER BY`), bypasses `minRelevance` at weight 0.15, and resurfaces forgotten memories. Delete (HNSW already covers it). S.
- **Previous-session continuity shows the oldest 400 chars** (`session.ts:358` `.substring(0,400)` vs `.slice(-297)` on the active path), ignores the LLM-written reflection summary, and `updateSessionGoal` has zero callers so `current_goal` is always empty. S.
- **`recallConversation` full-scans every conversation embedding per turn with no LIMIT**, and the keyword branch orders by recency not match count (`sqlite.ts:2644-2678`). Cap at last 500 or fold into HNSW. S.
- **Active-inference "explore" is always on** (uniform beliefs, zero evidence → `shouldExplore` true), doubling every FTS/HNSW fan-out for nothing; result of `updateBeliefs` discarded (`sqlite.ts:1691-1700`). Delete. S.
- **Heuristic reranker uses no stop-word filter** and overrides the cross-encoder blend at 0.4 weight (`reranker.ts:121-129`), so "the/and/you" overlap outscores semantics. Reuse recall's `stopWords` or drop the pass for `llm_with_traits`. S.

## Personality (`prompts/`, `src/prompts/`, `alive-ux.ts`, `language.ts`)

- **Three of five tone modules can never fire** (`dynamic-assembler.ts:38-66`): `tone_terse`/`tone_detailed`/`tone_casual` key on `preferredLength`/`relationshipDepth`, which the only caller (`agent.ts:2082`) never passes. Traits (`prefers_brevity`, `prefers_casual`) are tracked but never reach it; `getToneDirective()` has zero callers. Wire traits → assembler or delete the modules. S.
- **Emotion detection: `confused` maps to `stressed`** ("be shorter, fix first") — the opposite of what confusion needs; `happy/grateful` map to nothing; "deadline"/"behind" tag ordinary work text as stressed (`dynamic-context.ts:25-30`, `emotion-detector.ts:33-36`). S.
- **"Be casual, don't ask questions" is stated four times per turn** (`identity.md:54-73`, `agent.ts:2093`, `agent.ts:2313`, `rules.md:4`), both runtime nudges can fire together. ~120 wasted tokens and models over-correct into flat replies. Keep identity.md, one runtime nudge. S.
- **alive-ux status strings are a second preset-blind voice**: "ho jayega, hold on", "chalo" shown as 💭 status to Professional users whose addendum bans signature phrases (`alive-ux.ts:78-95`, `telegram.ts:724`). Half the module (`getTaskAck`, `getCasualIntro/Outro` with "anything else?" which identity.md bans, `getProactivePrefix`, greeting strings) has zero callers. Filter by `getToneReminder()`, delete ~130 dead lines. S.
- **Overlay-only markup and the clock widget are taught to every channel** (`identity.md:265-277`, `llm.ts:34`); Telegram HTML-escapes `<` so "what time is it?" renders the literal `<!--WIDGET: {"type":"clock"}-->`. Only overlay parses it. Gate on `channel === "overlay"`, strip HTML comments in `sanitizeAgentResponse`. Saves ~250 tokens per non-overlay request. M.
- **Stale/contradicting rules**: `rules.md:10` says NO_REPLY is Telegram-only but 5 channels honor it; `rules.md:5` + `identity.md:229` + the channel's 💭 edit = three acknowledgements before a tool runs, contradicting the Direct preset; `identity.md:139` and `:151` state the signature-phrase rule twice; `thinking.md` is seeded but nothing reads the slug; `systemContent.ts:14` says 7 slugs (there are 13). S.
- **`morning_energy` module injects unsolicited "surface priorities" on every 6-10am turn**, fighting both `identity.md:72` and Direct/Professional; `evening_wind_down` says "keep brief" even when detail was requested (`dynamic-assembler.ts:114-128`). Delete the first, soften the second. S.
- **Signature-phrase cadence ("one in four", "never twice in a row") is unenforced**: nothing records which phrase the last reply used. Lazy fix: one regex after the final response, one line in the next turn's nudge. S.

## Agent loop and routing (`agent.ts`, `llm.ts`, `model-router.ts`)

- **Context pruning runs two serial LLM calls before the first token** (`agent.ts:1218`, `context-pruning.ts:190-215`): `flushToMemory` is awaited despite the comment saying it's background, then the summary call. 3-6s stall whenever history crosses 60 messages. Fire-and-forget the flush; prune at end of turn. S.
- **Serial account-status HTTPS round trip gates every turn and every 5 tool calls** (`agent.ts:1103`, `account-guard.ts:77-98`); cache is only consulted in the `catch`. Credits are already enforced server-side per LLM call. Return cached when `credits > 0 && age < 30s`; run in parallel with tool selection. S.
- **Tool failure detected by substring `"error"`** (`agent.ts:3527,3699`) instead of the already-computed `isError`: any `read`/`grep`/`web_search` payload containing the text `"error"` unpins Haiku, records a world failure, and injects `[VERIFICATION REQUIRED]`. S.
- **Cascade escalation ignores `opusWarranted()` and discards the escalated model's tool calls** (`agent.ts:3391-3418`): a Sonnet reply flagged "too short" triggers a 2-credit Opus re-run the rest of the router forbids; if Opus calls a tool its reply is dropped and the original text returned. S.
- **Sub-agent recovery re-runs the whole step on Timeout/Transient** (`error-recovery.ts:146-158`), repeating `whatsapp_send`/`browser_click`/`edit` that already executed. Return `mutatorsRan` from `runSubAgent`; skip Level-0 retry when true. M.

## Proactive (`src/proactive/`)

- **Reward model "queue" verdict surfaces the thought** (`heartbeat.ts:219-227`, comment admits "there is no queue"); heuristic fallback can never say suppress at normal times, so an LLM outage makes it *more* talkative; `recentProactiveCount` is never passed so the fatigue term is dead; scoring call runs without `lean: true`. S.

## Suggested batches

1. **Browser reliability** (#1-5 + element-list cleanup + Chrome proxy url refresh): one PR, highest user-visible win.
2. **Computer-use accuracy** (#6-8 + Phase-8 delete + lazy screenshot + key table): one PR.
3. **Memory correctness** (#9-11 + briefing partition + recall touch flag + delete Hopfield/active-inference): one PR, mostly deletions.
4. **Loop + proactive bugs** (#12-16 + substring-error + pruning off critical path): one PR.
5. **Personality** (#17-18 + dead tone modules + prompt dedup + overlay gating): one PR plus a prompt reseed.

---

# Round 2 — deeper sweep (10 passes)

Owner direction for this round: Bhai needs **solid memory**, **very solid task reliability**, and a **strong personality with a soul and tastes of its own**. "Bhai" means brother: fun, smart, reliable, and it ships globally, so Hindi is seasoning, not a requirement. Findings below are new (round 1 items not repeated) and verified at the cited lines.

## Memory (round 2)

- **Synaptic prune hides about a third of older memories within 48h.** It runs every 6h and multiplies the same weak set by 0.8 each pass, so `decay_score` drops under the 0.2 recall floor. Weaken once per day, floor at 0.25. `self-evolving.ts:121-125`, `index.ts:1019`. S, high.
- **Identity is permanently "UNVERIFIED — do NOT echo back as truth".** `confirmIdentityField` has zero callers, so a name said in chat is never used confidently. Treat owner-channel assertions as verified. `identity.ts:169-224`, `memory-tools.ts:310`, `reflection.ts:360`. S, high.
- **GPS/IP location overwrites the user's stated home as verified.** Write device location to `current_location` only. `index.ts:404-411`. S, high.
- **Traits never decay below 0.756**, so a trait inferred once is injected forever. Use stored `last_decayed_at` and a real exponential decay; raise the floor for inferred traits. `traits.ts:26-28,298-304,359`. S.
- **Prospective memory never fires.** "remind me to" becomes a 0%-done goal that accumulates forever. Delete `prospective.ts`, drop the pattern, dedup and expire goals. `prospective.ts:74,115`, `goals.ts:73,199`. S.
- **Recalled lines have no dates**, and recency has a ~3-day half-life. Render `(category · 3w ago)`, move to a 30-day half-life, parse "last week" into a date window. `agent.ts:1895,1958`. S, high.
- **Temporal cache key ignores limit and scope**, and the bloom filter's answer is discarded. Key on query, limit and scopes; delete the bloom class. `temporal-cache.ts:88-127`. S.
- **HNSW rebuild skipped on count tie**, so after forget+store and a restart new memories are invisible to vector search. The boot loop also blocks the event loop. Diff id sets; yield every 50. `vector-index.ts:655-697`. S.
- **Nomic users re-embed the whole store every boot** (768 vs truncated 256 dim). The `context_embedding` column is written and never read. `sqlite.ts:2747-2765,1420`. S.
- **User model and world model can't work.** They query columns that don't exist (`trait_key` vs `key`, `conversations.role`). World model is written but never read. `user-model.ts:119-258`. S.
- **Episodic "KEY MILESTONES" are the same 3 forever.** Order by importance × recency; cap the table. `episodic.ts:82-89,213`. S.
- **"Forget that" can't forget.** Reason is lost, the snapshot is kept forever, and transcripts and episodes are untouched. There is no `memory_update` tool. Add `memory_forget({query})` with a preview and quote-gated execution. `memory-tools.ts:105-124`. M, high (trust).
- **The DB only grows.** Transcripts are stored 3-4 times, with no retention, VACUUM or `PRAGMA optimize`. Roughly 70MB/month. `reflection.ts:71-84`, `sqlite.ts:822-836`. S.
- **Self-model injects "Weaknesses: whatsapp_send (33%)" every turn.** That is the exact pattern the value gate bans because it causes false refusals. `self-model.ts:231-244`. S.
- **Hopfield loader checks embeddings-ready synchronously right after kicking warmup**, so it never loads. Reinforces deleting it. `index.ts:439,469`.

## Reliability: routing and orchestration

- **Category cap drops the tool the task needs.** For "open WhatsApp and send hi", `whatsapp_send` is cut. For "play X on YouTube", `browser_click` and `browser_video_control` are cut. Give each selected category a floor of 4. `tool-router.ts:1408,1675`. S, high.
- **Always-on memory category spends 18 of 36 tool slots every turn.** Keep only `memory_store` and `memory_search` always-on. `tool-router.ts:98-117`. S, high.
- **Classifier sees descriptions cut at 120 chars and only 6 tool names**, so it can't name the tools that would rescue a cut. `tool-router.ts:539`. S, high.
- **Overlapping categories** (coding ⊃ file_system/shell/codebase/code_execution; marketing duplicates; calendar and email duplicates). Make coding the single owner. M.
- **Router analytics are write-only.** `recordToolUsageForAnalytics` has zero callers, so thumbs up/down is a no-op. Wire it or delete about 300 lines. S.
- **The orchestrator plan prompt names tools the router didn't offer.** Build the TOOLS block from the actual selection. `agent.ts:2491,2600-2660`. S.
- **Swarm replan passes empty remaining steps** and then throws on unknown deps. `swarm.ts:182`, `mesh.ts:470`. S, high.
- **Sub-agents return `success:true` on timeout, loop-stuck and max-iterations**, so every recovery path is skipped. `sub-agent.ts:454,642,665`. S, high.
- **Sub-agent context drops the original task between messages 21 and 29**, and can split tool-call pairs (API rejects). `sub-agent.ts:468`. S, high.
- **Handoff discards everything but 300 chars**, while synthesis pastes full outputs. Emit `rawOutputTail`; cap synthesis. `handoff.ts:100-112`, `swarm.ts:514`. S.
- **Dangerous-step gate matches substrings** ("order", "format", "dropdown"). On non-Telegram channels it waits 5 min and then skips. `mesh.ts:127,287`. S, high.
- **Mesh and long-task resume treat failed steps as done.** Long-task cancel can't stop a running phase. `mesh.ts:422`, `long-task.ts:449,639,672`. S.
- **About 25 LLM calls of MCTS and hierarchical planning run before any swarm step.** Their only output is hint text. Gate them behind a flag. `swarm.ts:79,136,468`. S.
- **Evaluator turns an honest 0 into 70** (`||` instead of `??`) and runs on the same tier it judges. `evaluator.ts:105,117`. S.
- **Long-task Telegram controls are dead.** Nothing emits the `[LONG-TASK:` marker, and the progress callback outlives the turn. `telegram.ts:773`, `long-task-tool.ts`. S.
- **Classifier timeout of 5s was sized for nano, but the proxy maps nano to Haiku.** It likely times out and loses tier and multi_step. Measure, then fix. `tool-router.ts:518,576`. S.
- **Dead code:** FunctionGemma isn't used by routing (CLAUDE.md is wrong); pattern-speculator, the blackboard, and `onPartialResult` are unused.

## Reliability: browser (round 2)

- **Playwright profile lives inside the app bundle**, so logins vanish on every update. Use `getDataDir()`. `core.ts:29`. S, high.
- **No cookie bridge between the user's Chrome and Playwright.** `profile-sync.ts` is dead and cannot work. Add the `cookies` permission and a bridge `get_cookies`, and inject on a login wall. M, high.
- **`browser_click_at` auto-closes every new tab**, which kills OAuth popups and `target=_blank` links. Keep the tab and switch to it. `interaction.ts:216-256`. S, high.
- **Dialogs, downloads and nav timeouts are invisible.** `confirm()` is auto-dismissed but reported as success, downloads are deleted, timeouts are swallowed. Add `dialog` and `download` handlers and a `timed_out` flag. `navigation.ts:112`. S, high.
- **Iframes are skipped, and when scanned their coordinates aren't offset.** Card fields, Google Forms and reCAPTCHA are all in iframes. `core.ts:1166,1321-1384`. M, high.
- **Extraction is textContent-only.** Readability never actually loads, and output is capped at 8K with no paging. Inline Readability, add offset/next_offset and table/list shapes. `extraction.ts:346`, `opencli-tools.ts:498,559`. M, high.
- **Two screenshot actions never deliver an image.** `advanced.ts:408,839`. S.
- **Action cache can't replay correctly** (ids include `Date.now()`, no post-condition, stats self-inflate). Delete it. `action-cache.ts`. S.
- **Browser-memory strategies are injected on stop-word matches** with labels that mean nothing next session. `browser-memory.ts:357,382,443`. S.
- **`browser_type` select-alls whole documents** in Docs/Notion. In Chrome mode it appends and never submits. `interaction.ts:719`, `background.js:1209,1417`. M, high.
- **Stealth fingerprint contradicts itself**: UA says Chrome 131 on Chromium 145, timezone is hard-coded to New York, service workers are blocked. `core.ts:214-262`. S.
- **No login/OTP detection or handoff**; only CAPTCHA has one. Add `detectAuthWall` and reuse the CAPTCHA handoff banner. `captcha.ts:597`. S, high.

## Reliability: computer use (round 2)

- **`app_manager activate` returns before the app is frontmost**, so keystrokes land in the previous app. Poll frontmost up to 5s. `app-integrations.ts:1060`. S, high.
- **Destructive hotkeys bypass the gate** (cmd+q, cmd+w, cmd+return send, cmd+delete trash). Add a shared `isDestructiveHotkey`. `tool-intelligence.ts:375`. S, high.
- **Verify gate accepts a no-op screenshot action.** Make it return a real image. `verify-before-done.ts:113`, `os-computer-action.ts:206`. S, high.
- **`modifiers` and `button` are silently dropped on every platform**, so a shift-click becomes a plain click reported as success. `os-computer-action.ts:223,254,273`. S, high.
- **Dock, Spotlight and Control Center are AX-invisible** because only the frontmost app is dumped and `AXDockItem` isn't interactive. `ax-dump.ts:203`. S, high.
- **`os_inspect` default depth 12 hides most web content** (links sit at depth 17). Depth 20 costs the same 0.37s. `os-inspect.ts:71`. S.
- **AX dump walks minimized windows**, which can win the match and cause a misclick. `dump_ax.swift:157`. S.
- **No `AXPress`/`AXScrollToVisible`**, so off-screen list items always fall to vision. Add press/reveal to the Swift helper. M, high.
- **Windows paste mangles non-ASCII.** `os_type` is a PowerShell injection from untrusted text. `os-computer-action.ts:650`, `windows.ts:539`. S, high.
- **Linux key names no-op** (`enter` vs `Return`) but report success. Wayland hold/drag can't work. `os-computer-action.ts:740,837`. S.
- **AX permission error is hidden behind the negative cache** after the first call. `ax-dump.ts:100`, `os-inspect.ts:84`. S.
- **Tool tips and `rules-windows.md` name tools that don't exist on that platform**, or contradict `rules-mac.md`. S.
- **Dead `computer_use` agent** (~800 lines, broken AppleScript). Delete it. S.

## Reliability: channels and delivery

- **Telegram group buffer merges different users** and attributes the batch to the last sender, which can mean owner privileges for a non-owner. Key the buffer by chat and user. `telegram.ts:524-545`. S, high (security).
- **Code blocks get mangled by md→HTML** (`__init__` underlined, `# comment` bold). Placeholder-protect code. `telegram.ts:68-113`. S, high.
- **Chunks exceed 4096 after HTML conversion**; a fence split mid-block breaks parsing. `telegram.ts:988`, `alive-ux.ts:452`. M, high.
- **Streaming edits have no 429 handling**, and failed fallbacks drop bubbles. Add `@grammyjs/auto-retry` and keep at least 1s between edits. `telegram.ts:922-1012`. S, high.
- **Videos always error at the Claude proxy**, and audio parts are dropped silently, so song-ID hallucinates. `agent.ts:1170`, `convex/claude.ts:47`. S, high.
- **Telegram ignores non-image documents** (PDF/CSV/txt) silently. `telegram.ts:1050`. S, high.
- **Telegram voice handlers are registered twice**, the second set is dead, and there's no voice reply. `telegram-voice.ts`, `index.ts:523,578`. S.
- **Media and voice tasks can't be stopped** and show no progress. `telegram.ts:1366,1500`. M.
- **"quite" or "can't stop laughing" triggers stop.** Use a word-boundary regex. `telegram.ts:428`, `whatsapp.ts:1300`. S.
- **Discord, Slack, email and widget share the owner's history** and leak `[THINKING]` and approval markers. `discord.ts:287,687`, `slack.ts:195`. M, high.
- **WhatsApp shows "typing" for 10s, then silence**; `progressTimer` is never assigned. `whatsapp.ts:1408`. S.
- **WhatsApp bad-session reconnect loops forever**, wiping auth. Transient errors give up permanently after 20. `whatsapp.ts:2217`. S.
- **`ask_owner` contact context is a module global**, so concurrent contacts collide. `ask-owner.ts:38`. S.
- **Cross-channel sends to Telegram broadcast to every allowed user** and can be DND-suppressed while reporting success. `telegram.ts:1896`. M.
- **Overlay PDF drop dumps binary into the prompt.** `overlay-chat.ts:1051`. S.
- **Email threading is broken** (References, `RE:` case) and markdown is sent as unescaped HTML. `email.ts:196,447`. S.

## Reliability: desktop app and boot

- **About 10 modules write state to `cwd/data`, which is inside the read-only bundle.** WhatsApp re-pairs after every update, VAPID keys regenerate, proactive config is never found. Use `getDataDir()`. `push.ts:32`, `whatsapp.ts:83`, and others. S, high.
- **First run fires mic and Accessibility OS prompts before any UI**, and the mic await blocks the wizard. `desktop/main.js:6309`. S, high.
- **Ad-hoc signed, not notarized.** Gatekeeper blocks it, TCC grants go stale, and auto-update can't install. `desktop/package.json:203`. M, high (needs a Developer ID).
- **Session fetch has no timeout**, so captive-portal Wi-Fi hangs boot forever. `session.ts:136`. S, high.
- **Bot crashes and the "gave up restarting" state are never shown.** `main.js:1405`, `panel.html:1909`. S, high.
- **No overlay streaming**, and an error wipes the user's typed prompt. `overlay-chat.ts:956`, `overlay.html:3178`. M, high. *Retry fixed: an error keeps the prompt, Enter resends it. Streaming is out of Phase 4.*
- **Overlay is a single reply box** with no scrollback, no headings and no numbered lists. M. *Fixed: the last 10 turns of the session stay above the reply; headings render and code is no longer rewritten. Numbered lists read fine as plain lines.*
- **Hotkey during boot says "press again"** instead of showing a splash. `main.js:1964`. S.
- **Permission probe only logs**; the UI never learns that Accessibility is stale. `macos-permissions.ts:108`. S.
- **Two optional server syncs block boot serially**, costing up to 50s. `index.ts:201-236`. S.
- **Boot log dumps hundreds of tool names.** The SSID watcher spawns a binary Apple removed in 14.4. S.

## Reliability: coding and Forge

- **`shell_exec` drops stdout on failure** (tsc and vitest errors are hidden) and head-truncates. `test_run` JSON is cut mid-object. `shell.ts:186-230`, `agent.ts:340`. S, high.
- **`edit` refuses on CRLF or trailing-space drift.** Add normalized fallback matching. `edit.ts:180`. M.
- **Complexity classifier sends "fix auth.spec.ts" into the design-docs ceremony.** `model-router.ts:619-676`. S, high.
- **`generate_design_docs` times out at 25s**, ships placeholder templates, and still locks the agent in approval. `design-docs.ts:74-216`. M, high.
- **`approve_design_docs` self-approves on any 2-char substring** ("ok" in "looks"). Reuse Forge's `isQuoteAcceptable`. `design-docs.ts:258`, `consent.ts:41`. S, high (security).
- **`git_op` accepts raw refspecs** (`+main`, `:main`, leading `-`), which bypass the force and protected-branch gates. `git-op.ts:248-431`. S, high (security).
- **LSP never sends `didChange`**, so post-edit diagnostics are stale. The codebase index never refreshes after the agent's own edits. `lsp.ts:412,733`. S, high.
- **Walkthrough summarizes the last 10 unrelated commits** while the agent is told never to commit. `walkthrough.ts:89`. S.
- **`demo_project` misses Flask/Django/requirements.txt** and reports the wrong port when Vite bumps. `demo-project.ts:73-148`. M.
- **Forge verifier sandbox differs from production**, and always-pass expectations are allowed. `sandbox-runner.ts`, `verifier.ts:439`. M, high.
- **Forge lookup reuses wrong, unapproved or unregistered tools.** Dedup is never called. `orchestrator.ts:181-345`, `lookup.ts:99`. S, high.
- **Synthesized and approved tools are never offered to the model.** They are in no router category. `tool-router.ts:1660-1860`. M, high.
- **Verifier and `code_action` pass host functions into LLM code before approval** (`parseInt.constructor` is the host Function). `sandbox-runner.ts:28`, `code-action-agent.ts:35`. S, high (security).
- **Approval message asks the user to type a function call.** `approval-gate.ts:54-91`. S.

## Reliability: voice, research, security

- **STT fallback sends audio to the proxy, which drops it.** Without OpenAI or Groq keys, voice notes "transcribe" to nothing or to hallucinated text. `transcribe.ts:63`, `convex/claude.ts:39`. S, high.
- **ElevenLabs uses an English-only model and sends MP3 labelled ogg/opus PTT.** `elevenlabs.ts:14-36`, `whatsapp.ts:736`. S, high.
- **Voice replies read markdown and markers aloud.** `stripTtsMarkup` exists but is used only in live voice. `whatsapp.ts:734`. S.
- **Hybrid barge-in cancels the audio but not the in-flight turn**, so the old answer resumes mid-sentence. `live/session.ts:597`. S, high.
- **Research URL dedup is byte-exact**, so one article counts as "3 sources". `executor.ts:137`. S, high.
- **Research fetch failures are silent**, 4xx responses are retried, PDFs and JS shells are dropped, and there's no browser fallback. `fetcher.ts:121-170`. M, high.
- **Per-page LLM analysis runs serially** after a parallel fetch. `executor.ts:208`. S, high.
- **Synthesis never sees source URLs**, so citations can't link. `analysis.ts:393,437`. S, high.
- **Research crash checkpoints are deleted on boot**, never resumed. `persistence.ts:116-163`. M.
- **"Strong confidence" comes from a 0.15 Jaccard** against concatenated findings. `scoring.ts:112`. S.
- **Sub-agents and live voice feed raw web and tool output without the untrusted fence.** Wrap once in `executeTool`. `sub-agent.ts:610`, `live/session.ts:961`. S, high (security).
- **`shell_exec` codebase protection only checks 5 command names** but runs through a shell (`sed -i`, `>`, `git clean` bypass it). `shell.ts:64-151`. S.

## Personality (round 2)

- **Bhai avoids the user's name** because identity marks it "do NOT echo" (same root as the memory item). `identity.ts:169`. S, high.
- **Live voice skips the Settings preset**, and its overlay says "some days you're chipper", which contradicts "calm, not cheerful". `live/prompt-builder.ts:29,100`. S, high.
- **WhatsApp contacts get two personas** ("Personal Assistant" client prompt plus the Bhai identity) and a call-centre refusal. `whatsapp.ts:1554-1598`, `whatsapp-users.ts:118`. M, high.
- **Exemplar lines repeat across sections** ("morning ☕" ×3, "look at you go" ×2, "ho gaya ✅" ×3), so the model parrots them. `prompts/identity.md`. S, high.
- **Relationship and self-state inject "use relaxed tone" twice and only ratchet up**, ignoring the preset. The streak counts sessions, not days. `relationship.ts:94-143`, `self-state.ts:171`. S.
- **The default preset is pushed as an "OVERRIDE" of itself** (about 150 tokens) and promises cross-channel consistency it doesn't deliver. `personality-sync.ts:39-44`. S.
- **Tier-1 examples ship the founder's full name** and a sample tease aimed at the user. `identity.md` § 2. S.
- **No regression guard on voice.** Add an identity.md structural test and a prompt × preset eval. M.
- **User can't rename Bhai or set a nickname that sticks.** Add `user_nickname` and `bot_nickname` to the profile. `identity.ts:14-31`. S.

---

# Ideas: making Bhai feel known, reliable, and alive

Merged from the personality pass and the product pass. Each idea plugs into an existing hook. Ideas are listed by visible impact within each goal.

## Memory that feels like being known

1. **"Noted" with a one-tap undo.** `memory_store` ids go back to the channel as a `forget that` button (Telegram `InlineKeyboard`, overlay `QUICK_ACTIONS`). At most one per turn, removed after 10 min. S.
2. **Corrections supersede instead of duplicating.** Add a `supersedes` flag on `memory_store`, set the old row's `consolidated_into` (recall already hides those rows), and require a contradiction cue in the user's text. S/M.
3. **Dates on every injected memory**, plus a rule: facts older than about 90 days count as "last known", so hedge if it matters. S.
4. **Commitments surfaced once, on time.** Category `commitment` with `due_at`, fired once by a proactive source. Only first-person commitments, never inferred ones. M.
5. **People / Projects / Preferences / Commitments cards** instead of a flat dump, with `person:<name>` tags matched against capitalized names in the message. This replaces the dead knowledge-graph lookup. S/M.
6. **Bhai remembers what it did for you.** One `bhai_did` row per turn from verified mutators, so "same as the 12 Oct one? sent via Gmail". S.
7. **Confidence-tagged recall**: "if I remember right…" when the match is thin, never for the user's name. S.
8. **"Forget that" across every tier**, with a preview list and quote-gated execution. S/M.
9. **Pin on "remember this, it matters".** Pinned memories always keep a slot in the core memory list. S.
10. **Weekly "what I picked up about you" digest** with prune buttons. Only facts the user stated, never inferred moods. Skipped if under 3 items. M.
11. **Style corrections remembered**: "stop with the bullets" becomes a trait with a 30-day half-life unless repeated. S.

## Reliability on tasks

1. **The ack is the contract.** "on it — sending the Oct invoice to Priya via Gmail; done = sent screenshot." The verify reminder then quotes the contract back. S/M.
2. **Stuck report with a one-tap handoff**: what was done, the blocker, the evidence, what's needed, plus [I'll take over] [retry] [skip]. This conflicts with identity.md's "I can't is not in your vocabulary" and rules.md's "NEVER GIVE UP". Rewrite both to "never give up silently, never fake done". M.
3. **Done comes with the receipt.** The verifier's screenshot, URL or artifact path is attached to the final reply when a mutating tool ran. M.
4. **A trust ladder that remembers.** "Pay ₹480 on Swiggy? [yes, always under ₹500] [just this once]", stored as exact-scope grants with a cap and a 30-day expiry. M.
5. **A heartbeat that names the step**: "step 2/4 · logging into the portal · 38s" instead of vibes. S.
6. **Pre-flight before the plan runs.** Check permissions, that the app is installed, and that the site is logged in, and hand off before ten minutes of clicking. M.
7. **Idempotent sends.** A per-turn ledger on (tool, recipient, content hash), so retries never double-send. S.
8. **Playbooks written automatically from verified wins**, with `last_verified_at` and demotion after a failed replay. S/M.
9. **Resume after a crash, with the user's say-so**: "I was mid-way sending the invoice — pick it up?" S.
10. **Verify failure reports the difference** ("expected Sent, saw Draft") so the retry differs. S.
11. **Failures become learnings too** ("avoid: searching contacts by first name in WhatsApp Desktop"), after 2 occurrences or a user correction. S.
12. **"ho jayega, ~2 min" with an honest overrun line** at twice the estimate. Only with 3 or more past runs. S.

## Personality with a soul

Bhai is the older brother or close friend. He has an inner life (tastes, pet peeves, how he reacts to wins and messes), stays the same person across channels and days, and remembers you without surveillance.

1. **A voice guide of contrastive pairs** replaces the rule lists: about 30 "✗ … → ✓ …" pairs across win, loss, stuck, 2 AM, user wrong, Bhai wrong, scam, crisis, and mirroring Hinglish. Each exemplar appears once. identity.md keeps identity, safety and honesty; the voice guide owns style. M, highest visibility.
2. **Brother reactions as a switch, not a vibe.** A win gets one beat of real noise, then work, and is saved as a `win` episode to call back later. A loss gets steady, no jokes, the next step. S.
3. **One "shades-off" (serious) mode for every surface.** Set by grief, health, money loss or crisis, and enforced in code: no catchphrases, the steady status set, proactive paused, slower text-to-speech. Cleared after two light messages or 24h. M.
4. **Per-channel register table.** Telegram and WhatsApp get at most 2 lines; overlay gets full replies with markup; voice is spoken style with no emoji; email uses sentences. This also gates the overlay markup. S.
5. **A small card of stable opinions**, offered only when asked: lo-fi, team chai, tabs, under 10 browser tabs, no 2 AM deploys, pineapple pizza yes. They are framed as "an AI's take on principle" and never claim lived experience. S.
6. **Pet peeves triggered by evidence**: 47 open tabs, `final_FINAL_v3.docx`, `rm -rf` in history. One dry aside, and only when a tool result shows it. M.
7. **Callback discipline.** Episodes track `callback_count`; a running joke is created only when the user plays along and retired after 3 uses. Callbacks draw only on things the user told Bhai, never things observed from screen or email. S/M.
8. **Humor calibrated by what lands.** A `humor_receptive` trait comes from lol/😂 on the message after a joke, and decays back to "sometimes". S.
9. **Hindi seasoning that adapts.** A user in Berlin gets "ho jayega — it'll get done" glossed once, then rarely. A Hinglish user gets "chalo" often and never a gloss. Each phrase is glossed once ever. S.
10. **Nickname protocol, remembered.** `address_as` is set only on an explicit "call me". `calls_bhai` is mirror-only. A name governor allows the user's name at most once per ~10 messages and never twice in a row. S.
11. **Respecting silence.** "not now", "busy" or a heavy message sets `quiet_until`, which proactive honors; urgent alerts still pass. S.
12. **Earned confidence.** "Done this four times, two minutes" versus "first time on your machine, might take a try", from real playbook stats, translated into words, never percentages. S.
13. **Being wrong, done properly.** Own it, fix it, no apology spiral. A `correction` memory surfaces when the topic recurs. S.
14. **Proactive texts that read like a friend's.** The composer gets the preset, the user's register and one callback candidate. Two unanswered sends mean FYI-only for 48h. M.
15. **Milestones that fire once, ever** (7, 30 or 100 days; one year since the first chat), on distinct-day streaks. S.
16. **Self-lore that's true for an AI** (orange cube, no hands, "212 days old"), only when the user asks about Bhai. S.

---

# Roadmap

Five phases, each one or more PRs. Phase 0 comes first because it is data loss, security, or failures the user can't see. Most items are S.

**Phase 0 — Stop the bleeding.**
- *Data loss:* data dir for the browser profile and the ~10 `cwd/data` writers; the 6h prune; GPS overwriting location; shadow mode storing rejects; surprise gate; HNSW tie; nomic re-embed; identity "UNVERIFIED".
- *Security:* Telegram group buffer; `approve_design_docs` substring; `git_op` refspecs; Forge and `code_action` host functions; untrusted fence for sub-agents; `shell_exec` protection; Windows PowerShell injection; destructive hotkeys.
- *Silent failures:* 402 status; 25s deadline on thinking turns; session fetch timeout; crash toast; sub-agent `success:true` on failure; STT fallback; video sent to the proxy.

**Phase 1 — Reliability.**
- *Tool routing:* category floor, slim always-on memory, classifier summaries.
- *Browser:* round-1 batch, plus new tabs, dialogs, downloads, iframes, `browser_type`, auth-wall handoff, cookie bridge.
- *Computer use:* round-1 batch, plus activate-wait, modifiers, Dock AX, depth 20, AXPress/reveal, real verify screenshot.
- *Agent loop:* nudges out of history; substring "error"; pruning off the critical path; account check cached.
- *Orchestration:* swarm replan, sub-agent context, handoff, mesh gate, resume.
- *Channels:* Telegram HTML, chunking, 429, documents, stop regex; WhatsApp progress and reconnect.
- *Product:* ack-as-contract, stuck report, receipt, idempotent sends, step heartbeat, playbooks from wins.

**Phase 2 — Memory.**
- *Correctness:* round-1 memory batch; trait decay; dates on recall and a 30-day half-life; temporal cache key; delete prospective, Hopfield, active-inference and world-model; episodic recency; retention and VACUUM; drop "Weaknesses".
- *Product:* undo button; supersede on correction; `memory_forget` across tiers; pin; commitments; People/Projects cards; `bhai_did`; weekly digest.

**Phase 3 — Personality.**
- *Prompts:* voice guide of contrastive pairs (rewrite identity.md style sections, reseed); per-channel register; one serious-mode flag across all surfaces.
- *Wiring:* tone modules wired to traits; emotion mapping fixed; Hinglish per-user detection; voice and proactive respect the preset and language.
- *Persona fixes:* WhatsApp contact persona; nickname protocol and name governor; callback, joke and humor registries; stable opinions card; brother reactions; silence respect; regression test plus preset eval.

**Phase 4 — Polish and deletions.**
- *Delete:* dead code (`stagehand-bridge`, `action-cache`, `computer-use-agent`, `profile-sync`, router analytics half, MCTS stack behind a flag, alive-ux dead exports, `thinking.md`).
- *Overlay:* streaming, scrollback, retry, splash.
- *Research:* dedup, parallel analysis, cited URLs, resume.
- *Coding:* stdout on failure, CRLF edit, LSP `didChange`, classifier fix, design docs, walkthrough.
- *Forge:* single sandbox, lookup gating, dynamic tools offered to the router.
- *Distribution:* signing and notarization.
