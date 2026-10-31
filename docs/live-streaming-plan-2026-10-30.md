# Live Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While Bhai works, the overlay, the desktop app's in-app chat, the Chrome side panel and the web widget show a live status line, a tap-to-open panel of steps and short progress notes, an animated Bhai, and the answer typing itself in.

**Architecture:** The Convex LLM proxy forwards Claude's stream as padded, per-frame-encrypted NDJSON frames (opt-in per request); `llm.chat()` reads them, calls an `onDelta` callback, and still resolves the same `ChatCompletion` from the final `done` frame. `runAgent` turns deltas plus its own step progress into structured turn events, passed through a streaming safety filter, and `overlay-chat.ts` relays them per socket as new `turn_*` WS messages. The final `response` message is unchanged and authoritative, so old clients keep working.

**Tech Stack:** TypeScript (NodeNext ESM), Convex httpActions (Convex runtime, `@anthropic-ai/sdk` 0.133.0), Node `crypto` AES-256-GCM, `ws`, vanilla JS in `overlay.html` / Chrome extension / widget, Vitest.

**Spec:** `docs/live-streaming-design-2026-10-30.md` (approved 2026-10-30). Read it first; section numbers below (§) refer to it.

## Global Constraints

- Tests run under Node 20: `VT="PATH=/usr/local/bin:$PATH /usr/local/bin/node node_modules/vitest/vitest.mjs run"`; run `$VT <files>`. Typecheck: `npx tsc --noEmit -p .`. Lint: `./node_modules/.bin/biome check <files>` (no new diagnostics on touched lines).
- New `*.test.ts` files are gitignored: add `!<path>` under "# Session 2026-10-29" in `.gitignore` and `git add -f`.
- Commits as Bhavana Sanal (per-worktree git config), plain messages, **no** `Co-Authored-By: Claude` trailer, no mention of Claude/AI. Push only to remote `xagi` (XAGI-Lab/Bhai), never force.
- No prompt changes and no prompt reseed (§3 non-goals). No new npm dependencies.
- Every new source file starts with `// © 2024-2026 TRUSCOR Private Limited. All rights reserved.`
- Kill switches, exact names: bot `BHAI_NO_STREAMING=true`; Convex env `LLM_STREAMING_DISABLED=true` (§4.8).
- Thinking display: `display: "updates"` + beta `thinking-display-updates-2026-08-18` on Opus/Sonnet main-loop calls, the same whether or not the call streams; never on Sonnet `between_tools`, Haiku, or lean calls (§4.2, §9).
- Streamed text never reveals `[OTP_1]`-style handles; only the final `response` reveals (§4.5).
- Frame padding bucket: 256 bytes. Server frame coalescing: 60 ms. WS delta coalescing per socket: 40 ms.
- Stream timeouts: first frame within the existing per-effort attempt timeout (`attemptTimeoutMs`); gap between frames ≤ 30 000 ms.
- Copy (exact): stopped note `Stopped.`; finished summary `Worked for {N}s · {K} steps`; stream-cut note `Lost the connection mid-answer. Ask me again.`
- Respect Reduce Motion everywhere: no shimmer/bar/ripple animation, mascot pose swaps already skip.

## Review Focus

1. **Multi-byte text split across frames** (Hindi, Hinglish, emoji, ₹): must decode without mojibake. Test in Task 6.
2. **Overlay and side panel both open during a turn:** turn events reach only the originating socket; the side panel never shows an overlay turn. Test in Task 10.
3. **Overlay hidden/reopened, or reconnecting, mid-turn:** the rejoining socket gets a snapshot and continues; an old overlay page (no `turn_*` support) still renders from `response`. Test in Task 10.
4. **Long answer streaming past 25 s with a code fence:** not cut by a total deadline; an unclosed fence renders as a code block, not plain text that later flips. Tests in Tasks 6 and 11.
5. **Connection lost mid-answer** (Wi-Fi off, decrypt failure): partial answer is reset, the next model is tried; if all fail the surface shows the stream-cut note, never a silent half answer. Tests in Tasks 7 and 10.

---

### Task 0: Dev checks (spike, no product code)

**Files:** throwaway only (not committed): `convex/_spikeStream.ts` on the **dev** deployment.

