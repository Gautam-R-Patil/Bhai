# Live streaming: see Bhai think, work and answer as it happens

Design, 2026-10-30. Status: built 2026-10-30; manual check on the real surfaces pending. Builds on the Phase 4 tree (main `5d12c401`).

## 1. Why

Today, after you ask Bhai something in the overlay, you see a mascot in its "thinking" pose and, at most, one progress line that changes every few seconds (and sometimes doesn't, because updates get dropped). Then the whole answer lands at once. On a 20-60 second task it is hard to tell whether Bhai is working, stuck, or gone. The owner wants to *see* that Bhai is working, see what it is thinking and doing if they care to look, and read the answer as it is written, the way Gemini, ChatGPT and Claude feel. Reliability is one of Bhai's three pillars; visible, honest progress is part of it.

## 2. What the owner decided

All of these came from the owner in the brainstorm (mockups in `.superpowers/brainstorm/`, screens `working-view-v2.html` and `working-motion.html`):

1. **Minimal by default.** While Bhai works, the chat shows one live line: what Bhai is doing right now ("Comparing 14 flights by price…"), a step count, an elapsed-seconds counter, a chevron, and a thin moving bar. Nothing else.
2. **Thinking one tap away.** Clicking the live line slides open a "behind the scenes" panel: a *Thinking* section (what Bhai is thinking now) and a *Steps* section (every step so far, finished ones ticked, the current one pulsing). Clicking again closes it. "Perfect", per the owner.
3. **The answer types itself in** word by word under the live line, with a blinking caret, instead of landing whole.
4. **Animation: Bhai's face, alive** (option C). Bhai's character visibly works (bobs, blinks, glances, a soft ripple) so you can tell from the corner of your eye that something is happening. Minimal, but good, "like Gemini".
5. **All surfaces:** the desktop overlay, the desktop app's in-app chat (Chats tab, added by the owner during the build), the Chrome extension side panel, and the web widget.

## 3. Goals, non-goals, anti-goals

**Goals**
- First visible sign of life (live line) within ~300 ms of sending; first answer words within ~1 s of the model starting to write the answer.
- Every step Bhai takes appears in the panel; the live line never sits stale for more than a few seconds while work is happening.
- The answer streams on all three surfaces; Stop works on all owner surfaces.

**Non-goals (this project)**
- Telegram, WhatsApp, Discord, Slack, Matrix, email, voice: unchanged. (Telegram edit-in-place streaming can reuse this work later as its own step.)
- Changing what Bhai says or how it decides; no new prompts, no prompt reseed.
- Token-level billing or any pricing change.

**Anti-goals (a failure even if it "works")**
- **Leaks.** Streamed text, narration or thinking must never show anything the final reply would hide: vault values, card/OTP/Aadhaar values the owner isn't entitled to see here, internal tags (`<system_log>`, `<tool_log>`, `<memory-context>`, `[Tool Result …]`, `[SOURCE:…]`), markers (`[[STUCK]]`, `[NO_REPLY]`, `<!--QUICK_ACTIONS…-->`, `<!--WIDGET…-->`), or the server system prompt.
- **Fake "done".** A reply that Bhai's own checks send back for more work must not stay on screen as the answer.
- **More cost or slower turns.** No extra LLM calls, no extra credits, no longer total turn time.
- **Lost answers.** A dropped connection or a failed hop never leaves a half answer with no explanation.
- **Breaking old pieces.** An overlay page left open across a bot restart, an older extension, or a bot talking to a server without streaming must keep working exactly as today.
- **Motion that nags.** No large or constant movement; respect the OS "Reduce motion" setting.

## 4. How it works (the builder's starting point)

These are my calls as the designer unless marked as the owner's. The builder may change mechanics if the result meets sections 3 and 5.

### 4.1 The pipe, end to end

```
Claude ──SSE──▶ Convex /api/llm/chat ──encrypted frames──▶ llm.ts ──▶ agent.ts ──turn events──▶ overlay-chat.ts ──WS──▶ overlay / side panel / widget
          (already streams;                (new: opt-in)          (new: onDelta)  (new: safe filter)      (new msg types;          (new rendering)
           today .finalMessage())                                                                         final `response` stays)
```

The final `response` message stays exactly as today and stays **authoritative**: when it arrives, every surface replaces whatever it streamed with it. Streaming is a preview layer on top of today's protocol, which is what keeps old clients working (they ignore unknown message types; all three surfaces were checked).

### 4.2 Server (`convex/http.ts`, `convex/claude.ts`)

- **Opt-in.** The client asks for streaming with a request field (e.g. `stream: true`). Without it the route behaves exactly as today.
- **Stream frames, not one body.** Instead of `.finalMessage()`, forward the Anthropic stream as a `ReadableStream` of newline-delimited encrypted frames. Frame kinds: `text` (answer/narration delta), `thinking` (summarized thinking delta), `tool` (a tool call has started: name only; its arguments arrive in `done`), `reset` (discard everything streamed so far in this response), `error`, and a final `done` carrying the full OpenAI-shaped `ChatCompletion` exactly as today's body.
  - The client builds its `ChatCompletion` **only from `done`**. Deltas are for display. This keeps tool calls, usage and every downstream consumer unchanged.
- **Encryption.** Each frame is its own AES-256-GCM envelope with a fresh IV under the session key. The AAD binds the request's `rid`, a frame sequence number, and a final-frame flag, so frames can't be reordered, dropped, replayed from another response, or truncated without the client noticing. A missing `done` = failed attempt.
- **Server-side fallback** (`fallbacks: "default"`, triggered by refusals). Per the Anthropic refusal/fallback docs, the fallback model *continues* the partial text, so text already streamed stays valid. On a `fallback` block, emit a `void_tools` frame: it cancels earlier `tool` frames and earlier thinking for display, and keeps the text. Emit `reset` only when the final `stop_reason` is `refusal` (no fallback left, e.g. Haiku), which discards everything.
  - Fix the real existing bug in `toOpenAIResponse`: drop `tool_use` blocks that come before the last `fallback` block, and drop all `tool_calls` when `stop_reason` is `refusal` (a half-built tool call can be returned). Keep text joined as today. Test both.
- **Thinking.** On the 5.5 models thinking `display` defaults to `"omitted"` (empty deltas), so it must be requested explicitly. The owner chose `"updates"` (short progress notes, not summarized reasoning): see section 9. Rules:
  - Set the same `display` on **every** main-loop call whether or not it streams (kill switch, Azure, final-answer re-call, cascade), because a thinking-config change starts a new prompt-cache prefix. Expect one cache miss per conversation at rollout, then hits; measure it once on dev.
  - Sonnet's `between_tools` lane rejects `display` (400) and already returns progress text; leave it unset there. Haiku with thinking off has nothing to show.
  - On Opus/Sonnet 5.5, narration between tool calls arrives as progress-update *thinking* blocks, not as `text`. Treat them as the main source for the panel's Thinking and for sharper live-line text; the agent's own step statuses remain the fallback (models write fewer updates at high effort).
  - Thinking is **never** added to the final `ChatCompletion` content.
- **Delivery details.** Return `new Response(readable)` at once and write from a detached task (Convex's own streaming component does this; `ctx.runMutation` for usage/logging still works after). Pass `request.signal` to `anthropic.beta.messages.stream(params, { signal })`; always close the writer in `finally`; catch errors in the detached task and send an `error` frame. Send `Content-Type: text/event-stream` and `Cache-Control: no-cache, no-transform`. HTTP actions have a 30-minute limit, far above a 32k-token call.
- **Frame sizes.** One encrypted frame per token leaks token lengths to anyone who can see the traffic (a known way to rebuild streamed LLM text). Coalesce deltas server-side (~50-100 ms) and pad each frame to a size bucket (e.g. 256 bytes).
- **Billing unchanged.** Flat per-call charge taken before the call, as today. Provider error before `done` → refund, as today, reported as an `error` frame (headers are already sent, so not an HTTP status). Client disconnect: stop reading the Anthropic stream (abort it) to save upstream tokens; the flat charge stands, as it does today for an aborted call.
- **Azure/Grok (unhinged, CAPTCHA models)** stays non-streaming in this project: it returns one `done` frame. The surfaces still show the live line and steps; only the answer arrives whole. (Its own streaming is a later step.)

### 4.3 Client transport (`src/crypto-transport.ts`, `src/llm.ts`)

- `llm.chat()` gains an optional `onDelta(event)` callback. When present (and streaming isn't killed), it sends `stream: true`, reads frames as they arrive, verifies each, and calls `onDelta` for `text`/`thinking`/`tool`/`reset`. It still **returns a `Promise<ChatCompletion>`** built from `done`, so the middleware chain (cache, language, telemetry, cost) and every caller stay unchanged.
- **Timeouts for streams:** a time-to-first-frame limit (today's per-effort attempt timeout) plus a gap-between-frames limit, instead of one total-duration deadline that would cut a healthy long answer.
- **Fallback between models / last-resort retry / 401 refresh:** each new attempt starts with an implicit `reset` to `onDelta`, so text from a failed attempt is discarded on screen.
- **Decrypt failure mid-stream** is an attempt failure (like today's synthetic 502) and leads to the normal fallback, after a `reset`.
- **Strict on the streaming path.** Today `encryptedFetch` accepts any response without the (unauthenticated) `X-Encryption` header as plaintext, so an on-path attacker could swap in a plain `ChatCompletion` with `tool_calls`. When the client asked for a stream, a 2xx response that isn't encrypted frames is rejected; only non-2xx plain error bodies pass, as today. (Closing the same hole on the non-streaming path is a separate follow-up, since it changes how old-server and error responses are handled.)
- Only the agent's main per-iteration call (and the final-answer re-call, and cascade re-call) pass `onDelta`. Helper calls (classifier, HyDE, briefing, planner, research, memory, grounding) never stream.
- The main call should also receive the turn's abort signal so Stop ends the stream immediately (today it waits for the call to finish).

### 4.4 Agent loop (`src/agent.ts`)

The agent turns model deltas and its own progress into **turn events** for the chat surface. A new optional callback on `runAgent` (e.g. `onTurnEvent`) carries structured events; the existing string `onProgress` stays for every other channel, so the 13 other `runAgent` callers don't change.

Events (all carry the turn id):
- `status {text, step, elapsedSec}`: the live line. Comes from today's milestone/step statuses (`MILESTONE_DESCRIPTIONS`, `step-status.ts`). **Coalesce, don't drop**: today's 3 s throttle drops updates; for turn events keep the latest and flush it, so the live line is never stale.
- `step {id, text, state: running|done|failed}`: the panel's step list. One per tool batch/milestone; the contract line (`on it — …; done = …`) heads the panel when present.
- `thought {text}` (append): the panel's Thinking section. Sources: model thinking deltas, and narration text that turns out to precede tool calls (see below).
- `answer {attempt, text}` (append) and `answer_reset {attempt}`: the streaming answer.
- `end`: the turn is over (the final `response` follows/accompanies it).

**Narration vs answer.** While a response streams, Bhai can't know yet whether the text is the answer or narration before tool calls. Rule:
1. Text deltas stream as **answer** (with the safety filter, 4.5).
2. If a `tool` frame arrives in the same response, emit `answer_reset`, and move that text into **Thinking** (it was narration: "Let me open Google Flights…").
3. If the response ends with no tools, the text is a *candidate* answer. If any of Bhai's checks then sends it back for more work (anti-giving-up, leave-to-look, ack-without-action, verify-before-done, persistence nudge, final-answer model switch, empty retry, cascade), emit `answer_reset` and add a step such as "Checking it actually worked". Nothing that a check rejected stays shown as the answer.
   - The verify-before-done gate can be predicted *before* the call (it depends on state, not text); the builder may use that to stream such a reply straight into Thinking instead of answer-then-reset. Optional.
4. Final reply: the `response` message replaces the streamed answer with the fully processed text (stuck line, reveal, quick actions, widgets, links, receipt).

**Owner-only content.** `thought` events (thinking and narration) go only to owner sockets on owner, non-autonomous turns. Widget (guest) turns get `status`, `step` and `answer` only. Today `[THINKING]` isn't owner-gated; fix that too.

### 4.5 The safety filter (the most important piece)

Every `answer` and `thought` delta passes through one streaming filter **in the agent process** before it leaves:
- Reuse and extend `StreamingContextScrubber` (`src/context-scrubber.ts`, exists, unused).
- **Hold back, don't guess:** text that might start a tag or marker (`<`, `<!--`, `[`, `*[[`, a backtick-wrapped `[[`) is held until it's clear whether it is one. Known blocks (`<system_log>…`, `<tool_log…>`, `<memory-context>…`, `[Tool Result …]`, `[SOURCE:…]`, `<!--WIDGET…-->`, `<!--QUICK_ACTIONS…-->`) are swallowed until their terminator. Markers (`[[STUCK]]`, `[NO_REPLY]`) are dropped.
- **No reveal while streaming** (my call). `[OTP_1]`-style handles stay handles in every streamed delta; only the final `response` reveals them, under today's rule (owner, private, non-autonomous, never vault secrets). Reason: during a turn Bhai keeps taking screenshots, and the Chrome side panel (and the overlay on Linux) is visible to screen capture, so a revealed value would land in the model's next screenshot or the done receipt.
- **Thinking and narration** additionally go through credential masking (`protect(…, {credentials: true})`) and the secrets sanitizer, line-buffered, because they are new exposure: code tools' raw output can reach the model unmasked.
- **Withdrawn text.** Narration, a candidate answer a check rejects, or a failed attempt's text can be visible briefly before `answer_reset` clears it. That is accepted (the widget only connects on the owner's own machine). What is never accepted is showing anything the filter hides.
- **The invariant to test:** for any reply and *any* way of cutting it into chunks, nothing the filter emits contains a hidden tag, marker, block content, revealed value or unmasked credential; and for an answer that becomes final, the streamed text equals the final text with handles unrevealed and end-only additions (stuck line, quick actions) removed. Property test it with randomized chunk boundaries over a corpus of real replies containing every tag/marker/handle.

### 4.6 Chat protocol (`src/overlay/overlay-chat.ts`)

- New WS message types mirroring the turn events, each with `turn` (id) and `seq`: `turn_status`, `turn_step`, `turn_thought`, `turn_answer`, `turn_answer_reset`. Deltas are coalesced per socket (~30-50 ms) so a fast answer isn't thousands of messages.
- Existing `thinking` (turn start), `contract`, `progress`, `response`, `error`, `silent` stay as they are. Old pages/extensions keep working off them.
- **Routing.** Turn events go only to the socket the turn belongs to (plus same-chat reroute after a reconnect, as today). Never fall back to "the only owner socket" for streaming events: that path today can push an overlay turn into the extension's side panel.
- Background `progress` broadcasts (research) must not overwrite a running turn's live line: tag them as background and let surfaces show them elsewhere or not at all during a turn.
- Desktop companion stdout (`COMPANION_TYPES`): don't add the per-delta types (it would print a line per delta); keep turn start/end only.

### 4.7 Surfaces

**Desktop overlay (`src/overlay/overlay.html`)**
- During a turn: reply box visible with the live line (dot, shimmering text, `step N · Ns`, chevron) and the thin moving bar; panel closed by default; panel open/closed state remembered (my call) in `localStorage`.
- Answer: append to an accumulator, re-render with `renderMd` at most once per animation frame (it's pure and safe to call repeatedly). Call `replyArriving()` **once** per turn (it isn't idempotent). Don't re-run the bubble spring, input clear, `waiting=false` or quick-action rebuild per delta; those run on the final `response`.
- Partial markdown: avoid ugly flips (e.g. don't render an unclosed code fence as plain text; hold it as a code block until closed). Builder's call how.
- `answer_reset`: clear the streamed answer back to the live line (no history entry).
- **After the turn** (my call): the live line collapses into a quiet "Worked for 23s · 5 steps ▾" above the finished answer, which still opens the panel, like "Thought for 23s" in ChatGPT/Claude/Gemini. It lives only for the session (in memory with the overlay's reply history); thinking and steps are **not** written to disk, `chrome.storage` or the chat log, so no new at-rest copy of thinking exists.
- **Stop** (my call): the text already streamed stays, followed by a plain "Stopped." note, the way the reference products behave. The stopped `response` carries the partial (filtered) text, and the agent adds it to the conversation history as an interrupted assistant message, so "continue from there" works.
- **Mid-turn hide or reconnect:** the bot keeps each running turn's current state (live line, steps, thought so far, answer so far) and sends a snapshot to a socket that (re)joins that chat, so a reopened overlay picks up where it was.
- Accessibility: `aria-busy=true` on the reply while streaming so screen readers announce once at the end.
- **Bhai alive (owner's choice C):** drive the existing mascot (`BhaiMascot`, moods/poses, `react()`): `thinking` while a thought streams, `looking` while reading/browsing steps, `working`/`typing` while acting or while the answer streams, a small `react('nod')` when a step completes, `happy` at the end, `oops` on error. The mascot already skips pose swaps under Reduce Motion; keep the live dot/bar/shimmer subtle and static under Reduce Motion too.

**Chrome side panel (`chrome-extension/background.js`, `sidepanel.js`)**
- Same live line + panel + typed answer, styled to the side panel. The extension has no mascot today: bring the mascot over if the generated mascot block can be reused cleanly, otherwise a small animated Bhai face; builder's call, but it must read as "Bhai is busy".
- Streaming updates a *draft* message in place; the final `response` replaces it in the stored chat. Don't write `chrome.storage.local` per delta (today `addChat` writes the whole array each time); write once at the end. `renderChat` is append-only by count, so it needs an in-place update path.
- **Fix Stop:** it sends `{type:"chat", text:"stop"}` today, which the bot treats as a new message (and, when idle, starts a paid turn whose message is "stop"). Send `{type:"stop"}`.
- Ignore background research `progress` while idle (today it flips the panel to "busy").

**In-app chat (`desktop/panel.html` Chats tab)**
- Same as the overlay: live line, toggle panel, typed answer, `Worked for…`, Stop keeps partial text. It already talks over an owner socket held by `desktop/main.js` that names its chat id and sends a real `stop`, so it gets owner notes and same-chat rejoin for free.

**Web widget (`src/widget/widget.ts`)**
- Live line + steps + typed answer in the agent bubble; no Thinking section (guest turns). The widget can't stop turns today; keep it that way unless trivial.

### 4.8 Kill switches and rollout

- `ATLAS_NO_STREAMING=true` (bot): never request streaming; surfaces get today's behaviour plus the improved live line/steps.
- A server-side switch in Convex env (e.g. `LLM_STREAMING_DISABLED=true`) answers stream requests with one encrypted `done` frame, so streaming can be turned off for everyone without a release.
- Server honours `stream` only when asked, so old bots are unaffected. A new bot talking to an old server gets today's single encrypted JSON body: when the response isn't framed but *is* a valid encrypted envelope, take today's path.
- Ship order: server streaming behind the flag → client transport → agent events + filter → overlay → side panel → widget. Each step leaves the product working.

## 5. How we'll know it worked

- Time to first answer word, measured from the model starting to write (target ≤ 1 s), and time to live line after send (≤ 300 ms), logged for owner turns.
- Filter property tests pass (4.5); a corpus test proves no tag/marker/secret leaks across thousands of random chunkings.
- Protocol tests: an old-protocol client (ignoring new types) still renders every turn from `response`; streamed text from a failed attempt, a refused server-side fallback, a narration-then-tools response, and a gate-rejected "done" never remains on screen.
- Stop ends a streaming turn within ~1 s on overlay and side panel.
- No change in credits per turn or LLM calls per turn on the harness benchmarks.
- Manual check on the real overlay, side panel and widget: live line, panel open/close, typed answer, mascot alive, Reduce Motion respected.

## 6. Checks to run first (on dev only)

The reviewers answered most of the original open questions from the Convex and Anthropic docs and the open-source Convex backend: HTTP actions stream `ReadableStream` bodies chunk by chunk (Convex 1.12+; the backend wires client disconnects into `request.signal`), the action limit is 30 minutes, readable thinking must be requested (`display`), and a refusal fallback can follow streamed tool calls (handled in 4.2). What's left:

1. `curl -N` a tiny streaming httpAction on the dev deployment and confirm frames arrive spread out over time (the hosted edge in front of convex.site is closed source). **If it buffers:** don't build a database fallback (it would store answers in plaintext on the server and need a new auth path). Ship everything else (live line, steps, Thinking from the agent's own events, mascot, Stop) and let the answer land whole until buffering is solved.
   **Result (2026-10-30):** passed on avid-finch-726. A test route writing a line every 500 ms arrived ~500 ms apart (about 150 ms behind the server's clock), not buffered; on a client disconnect Convex logged "Client disconnected" and the handler stopped. Route removed.
2. Two identical dev calls with the chosen `display` setting: confirm one cache miss, then `cache_read_input_tokens` hits.
   **Result (2026-10-30):** passed. After deploying `display: "updates"` at 09:02, live Sonnet turns still read 23-28K cached tokens on follow-up calls (09:07, 09:18), the same pattern as before the change.

## 7. Existing bugs this project fixes on the way (because streaming depends on them)

- Side panel Stop sends a chat message instead of a stop (and starts a paid "stop" turn when idle).
- The 3 s progress throttle drops the latest status instead of coalescing.
- `[THINKING]` reaches non-owner sockets; the file-drop path shows it as a progress line.
- Single-owner-socket fallback can route an overlay turn into the side panel.
- `toOpenAIResponse` turns every `tool_use` block into a tool call, so after a refusal-triggered fallback (or a refusal with a half-built tool call) the agent can run a tool from the declined attempt.
- The main per-iteration LLM call ignores the turn's abort signal.

## 8. What's left to the builder

Exact frame/field names, coalescing intervals, CSS and motion details within the mockups, how partial markdown is held, whether the verify-gate prediction is used, how the mascot reaches the side panel, test structure, and the order of commits within the ship order in 4.8.

## 9. The owner's call on Thinking

**The Thinking section shows short progress notes** (`display: "updates"`), chosen by the owner over summarized reasoning: one-line notes on what Bhai is doing and why ("Comparing the cheapest against arrival times before I answer"). Summarized reasoning was turned down because a summary can restate Bhai's private server instructions in its own words, and no filter can reliably catch a paraphrase.
- Opus and Sonnet get `display: "updates"` with the beta header `thinking-display-updates-2026-08-18`, set the same way on every main-loop call (4.2).
- Sonnet's `between_tools` lane already returns progress text and takes no `display`; Haiku has none. There, Thinking falls back to the agent's own step notes.
- The notes still go through the thought filter (4.5).