- [ ] **Step 1:** Add a temporary httpAction `GET /api/_spike/stream` that returns `new Response(readable, {headers: {"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform"}})` and writes `tick N\n` every 500 ms for 5 s from a detached task. Deploy to dev only (`npx convex dev --once`). Ask the owner before deploying if they haven't approved dev deploys this session.
- [ ] **Step 2:** Run `curl -N https://avid-finch-726.convex.site/api/_spike/stream`. Expected: ticks arrive ~500 ms apart, not all at once at 5 s. Ctrl-C after 2 ticks and confirm in the Convex dev logs that the handler's `request.signal` fired.
- [ ] **Step 3:** If ticks arrive all at once (edge buffers), stop and tell the owner: per §6 the plan continues with Tasks 1–2 and 8–14 and the answer lands whole (Tasks 3–7 deferred). Otherwise continue.
- [ ] **Step 4:** Remove the spike route and redeploy dev. Record the result (one line) in §6 of the spec and commit the spec.

The cache check (§6 item 2) runs at the end of Task 2.

### Task 1: Stop running tool calls from a declined attempt

**Files:**
- Modify: `convex/claude.ts` (`toOpenAIResponse`, ~221-259)
- Test: `convex/claude.test.ts`

**Interfaces:**
- Produces: `toOpenAIResponse(msg: Beta.BetaMessage)` unchanged signature; drops `tool_use` blocks before the last `fallback` block, and all tool calls when `msg.stop_reason === "refusal"`. Text stays joined.

- [ ] **Step 1: Write the failing tests** in `convex/claude.test.ts`:
  - `"drops tool calls made before a server-side fallback"`: content `[text "Let me ", tool_use{id:"t1",name:"shell_exec"}, {type:"fallback"}, text "check that.", tool_use{id:"t2",name:"read_file"}]`, stop_reason `tool_use` → `choices[0].message.tool_calls.map(c=>c.id)` equals `["t2"]`, `content` equals `"Let me check that."`.
  - `"returns no tool calls on a refusal"`: content `[text "I can't", tool_use{id:"t1"}]`, stop_reason `refusal` → `tool_calls` undefined or `[]`, `finish_reason` `"content_filter"`.
- [ ] **Step 2:** `$VT convex/claude.test.ts` → both FAIL.
- [ ] **Step 3:** Implement in `toOpenAIResponse`: find the index of the last block with `type === "fallback"`; keep `tool_use` blocks only after it; none if refusal.
- [ ] **Step 4:** `$VT convex/claude.test.ts` → PASS.
- [ ] **Step 5:** Commit: `Proxy: never run a tool call from a declined attempt`.

### Task 2: Ask for progress notes on every main-loop call

**Files:**
- Modify: `convex/claude.ts` (`toClaudeRequest`, ~173-208)
- Test: `convex/claude.test.ts`

**Interfaces:**
- Produces: `toClaudeRequest(body, chat)` adds `display: "updates"` to the `thinking` param (when today's code leaves `thinking` unset, set it to the model's default thinking type as documented for Opus/Sonnet 5.5, plus `display`) and appends `"thinking-display-updates-2026-08-18"` to `params.betas` when **all** hold: model is Opus or Sonnet, `body.lean !== true`, thinking is not off (`reasoning.effort` not `none`/`minimal`). Unchanged otherwise. Not dependent on `body.stream`.

- [ ] **Step 1: Write the failing tests:** `"requests progress-note display for Opus/Sonnet main calls"` (Sonnet, effort `low`, tools present → `params.thinking.display === "updates"` and betas include the header); `"leaves lean, Haiku and thinking-off calls alone"` (three cases → no `display`, no header); `"same thinking config whether or not stream is set"` (`toClaudeRequest({...b, stream:true})` deep-equals `toClaudeRequest(b)` apart from no stream field).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Check the SDK type for the exact `thinking` shape in `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` (`display` option) and use the type that accepts `display`.
- [ ] **Step 4:** Run → PASS. `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** Deploy to dev and run the cache check (§6 item 2): two identical non-lean Sonnet calls through `/api/llm/chat`; expected the second response's `usage.prompt_tokens_details.cached_tokens` > 0. Record the result in §6.
- [ ] **Step 6:** Commit: `Proxy: ask Opus and Sonnet for short progress notes`.

### Task 3: Frame codec (server encode, client decode)

**Files:**
- Create: `convex/streamFrames.ts`
- Modify: `src/crypto-transport.ts` (export a frame decrypt helper)
- Test: `src/llm-stream-frames.test.ts` (imports both sides)

**Interfaces:**
- Produces (server, `convex/streamFrames.ts`):
  - `type FrameKind = "text" | "note" | "tool" | "void_tools" | "reset" | "error" | "done"`
  - `type Frame = { kind: FrameKind; text?: string; name?: string; error?: string; status?: number; completion?: unknown }`
  - `async function encodeFrame(frame: Frame, seq: number, final: boolean, reqRid: string, sharedKeyBase64: string): Promise<string>` → one NDJSON line (ends with `\n`): an `EncryptedEnvelope` JSON whose plaintext is `JSON.stringify({...frame, pad})`, `pad` filling to the next multiple of 256 bytes. AAD = `POST|/api/llm/chat|${ts}|${rid}|${reqRid}|${seq}|${final ? 1 : 0}` (use `encryptResponse`'s `additionalData` callback).
- Produces (client, `src/crypto-transport.ts`):
  - `export function decryptFrame(line: string, reqRid: string, expectSeq: number): { frame: Frame; final: boolean }`: tries AAD with `final=0`, then `final=1`; throws on a bad tag, on `seq !== expectSeq`.
  - `Frame`/`FrameKind` types re-declared in `src/llm-stream.ts` (Task 6) with the same shape.

- [ ] **Step 1: Write the failing tests:** round-trip each kind; `"rejects a reordered frame"` (decrypt seq 1 with `expectSeq` 0 → throws); `"rejects a frame from another request"` (different `reqRid` → throws); `"marks the final frame"`; `"pads to 256-byte buckets"` (ciphertexts of `text:"a"` and `text:"ab"` have equal length).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement both sides.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `Streaming frames: per-frame encryption bound to request, order and end`.

### Task 4: Map Claude's stream to frames

**Files:**
- Create: `convex/llmStream.ts`
- Test: `convex/llmStream.test.ts`

**Interfaces:**
- Consumes: `Frame` (Task 3), `toOpenAIResponse` (Task 1).
- Produces: `async function pipeClaudeStream(events: AsyncIterable<Beta.BetaRawMessageStreamEvent>, emit: (f: Frame) => void, opts: { coalesceMs: number }): Promise<Beta.BetaMessage>`. Rules: `text_delta` → coalesced `text`; `thinking_delta` with non-empty text → coalesced `note`; `content_block_start` of `tool_use` → `tool {name}`; `content_block_start` of `fallback` → flush, then `void_tools`; final `stop_reason === "refusal"` → `reset`. Returns the accumulated message (use the SDK's `BetaMessageStream` accumulation if handed the stream object; for tests accept a plain async iterable and accumulate).

- [ ] **Step 1: Write the failing tests** with synthetic event arrays: plain answer → `text` frames joining to the full text; `"notes come from thinking deltas, empty ones are skipped"`; `"tool start emits a tool frame"`; `"fallback keeps text and voids tools"` (expect frame kinds in order `text, tool, void_tools, text`); `"refusal ends in reset"`; `"coalesces deltas within the window"` (fake timers, 5 deltas in 10 ms → 1 frame).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `Proxy: turn Claude's stream into frames`.

### Task 5: Streaming branch in `/api/llm/chat`

**Files:**
- Modify: `convex/http.ts` (route at ~388-755; provider call ~681-706)
- Test: `convex/llmStream.test.ts` (route helper), manual dev check

**Interfaces:**
- Consumes: `encodeFrame` (Task 3), `pipeClaudeStream` (Task 4).
- Produces: when `body.stream === true`, the request was encrypted, the model isn't Azure, and `process.env.LLM_STREAMING_DISABLED !== "true"`: respond `200` with headers `X-Encryption: ecdh-aes-256-gcm`, `X-Stream: frames`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, body = NDJSON frames ending in a final `done {completion}` (the same object today's body holds). Azure models or the kill switch: a single final `done` frame. Extract the frame-writing loop as `export async function streamCompletion(write: (line: string) => Promise<void>, run: (emit) => Promise<Beta.BetaMessage>, encode: (f, final) => Promise<string>): Promise<{ ok: boolean; message?: Beta.BetaMessage }>` so it can be unit-tested.
- Billing/logging: pre-deduction unchanged. Provider error before `done` → `refundIfDeducted`, then an `error {status, error}` frame marked final. `logCall` / `incrementModelUsage` run after `done` is written. `anthropic.beta.messages.stream(params, { signal: request.signal })`; writer closed in `finally`.

- [ ] **Step 1: Write the failing tests** for `streamCompletion`: success writes N frames + a final `done`; a `run` that throws after 2 deltas writes those frames, then a final `error` frame, and returns `ok:false`; `"done carries the same completion as the non-streaming path"` (compare with `toOpenAIResponse(message)`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement helper and wire the route (return the `Response` immediately, write from a detached `void (async () => {...})()`, catch everything into an `error` frame).
- [ ] **Step 4:** Run → PASS; `npx tsc --noEmit -p .` clean (the Convex folder is in the TS project; also run `npx convex typecheck` if available).
- [ ] **Step 5:** Deploy to dev; `curl` a streamed request is not practical (encrypted) — verify end to end after Task 7 instead. Commit: `Proxy: stream frames when the client asks`.

### Task 6: Client frame reader

**Files:**
- Create: `src/llm-stream.ts`
- Modify: `src/crypto-transport.ts` (add `encryptedFetchStream`)
- Test: `src/llm-stream.test.ts`

**Interfaces:**
- Produces:
  - `export async function encryptedFetchStream(url: string, options: RequestInit): Promise<{ response: Response; rid: string }>`: same encryption and auth as `encryptedFetch`, adds `stream: true` to the body, does **not** read the body.
  - `export type LLMDelta = { kind: "text"; text: string } | { kind: "note"; text: string } | { kind: "tool"; name: string } | { kind: "void_tools" } | { kind: "reset" }`
  - `export async function readFrames(response: Response, reqRid: string, opts: { firstFrameMs: number; gapMs: number; signal?: AbortSignal; onDelta: (d: LLMDelta) => void }): Promise<ChatCompletion>`: reads `response.body` line by line with `TextDecoder("utf-8", { stream: true })`, decrypts with `decryptFrame`, forwards non-final frames to `onDelta`, returns `done.completion`; throws `{status, message}` on an `error` frame, a missing `done`, a decrypt/order failure, or a timeout.
  - Strictness: if the request was a stream and the response is 2xx without `X-Stream: frames`, accept only a valid encrypted single envelope (old server) and return it via today's decrypt; a 2xx plaintext body throws.

- [ ] **Step 1: Write the failing tests** (build bodies with `encodeFrame` from Task 3 into a `ReadableStream`):
  - `"delivers deltas in order and returns the done completion"`.
  - Review Focus 1: `"decodes multi-byte text split across chunks"`: frame text `"हाँ भाई ₹3,240 👍"`, the NDJSON bytes split at every byte offset → identical deltas.
  - Review Focus 4: `"no total deadline: a 40 s stream with 1 s gaps completes"` (fake timers, `firstFrameMs: 25000`, `gapMs: 30000`).
  - `"times out on a 31 s gap"`; `"throws on a missing done"`; `"throws on an error frame with its status"`; `"rejects a 2xx plaintext body"`; `"accepts an old server's single encrypted envelope"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `Client: read encrypted stream frames`.

### Task 7: `llm.chat()` streams through `onDelta`

**Files:**
- Modify: `src/llm.ts` (`LLMClient` interface ~34-70; attempt loop ~343-574)
- Test: `src/llm-stream-client.test.ts`

**Interfaces:**
- Consumes: `encryptedFetchStream`, `readFrames`, `LLMDelta` (Task 6).
- Produces: `LLMClient.chat(params & { onDelta?: (d: LLMDelta) => void })`. When `onDelta` is set and `process.env.BHAI_NO_STREAMING !== "true"`: each attempt (incl. fallback models, the 401 retry and the last-resort retry) first calls `onDelta({kind:"reset"})` if any delta was sent earlier in this `chat()` call, then streams. The resolved `ChatCompletion` goes through the same post-processing as today (`tryParseOssToolCalls`, `sanitizeContextEchoes`, `updateModelStats` with latency to `done`). The caller's `signal` aborts the stream and tries no other model (as today). Without `onDelta`: byte-for-byte today's path.

- [ ] **Step 1: Write the failing tests** (mock `encryptedFetchStream`/`readFrames`, follow `src/llm-timeout.test.ts` style):
  - `"forwards deltas and resolves the same completion shape"`.
  - Review Focus 5: `"a mid-stream failure resets, then streams the fallback model"` (first attempt emits 2 text deltas then throws a network error → observed deltas: `text, text, reset, text…`, result from model 2).
  - `"no onDelta means no stream flag"`; `"BHAI_NO_STREAMING=true disables streaming"`; `"abort mid-stream tries no other model"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, plus `$VT src/llm-timeout.test.ts src/llm-guest.test.ts src/llm-cache.toolsig.test.ts`.
- [ ] **Step 5:** Commit: `LLM client: stream deltas to the caller, same final answer`.

### Task 8: Streaming safety filters

**Files:**
- Create: `src/stream-filter.ts`
- Modify: `src/context-scrubber.ts` only if `StreamingContextScrubber` needs an export tweak
- Test: `src/stream-filter.test.ts`

**Interfaces:**
- Produces:
  - `export class AnswerStreamFilter { constructor(opts: { channel: string }); push(delta: string): string; flush(): string }`: composes `StreamingContextScrubber`; holds back from `<`, `<!--`, `[`, `*`/`_`/backtick-wrapped `[[` until decidable; swallows `<system_log>…</system_log>`, `<tool_log…</tool_log>`, `<memory-context>…`, `[Tool Result …]` (to `\n\n`, `\n[A-Z]` or end), `[SOURCE:…]`, `<!--WIDGET:…-->`, `<!--QUICK_ACTIONS:…-->`; drops `[[STUCK]]` (any wrap, any case) and `[NO_REPLY]`; **never** reveals handles; mirrors `sanitizeAgentResponse` + `takeStuckMarker` + overlay `parseInteractiveElements` stripping.
  - `export class NoteStreamFilter { push(delta: string): string; flush(): string }`: line-buffered; each completed line goes through `AnswerStreamFilter` rules, then `protect(line, { credentials: true })` and `sanitizeSecrets`.
  - Hold-back is bounded for markers (≤ 32 chars) and unbounded only inside a recognised block.

- [ ] **Step 1: Write the failing tests:**
  - Property test `"no chunking leaks hidden content"`: a corpus of ≥ 12 real-shaped replies covering every tag, marker, handle (`[OTP_1]`, `[CARD_2]`), an unterminated `<memory-context>`, a `[[ stuck ]]` in backticks, a `<!--QUICK_ACTIONS:[…]-->` at the end; for each, 200 random chunkings → concatenated output contains none of the hidden substrings, and for replies that are final answers equals `finalReplyText(reply)` (from `src/agent.ts`, export it if needed) with stuck line/quick actions removed and handles unrevealed.
  - `"plain text streams with no added delay"`: `push("Hello there")` returns `"Hello there"` immediately.
  - `"a lone [ in prose is released once it can't be a marker"`: `push("see [")` → `"see "`, `push("1] ok")` → `"[1] ok"`.
  - `"notes mask credentials"`: `push("token sk-ant-abc123…\n")` → no `sk-ant-` in output.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `Streaming filters: nothing the final reply hides ever streams`.

### Task 9: Turn events from the agent

**Files:**
- Create: `src/turn-events.ts`
- Modify: `src/agent.ts` (`ChannelContext` ~734, `AgentResponse` ~723, main `llm.chat` ~3429, gates ~3754-4047, `sendProgress` ~1909-1929, tool-call branch ~4090, cancel ~2181-2188)
- Test: `src/turn-events.test.ts`, `src/agent-turn-events.test.ts`

**Interfaces:**
- Produces (`src/turn-events.ts`):
  - `export type TurnEvent = { type: "status"; text: string; step: number; elapsedSec: number } | { type: "step"; id: number; text: string; state: "running" | "done" | "failed" } | { type: "note"; text: string } | { type: "answer"; attempt: number; text: string } | { type: "answer_reset"; attempt: number } | { type: "end" }`
  - `export type TurnEventSink = (e: TurnEvent) => void`
  - `export function createStatusCoalescer(sink: TurnEventSink, minGapMs = 3000): { push(e: Extract<TurnEvent, {type:"status"}>): void; flush(): void; stop(): void }`: never drops the latest status; emits it at most every `minGapMs` and on `flush`.
- Produces (`src/agent.ts`):
  - `ChannelContext.onTurnEvent?: TurnEventSink`.
  - `AgentResponse.partialText?: string` (the filtered answer streamed so far, set when the turn was stopped).
  - Behaviour (§4.4): main-loop `llm.chat` calls (iteration call, final-answer re-call, cascade re-call) pass `onDelta` only when `onTurnEvent` is set, and pass the turn `signal`. Deltas: `text` → `AnswerStreamFilter` → `answer`; `note` → `NoteStreamFilter` → `note` (only if `channelContext.isOwner && !autonomous`); `tool` → `answer_reset` and the streamed text so far moves to a `note` (owner only); `void_tools`/`reset` → `answer_reset`. Any gate that sends a candidate reply back (anti-giving-up, leave-to-look, ack-without-action, verify-before-done, persistence nudge, final-answer switch, empty retry, cascade) emits `answer_reset` and a `step` "Checking it actually worked" (verify gate) or "Taking another pass" (others). Milestones → `step` + `status` via the coalescer. `[THINKING]` progress is emitted only for owner, non-autonomous turns (fix §7). On cancel: `partialText` = filter output so far; the stopped history entry gets that text as an assistant message ending in ` [stopped]`.
  - The 13 other `runAgent` callers are untouched (no `onTurnEvent`).

- [ ] **Step 1: Write the failing tests:**
  - `turn-events.test.ts`: `"coalescer keeps the latest status"` (3 statuses within 1 s → after `flush`, the last one was emitted; none lost at the end).
  - `agent-turn-events.test.ts` with a fake `LLMClient` that calls `onDelta` then resolves: `"a plain answer streams as answer events"`; `"narration before a tool call resets and becomes a note"`; `"a reply sent back by the verify gate is reset"`; `"guests get no notes"` (`isOwner:false` → no `note` events); `"stop keeps the partial answer"` (abort after 2 deltas → `partialText` equals their filtered text); `"no onTurnEvent means no onDelta passed"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, then the agent's existing tests: `$VT src/agent*.test.ts src/agents src/overlay/contract-line.test.ts`.
- [ ] **Step 5:** Commit: `Agent: structured turn events with streamed answer, steps and notes`.

### Task 10: Turn relay and protocol in `overlay-chat.ts`

**Files:**
- Create: `src/overlay/turn-relay.ts`
- Modify: `src/overlay/overlay-chat.ts` (turn start ~956-1165, file path ~1194-1280, `sendToClient` ~1393-1422, stop ~649-665, research broadcast ~791-802, `hello` handling ~637)
- Test: `src/overlay/turn-relay.test.ts`

**Interfaces:**
- Consumes: `TurnEvent`, `TurnEventSink` (Task 9), `AgentResponse.partialText`.
- Produces (`turn-relay.ts`):
  - `export function createTurnRelay(opts: { turn: string; send: (msg: object) => void; owner: boolean; coalesceMs?: number }): { sink: TurnEventSink; snapshot(): TurnSnapshot; finish(): void }`
  - WS messages (all with `turn`, `seq`): `turn_status {text, step, elapsed}`, `turn_step {id, text, state}`, `turn_note {text}` (owner sockets only), `turn_answer {attempt, text}` (append), `turn_answer_reset {attempt}`, `turn_snapshot {status, steps, notes, answer}`. Answer/note deltas coalesced at 40 ms.
  - `type TurnSnapshot = { status?: {text: string; step: number; elapsed: number}; steps: {id: number; text: string; state: string}[]; notes: string[]; answer: string }`
- `overlay-chat.ts` changes: pass `onTurnEvent: relay.sink` in both overlay `runAgent` calls (chat ~1100 and file drop ~1243; the file-drop path then stops showing reasoning as a progress line); the existing `thinking` start message gains `turn`; the final `response` gains `turn` and `worked: { secs, steps }`; a stopped turn sends `response {text: partialText ? partialText + "\n\nStopped." : "Stopped.", stopped: true}`. Turn messages are sent only to the turn's socket, or to an open owner socket with the same chat id after a reconnect; **never** via the "only owner socket" fallback (fix §7). On `hello {chat}` while that chat's turn runs, send `turn_snapshot`. Research broadcast `progress` gains `background: true`. `COMPANION_TYPES` unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `turn-relay.test.ts`: `"coalesces answer deltas"`; `"notes never go to a guest relay"`; `"snapshot reflects state after a reset"`.
  - In `src/overlay/turn-relay.test.ts` (or a new `overlay-chat-turns.test.ts`, following `overlay-turns.test.ts`), Review Focus 2: `"an overlay turn's events never reach the extension socket"` (two owner sockets, different chat ids, overlay socket closes mid-turn → extension socket receives no `turn_*`).
  - Review Focus 3: `"a rejoining socket gets a snapshot"`; `"an old client that ignores turn_* still gets the full response"`.
  - Review Focus 5: `"all attempts failing ends with the stream-cut note"` (agent throws after answer deltas → `error {text: "Lost the connection mid-answer. Ask me again."}`).
  - `"stop sends the partial answer plus Stopped."`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, plus `$VT src/overlay`.
- [ ] **Step 5:** Commit: `Overlay chat: relay turn events per socket, snapshots, partial on stop`.

### Task 11: Overlay UI

**Files:**
- Modify: `src/overlay/overlay.html` (CSS ~275-470, 945-999; handler `handle()` ~3106-3392; `renderMd` ~3524; `replyArriving`/`keepTurn` ~4232-4251; mascot wrapper `setMood` ~2859)
- Test: `src/overlay/inline-scripts.test.ts` (existing, must pass), new `src/overlay/turn-view.test.ts`

**Interfaces:**
- Consumes: the Task 10 messages.
- Produces: an inline pure function `turnView(state, msg) → state` near the top of the overlay script (state = `{turn, status, steps, notes, answer, open}`), so it can be extracted by the test with the same regex/vm approach as `inline-scripts.test.ts` and unit-tested; and `renderStreamingMd(text)` = `renderMd` that renders an unclosed trailing ``` fence as an open code block.
- UI per §2/§4.7 and the approved mockup `.superpowers/brainstorm/*/content/working-view-v2.html`: reply box visible from turn start with the live line (pulsing dot, shimmering text, `step N · Ns`, chevron) and thin moving bar; clicking toggles the panel (Notes + Steps); open state in `localStorage` key `bhai.turnPanelOpen` (try/catch). Answer re-rendered at most once per `requestAnimationFrame`. `replyArriving()` called once per turn. `aria-busy="true"` on `#reply-text` while streaming. After `response`: the live line becomes `Worked for {N}s · {K} steps ▾` above the answer, still opening the panel; kept with the turn in `#reply-history`. Mascot: `thinking` on `turn_note`, `looking` on browse/read steps (reuse `moodFromProgress`), `working` on other steps, `typing` while `turn_answer` arrives, `BhaiMascot.react(icon, "nod")` on a step reaching `done`, then today's `happy`/`oops`. Reduce Motion (`matchMedia('(prefers-reduced-motion: reduce)')`): no shimmer, static bar, no ripple.

- [ ] **Step 1: Write the failing tests** in `turn-view.test.ts`: `"answer deltas append, reset clears"`; `"snapshot replaces state"`; `"a step done after running keeps its order"`; Review Focus 4: `"an unclosed fence renders as a code block"` (`renderStreamingMd("x\n\`\`\`js\nconst a")` contains `<pre`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, plus `$VT src/overlay/inline-scripts.test.ts`.
- [ ] **Step 5:** Manual: `npm run dev`, open the overlay, ask "find me a cheap flight to Goa next Friday": live line within ~300 ms, panel opens/closes and is remembered, answer types in, Bhai animates, Stop keeps partial text + `Stopped.`, `Worked for` line after; repeat with macOS Reduce Motion on.
- [ ] **Step 6:** Commit: `Overlay: live line, steps and notes panel, typed answer, Bhai at work`.

### Task 12: Chrome side panel

**Files:**
- Modify: `chrome-extension/background.js` (`handleOverlayMessage` ~498-541, `addChat` ~37-44, stop ~2307-2309, `sendToBhai` ~330-347), `chrome-extension/sidepanel.js` (`setBusy` ~343-361, `renderChat` ~308-335, listener ~808-822), `chrome-extension/sidepanel.html` (styles), `chrome-extension/manifest.json` (version bump to 2.2.0)
- Create: `chrome-extension/turn-view.js` (pure, shared shape with Task 11's `turnView`)
- Test: `src/chrome-extension-turn-view.test.ts` (imports `chrome-extension/turn-view.js`)

**Interfaces:**
- Produces: `turnView(state, msg)` (same contract as Task 11); background keeps one in-memory draft per running turn and broadcasts `turn_update {state}` to the panel; `addChat` (and its `chrome.storage.local` write) runs once, on `response`, with the final text. Stop sends `{type: "stop"}` (fix §7). Background `progress` with `background: true` is ignored while no turn runs. Panel: live line + toggle panel (state in `chrome.storage.local` key `bhai.turnPanelOpen`) + typed answer in a draft bubble updated in place; `Worked for…` after. Mascot: port the generated mascot block if it runs standalone (same `BhaiMascot.mount/react` API); otherwise a 22 px CSS face with blink/bob/ripple as in the approved `working-motion.html` option C.

- [ ] **Step 1: Write the failing tests:** same four `turnView` cases as Task 11 against `chrome-extension/turn-view.js`, plus `"a background progress message doesn't start a turn"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `node --check chrome-extension/background.js chrome-extension/sidepanel.js`.
- [ ] **Step 5:** Manual: load the unpacked extension, ask from the side panel: live line, panel, typed answer, Stop actually stops (no BUSY error), an idle Stop click doesn't start a turn, research running in the background doesn't flip the panel to busy.
- [ ] **Step 6:** Commit: `Side panel: live turns, typed answers, a Stop that stops`.

### Task 13: Web widget

**Files:**
- Modify: `src/widget/widget.ts` (handlers ~305-338, bubble ~251-265)
- Test: `src/widget/widget-turns.test.ts`

**Interfaces:**
- Consumes: Task 10 messages (the widget is a guest: it never receives `turn_note`).
- Produces: live line in the status area, steps under a toggle, `turn_answer` appended into the current agent bubble (re-rendered with the widget's `renderMarkdown`), reset clears the bubble, final `response` replaces it. `thinking_content` is no longer rendered into the bubble.

- [ ] **Step 1: Write the failing tests** (evaluate the built widget script against a minimal DOM stub, or export the message handler for test): `"answer deltas fill the agent bubble"`; `"reset clears it"`; `"response replaces streamed text"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `Widget: live status and typed answers`.

### Task 13b: In-app chat (desktop app's Chats tab)

Added 2026-10-30 at the owner's request ("there is also a chat option inside the app also now so apply the things to that also").

**Files:**
- Modify: `desktop/panel.html` (`sendChat` / `finishLiveChat` / `bhai.onChatEvent` ~1660-1712; Chats styles), `desktop/main.js` only if the relay (~2476-2509) needs a change (it already forwards every socket message with the chat id and sends `{type:"stop"}`)
- Test: `desktop/tests/chat-turn-view.test.js` (desktop vitest, runs on the default Node, not Node 20)

**Interfaces:**
- Consumes: Task 10 messages via the existing `chat:event` IPC (`{ chat, msg }`), the same `turnView(state, msg)` contract as Tasks 11-12 (a third small copy inside panel.html; same accepted duplication as the side panel, see ledger ruling).
- Produces: in the open thread, the `.chats-working` row becomes the live line (dot, text, `step N · Ns`, chevron) with the toggle panel (Notes + Steps; open state in `localStorage` key `bhai.turnPanelOpen`), and the assistant bubble streams the answer (re-rendered with the Chats renderer at most once per frame), reset clears it, the final `response` replaces it, then `Worked for {N}s · {K} steps ▾` above the answer. Stop keeps partial text + `Stopped.`. Bhai alive: the panel's mascot if Chats has one, otherwise the same small CSS face as the side panel. Reduce Motion respected.

- [ ] **Step 1: Write the failing tests** for the panel's `turnView` (extract it like Task 11, or export it for the desktop tests): the four Task 11 cases.
- [ ] **Step 2:** `cd desktop && npx vitest run tests/chat-turn-view.test.js` → FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `$VT src/overlay/inline-scripts.test.ts` (it parses `desktop/*.html` scripts).
- [ ] **Step 5:** Manual: open the app → Chats, ask the Goa question: live line, panel, typed answer, Stop, `Worked for` line; switch to another chat mid-turn and back.
- [ ] **Step 6:** Commit: `In-app chat: live turns and typed answers`.

### Task 14: Measure, document, gate

**Files:**
- Modify: `src/overlay/overlay-chat.ts` (timing log), `CLAUDE.md` (Overlay, Env Kill-Switches, LLM Client sections), `docs/live-streaming-design-2026-10-30.md` (status line)
- Test: `src/overlay/turn-relay.test.ts`

**Interfaces:**
- Produces: one log line per owner turn: `⏱️ [overlay] turn <id> live=<ms> firstWord=<ms> total=<ms>` (live = send → first `turn_status`; firstWord = first `turn_answer`).

- [ ] **Step 1: Write the failing test:** `"logs live and first-word timings"` (spy on `console.log`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Document in `CLAUDE.md`: the streaming path (one paragraph under LLM Client), the `turn_*` protocol (Overlay), `BHAI_NO_STREAMING` and `LLM_STREAMING_DISABLED` (kill switches).
- [ ] **Step 6:** Gate: `npx tsc --noEmit -p .`; full suite `$VT`; Biome on changed files (no new diagnostics); `cd native && cargo fmt --check` untouched; `git log --format='%an %ce%n%B' xagi/main..HEAD` shows only Bhavana and no Claude trailer.
- [ ] **Step 7:** Manual pass on all four surfaces (Task 11/12/13/13b manual steps) with timings ≤ 300 ms live line and ≤ 1 s first word after the model starts writing; credits per turn unchanged on a harness benchmark run.
- [ ] **Step 8:** Commit: `Streaming: timings, docs`. Merge `xagi/main`, rerun the gate, push as Bhavana, deploy Convex to prod only with the owner's go-ahead.
