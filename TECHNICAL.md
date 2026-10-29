# Technical Overview — Bhai v0.2.1

> **Bhai** (Advanced Technology for Logical Autonomous Systems) is a continuously running personal AI agent built by [XAGI Labs](https://xagilab.com). This document covers how it is built — its architecture, tech stack, key components, and deployment.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tech Stack](#2-tech-stack)
3. [Key Components & Services](#3-key-components--services)
   - 3.1 LLM Client & Encrypted Transport
   - 3.2 Model Router
   - 3.3 Tool Router
   - 3.4 Agent Loop
   - 3.5 Four-Tier Orchestration
   - 3.6 Memory System
   - 3.7 Native Rust Layer
   - 3.8 Convex Backend
   - 3.9 Browser Automation
   - 3.10 Vision Navigation
   - 3.11 Coding Pipeline
   - 3.12 Deep Research Engine
   - 3.13 Proactive Engine
   - 3.14 Video Studio
   - 3.15 Meta-Harness Optimizer
   - 3.16 Voice Subsystem
   - 3.17 A2A Protocol
   - 3.18 Communication Channels
   - 3.19 Desktop App
   - 3.20 Marketing Brain
4. [Data Flow](#4-data-flow)
5. [Security Architecture](#5-security-architecture)
6. [Deployment](#6-deployment)
7. [Configuration Reference](#7-configuration-reference)

---

## 1. Architecture Overview

Bhai is a **local-first** autonomous agent. The Node.js process runs on the user's machine, all memory stays on-device in SQLite, and the only outbound traffic is to a Convex backend that acts as an encrypted API-key proxy for LLM calls.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Channels                                     │
│  Telegram · Discord · Slack · Matrix · WhatsApp · Email                 │
│  Desktop Overlay (Electron) · Canvas (WebSocket) · Web Widget           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│                       Agent Loop  (src/agent.ts)                        │
│  12 parallel memory retrievals → model routing → semantic tool select   │
│  → LLM call (encrypted) → tool execution → completion check             │
│  Max 200 iterations · Cascade escalation · Mid-session credit gate      │
└─┬──────────┬──────────┬──────────┬──────────┬──────────┬────────────────┘
  │          │          │          │          │          │
┌─▼────┐ ┌───▼───┐ ┌────▼────┐ ┌───▼────┐ ┌───▼─────┐ ┌──▼──────┐
│Memory│ │Agents │ │  Tools  │ │Research│ │Proactive│ │ Screen  │
│59 mod│ │36 mod │ │ 140 mod │ │ 11 mod │ │ 60 mod  │ │ 16 mod  │
└──────┘ └───────┘ └─────────┘ └────────┘ └─────────┘ └─────────┘
   │         │          │          │          │           │
┌──▼─────────▼──────────▼──────────▼──────────▼───────────▼──────────────┐
│                    Native Rust Layer  (native/src/, 80 modules)          │
│  SIMD vectors · model router · HNSW search · swarm/mesh · harness       │
│  browser guard · proactive scheduler · metacognition · MCTS             │
│  AX walker · secrets sanitizer · pcm-VAD · spreading · query classifier │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────┐
│                     Convex Backend  (convex/)                            │
│  Claude proxy (E2E encrypted) · Sessions · Credits · Store · Prompts    │
│  Dev: avid-finch-726.convex.cloud · Prod: avid-finch-726.convex.cloud   │
└─────────────────────────────────────────────────────────────────────────┘
```

### How it all connects

1. **Ingress** — A message arrives on any channel (Telegram, WhatsApp, Discord, Slack, Matrix, Email, Canvas, Overlay, Web Widget). The channel adapter extracts media (voice/image/video), runs sender authentication (owner ID allowlist, or contact/guest handling with a restricted tool set), and converts the inbound payload into a standardized `UserMessage` shape.
2. **Agent entrypoint** — The channel handler calls `runAgent(llm, message, onProgress, media)` in `src/agent.ts`. This function owns the entire conversation lifecycle; it is re-entrant (multiple channels may call it concurrently), but each invocation gets its own iteration counter and memory context.
3. **Memory fan-out (first iteration only)** — 12 memory retrieval systems fire in parallel via `Promise.all()`. Results are composed into an injection block under a ~2–3 K token budget and prepended to the system prompt. Each retrieval has a hard token ceiling so a single noisy source cannot starve the others.
4. **Model routing** — `chooseModel()` calls into native Rust (`native/src/model_router.rs`) with the current message, iteration count, error count, tool-call history, and media flags. The router returns a model id (always one of Haiku / Sonnet / Opus once it reaches Convex) and a `thinkingLevel` ("off" / "low" / "medium" / "high" / "max").
5. **Tool routing** — The query is embedded into a 384-dim MiniLM vector. Cosine similarity against the cached category embeddings selects the top-K tool categories. Only those tool schemas are loaded into the LLM context (typical: 15–36 tools out of 100+ available).
6. **LLM call** — The request is encrypted end-to-end with a per-session AES-256-GCM key derived via ECDH, posted to Convex, translated to a Claude Messages API call (`convex/claude.ts`), and the response is decrypted client-side. API keys never appear on the client.
7. **Tool execution** — The agent parses `tool_calls` from the LLM response. Non-browser tools execute in parallel (`Promise.all`); browser tools (shared page state) and screen-driving tools (`os_*`, `app_manager`, `apple_script`, `window_manage`, `run_shortcut`) execute sequentially, in call order.
8. **Loop termination** — The loop continues until `finish_reason === "stop"`, the agent emits `TASK_COMPLETE`, the iteration cap (200) is hit, or the circuit breaker trips.
9. **Egress** — The final assistant message is streamed back to the originating channel using its own formatting adapter (Markdown → HTML for Telegram, blocks for Slack, embeds for Discord, plain for SMS-style channels).
10. **Post-session** — After the conversation settles (no follow-up within a threshold), `runReflection()` runs: extract coding strategies, detect goals, record outcomes into the self-model, and embed the turn into episodic memory.

### Why local-first

Bhai runs as a single long-lived Node.js process on the user's own machine. This choice is deliberate:

- **Privacy:** memory, embeddings, browser profile, and research artifacts never leave the device
- **Latency:** tool calls (shell, browser, file edits) run against local resources with zero network hop
- **Resilience:** Bhai continues to function for memory recall, file edits, and local tools even when offline — only LLM calls require the Convex proxy
- **Cost:** expensive operations (vector search, reranking, tree-sitter parsing) run on local hardware instead of burning cloud compute

---

## 2. Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Runtime | Node.js | >= 20.19 / >= 22.12 | ES Modules throughout (`"type":"module"`) |
| Language | TypeScript | ^5.7 | Strict mode, ES2022, NodeNext resolution |
| Native acceleration | Rust + napi-rs | edition 2021 | Compiled to `.node` binary per platform |
| SIMD math | `wide` + `simsimd` | 0.7 / 6.5 | ~15-20x speedup vs pure JS |
| Parallelism | `rayon` | 1.10 | CPU-parallel batch ops in Rust |
| Encryption (native) | `aes-gcm` + `scrypt` | 0.10 / 0.11 | AES-256-GCM + Argon2-class KDF |
| Local database | SQLite (better-sqlite3) | ^12.11 | WAL mode, 64 MB cache, 256 MB mmap |
| Serverless backend | Convex | ^1.34 | Auth, LLM proxy, credits, store |
| LLM backend | Claude API via Convex (`convex/claude.ts`) | — | Haiku / Sonnet / Opus; keys only in Convex env |
| Embeddings | `@xenova/transformers` | ^2.17 | MiniLM L6 v2 (384-dim), Nomic optional |
| Browser automation | Playwright | ^1.51 | Chromium headless, persistent profile |
| Chrome bridge | Custom extension | MV3 | Real Chrome via WebSocket IPC |
| Desktop app | Electron | ^42 | macOS + Windows, auto-updater |
| Telegram | grammY | ^1.35 | Bot API |
| Discord | discord.js | ^14.26 | Text |
| Slack | @slack/bolt | ^4.7 | Socket Mode |
| WhatsApp | @whiskeysockets/baileys | ^7.0.0-rc14 | WhatsApp Web protocol |
| Email | IMAPFlow + Nodemailer | ^1.2 / ^8.0 | IMAP read + SMTP send |
| Video processing | fluent-ffmpeg | ^2.1 | FFmpeg wrapper |
| Code parsing | tree-sitter | ^0.22 | TS/JS default; Python/Rust/Go gated behind `ATLAS_MULTI_TREE_SITTER`; regex fallback covers 15 langs |
| Schema validation | Zod | ^4.3 | All tool parameter schemas |
| Linter/formatter | Biome | ^2.4 | Replaces ESLint + Prettier |
| Test runner | Vitest | ^4.1 | Unit + integration tests |
| Swift helpers | Swift 5.9 | macOS 13+ | OCR (`ocr_screen.swift`), GPS (`get_location.swift`), AX dump (`dump_ax.swift`) |
| MCP | @modelcontextprotocol/sdk | ^1.9 | External tool providers |

### LLM Providers (Claude API via Convex)

The client never talks to a model vendor. Every request goes to Convex, and `convex/claude.ts` translates the client's OpenAI-format body into a Claude Messages API call (prompt-cache breakpoints, effort, image and PDF blocks) and the reply back into the OpenAI chat-completion shape the client already parses. `toClaudeModel()` collapses any client model id onto one of three Claude models:

| Claude model | Convex id | Chosen for client ids containing | Credits / call |
|--------------|-----------|----------------------------------|----------------|
| Haiku 5.5 | `claude-haiku-5-5` | `haiku`, `nano`, `mini`, `micro`, `lite`, `flash` (whole id segments) | 0.25 |
| Sonnet 5.5 | `claude-sonnet-5-5` | everything else (default) | 1 |
| Opus 5.5 | `claude-opus-5-5` | `opus` | 2 |

Other server-side routes:

- **Azure AI Foundry** (`convex/grok.ts`): xAI Grok for unhinged mode (18+, owner opt-in; falls back to Sonnet, billed like Sonnet) and any `azure/<deployment>` id (used by the picture-CAPTCHA solver).
- **Speech-to-text** (`convex/stt.ts`, `/api/stt`): Claude can't hear audio, so voice notes go to any OpenAI-compatible transcription API configured in Convex env; billed like a Haiku call.
- **Search proxies** (`/api/search/parallel|claude|tavily|exa`) so search keys never reach the client.

All provider keys (`ANTHROPIC_API_KEY`, Azure, STT, search, voice) live exclusively in Convex environment variables.

---

## 3. Key Components & Services

### 3.1 LLM Client & Encrypted Transport

**Files:** `src/llm.ts`, `src/crypto-transport.ts`

Every LLM call goes through a two-layer security stack:

**Layer 1 — ECDH session key exchange**
When the desktop app starts (or when a new session begins), the client generates an ephemeral P-256 key pair and sends the public key to Convex via `/api/auth/session`. Convex returns its own ephemeral public key. Both sides derive the same 256-bit shared secret using ECDH + SHA-256. This shared key is stored with the session record.

**Layer 2 — AES-256-GCM payload encryption**
Every subsequent request to `/api/llm/chat` is encrypted with the derived key. The envelope format is `{ iv, ct, tag, ts, rid }` (all base64). The server decrypts, validates the timestamp (90-second replay window), deducts credits and forwards to Claude with its own API key, encrypts the response, and returns it. API keys never travel to or from the client.

**Semantic response cache** (`src/llm-cache.ts`): Simple queries (20–500 chars) are cached in a 200-entry LRU keyed by MiniLM embedding. A hit requires cosine similarity ≥ 0.97 by default (`ATLAS_LLM_CACHE_THRESHOLD`; lowered thresholds produced false positives on short follow-ups) and age < 10 minutes. Tool-call requests and extended-thinking requests are never cached, and tool state is not part of the key.

**Adaptive language matching** (`src/language.ts`): Every request is analyzed for writing system (Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, and 10+ Latin-script languages + Hinglish romanization). A `Respond in {language}` directive is injected automatically. Detection uses Unicode script analysis as the primary signal, with keyword heuristics as a tiebreaker (e.g. distinguishing Hindi-in-Latin-script from English).

**Thinking levels** — `thinkingLevel` (`off|low|medium|high|max`) is sent as `reasoning.effort`, and the proxy maps it to Claude's `output_config.effort` (`low` … `max`). `off`/`none` turns thinking off where the model allows it (Haiku `disabled`, Sonnet `between_tools`; Opus cannot, so it gets the lowest effort). The thinking level is inferred from task type by the router; coding tasks skip the thinking bump with `ATLAS_NO_CODING_THINKING=true`. The per-attempt HTTP timeout scales with the effort (`ATLAS_LLM_ATTEMPT_TIMEOUT_MS`, default 25 s; each fallback hop gets a fresh timeout).

**Skills injection** — when the caller passes `skillSlugs`, the Convex server prepends the matching markdown skill content to the system prompt (from the `system_skills` table). This lets specialized domains (e.g. Convex development, video editing) get additional context without the client ever holding the skill content.

**Response format** — callers can pass `responseFormat: "json_object"` to ask for JSON. The `extractJSON()` utility in `src/utils/json-extract.ts` is the fallback: it strips markdown fences and recovers JSON from mixed output, so callers do not depend on provider support for the flag.

---

### 3.2 Model Router

**Files:** `src/model-router.ts`, `native/src/model_router.rs`

A TypeScript wrapper around the napi-rs native router (JS-only fallback when the binary is missing). Inputs: iteration count, error count, last tool calls, task type (`coding`, `research`, `tool_loop`, `error_recovery`, …), media, the user's `"simple"`/`"complex"` hint, and conversation mood. Output: a model id, a thinking level, and a horizontal-failover list. The client still picks among legacy multi-vendor ids (the `MODELS` constant in `src/llm.ts`), but **every id lands on one of three Claude models** in `convex/claude.ts` (`toClaudeModel`), billed per call: **Haiku 0.25 cr, Sonnet 1 cr, Opus 2 cr** (`convex/credit_cost.ts`; see §3.1 and §3.8). Cheap client-side rungs (GPT-5 nano/mini, Gemini Flash, Nova …) therefore bill and run as Haiku.

**Task-context routing (iteration 1).** The tool router's lean classifier also returns `tier` (`chat|simple|standard|complex`) and `multi_step`. `agent.ts` adjusts the native pick from it: `chat` → Haiku with thinking off and only `request_tools` (the "chat lane"); `simple` → Haiku with low thinking; `complex` → at least Sonnet. The planner runs only for multi-step, complex or chained work, and later iterations reuse the turn's tool set (prompt cache). A non-complex desktop-only turn (categories within `os_control` / `app_management` / `system_controls`) stays on Haiku for its first 8 iterations until a step fails, metacognition flags a loop, or `request_tools` widens it. Opus is gated by `opusWarranted()` (explicit ask, `modelHint` complex, or 3+ errors).

**Cascade escalation:** on errors (or a circuit-breaker trip) the router upgrades Haiku → Sonnet → Opus. This works in sub-agents too.

**Cost-aware routing** (`ATLAS_NO_COST_ROUTING` disables the TS net): native `select_dynamic_model` down-routes the cheapest user-facing rungs (`pn≤3 & score≤15` → GPT-5 nano, `pn≤4 & score≤25` → GPT-5 mini); otherwise Haiku → Sonnet → Opus, with Opus gated to ComplexChat / explicit-complexity branches. A TS safety net caps plain single-turn chat at Sonnet. Cost tables are kept in sync across `native/src/model_router.rs`, `src/llm-middleware.ts` (`MODEL_COSTS`, telemetry) and `convex/credit_cost.ts` (the billing source of truth).

**Dynamic orchestrator.** The plan call (`needsPlanning && iteration === 1`) picks its model via `classifyOrchestratorComplexity()` — simple → Haiku (thinking off), mild → Haiku (low), complex → Sonnet (low) — and sends `serverPromptSlug: "orchestrator-base"` so the proxy serves rules + that slug instead of the full identity stack. A cheap-tier failure is retried once on Sonnet. A single-target OS/app/messaging/media action (not chained, confidence ≥ 0.7) skips the plan entirely (`ATLAS_NO_GUI_FASTPATH` restores it). Routing is always logged to `data/orchestrator-routing.jsonl`. Kill-switches: `ATLAS_NO_DYNAMIC_ORCHESTRATOR`, `ATLAS_ORCH_SHADOW`.

**Browser/OS routing.** The native `browser_os` block picks by complexity — complex (creative/design, media, 2+ errors, CAPTCHA handling, auth keywords) → Sonnet; moderate → Gemini 3.1 Pro tier; simple + vision → GPT-5 mini; simple text-DOM → GPT-5 nano (the latter two still bill as Haiku). Design-tool or stuck (`iter>=20` / `errors>=4`) browser work goes to Opus. `ATLAS_NO_DYNAMIC_BROWSER_ROUTING` restores "any action browser/OS tool → Sonnet".

**Coding escalation** (`maybeEscalateForCoding`, `ATLAS_NO_CODING_ESCALATION`): non-trivial coding forces a Pro-or-better tier (the router's tiers are inverted: 0 = Opus … 5 = Haiku; `PRO_TIER_CEILING = 4`), and sub-agent coders are pinned to Pro. Extended thinking is added unless `ATLAS_NO_CODING_THINKING=true`.

**Tool-synthesis routing:** a dedicated `tool_synthesis` `TaskType` routes Skill Forge synthesis to Sonnet + high thinking (Opus + max in dream-replay when `ATLAS_FORGE_DREAM_OPUS=true`).

**Context-window awareness:** the router carries each model's context window so the agent loop prunes tokens proactively and the failover guard avoids routing an over-budget conversation to a smaller-window model. The native router returns a `horizontalFailover` list that the TS client walks on error before escalating a tier (DeepSeek is in the native failover chain).

**Helper calls** (classifier, HyDE, briefing) pass `lean: true` — no thinking, no client clock block, no server `rules` preamble when tool-less. HyDE runs only in `retrieve` mode; the memory briefing only above `BRIEFING_MIN_CHARS`. LLM telemetry logs cached tokens.

---


### 3.3 Tool Router

**Files:** `src/tool-router.ts`, `native/src/tool_router.rs`

Tool selection uses semantic similarity — not keyword matching.

**At boot:** Each of 20+ tool category descriptions is embedded with MiniLM (384-dim vectors) and cached in the Rust module.

**Per request:** The user query is embedded → cosine similarity computed against all category embeddings → top-K categories selected → tool schemas for those categories loaded into the LLM context.

A `request_tools` meta-tool lets the agent ask for additional tool categories mid-task without restarting. Co-occurrence learning tracks which tools are used together and boosts correlated categories.

**Categories:** core, memory, browser, web_search, file_system, shell, os_control, system_controls, media, communication, scheduling, app_management, research, coding, long_tasks, google_api, social_media, voice, document, integrations.

**FunctionGemma fallback** (`src/models/function-gemma.ts`): An optional 270M local model via Ollama (85% accuracy) can be used for zero-cost tool routing when the LLM call budget is tight.

**Chat lane and gating:** the lean classifier also decides when a turn needs no tools at all (small talk, opinions, writing, math) so the agent takes the cheap chat lane (§3.2). `isToolOfferable` hides tools that cannot work right now — for example `whatsapp_send` / `whatsapp_sticker` / `whatsapp_group_info` while WhatsApp is not connected (`ATLAS_NO_WHATSAPP_TOOL_GATING` restores them); it is re-evaluated per message. Non-owners (contacts, guests, email senders, widget visitors) only ever get the narrow `NON_OWNER_TOOLS` set (`src/security/tool-access.ts`).

**Analytics** (`src/tool-router-analytics.ts`): Tracks tool usage patterns, selection accuracy, and category hit rates for the Meta-Harness optimizer.


### 3.4 Agent Loop

**File:** `src/agent.ts`

The core execution engine. Each call to `runAgent()` runs through this pipeline:

1. **Account gate** — check credits via Convex; block if exhausted
2. **Message preprocessing** — strip internal tags, prune context window
3. **First iteration only:** 12 memory retrieval systems fire in parallel:
   - Identity profile, behavioral traits, session summary
   - Self-state, emotional context, episodic milestones
   - Relationship tone, anticipation signals, core memory
   - Query-specific recall (HNSW vector search)
   - Task learnings, knowledge graph entities
   - Each has a token budget; total injection ~2-3K tokens
4. **Each iteration:** `chooseModel()` → semantic tool select → LLM call → tool execution → check for `finish_reason: stop` or `TASK_COMPLETE` signal
5. **Tool execution:** Browser tools run sequentially (shared page state), and so do screen-driving tools (`os_*`, `app_manager`, `apple_script`, `window_manage`, `run_shortcut`) in call order; all other tools run in parallel. Tool results carrying `screenshot_base64` / `zoomed_base64` are turned into image parts (≤ 1568 px) before offload/truncation, and only the newest few screenshots stay in history
6. **Cascade escalation:** Errors accumulate → auto-upgrade model tier
7. **Max 200 iterations;** mid-session credit check every 5 tool calls

**Reliability layer:**

- **Per-turn nudges** — steering messages go through `pushNudge` and are stripped at turn end; a context prune is computed after the turn and applied before the next turn's history cap.
- **Send ledger** (`src/tools/send-ledger.ts`) — the same message or file to the same recipient within 10 minutes is refused unless the call passes `resend: true`; an in-flight send reports "still being sent".
- **Task contract** — the first line of real work is "on it — …; done = …" (`prompts/rules.md`). The `[ACK]` progress line shows it and the verify-before-done nudge quotes the done-criterion back (`src/agents/verify-before-done.ts`, order-aware: a screenshot taken after the last action counts as verification).
- **Stuck report** — "never give up silently, never fake done": after 2–3 different attempts, or when only the owner can unblock, the reply ends with `[[STUCK]]` (stripped by `takeStuckMarker`, `src/channel-text.ts`). Telegram shows I'll take over / Retry / Skip; other channels get a reply line. Failing exits (circuit breaker, LLM failures, iteration cap) also return a stuck report.
- **Done receipt** — after a mutator plus a later screenshot, the owner's private chat gets the clean (ungridded) screenshot; never on vault/withheld turns, failed last actions or stuck turns.
- **Step heartbeat** (`src/step-status.ts`) — progress reads "step N · status · Ns", re-sent about every 20 s while a tool batch runs.
- **Playbooks** (`src/memory/playbooks.ts`) — a programmatically verified win stores its tool steps in task-learnings (tool names and short targets only: no typed text, bodies, secrets, emails or phones; never a task carrying a one-time code or a "secret"); a failed replay demotes it.
- **Swarm approval gate** (`src/agents/swarm-context.ts`, `src/tools/swarm-gate.ts`) — inside swarm runs, explicit external-action tools, per-call-consent tools and shell launchers are held until the owner's fresh yes (`swarm_task confirmed: true`, enforced by `src/security/consent.ts`); payments and orders never run in a swarm. Accepted limit: effects through generic UI clicks or self-written scripts.
- **Owner vs. guest turns** — only the owner's own turns set the reply language, goals, session summary and owner memories; guests and contacts get their own short conversation (`src/guest-history.ts`) and never see the owner's chat, Settings tone or personal learnings.

**Circuit breaker** (`src/agents/circuit-breaker.ts`): Trips on 5 consecutive failures, 8 no-progress iterations, or 3-minute stall. States: CLOSED → OPEN → HALF-OPEN with escalating cooldowns (30s → 60s).

**Metacognition** (`src/agents/metacognition.ts`): The loop tracks signals every iteration — token usage, tool error rate, progress delta, confidence — and asks "should I stop, escalate, ask for help, or retry?" at each decision point. When it detects pathological patterns (loop detection on tool call sequences, monotonic confidence decay, plateau on progress), it triggers intervention: either switch role, request human input via `human-interrupt.ts`, or gracefully exit with a partial result.

**Plan mode** (`src/agents/plan-mode.ts`): A runtime-gated state machine with four states:

| State | Writes allowed? | How to enter | How to exit |
|-------|---------|--------------|-------------|
| `act` | Yes | Default | — |
| `plan` | No (read-only tools) | `enter_plan_mode({ reason })` | `exit_plan_mode({ plan })` |
| `spec` | No | `enter_spec_mode({ title })` | `finish_spec({ spec })` |
| `awaiting_approval` | Design-docs dir only | Auto, on `generate_design_docs` success | `approve_design_docs({ user_quote })` |

Each state has an explicit `*_ALLOWED_TOOLS` list in `plan-mode.ts`; `filterToolsFor*` strips tools before the LLM call, and `checkWritePathInApprovalMode()` enforces at execution time.

**Context pruning** (`src/memory/context-pruning.ts`): When the message history exceeds its cap, older messages are summarized rather than dropped; first-iteration memory injection is separately capped by the tunable `agent.contextCap` harness dimension (default 8000 chars). The pruner preserves:

- All system reminders
- The most recent user message
- The last N tool calls + results (N dynamic based on iteration count)
- A compressed rolling summary of earlier turns

**System reminders** (`src/agent/system-reminders.ts`): Injected into the message stream (not the system prompt) at specific decision points to nudge behavior without bloating context. Examples: "You are at iteration 150/200 — start wrapping up"; "Plan mode active — write tools blocked"; "Coding complexity: complex — follow the 4-phase flow".

**Loop guardrail:** A per-turn guard hard-stops identical-args tool-call loops (the same tool invoked with the same arguments repeatedly), separate from the metacognition loop detector; the no-progress guard is relaxed for legitimately long/iterative tasks.

**Diagnostic commands** (`src/commands/`): `/recap [n]` summarizes the last *n* turns (default 20) with zero AI cost; `/doctor` runs a system probe across Convex connectivity, session/credit state, the native binary, environment, and memory health (`src/diagnostics/doctor.ts`).

---

### 3.5 Four-Tier Agent Orchestration

**Directory:** `src/agents/` (36 files)

| Tier | Entry point | Max scale | Purpose |
|------|------------|-----------|---------|
| **Sub-Agent** | `sub-agent.ts` | — | Specialized role (researcher/coder/browser/system/general), scoped tool subset, loop detection |
| **Swarm** | `swarm.ts` | 20 steps | Decomposes task → executes via Mesh → evaluator-optimizer loop with up to 3 replans |
| **Mesh** | `mesh.ts` | Unlimited steps | Parallel DAG: independent steps run concurrently, dependent steps sequentially; critical path scheduling |
| **Long-Task** | `long-task.ts` | 100 phases × 200 iter × 30 min | Multi-phase executor; checkpoints every 60s to `data/long-tasks/{id}.json`; resumable after crash |

**Reliability layers:**
- `error-recovery.ts` — retry → rephrase → reroute (switch role) → skip
- `evaluator.ts` — quality scoring (completeness/accuracy/coherence/actionability 0-100); retry if < 60
- `replanner.ts` — revises remaining plan when failures or new info detected
- `metacognition.ts` — tiered self-monitoring between iterations. **Tier A:** content-aware loop detection + an intervention dispatcher that picks `escalate` / `replan` / `critics` / `ask_user`. **Tier B (VOC):** a value-of-computation re-threshold (τ = 1 − cost_loss/cost_win, zero-LLM arithmetic) that suppresses an intervention when the agent is already confident, so low-payoff interventions don't burn credits (`ATLAS_NO_META_VOC`). **Tier C:** shadow-mode confidence calibration (identity until enabled) + an opt-in LLM judge. Outcomes are logged for later analysis (`ATLAS_NO_METACOG_LOG`); disable interventions entirely with `ATLAS_NO_META_INTERVENTIONS`. A separate per-turn guardrail in `src/agent.ts` hard-stops identical-args tool-call loops
- `multi-critic.ts` — multi-perspective debate on solution quality
- `code-critic.ts` — compile + lint + test + SAST (Semgrep) in parallel; weighted consensus score
- `agent-worktree.ts` — git worktree isolation for parallel coder steps (opt-in via `ATLAS_AGENT_WORKTREE=true`)
- `mixture.ts` — Mixture-of-Agents: 3 parallel proposals blended for complex tasks
- `speculative.ts` — races primary + alternative approach; first success wins
- `a2a.ts` — Google A2A protocol; exposes Bhai as a callable agent to external systems

**Shared context:** `blackboard.ts` provides a per-swarm key-value store for inter-agent data passing.

**Swarm approval gate:** runs started by `swarm_task` hold explicit external-action tools, per-call-consent tools and shell launchers until the owner gives a fresh yes (see §3.4); payments and orders never run inside a swarm.

**Human-in-the-loop:** `human-interrupt.ts` pauses dangerous operations (delete, deploy, send email) and waits for user confirmation (default 5-minute timeout with configurable default action).

---

### 3.6 Memory System (59 modules)

**Directory:** `src/memory/`

All memory is local SQLite (`data/memory.db`) with WAL journal mode, 64 MB page cache, and 256 MB mmap. No memory data leaves the user's machine.

**Storage layers:**

| Module | Purpose | Key detail |
|--------|---------|-----------|
| `sqlite.ts` | Primary store | `remember()`, `recall()`, `getCoreMemory()` |
| `vector-index.ts` | HNSW ANN search | M=16, EF=200/50, Float16 quantization |
| `knowledge-graph.ts` | Entity-relationship graph | Bi-temporal (valid_at/invalid_at/expired_at) |
| `embeddings.ts` | Vector generation | MiniLM 384-dim (default), Nomic 768→256 optional |
| `emotional.ts` | Emotional trajectory | Exponential decay (λ=0.05), 30-day max |
| `episodic.ts` | Milestone events | achievement, struggle, decision, milestone |
| `traits.ts` | Behavioral traits | Confidence-weighted, 600-token budget, conflict detection |
| `identity.ts` | User profile | JSON Resume format; persisted to `user_profiles` |
| `working-memory.ts` | Short-term buffer | 20 items, 3000-token budget, attention-scored |
| `hopfield-memory.ts` | Associative recall | Continuous Hopfield network, similarity > 0.3 gate |
| `world-model.ts` | World state | Per-entity accessibility scores, EMA response times |
| `user-model.ts` | User model | Aggregates identity + traits + KG into unified prediction |
| `active-inference.ts` | Predictive inference | Free-energy minimization; explore vs exploit (Nature Comms Dec 2025) |
| `reflection.ts` | Nightly consolidation | SAC-DR; trait extraction, HMAC audit log |
| `self-evolving.ts` | Synaptic pruning | Strength-based: weak→delete, medium→weaken, strong→strengthen |
| `task-learnings.ts` | Task strategies | Per-(category, pattern, context) learning; merges on re-encounter |
| `codebase-index.ts` | Repo sidecar | Per-repo SQLite at `data/codebase-index/{hash}.db`; tree-sitter parse |
| `studio-graph.ts` + `studio-insights.ts` | Memory Studio | Interactive graph viewer with edit/pin/forget controls + AI-generated insights |
| `embedding-cache.ts` + `resolve-embedding.ts` | Embedding indirection | Caches expensive embeds; resolves text → vector with provider fallback |
| `spreading-activation.ts` | Spreading Activation Network | k-hop BFS over the knowledge graph for associative recall boost |
| `fts5-query.ts` | BM25 search helper | SQLite FTS5 query construction + scoring |
| `project-memory.ts` | Per-project scoping | Tags memory entries with the active workspace root for project-scoped recall |
| `anticipation.ts` / `briefing.ts` | Forward-looking context | Upcoming-event scan + morning briefing assembly |
| `value-gate.ts` + `gate-audit.ts` | Write value-gate | Every `remember()` passes a Haiku gate (hardReject/hardAllow short-circuits + LLM judgment); sha256-cached, fail-closed, decisions logged to `data/memory-gate.jsonl` (10 MB rotation) |
| `compression-template.ts` | Structured compression | 13-section continuity template (active task verbatim, completed actions, exact errors, decisions, pending asks, files); persisted so the next iterative pass parses + extends it |
| `playbooks.ts` | Playbooks from verified wins | Compact tool-step recipes stored in task-learnings; failed replay demotes |
| `at-rest-scrub.ts` | At-rest masking migration | One-time scrub of card numbers, OTPs and typed passwords saved before at-rest masking (`secrets_at_rest_v1`); new writes are masked via `protectForDisk` |
| `sleep-gate.ts` / `reranker.ts` / `strategy-library.ts` / `memory-tiers.ts` | Consolidation + retrieval support | Conflict detection, cross-encoder rerank, reusable strategies, tiering |

**Write value-gate** (`value-gate.ts`): `remember()` is async and routes through a gate. `hardReject` drops tool-result prefixes, screenshot/image blobs, WM-spill rows, and oversize (>2000-char) content; `hardAllow` fast-passes curated categories, high-importance writes, and reflection/consolidation sources; everything else gets a cheap Haiku yes/no (sha256-cached, fails closed to allow). Default is **shadow mode** (`ATLAS_MEMORY_GATE_SHADOW`, decides + logs but always inserts); set to `"false"` to enforce. `ATLAS_NO_MEMORY_GATE=true` reverts to direct writes. Working-memory spill no longer persists to LTM; per-message flush uses a Haiku extractor rather than a blanket filter.

**Conversation corpus + `session_search`** (`src/tools/session-search.ts`, `fts5-query.ts`): the full message corpus is stored and searchable via an FTS5 BM25 recall tool, distinct from semantic recall — exact-phrase lookups across past turns. Capped by `ATLAS_CORPUS_MAX_MESSAGES`; disable the tool with `ATLAS_NO_SESSION_SEARCH`.

**Retrieval fusion:** Results from multiple sources are blended using RRF (Reciprocal Rank Fusion) + recency exponential decay + importance weights + SAN/Hopfield boost multipliers. A cross-encoder reranker makes the final pass.

**Memory decay:** Runs every 6 hours. Self-evolving synaptic pruning uses a strength score: `importance × log₂(1 + access_count) × exp(-0.01 × days_since_access)`. Memories below 30% of median strength are deleted.

**Dream consolidation** (`src/memory/reflection.ts`, `src/proactive/dreaming.ts`): When the user has been idle for 2+ hours during 11 pm–6 am, Bhai enters dream mode — consolidates memories, runs pending tasks via sub-agents, proposes self-edits for repeated failures, and queues results for morning delivery.

**Privacy at rest and owner/guest separation:** card numbers, one-time codes and typed passwords are masked before they reach the memory DB, the conversation archive or logs (`src/security/pii-vault.ts`, `credential-mask.ts`). A contact's photos and tool results stay out of the owner's memory, and guests' words never become the owner's goals or session summary.

**Memory categories** — every entry stored via `remember()` is tagged with a category for retrieval scoping and decay tuning:

| Category | Purpose | Decay |
|----------|---------|-------|
| `identity` | User profile (name, role, preferences) | None (permanent) |
| `preference` | Things the user likes / dislikes | Slow (90 d) |
| `fact` | Objective fact about the user's world | Slow (180 d) |
| `episode` | Conversation milestone | Medium (30 d) |
| `skill` | Something the user is learning / good at | Slow (90 d) |
| `relationship` | Person, colleague, family | Slow (90 d) |
| `code` / `code_*` | Coding strategy (preserved from pruning) | None |
| `task` | Pending / completed task | Short (7 d) |
| `observation` | Ambient passive observation | Short (3 d) |

**Bi-temporal knowledge graph** — `knowledge-graph.ts` stores every fact with three timestamps: `valid_at` (when the fact started being true), `invalid_at` (when it stopped), and `expired_at` (when Bhai last confirmed the fact). This allows queries like "what did the user believe 3 days ago?" to return historically accurate answers.

**Vector index internals** — `vector-index.ts` uses HNSW with:
- `M = 16` (max connections per layer)
- `efConstruction = 200` (beam width during insertion)
- `efSearch = 50` (beam width during query)
- Float16 quantization of embeddings to halve memory footprint (2× more vectors in the same RAM)
- Incremental batch insertion every 50 embeddings or 5 seconds

**Retrieval pipeline** — when `recall()` is called:

1. **Candidate generation** — three parallel passes: HNSW vector search (top 50), BM25 full-text search (top 30), recency scan (top 20 most recent within the requested scope)
2. **RRF fusion** — combine the three rankings with `score = Σ 1/(k + rank_i)`, k=60
3. **Feature expansion** — add importance, access count, recency decay, SAN activation boost, Hopfield associative boost
4. **Cross-encoder rerank** — a small cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) re-ranks the top 30 by semantic relevance to the query; blended with the RRF score via `crossEncoderBlend` harness dimension (default 0.6)
5. **Diversity filter** — MMR-style deduplication to avoid returning near-identical memories
6. **Token-aware trimming** — pack results to fit the caller's token budget, preferring shorter high-score entries

---

### 3.7 Native Rust Layer (80 modules)

**Directory:** `native/src/`

Built with napi-rs, compiled to platform-specific `.node` binaries. TypeScript loads the binary at runtime; all subsystems fall back to pure-JS implementations if the binary is unavailable. New ports follow the empirical rule: only port modules where TS is genuinely slow AND Rust has a structural advantage (multi-pattern scanning, large-batch SIMD, true parallelism) — see CLAUDE.md "Rust expansion — empirical lessons" for the canonical worked examples (secrets-sanitizer wins, spreading BFS / SHA-256 / small-tree AX flatten lose).

**Build profile:** `opt-level=3`, LTO enabled, `codegen-units=1`, `panic=abort`, binaries stripped. The `vad` cargo feature gates `libfvad` (adds 30–60s to clean builds and a C toolchain dep, so it is opt-in: `napi build --features vad`).

**Module groups:**

| Group | Modules | What it accelerates |
|-------|---------|-------------------|
| Vector math | `vector.rs`, `batch.rs`, `hnsw.rs` | SIMD dot-product, cosine similarity, ANN search |
| Routing | `model_router.rs`, `tool_router.rs`, `tool_analytics.rs`, `query_classifier.rs` | Model/tool selection scoring |
| Memory | `memory_state.rs`, `memory_tiers.rs`, `knowledge_graph.rs`, `hnsw.rs`, `hopfield.rs`, `spreading.rs`, `temporal_cache.rs`, `consolidation.rs`, `context_pruning.rs`, `sleep_gate.rs`, `surprise_gate.rs`, `reflection_core.rs`, `session_memory.rs`, `working_memory.rs`, `task_learnings.rs`, `traits_engine.rs` | Hot-path memory ops |
| Agents | `agent_core.rs`, `swarm.rs`, `mesh.rs`, `sub_agent.rs`, `long_task.rs` | Orchestration state tracking |
| Reasoning | `metacognition.rs`, `mcts_engine.rs`, `active_inference.rs`, `logic_engine.rs`, `process_reward.rs`, `pattern_speculator.rs`, `prompt_evaluator.rs` | Inference and planning |
| World/user models | `world_model.rs`, `user_model.rs`, `credibility_model.rs` | Predictive state |
| Proactive | `proactive_scheduler.rs`, `proactive_monitor.rs`, `proactive_intent.rs`, `proactive_calendar.rs`, `proactive_news.rs`, `proactive_stale_email.rs`, `proactive_tasks.rs`, `proactive_weather.rs`, `proactive_source_gate.rs`, `inner_thoughts.rs`, `goal_engine.rs`, `habit_detector.rs`, `notification_tracker.rs` | Intent queue, per-source scoring, rate limiting, DND |
| Browser | `browser_agent.rs`, `browser_guard.rs`, `chrome_bridge.rs`, `ip_guard.rs` | Element scoring, stealth, CAPTCHA detection |
| Vision Nav | `ax_walker.rs` (opt-in) | Cross-OS accessibility-tree flatten/find |
| Voice | `pcm_vad.rs` (cargo feature `vad`, opt-in) | libfvad-backed barge-in detection for hybrid voice |
| Security | `security.rs`, `secrets_sanitizer.rs` (default-ON), `pii_protect.rs` (opt-in `ATLAS_NATIVE_PROTECT`) | Encryption helpers; multi-pattern outbound secrets scrubber (1.9–3.4× faster than TS at 1–200 KB); linear-time credential masking / PII finding, byte-identical to the TS |
| Research | `research_engine.rs`, `info_gain.rs`, `citation_graph.rs`, `skill_scorer.rs` | Research acceleration |
| Harness | `harness_optimizer.rs` | NSGA-II Pareto, GP surrogate, TextGrad scoring |
| Skill Forge sandbox | `forge_sandbox/` (`pool.rs`, `worker.rs`, `strikes.rs`, `linux_seccomp.rs`, `linux_landlock.rs`, `macos.rs`, `windows_appcontainer.rs`, …) | OS-level kernel sandbox supervisor for persisted dynamic tools: macOS sandbox-exec, Linux seccomp + Landlock + netns, Windows AppContainer + JobObject; LRU warm-pool, three-strike auto-archive |

**Performance numbers** (from `native/README.md`):

| Operation | JS | Native | Speedup |
|-----------|-----|--------|---------|
| cosine similarity (768-dim) | 12 μs | 0.8 μs | 15× |
| findTopK (1000 vectors) | 15 ms | 0.9 ms | 17× |
| batch similarity | 14 ms | 0.7 ms | 20× |

---

### 3.8 Convex Backend

**Directory:** `convex/`

Convex serves as the secure cloud layer. The Node.js client connects to it via the Convex SDK; API keys for LLMs live only in Convex environment variables and are never sent to the client.

**Database tables** (27, defined in `convex/schema.ts`):

| Table | Purpose |
|-------|---------|
| `accounts` | OTPless identity, plan (free/pro/enterprise), AI credits, activations |
| `sessions` | 24h TTL tokens; ECDH shared key for E2E encryption; device fingerprint |
| `devices` | The owner's devices (`platform:host:user` fingerprint, first/last seen) behind Account → Devices; removing one signs it out |
| `auth_handoffs` | Short-lived email-link sign-in handoff (OTPless) |
| `rate_limits` / `request_rate_limits` | Sliding-window LLM rate limit + per-endpoint request limiter |
| `llm_usage_counters` / `llm_call_log` / `error_log` | Per-account usage rollups, per-call telemetry, server-side error log |
| `waitlist` / `contact_submissions` | Marketing-site waitlist + contact form intake |
| `user_prompt_addenda` / `user_prompt_addendum_history` | Per-user system-prompt addenda (e.g. the personality tone) + edit history; usage-tracked, nightly staleness sweep |
| `telegram_bot_claims` | One-tap Telegram bot creation: username claimed by an account, token held until the desktop collects it once |
| `bhai_mail_addresses` / `bhai_mail_inbox` / `bhai_mail_sends` / `bhai_mail_cursor` | Bhai's own email address (`<name>.bhai@…`): address claims, queued inbound mail, capped sends, mailbox read cursor |
| `developers` | Store publisher accounts (email + bcrypt, approval workflow) |
| `admins` | Admin panel users with role + permissions |
| `store_items` | Published skills, tools, MCP servers (slug, type, category, tags, pricing) |
| `submissions` | Pending store review queue |
| `store_installs` | User install records with auto-update preference |
| `store_reviews` | 1–5 star ratings with helpful votes |
| `store_activity_log` | Analytics for admin dashboard |
| `system_prompts` | Server-side prompts (versioned); client fetches by slug |
| `system_skills` | Built-in skill definitions served at runtime |

**HTTP endpoints** (`convex/http.ts`; the admin-panel `/api/admin/*` and `/api/store/*` routes are omitted):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/llm/chat` | POST | Authenticated, E2E-encrypted Claude proxy with prompt caching and credit pre-check |
| `/api/llm/audit` | POST | Client-side LLM audit/telemetry intake |
| `/api/stt` | POST | Speech-to-text for voice notes (any OpenAI-compatible provider set in Convex env) |
| `/api/auth/session` · `/refresh` · `/revoke` | POST | Session create (+ optional ECDH key exchange), TTL extension, logout |
| `/api/otpless/validate-token` · `/handoff` | POST | OTPless token validation (also reactivates a device); email-link sign-in handoff |
| `/auth-login` | GET | Hosted sign-in page |
| `/api/account/status` · `/info` · `/update-profile` | GET/POST | Credit balance, account info, profile |
| `/api/account/devices` · `/devices/remove` | GET/POST | List / remove the owner's devices |
| `/api/system/prompt` · `/api/system/skill-metadata` | GET | System prompt by slug; skill metadata |
| `/api/user/addendum/{list,upsert,revert,deactivate}` | POST | Per-user prompt addenda (personality tone etc.) |
| `/api/search/{parallel,claude,tavily,exa}` | POST | Search proxies (keys stay server-side) |
| `/api/mail/{claim,inbox,ack,send}` | POST | Bhai's own email address: claim, collect, acknowledge, send |
| `/api/telegram/managed/{claim,collect}` · `/api/telegram/manager-webhook` | POST | One-tap Telegram bot creation |
| `/api/keys/voice` · `/api/spotify/app-token` · `/api/config/secrets` | GET/POST | Voice-backend keys, Spotify client credentials, shared config secrets |
| `/api/app/runtime-key` | POST | XOR key delivery for desktop app protection |
| `/api/updates/latest-mac.yml` · `/latest.yml` | GET | Electron auto-updater metadata (macOS / Windows) |
| `/api/waitlist/submit` · `/api/contact/submit` | POST | Marketing-site forms |

**Prompt caching:** `convex/claude.ts` adds `cache_control: ephemeral` breakpoints (system prompt, tools schema, conversation history) to Claude requests, so repeated context is billed at the cached rate.

**Credit costs** (`convex/credit_cost.ts`, server-side only; one credit per call by the Claude model that actually answers, in line with real API prices):

| Model | Cost |
|-------|------|
| Haiku 5.5 | 0.25 cr |
| Sonnet 5.5 | 1 cr |
| Opus 5.5 | 2 cr |

Any client model id resolves through `toClaudeModel()`; unknown ids land on Sonnet so a typo can't skip billing. Grok (unhinged mode) is priced like Sonnet; a voice-note transcription costs 0.25. New accounts start with 100 free credits.

**Atomic credit deduction** — OCC (Optimistic Concurrency Control) is used to prevent race conditions:

```ts
// convex/accounts.ts (simplified)
await ctx.db.patch(accountId, {
  ai_credits: account.ai_credits - cost,
});
```

Convex's OCC serializes concurrent mutations on the same document, so two LLM calls arriving simultaneously cannot both spend the last credit. If a mutation conflicts, Convex retries automatically.

**Session token lifecycle:**

1. Client calls `POST /api/auth/session` with OTPless user ID (and optional ECDH public key)
2. Server generates a random 256-bit token, computes the shared AES-256 key (if client sent pubKey), and inserts a row into `sessions` with `expiresAt = now + 24h`
3. Client stores token in `safeStorage` (Electron) or memory (CLI)
4. Each subsequent request sends `Authorization: Bearer <token>`
5. Server validates: token exists → not expired → matches device fingerprint (if set) → not revoked
6. Expired sessions and stale rate-limit rows are swept by a daily Convex cron (`sweep sessions+rate_limits`, 04:45 UTC); the same cron file also trims `llm_call_log` and `error_log` to 30 days, retires never-used prompt addenda, and polls Bhai's mailbox every minute

**System prompt management** — prompts are source-of-truth in `prompts/*.md` in the repo, seeded to the `system_prompts` table via `scripts/seed-system-content.ts` (needs `ADMIN_API_KEY`). The client pulls them on demand:

```ts
// src/config/system-prompts.ts
const prompt = await fetchSystemPrompt('coding');  // HTTP GET /api/system/prompt?slug=coding
```

In-flight request coalescing ensures concurrent callers requesting the same slug share a single HTTP round-trip. A single-flight auth refresh handler prevents auth-token-expired requests from stampeding the refresh endpoint.

**Seeded slugs** (14): `identity`, `rules`, `rules-mac`, `rules-windows`, `browsing`, `thinking`, `coding`, `spec`, `proactive-composer`, `monitor-rule-parser`, `orchestrator-base`, `site-skill-mint`, `site-skill-review`, `unhinged`. A client-side system-prompt cache has a TTL with stale-fallback so a re-seed propagates without a restart. The personality chosen in Settings is pushed as a `user-personality` addendum (`src/setup/personality-sync.ts`) and rendered by `convex/systemContent.ts` as its own "Tone the user chose in Settings" section.

**Store marketplace flow:**

1. Developer registers via portal → `developers` row with `status: "pending"`
2. Admin approves → status flips to `"approved"`; developer can now submit items
3. Developer submits skill/tool/MCP server → `submissions` row + file uploaded to Convex storage
4. Admin reviews → approve: row moves to `store_items` and becomes publicly discoverable; reject: submission stays in queue with notes
5. User installs → `store_installs` row created; hot-reload injects the item into the running agent
6. User reviews → `store_reviews` row; affects item ranking and featured placement

**Bhai's own email** (`convex/bhaiMail*.ts`, `src/bhai-mail.ts`): "Get Bhai's email" claims `<name>.bhai@<domain>` on a catch-all Hostinger mailbox. A Convex cron reads the mailbox over IMAP every minute and routes mail to its user; each user's bot collects its mail through `/api/mail/*`, runs the agent and replies via SMTP. Mail from the owner's address gets full Bhai; everyone else gets guest mode (own conversation, `NON_OWNER_TOOLS`). Newsletters and auto-replies are only announced, never answered, and sends are capped per day so the company domain cannot be used to spam. The mailbox password lives only in Convex env.

**One-tap Telegram bot** (`convex/telegramManaged.ts`): XAGI runs a single manager bot with Telegram's Bot Management Mode. The desktop asks for a `t.me/newbot/<manager>/<username>` link, the user taps Create, the manager's webhook receives the new bot, Convex fetches its token (only for a username that account claimed), locks the bot to its owner, and the desktop collects token and owner id once (claims expire after 30 minutes). Without the manager env vars the button falls back to BotFather steps.

### 3.9 Browser Automation

**Directory:** `src/tools/browser/` (27 files)

Bhai supports two browser backends behind a unified `BrowserBackend` interface:

**Playwright backend** (`playwright-backend.ts`): Headless Chromium with a persistent profile at `data/browser-profile/`. Default for most use cases.

**Chrome extension backend** (`chrome-backend.ts`, `chrome-bridge.ts`): A WebSocket bridge to the user's real Chrome browser via a companion extension (Manifest V3). The `ChromePageProxy` class mimics Playwright's Page API, so the rest of the code doesn't know which backend is active.

**Bridge security.** The extension talks to Bhai over two loopback servers (bridge `:18800`, overlay `:18792`) guarded against DNS rebinding (`src/security/loopback.ts`). Only Bhai's own Chrome extension (by extension ID, `src/security/extension-origin.ts`) may take the bridge token or the owner socket. The bridge token is delivered over **Chrome native messaging** (Chrome starts the host only for Bhai's extension, as the same OS user); once that works for the first time (`~/.atlas/bridge-native-ok`), `/discover` stops serving tokens. Owner tokens cannot be read off Bhai's own pages by the agent's browser or other pages. **Agent tab pinning:** Bhai keeps working on its own tab even if the owner clicks another one; `close_active` can never close the owner's tab in another window. Every way of opening a URL refuses `file://`, `javascript:` and `data:`.

**Stealth** (`browser_guard.rs`): The Rust module compiles a 13-patch stealth initialization script that:
- Sets `navigator.webdriver = false`
- Injects a realistic `window.chrome` stub (runtime, loadTimes, csi, app)
- Fills `navigator.plugins` with realistic entries
- Removes `__playwright`, `__puppeteer`, `$cdc_*` markers
- Cleans CDP stack traces from `Error.stack`
- Fixes headless window dimension mismatch
- Simulates human hardware (`hardwareConcurrency=8`, `deviceMemory=8`)
- Generates session-stable, platform-appropriate Chrome user agents

Because the script is compiled into the Rust binary, it cannot be read from unpacked TypeScript.

**Human timing simulation:** `humanTypingDelayMs()` uses WPM-based per-character delays with ±30% jitter and extra pauses for punctuation. `humanClickDwellMs()` simulates 150–400 ms button holds. Mouse movement follows Fitts's law via `humanMouseParams()`.

**CAPTCHA solving** (`captcha.ts`, `captcha-vision.ts`, `captcha-forms.ts`, `captcha-chrome.ts`) — detection covers reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile (broadened detection) and form-style checks (image text, text questions, click-the-image). Solving is a waterfall:

| Tier | Method | Cost | Notes |
|------|--------|------|-------|
| 1 | Turnstile passive stealth | Free | Waits for the frame to hide |
| 2 | Picture solver (`captcha-vision.ts`) | Credits | Bhai reads the challenge DOM and asks vision models only "which numbered tiles match?" (a lettered grid for click/drag puzzles); Bhai does every click and drag itself. Default models run in parallel (`azure/gpt-6-astra` + `azure/gpt-6.1-terra`) with `azure/gpt-5.4` breaking ties, chosen from a measured bake-off (`ATLAS_CAPTCHA_MODELS` overrides). Built-in Playwright browser only |
| 3 | reCAPTCHA v2 audio bypass | Free | Downloads MP3, transcribes it |
| 4 | NopeCHA API | Free (100/day) | `NOPECHA_API_KEY` |
| 5 | 2captcha | Paid | `CAPTCHA_API_KEY` |

If the pipeline fails, Bhai hands the challenge to the owner (`human-handoff.ts`; wait tunable with `ATLAS_CAPTCHA_HANDOFF_MS`).

**Video control** (`video-control.ts`): Controls YouTube and HTML5 video players with 3-tier fallback: JS Player API → keyboard shortcuts → hover+click UI. A 10-second native cache (LRU 16 entries) avoids redundant state queries.

**OpenCLI tools** (`opencli-tools.ts`): `browser_batch_fetch` fetches N URLs in a single `page.evaluate()` call with configurable concurrency (default 5, max 20). `browser_auto_scroll` uses MutationObserver for intelligent scroll-and-settle detection.

**Element compression** (`browser_guard.rs`): Two-tier bounding-box dedup + spatial dedup (30 px radius) + consecutive group folding reduces DOM snapshots by ~15% before sending to the LLM, using the OpenCLI `[N]<tag>text` format.

**Mode-based tool switching** (`mode-tools.ts`):

| Mode | What the agent sees | When used |
|------|---------------------|-----------|
| `fast` | Text-only DOM snapshot (compressed, IDs visible) | Default — cheaper, faster |
| `vision` | Screenshot + OCR overlay + SoM (Set of Marks) annotations | Complex pages, visual-only elements |

The agent calls `set_browser_mode({ mode: "vision" })` when text-only DOM inspection fails to find the target element; falls back to `fast` mode when the task is done.

**Browser memory** (`src/tools/browser-memory.ts`): Persists site-specific learnings across sessions — element selectors that worked, cookie banners that were dismissed, anti-bot gates that were bypassed. Stored in the main `memories.db` with category `browser_strategy`.

**Strategy save/recall** (`strategy-save.ts`, `strategy-recall.ts`): When the agent finds a good approach for a site ("on Reddit, click 'Show all comments' before scraping"), it saves that strategy. On the next visit to the same domain, the strategy is pre-injected into context.

**Profile sync** (`profile-sync.ts`): Synchronizes the persistent Playwright profile across devices by exporting cookies, localStorage, and IndexedDB to a portable archive.

**Vault-aware typing** (`vault-typing.ts`): browser typing resolves `{{vault:<id>.field}}` tokens only on an https page whose origin matches the entry's domains, checked again right before the keys land (§5.12).

**Site Skills** (`src/skills/site/`, `src/tools/site-task.ts`, `site-skill-mint.ts`): a learned per-site skill lets `site_task` book or order in ~3 calls instead of 20–40 raw browser steps. Checkout goes through the consent gate (the owner's fresh yes mints a single-use token, plus a spend cap). When no skill exists the session is recorded locally; the owner can say "learn this site" and the Skill Minter builds one in the background (`mint/`, prompts `site-skill-mint` / `site-skill-review`), which goes live only on the owner's own approval. A drift detector (`drift.ts`) queues a repair re-mint when a site changes under a learned skill; a repair that leaves what the skill may click and ask unchanged goes live by itself, any other asks for approval.

---

### 3.10 Vision Navigation

**Directory:** `src/screen/` (16 files), tools at `src/tools/os-*.ts` + `src/tools/platform*.ts`

Autonomous GUI control: accessibility tree first, learned click memory next, and a cloud grounding call only when those miss. There is one setup for everyone — no tier picker and no local ML download.

#### Capability detection (`capability-detector.ts`)

On boot Bhai profiles the host. The picked profile is `standard` (AX tree → click memory → cloud grounding). `ATLAS_VISION_PROFILE=lite|standard` overrides it; `lite` additionally skips OmniParser. The old `full` tier (Ollama + UI-TARS, ~4.5 GB) is retired and a stored `full` reads as `standard`; the setup wizard no longer has a vision step.

#### Tiered Perception Cascade (`perception-router.ts`)

Given a natural-language instruction ("click Send"), the router walks tiers in confidence-gated order:

| # | Tier (`CascadeTier`)           | Typical latency  | Confidence gate |
|---|-------------------------------|------------------|-----------------|
| 1 | `memory` — click-memory recall (DB lookup) | ~5 ms           | ≥ 0.90          |
| 2 | `ax_exact` — AX exact-label match | 50–200 ms        | ≥ 0.95          |
| 3 | `ax_fuzzy` — AX fuzzy-label match | 50–200 ms        | ≥ 0.80          |
| 4 | `omniparser` — caption match   | 200–800 ms       | ≥ 0.80; runs only if its deps, icon_detect weights and Florence caption weights are all present (no install ships them any more, so in practice skipped) |
| 5 | `ui_tars` — local grounding    | 400–800 ms       | ≥ 0.70; retired (no install ships UI-TARS; `os_ground` is no longer offered) |
| 6 | `cloud_grounding`              | 1500–4000 ms     | ≥ 0.60 |
| 7 | `cloud_vlm_required`           | —                | router returns null → caller falls back to the agentic VLM |

First tier whose confidence clears its gate wins. The **cloud-grounding tier** (`cloud-grounding.ts`, on by default, `ATLAS_NO_CLOUD_GROUNDING` disables) sends the screenshot plus instruction to a cloud VLM through the LLM proxy with a grounding-only system prompt and a 30 s timeout. The screenshot is downscaled to ≤ 1568 px (`downscaleForVision`) and coordinates are scaled from the image actually sent. The call defaults to Haiku; `os_smart_click` re-grounds on Sonnet once after a verified miss. An **AX cold-window retry** re-dumps the tree once (after `ATLAS_AX_RETRY_DELAY_MS`, default 250 ms) when both AX tiers miss, since a freshly activated window's first dump is often incomplete (`ATLAS_NO_AX_RETRY`). The router does NOT execute the click — it returns a `ClickTarget` that the caller hands to `os_computer_action` with `coordSystem='screen'`.

#### Click memory (`click-memory.ts`)

Successful clicks (verified by `outcome-classifier.ts` — pre/post screenshot diff) write `{ app, window_title, instruction_hash, x_pct, y_pct, success_count, last_used_at }` to `data/click-memory.db`. On the next visit to the same app/instruction, tier 1 returns the recalled site in microseconds. Kill-switch: `ATLAS_NO_CLICK_MEMORY=true`.

#### Drift calibration (`drift-calibration.ts`)

Per-monitor affine correction. Every confirmed click contributes a sample; once a monitor has ≥ 10 samples the calibrator fits a 2D affine transform to correct systematic offset (DPI scaling, fractional zoom, multi-monitor boundaries). `applyCalibration(monitorId, x, y)` runs before every click. Kill-switch: `ATLAS_NO_DRIFT_CALIBRATION=true`.

#### AX walker (`ax-dump.ts`)

Cross-OS accessibility-tree dump:
- **macOS:** `scripts/dump_ax_bin` (Swift, `AXUIElement` API), built by `npm run build:helpers`
- **Windows:** UIA `IUIAutomation` via `dump_uia.ps1`
- **Linux:** AT-SPI helper (`dump_atspi.py`)

Helper scripts resolve through the bundle-aware `getScriptsDir()` / `resolveScript()` in `src/config/paths.ts`, because the packaged app is a single esbuild bundle (`bot-bundle.mjs`) whose `__dirname` is flat; the old resolver missed them and silently forced every click onto the slow vision path. Rows with empty labels (text lives in a child `AXStaticText`) get a label from `deriveLabelFromDescendants`, and `scoreText` is token-aware. A dump that was cut short (slow or hung app) sets `"partial": true` and is treated as an AX miss. Opt-in knobs: `ATLAS_AX_BATCH=true` (batched attribute reads, ~2–3.5× faster dumps; AXValue stays a per-node read so a secure field's value is never requested), `ATLAS_AX_MSG_TIMEOUT_MS=N`, and `ATLAS_NATIVE_AX=true` (Rust flatten/find, only worth it for very large trees — the TS default wins below ~200 nodes).

#### Primary GUI tool

`os_smart_click` (`src/tools/os-smart-click.ts`) is the agent's primary GUI interaction tool; the tool router prompt demotes coordinate-based legacy tools in its favor. A boot-time permission probe ensures macOS Accessibility / Windows UIA / Linux AT-SPI access is granted before the agent tries to use it.

On each call it **activates the target app**, then **re-captures a fresh screenshot at click time** — window-scoped via `screencapture -R` when the focused window's bounds are known (the cascade gets window-relative dims so scaling stays correct), else full-screen (`ATLAS_NO_WINDOW_SCOPED_CAPTURE`). A caller-passed `screenshot_base64` is only a last resort (`ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT=true` restores trusting it), because stale pixels caused misclicks.

**Post-click verification:** VISION-tier clicks are verified by capturing before/after and running `classifyOutcome`; `no_op` / `wrong_target` records a click-miss and returns `click_unverified` instead of a false success, then triggers one self-correcting re-ground that descends past the failed tier. A slow UI is no longer mistaken for a missed click and clicked twice. AX and memory tiers stay trusted. Disable with `ATLAS_NO_SMARTCLICK_VERIFY` / `ATLAS_NO_SMARTCLICK_SELFCORRECT`.

#### Agent cursor (`agent-cursor.ts`, `desktop/agent-cursor.js`)

When the desktop app spawned the bot, computer-use tools emit `##BHAI_CURSOR##{json}` stdout lines and the desktop draws a ghost cursor plus a "Bhai is in control" edge glow in click-through windows, one per display. Captures run inside `withCursorHidden()` (hide, ack ≤ 150 ms, capture, show). Not drawn on Linux; `ATLAS_NO_AGENT_CURSOR=true` disables it.

---

### 3.11 Coding Pipeline

**Directory:** `src/tools/coding/`, `src/agents/plan-mode.ts`

#### Complexity classification

Every coding request is classified on the first iteration:

| Level | Criteria | Behavior |
|-------|----------|----------|
| Trivial | Add log, rename, typo fix, bump version | No design docs, stays on Light tier |
| Standard | Direct implementation | Pro tier, straight to code |
| Complex | Refactor, new system, build verb + high-stakes domain, > 400 chars | Full 4-phase flow below |

#### Complex task flow

1. **Design docs** — `generate_design_docs` writes PRD.md + TECHNICAL.md + ARCHITECTURE.md under `Bhai Files/Documents/design-docs/<slug>/`. Auto-transitions to `awaiting_approval` state.
2. **Approval gate** — Write tools are blocked except in the design-docs directory. The agent calls `approve_design_docs({ user_quote })` when the user approves.
3. **Implement** — Standard coder loop on Pro tier. Git worktree isolation if `ATLAS_AGENT_WORKTREE=true` and ≥ 2 parallel coder steps.
4. **Walkthrough** — `demo_project` auto-detects stack, launches runtime, records screen, generates WALKTHROUGH.md via `git log` + `git diff`.

#### Supporting tools

- **LSP** (`lsp.ts`): `goToDefinition`, `findReferences`, `hover`, `documentSymbol`; auto-attached to edit results as `post_edit_diagnostics` unless `ATLAS_NO_POST_EDIT_DIAGNOSTICS=true`
- **Codebase index** (`codebase-index.ts`): Per-repo SQLite sidecar at `data/codebase-index/{hash}.db`; tree-sitter parses TS/JS by default (Python/Rust/Go gated behind `ATLAS_MULTI_TREE_SITTER=true`; a regex fallback covers 15 languages); BM25 FTS5 over symbol names; depth auto-picks: ≤500 files → call graph, ≤5000 → imports, else → symbols
- **git_op** (`git-op.ts`): 4-tier safety model — safe (status, commit, branch) / confirm (merge, cherry-pick) / destructive (reset, push) / blocked; protected branches `main`, `master`, `production`, `release/*`
- **Code critic** (`code-critic.ts`): compile (weight 0.4) + test (0.4) + lint (0.2) + SAST/Semgrep (0.15) + UI verify; fires in swarm synthesis for coder steps; 90s wall-clock budget

---

### 3.12 Deep Research Engine

**Directory:** `src/research/` (11 files)

A 3-phase background research loop that runs as a separate async task.

**Phase 1 — Discovery (40% of source budget):** Broad multi-engine search. Generates competing hypotheses (`hypothesis-engine.ts`) with Bayesian confidence updates. Each hypothesis has designed `searchFor` and `searchAgainst` queries.

**Phase 2 — Deep reading (40%):** In-depth page analysis. Fetches full content, extracts findings, follows `followUpQueries`.

**Phase 3 — Verification (20%):** Cross-references findings. `crossReferenceFindings()` assigns confidence: strong (≥2 sources), moderate (1), weak (0).

**Search engines** (13, queried in parallel and merged): Parallel (first; AI-optimized, dated pages with excerpts, proxied through Convex), Tavily, Exa, Bing, SearXNG, Brave, DuckDuckGo, Wikipedia, Google (Playwright-based, may be blocked), Mojeek, plus Semantic Scholar, arXiv and OpenAlex when the academic profile is on. The lighter `web_search` tool uses a fetch-only subset (Parallel, Claude, Tavily, Exa, Brave, DuckDuckGo, Bing); its Google scraper was dropped because google.com/search now serves a JavaScript-only page, and one stalled engine no longer sinks the whole search.

**Engine health:** Exponential backoff on failures: 15s → 30s → 60s → 120s → 240s (5 min cap). Failed engines are bypassed automatically.

**Source ranking** (`scoring.ts`): Weighted score = domain quality (0.25) + finding density (0.22) + content depth (0.18) + credibility (0.12) + recency (0.13) + citation count (0.10).

**Credibility model** (`credibility-model.ts`): Bayesian per-domain credibility (default 0.5). Confirmed claims → score toward 0.6; contradicted → toward 0.4. Backed by native Rust for fast updates.

**Cap:** 1000 findings maximum (trimmed by length). Results saved to `data/research/` as markdown.

**Hypothesis engine** (`hypothesis-engine.ts`): Generates competing hypotheses before searching. For a question like "is X causing Y?", the engine generates:

- **H1:** X causes Y directly
- **H2:** Y causes X (reverse causation)
- **H3:** Z causes both X and Y (confounder)
- **H4:** X and Y are uncorrelated (null hypothesis)

Each hypothesis gets Bayesian confidence updates based on found evidence, with `searchFor` and `searchAgainst` queries to avoid confirmation bias.

**Fetch and extraction** (`fetcher.ts`): Tiered fetch pipeline:

1. **Simple HTTP** for static pages (cheap, fast)
2. **Playwright rendering** for JS-heavy pages (slower, more expensive)
3. **Mozilla Readability** for article extraction
4. **unpdf** for PDF text extraction
5. **Cheerio** for DOM querying

**Persistence** (`persistence.ts`): Research runs are saved incrementally (every 10 findings) so a crash or session restart doesn't lose work. Each run gets a unique ID and is stored at `data/research/<id>/`:

- `query.txt` — original query
- `findings.json` — all findings with metadata
- `report.md` — final synthesized report
- `sources.json` — source credibility scores
- `timeline.json` — event log with timestamps

**Research profiles** (`profiles.ts`): Pre-configured search strategies for domains (`academic`, `news`, `technical`, `commercial`, `adversarial`). Each profile pre-weights search engines and sets domain filters.

**Analysis engine** (`analysis.ts`): Post-research analysis includes bias detection (one-sided evidence), gap identification (questions the research didn't answer), and follow-up suggestion.

---

### 3.13 Proactive Engine

**Directory:** `src/proactive/` (60 files)

Bhai can send messages without being prompted. The proactive system runs on three levels:

**Heartbeat** (`heartbeat.ts`): Fires on a configurable interval. Checks battery, CPU, network, disk. Sends morning briefing (random time 6–10 am). Triggers inner-thoughts, monitors, and dreaming checks.

**Dreaming** (`dreaming.ts`): When the user has been idle 2+ hours during 11 pm–6 am:
1. Memory consolidation (DreamReplay + SleepGate conflict detection + relationship decay)
2. Harvest pending tasks from conversation (LLM scans for unanswered questions, follow-ups)
3. Execute tasks via sub-agents (max 3 tasks, 10 min each, 30 min total budget)
4. Propose self-edits if ≥2 recent failures
5. Queue results for morning delivery

**Observer pipeline** (`observer.ts`, `composer.ts`, `dispatch.ts`): Intent sources → Observer queue → Composer (template fast-path or LLM fallback with Haiku) → Dispatch (kill-switch gates → channel sender).

**Postures** (per channel, configurable via `data/proactive-config.json`):

| Posture | Max/day | Min gap | Heartbeat interval | Boundary only |
|---------|---------|---------|-------------------|---------------|
| calm | 3 | 120 min | 120 min | yes |
| active | 8 | 45 min | 60 min | no |
| ambient | 1 | 360 min | 240 min | yes |

Defaults: Telegram = active, WhatsApp = calm, Overlay = ambient, Discord/Slack/Matrix/Email = calm.

**Kill-switches:** `ATLAS_PROACTIVE_DISABLE` (global off), `ATLAS_PROACTIVE_DISABLE_SOURCES` (CSV list of sources), `ATLAS_PROACTIVE_DISABLE_CHANNELS` (CSV list), `ATLAS_PROACTIVE_SHADOW` (compose + log but never send).

Other guardrails: "shut up" mutes proactive messages until "resume" (kept across restarts, and no raw pushes slip past it); the daily message cap resets at the owner's local midnight and daily counts and sent topics survive a restart; the morning briefing goes out as one message; alert floods are collapsed.

**Rust scheduler** (`proactive_scheduler.rs`): Intent queue per channel with priority formula: `base × freshness × posture_weight × source_weight`. Urgent=100, normal=10, ambient=1 base. Freshness decays exponentially.

**Intent sources** (`src/proactive/intent.ts`):

| Source | What it watches |
|--------|-----------------|
| `latent_topic_monitor` | Topics the user has mentioned being interested in — signals when new relevant info appears |
| `memory_anticipation` | Memories with upcoming relevance (birthday tomorrow, expiring subscription) |
| `calendar_fact_check` | Upcoming calendar events — cross-references against stored facts to flag conflicts |
| `calendar_fusion` | Merges multiple calendar sources, detects double-booking |
| `stale_todo` | Todo items past their expected completion date |
| `meeting_followup` | After a meeting ends, suggests follow-up actions |
| `habit_anomaly` | Pattern break (e.g. user hasn't done their morning run for 3 days) |
| `env_context` | Environment signals (weather change, battery low, DND expiring) |
| `long_task_status` | Long-running tasks hitting milestones |
| `convex_notification` | Server-pushed notifications (credit low, account status change) |
| `onboarding_graduation` | Day-2/3/5 post-install nudges that graduate a new user from the wizard into everyday use (`ATLAS_NO_ONBOARDING_NUDGES` to disable) |

**Composition fast-path** — for template-friendly intents (low-novelty, high-frequency), the Composer uses a pre-written template with variable slots rather than calling the LLM. This cuts composition latency from ~800ms (LLM) to ~5ms (template) for the most common proactive messages. LLM fallback fires for high-novelty intents.

**Post-filters:** every composed message runs through banned-phrase and third-person filters before dispatch — prevents "As an AI assistant" style bot-speak and enforces first-person framing.

**Mode emoji prefix** — proactive messages prefix a mode indicator: 💡 for `fyi`, ❓ for `question`, ✅ for `review`. This lets users visually distinguish proactive from responsive messages.

---

### 3.14 Video Studio

**Directory:** `src/video-studio/` (25 files), `src/tools/video-studio.ts`

A complete AI-guided video editing pipeline.

**Workflow:**
1. `video_create_project` — copies input files to `data/video-projects/vid_YYYY_MM_DD_NN/inputs/`; SHA-256 integrity hashes stored
2. `video_analyze` — scene detection, keyframe captioning, Whisper transcription, face tracking, beat detection (Python sidecar)
3. `video_plan_edit` — LLM (Sonnet) generates a structured `EditPlan` in 2 passes with Zod validation
4. `video_render` — compiles the plan to FFmpeg filter graph; handles trim, scale, fade, overlays, transitions, audio mixing
5. `video_patch_plan` — RFC 6902 JSON Patch for incremental plan edits (replace/add/remove)
6. `video_ffmpeg` — raw FFmpeg escape hatch with security validation (no URL schemes, no path traversal, outputs restricted to `/tmp` or `data/video-projects/`)
7. `video_search_broll` — searches Internet Archive or Pexels (if `PEXELS_API_KEY` set)

**EditPlan schema** (`plan/schema.ts`): Includes output (aspect ratio 16:9/9:16/1:1/4:5, fps, resolution), sources with durations, video tracks (crop `auto_face` or `W:H:X:Y`), audio tracks (volume dB, beat sync, ducking), overlays (captions, text, stickers), transitions (xfade or cut).

**Effects:** `bg_replace:<path>` (downloads ~400 MB BiRefNet model), `color_grade:warm|cool|vintage|mono`, `stabilize`, `stylize:<preset>`.

**Python sidecar:** Beat detection, background matting, face tracking, and fast Whisper transcription run via Python scripts in `src/video-studio/python/`, called as child processes.

**EditPlan validation pipeline** (`plan/schema.ts`):

1. **Zod schema** — first validation pass; rejects plans with invalid types, missing required fields, out-of-range values
2. **Constraint checks** — referential integrity (all `source` IDs in tracks must exist in `sources[]`), non-overlapping video segments, audio volume sanity
3. **Duration check** — ensures `out > in` on every track, and that out values don't exceed the source's `duration`
4. **Overlay bounds** — overlay `from < to`, both within the output duration

A `validateEditPlan()` helper returns `{ ok: true, plan }` or `{ ok: false, errors: string[] }` with human-readable error messages.

**Output targets:**

| Target | Format | Notes |
|--------|--------|-------|
| `mp4` | H.264 + AAC | Direct render via FFmpeg |
| `fcpxml` | Final Cut Pro XML | For hand-tuning in NLE |

**Aspect ratios:** `16:9` (YouTube/TV), `9:16` (TikTok/Reels/Shorts), `1:1` (Instagram feed), `4:5` (Instagram portrait).

**Overlay types** (discriminated union):

| Type | Fields |
|------|--------|
| `captions` | style, highlight_color, position, font_family/size |
| `text` | content, font color/family/size, box color, x/y |
| `sticker` | asset path, scale, x/y |

**Transition types:** `xfade` (crossfade between clips, configurable duration), `cut` (hard cut).

---

### 3.15 Meta-Harness Optimizer

**Directory:** `src/harness/` (17 files)

An automated outer-loop optimization system (based on arxiv 2603.28052) that treats Bhai configuration as a tunable parameter space and evolves it automatically.

**30+ tunable dimensions** (defined in `registry.ts`):

| Dimension | Default | Range |
|-----------|---------|-------|
| `memory.fusion.relevanceWeight` | 0.5 | numeric |
| `memory.fusion.recencyWeight` | 0.25 | numeric |
| `memory.san.weight` | 0.3 | numeric |
| `memory.hopfield.weight` | 0.15 | numeric |
| `memory.recall.k` | 10 | 3–50 |
| `memory.crossEncoder.blend` | 0.6 | numeric |
| `agent.contextCap` | 8000 | 2000–20000 |
| `evaluator.acceptThreshold` | 70 | 50–95 |
| `swarm.multiCriticThreshold` | 60 | 30–90 |
| `toolRouter.maxToolsTotal` | 36 | 10–80 |
| `research.discoveryPhaseRatio` | 0.4 | numeric |
| Sub-agent role system prompts | (defaults) | string |
| … and 20+ more | | |

**Optimization loop** (`optimizer.ts`):
1. **Phase 0:** Initialize 4 seed configs in parallel (baseline, memory-aggressive, tool-conservative, evaluator-strict)
2. **Phase 1 (per iteration):**
   - NSGA-II parent selection from Pareto frontier
   - Optionally generate TextGrad dimension critiques (if last candidate regressed ≥2 points)
   - Propose changes via **filesystem-agent** (code-proposer reads raw trace files — not summaries — giving 50% vs 34.9% accuracy per the paper ablation)
   - Validate code patches (static safety gates: no `eval`, no network, no destructive fs outside `data/harness/`)
   - GP surrogate pre-screening: skip evaluation if upper-confidence-bound < `best - 5`
   - Evaluate candidate (35% task + 25% memory + 25% tool + 15% token efficiency)
   - Update Pareto frontier; apply if improvement, revert if regression

**Multi-objective tracking** (`pareto.ts`): 4 objectives — task score (0–100), token efficiency (0–1), memory precision (0–1), tool accuracy (0–1). NSGA-II front peeling + crowding distance for selection diversity. Hypervolume approximation for frontier improvement detection.

**Trace store** (`trace-store.ts`): Every agent invocation is traced (tools selected, context sources, memory hits, evaluation score, duration). Traces are written per-candidate to `data/harness/runs/<run_id>/candidates/<id>/traces/*.json` for the filesystem-agent proposer to read directly.

**Run storage layout:**
```
data/harness/runs/<run_id>/
├── run_config.json
├── indexes/leaderboard.json
└── candidates/
    ├── c0000/            ← baseline
    │   ├── manifest.json
    │   ├── scores.json
    │   ├── traces/
    │   └── .metaharness/
    └── c0001/...
```

Active config is persisted to `data/harness/active/harness-config.json` and loaded at boot.

**Entry command:** `/optimize-harness` slash command triggers the optimizer. Parameters:

- `budget` — maximum LLM spend in credits (default 10)
- `iterations` — max optimization iterations (default 20)
- `parallel` — parallel candidate evaluations (default 2)
- `seedDir` — initial candidate pool (default: 4 hand-crafted seeds)

**TextGrad critique** (`textgrad-refiner.ts`): When a candidate regresses, the optimizer asks the LLM to critique each dimension individually: "the `memory.recall.k` was set to 30 in this candidate — was that too aggressive? Too conservative? Just right?" The aggregated textual gradient is fed back to the proposer to guide the next proposal.

**Filesystem-agent proposer** — rather than feeding summary statistics to the LLM proposer, the optimizer gives it a filesystem of raw trace JSON files and lets it read them directly. The paper (arxiv 2603.28052) shows this improves proposal accuracy from 34.9% → 50%. The proposer sub-agent is restricted to read-only filesystem tools within the run directory.

**Safety gates** — before applying a candidate config, the optimizer runs static safety checks:

- No `eval` or `Function()` constructor
- No outbound network calls from modified code
- No filesystem writes outside `data/harness/`
- Type-checks pass (`tsc --noEmit`)
- Linter passes (`biome check`)

Candidates that fail safety gates are marked `scope-violation` and discarded without evaluation.

**Leaderboard** — `data/harness/runs/<run_id>/indexes/leaderboard.json` tracks the top-10 candidates by composite score, updated after every evaluation. The harness CLI can query the leaderboard to apply the current best config to production.


### 3.16 Voice Subsystem

**Directory:** `src/voice/` (22 files, incl. `live/` with 19)

**Transcription** (`transcribe.ts`, `telegram-voice.ts`): local Whisper (OpenAI `whisper-1` or Groq `whisper-large-v3-turbo`) when an `OPENAI_API_KEY` / `GROQ_API_KEY` is configured; otherwise the server transcribes via `/api/stt` (`convex/stt.ts`), so a fresh install needs no voice key. It throws `STT_NOT_CONFIGURED` when neither can. `transcribeAudio()` and `transcribeBuffer()` variants both supported.

**TTS** (`tts.ts`, `elevenlabs.ts`): provider order is `ATLAS_TTS_PROVIDER` → `ELEVENLABS_API_KEY` → `OPENAI_API_KEY` → none. OpenAI `tts-1` (default voice `nova`; also `alloy`, `echo`, `fable`, `onyx`, `shimmer`) and ElevenLabs as paid premium. Output format: Opus. For local-only operation, `voice/live/kokoro-tts.ts` runs Kokoro TTS in-process via `kokoro-js` — zero API cost, fully offline.

**Live voice mode** (`live/`): Streaming bidirectional voice with tool calling. The subdirectory contains the backend abstractions, audio pipeline (`audio/`), screen-share streaming, transcript speaker, memory bridge, tool bridge, and prompt builder.

| Backend | Protocol | Notes |
|---------|----------|-------|
| `gemini-live.ts` | `@google/genai` SDK, `Modality.AUDIO` | Model chain: gemini-2.5-flash-native-audio-latest → preview-12-2025 → preview-09-2025 → 3.1-flash-live-preview |
| `openai-realtime.ts` | WebSocket `wss://api.openai.com/v1/realtime` | Model: gpt-4o-realtime-preview |
| `hybrid-pipeline.ts` | STT → agent → TTS pipeline | Fallback when streaming backends unavailable; uses Kokoro TTS for fully local operation |

**Barge-in / VAD:** Hybrid mode uses an RMS-amplitude gate by default. Setting `ATLAS_NATIVE_VAD=true` routes barge-in through `native/src/pcm_vad.rs` (libfvad-backed; requires the native binary built with cargo feature `vad`). Aggressiveness is controlled by `ATLAS_VAD_MODE=0..3` (0 = quality / 3 = very aggressive, fewer false positives; default 2). libfvad classifies the signal spectrum so background noise and music false-positive far less than the RMS gate. Native Gemini Live and OpenAI Realtime backends use server-side VAD and ignore this knob.

Voice-safe tools (allowed during live sessions): `spotify`, `music_control`, `set_volume`, `shell_exec`, `apple_script`, `web_search`, `get_current_time`, `memory_store`, `memory_search`, `schedule_task`, `set_reminder`, `read`, `write`, `send_file`.

Live voice config: `LIVE_VOICE_NAME` (Gemini voices: Aoede/Charon/Kore/Fenrir/Puck; OpenAI: alloy/shimmer/echo), `LIVE_VOICE_BACKEND` (`gemini-live` / `openai-realtime` / `hybrid`).

---

### 3.17 A2A Protocol

**File:** `src/agents/a2a.ts`

Bhai implements Google's Agent-to-Agent (A2A) protocol, which enables external systems to discover and delegate tasks to Bhai.

**Agent Card** (published at `/.well-known/agent.json`):
```json
{
  "name": "Bhai",
  "version": "0.2.1",
  "capabilities": ["research", "coding", "browser", "system", "memory"],
  "endpoint": "http://127.0.0.1:18792/a2a",
  "maxConcurrentTasks": 5
}
```

**Task lifecycle:** `pending` → `in_progress` → `completed` / `failed` / `cancelled`. Tasks auto-expire after 1 hour. Max 5 concurrent tasks.

**Agent-as-tool pattern:** Any A2A agent can be wrapped as a `delegate_to_{name}` tool and called from within Bhai's own agent loop.

**HTTP routes:**
- `GET /.well-known/agent.json` — agent discovery
- `GET/POST /a2a/tasks` — list / create tasks
- `GET /a2a/tasks/:id` — task status
- `POST /a2a/tasks/:id/cancel` — cancel task

---

### 3.18 Communication Channels

| Channel | Library | Notes |
|---------|---------|-------|
| Telegram | grammY ^1.35 | Owner ID allowlist; voice/image/video extraction; Markdown→HTML; one-tap bot creation (§3.8); stuck-report buttons |
| Discord | discord.js ^14 | Text; message content intent |
| Slack | @slack/bolt ^4.7 | Socket Mode |
| Matrix | matrix-js-sdk | Federated messaging |
| WhatsApp | @whiskeysockets/baileys ^7 | 4 identity tiers (owner/contact/unknown/group); persona system; rate limit 50/hr, min 2s interval |
| Email | IMAPFlow + Nodemailer | Own address `<name>.bhai@…` (§3.8), or the owner's own IMAP/SMTP account with a sender allowlist |
| Canvas | ws (WebSocket) | Port 18791 on `127.0.0.1`; CanvasWidget types: html/chart/table/form/markdown |
| Web Widget | Inline IIFE | Served at `/widget.js`; `?token=` auth; 56 px bubble, 350×500 window; visitors are guests and the widget cannot screenshot |
| Desktop | Electron overlay | Panel at `http://127.0.0.1:18792`; Chrome extension bridge on `:18800`. Always on, so it has no card on the Channels page |

**Setup flows** (desktop Channels page, `desktop/components/channel-card.js`): a passing token check saves the channel and restarts Bhai by itself (no Save & Apply); the first connected channel becomes Primary, and switching a channel off applies at once. Telegram: one-tap managed bot, otherwise a pasted token (checked on paste; "say hi" to the bot fills the user ID). Discord: invite button, owner ID filled from the app, Message Content intent check. Slack: one link creates the app from a prefilled manifest. Email and Matrix: one screen; email does a real IMAP sign-in. WhatsApp (`desktop/setup/whatsapp-pair.js`): scan a QR in the wizard or Channels page, then the owner step shows a QR / `wa.me` link with the one-time code typed in — tap Send. Copied tokens on the clipboard fill in automatically (only text shaped like that token is handed over).

**Non-owners:** contacts, guests and email senders get their own conversation and the `NON_OWNER_TOOLS` allowlist, never the owner's chat, memories or Settings tone.

**WhatsApp groups:** Auto-approve if owner added; otherwise notifies owner with approve/decline prompts. Response gating: skip if < 30s since last send or bot share > 15% of total messages; then Haiku yes/no decision. The persona's anti-impersonation rules are hard-coded in `whatsapp.ts`, not in the persona.

---

### 3.19 Desktop App (Electron)

**Directory:** `desktop/`

Cross-platform Electron app (macOS + Windows, Electron ^42) with:

- **Panel pages** (`desktop/panel.html`): Dashboard, Chats, Channels, Store, Vault, Account and Settings; Memory (the Memory Studio graph viewer) opens from Settings. **Settings** saves by itself, has search, shows what is really connected, and holds personality (pills: casual_playful, professional_concise, warm_supportive, direct_terse, unhinged — 18+, owner-only), hotkey, theme, voice, an update channel (Advanced) and Data & privacy; About is folded in. **Account** has a real Devices list (§3.8). **Vault** (`desktop/vault-store.js`) is the owner's saved logins, API keys, cards and UPI IDs (§5.12); showing, editing or deleting an entry asks for Touch ID, once per entry per minute.
- **Overlay panel:** the single Electron overlay window (served from `src/overlay/overlay.html` + `overlay-chat.ts`); the former native Swift `overlay-app/` is gone. It floats on top of all windows and connects to the Bhai overlay WebSocket, authenticated by a `?localToken=` gate exchanged through a discovery-first handshake. It says so when a message can't be sent because Bhai isn't connected.
- **Agent cursor** (`desktop/agent-cursor.js`): ghost cursor and edge glow while Bhai drives the screen (§3.10).
- **Auto-updater:** `electron-updater`; provider = generic; update metadata served from Convex (`/api/updates/latest-mac.yml`, `/latest.yml`); a quiet update check, with an update-channel option in Advanced.
- **Source protection:** Bytecode compilation via `bytenode`; runtime XOR key fetched from Convex `/api/app/runtime-key`; `.env.enc` encrypted with the runtime key
- **Session management:** Session token cached in Electron `safeStorage` with 1-hour refresh before expiry
- **Setup wizard:** `desktop/wizard/` — first run is three screens: sign in (terms clickwrap inline) → connect Chrome (setup installs in the background meanwhile, `desktop/installer/`) → the Ready Hub, where permissions live and suggestions are ranked from a live snapshot of the user's running apps (`magic-moment-ranker`). Name, persona, hotkey, theme and voice have defaults and live in Settings. Persona seeds the prompt layer (`src/prompts/persona-bias.ts`) and onboarding graduation nudges (Day-2/3/5) follow via the proactive engine.
- **Chrome extension bridge:** companion MV3 extension (`chrome-extension/`) with the `nativeMessaging` permission; it asks the native host for the bridge token first and falls back to the loopback `/discover` endpoint (§3.9). Service worker with heartbeat.
- **Store IPC:** Desktop store install/uninstall routes through the authenticated Convex proxy rather than calling the store backend directly.

**Build targets:**
- macOS: DMG via `create-dmg.sh` (`npm run build:mac`)
- Windows: NSIS installer (`npm run build:win`)

---

### 3.20 Marketing Brain

**Directory:** `src/marketing/` (29 files)

A full content-marketing automation system for agencies and personal brands.

**Platforms:** Instagram, LinkedIn, TikTok, X (Twitter), Facebook, YouTube, Reddit, Product Hunt (9 platforms).

**Core workflow:**
1. `brand_audit` — scrapes website, analyzes social profiles, researches competitors
2. `campaign_plan` — generates content pillars, weekly cadence, platform calendar
3. Script writer — duration-aware scripts (Instagram 30s, TikTok 45s, YouTube Shorts 60s) with hook + scenes + hashtags
4. Video pipeline — uses Video Studio to generate clips; `video_plan_edit` → `video_render`
5. Social posting — `social_post` tool; platform adapters with rate limits (Instagram 25/24h, TikTok 15/24h, etc.)
6. Outreach engine — Apollo.io + Hunter.io for leads; email via Hostinger SMTP; Twitter DM (Pro tier)
7. Trend researcher — Apify `instagram-hashtag-scraper` + `clockworks/tiktok-scraper`

**Content calendar:** Stored in `marketing_calendar` SQLite table; statuses: draft → pending_approval → approved → scheduled → posted / failed.

**Credential storage:** Platform tokens stored as env vars (`IG_ACCESS_TOKEN_<brandId>`, `LI_ACCESS_TOKEN_<brandId>`, etc.) and managed via `credential-manager.ts`.

**Lead finding** (`outreach-engine.ts`, `lead-finder.ts`):

1. **Search Apollo.io** for people matching job-title + industry + location filters
2. **Verify emails via Hunter.io** — rejects role-based (`info@`, `support@`) and unverifiable addresses
3. **Enrich with LinkedIn data** (Phantombuster — optional, ToS risk)
4. **Segment into campaigns** — ICP scoring, persona tagging
5. **Draft personalized outreach** — LLM-written cold emails with context from the lead's profile
6. **Send via Hostinger SMTP** (bulk-safe, low deliverability risk) or platform DM

**Rate limits per platform** (conservative defaults):

| Platform | Cap | Window |
|----------|-----|--------|
| Instagram | 25 posts | 24 hours |
| TikTok | 15 posts | 24 hours |
| YouTube Shorts | 10 | 24 hours |
| X (Twitter) | 50 posts, 1000 DMs | 24 hours |
| LinkedIn | 20 posts | 24 hours |
| Reddit | 10 (tracks karma/age) | 24 hours |
| Facebook | 20 posts | 24 hours |
| Product Hunt | 1 launch | per product |

**Trend research** (`trend-researcher.ts`): Uses Apify actors (`instagram-hashtag-scraper`, `clockworks/tiktok-scraper`) to pull top-performing content for given hashtags/keywords. Output is distilled into content ideas via the script writer LLM.

**Brand audit** (`brand-audit.ts`): Scrapes the user's website + social profiles + competitors, runs an LLM analysis for voice-of-brand, positioning gaps, and competitive differentiation. Output: a `BrandAudit` JSON blob with strengths/weaknesses/opportunities/threats.

**Campaign planner** (`campaign-planner.ts`): Given a brand audit and a marketing goal (awareness/leads/sales), generates a weekly calendar with:

- Content pillars (3–5 themes)
- Per-day platform mix (e.g. Mon=IG Reel + X, Tue=LinkedIn post, Wed=TikTok, etc.)
- Draft hooks and scripts for the first week

**Product Hunt launch** (`product-hunt.ts`): End-to-end launch automation — teaser posts, hunter outreach, launch-day crew coordination, comment monitoring, post-launch analytics.

---

## 4. Data Flow

### Inbound message (Telegram example)

```
User sends message on Telegram
    │
    ▼
telegram.ts: sender ID allowlist check → extract media (voice/image/video)
    │
    ▼
runAgent(llm, message, onProgress, media)
    │
    ├─ [First iteration] 12 memory systems fire in parallel
    │       identity + traits + session + emotional + episodic + relationship
    │       + anticipation + core memory + HNSW recall + task learnings + KG + self-state
    │       → inject ~2-3K tokens of context
    │
    ├─ chooseModel() → Rust router → model + thinking level
    │
    ├─ tool-router: embed query → cosine similarity → load top-K tool schemas
    │
    ├─ encryptedFetch() → POST /api/llm/chat on Convex
    │       → Convex: decrypt request → assemble system prompt → translate to the Claude Messages API
    │       → Claude (Haiku / Sonnet / Opus) → response
    │       → Convex: deduct credits → encrypt response → return
    │
    ├─ parse tool calls → execute in parallel (except browser + screen-driving tools: sequential)
    │       each tool result → feed back into messages array
    │
    ├─ check finish_reason / TASK_COMPLETE → loop or exit
    │
    └─ [After session] runReflection() → SAC-DR → embed conversation → store
    │
    ▼
smartChunkMessage() → Markdown→HTML → send via Telegram API
```

### Credit flow

```
User message → account guard checks local cache
    → if stale: GET /api/account/status on Convex
    → Convex: validateSession → return {credits, status}
    → block if credits < minimum threshold
    → on LLM call: Convex deductCredits() atomically (OCC-serialized)
    → local balance cache updated
```

---

## 5. Security Architecture

Security is defense in depth. Even if any single layer fails, the next layer contains the blast radius.

### 5.1 End-to-End Encryption (Application Layer)

Every LLM call is encrypted at the application layer on top of HTTPS:

**Step 1 — Session setup (ECDH P-256):**
```
Client:  _ecdh.generateKeys()  → pubKey_C  (base64)
         POST /api/auth/session { pubKey: pubKey_C }
Server:  _ecdh.generateKeys()  → pubKey_S
         shared = _ecdh.computeSecret(pubKey_C)
         returns { pubKey: pubKey_S, token, sharedKey_id }

Both:    salt = b"atlas-e2e-salt"
         info = b"atlas-e2e-aes256-key|" + pubKey_C + b"|" + pubKey_S   ← binds both public keys
         key  = HKDF-SHA256(shared, salt, info, 32 bytes)   ← 256-bit AES key
                (legacy v1 sessions used SHA-256(shared || salt || info))
```

**Step 2 — Per-request envelope (AES-256-GCM):** the AAD (`METHOD|path|ts|rid`) is bound to the GCM tag, so a captured envelope cannot be replayed against another route or have its `ts`/`rid` rewritten on the wire.
```
envelope = {
  iv:  random 12 bytes (base64)
  ct:  AES-256-GCM ciphertext (base64)
  tag: 16-byte auth tag (base64)
  ts:  Unix ms timestamp
  rid: random request id (prevents replay within 90s window)
}
```

**Step 3 — Replay protection:** server rejects any request whose `ts` is outside the ±90-second window. The `rid` is tracked server-side to catch duplicates within that window.

**Step 4 — Response encryption:** the server encrypts the response with the same derived key before returning. The client verifies the auth tag and decrypts before parsing.

API keys (Claude, Azure, speech-to-text, search, voice, Apify, Apollo, Hunter, CAPTCHA services, etc.) live only in Convex environment variables. They are never sent to the client in any form.

### 5.2 Docker Sandbox

Untrusted code execution (shell tools with unknown payloads, tool fabricator sandbox tests, `code_execute` from the code-action agent) runs in a tightly constrained Docker container:

| Setting | Value |
|---------|-------|
| Base image | `node:20-alpine` |
| Memory limit | 256 MB |
| CPU quota | 50% (`CpuPeriod=100000`, `CpuQuota=50000`) |
| Network mode | `none` (no outbound connections at all) |
| AutoRemove | `true` |
| Default timeout | 30 seconds |
| Read-only root filesystem | yes |
| Dropped capabilities | ALL |
| Work directory | `/sandbox` mounted tmpfs |

The sandbox is disabled entirely if the Docker daemon is not available — `src/security/sandbox.ts` falls back to refusing untrusted execution rather than running it unsandboxed.

### 5.3 Protected Paths & Destructive Command Allowlist

`src/security/allowlist.ts` blocks any shell command whose pattern matches:

- Recursive root delete (`rm -rf /`, `rm -rf /*`, `rm -rf ~`)
- Disk wipe utilities (`diskutil eraseDisk`, `format C:`, `mkfs.*`)
- Raw block device writes (`dd of=/dev/disk0`, `dd of=/dev/sd*`)
- Fork bombs (`:(){ :|:& };:`, `perl -e 'fork while 1'`)
- Power/reset (`halt`, `shutdown`, `reboot`, `init 0`)
- Destructive writes to Bhai's own installation directory

Bhai's own data directory (`data/`, `dist/`, `src/`, `native/`) is also protected from self-modification unless the user explicitly opts in.

### 5.4 Secrets Storage

Provider and service keys are never on the client: they live only in Convex env. The owner's own secrets (logins, API keys, cards, UPI IDs) live in the desktop vault, encrypted with Electron `safeStorage` (Keychain / Credential Manager) in `vault.enc`, and are handed to the bot over its stdin pipe at spawn and on every edit — held in memory only, never written to disk by the bot and never sent to Convex. See §5.12.

### 5.5 Rate Limiting

Convex enforces a sliding-window rate limit on the `/api/llm/chat` endpoint: **60 requests per 60-second window per session token**. Violations return HTTP 429 with a `Retry-After` header.

Client-side, individual tools also self-rate-limit to prevent single-tool storms (e.g. `web_search` is capped at 30 calls per minute).

### 5.6 Session Security

- **Tokens:** 256-bit cryptographically random hex strings (generated via `crypto.randomBytes(32).toString('hex')`)
- **TTL:** 24 hours, refreshable by calling `/api/auth/refresh` up to 1 hour before expiry
- **Device fingerprint binding:** optional; when enabled, a session token can only be used from the device that created it
- **Revocation:** all sessions for a user can be revoked with a single call to `/api/auth/revoke?all=true`
- **Timing-safe comparison:** `timingSafeCompare()` is used for key validation to prevent timing attacks
- **Secure storage:** on desktop, session tokens are cached in Electron `safeStorage` (Keychain on macOS, DPAPI on Windows)

### 5.7 Threat-Pattern Library & Prompt-Injection Defense

`src/security/threat-patterns.ts` is a centralized scanner (`scanForThreats`) for prompt-injection, data-exfiltration, and bidirectional-text (bidi) spoofing patterns. It feeds two places: the memory write value-gate (untrusted content is screened before it can be persisted) and untrusted tool-result handling.

- **Untrusted-result fencing** — tool results from untrusted surfaces (fetched web pages, MCP outputs) are wrapped in an explicit fence before reaching the LLM, so injected "ignore previous instructions" payloads are framed as data, not instructions. Disable with `ATLAS_NO_UNTRUSTED_WRAP`; disable the scan with `ATLAS_NO_THREAT_SCAN`.

### 5.8 Outbound URL Guard (SSRF / Metadata Floor)

`src/security/url-safety.ts` validates every outbound URL the agent fetches against an SSRF guard: it blocks private/loopback/link-local ranges and the cloud-metadata floor (`169.254.169.254` and peers) so a coerced fetch can't reach internal services or instance credentials.

### 5.9 Supply-Chain: OSV Malware Check

Before installing an MCP package, `src/security/osv-check.ts` queries OSV for known-malware advisories (`MAL-*`) and refuses install on a hit. `src/security/skill-scanner.ts` similarly scans sideloaded skills. Disable with `ATLAS_NO_OSV_CHECK`.

### 5.10 Secrets Sanitizer (Outbound)

`secrets-sanitizer.ts` (native default-ON, `ATLAS_NO_NATIVE_SANITIZER` to force TS) scans every tool result for credentials before it reaches the LLM — API keys, tokens, **DB connection strings and URL userinfo passwords** (`postgres://user:pass@…` → redacted). Its regexes are linear-time (no backtracking blow-ups; `redos.test.ts`). `credential-mask.ts` masks credentials by structure rather than by ordinary words, `log-redaction.ts` runs every console line through the sanitizer (imported first by `src/index.ts`), and `sensitive-paths.ts` enumerates path patterns that must never be read into context.

### 5.11 Other Security Measures

- **Dangerous tool gating:** tools with `requiresConfirmation: true` (delete, format, send_email, git push --force) are held by `human-interrupt.ts` for user approval; default 5-minute timeout with configurable default action
- **Write-path gating in plan mode:** `edit` and `write` tool paths are runtime-validated against the active plan-mode state (`plan`, `spec`, `awaiting_approval`, `awaiting_dynamic_tool_approval`) — not just prompt-enforced
- **Skill Forge kernel sandbox:** persisted dynamic tools execute in OS-isolated child processes (macOS sandbox-exec, Linux seccomp + Landlock + netns, Windows AppContainer + JobObject) with a three-strike auto-archive on capability violations — see §3.7 and the Forge spec
- **MCP tool vetting:** external MCP server tool schemas are validated against a JSON Schema before being exposed to the LLM
- **Audit log:** every tool call is appended to `data/audit.jsonl` with timestamp, tool name, args (redacted), and outcome; HMAC-signed on reflection events for tamper detection
- **Consent gate for irreversible actions** (`src/security/consent.ts`): deleting files, emptying Trash, dangerous shell commands, checkout and payments are refused the first time and recorded as pending; the call is allowed only when it comes back with `confirmed: true` after the owner sent a *new* message that reads as a yes. A flag the model sets on its own (say, because a web page told it to) is never enough, and autonomous runs (scheduled tasks, swarms) cannot confirm.
- **Local servers:** the overlay (`:18792`) and Chrome bridge (`:18800`) reject non-loopback `Host` headers (DNS-rebinding guard, `loopback.ts`), accept only Bhai's own extension origin (`extension-origin.ts`), and OAuth callback servers listen on loopback only with a random `state` that is checked and page output escaped (`oauth-state.ts`).
- **Owner vs. non-owner:** contacts, guests and email senders get `NON_OWNER_TOOLS` only (`tool-access.ts`) and their own conversation; LLM-written JS runs in a fresh `vm` context with no host-realm objects (`vm-isolate.ts`).

### 5.12 Secrets Vault & PII Handling

**Vault** (`src/security/vault.ts`, `src/tools/vault.ts`, `desktop/vault-store.js`): the agent *uses* the owner's saved secrets but never *sees* them.

- The model sees labels (`vault_list`) and writes tokens like `{{vault:<id>.password}}`. `resolveVaultArgs()` swaps a token for its value in the typing tools only, at the moment they run.
- **Login / API-key tokens are domain-locked:** they resolve only on an https page on one of the entry's domains (or a subdomain, never a public suffix), checked again right where the keys land, so a navigation, redirect or tab switch cannot redirect the secret. In a native desktop app (`os_type`) there is no origin, so the owner must OK that exact call.
- **Cards / UPI** resolve only inside a payment authorization the owner approved for an item and amount (`vault_authorize_payment`, behind the consent gate and the Site Skill spend cap), in the browser, on the page it was made on, for 5 minutes, each field once. The CVV is never stored; it is asked for at that moment.
- The desktop gates Show / Edit / Delete behind Touch ID (once per entry per minute). `ATLAS_NO_VAULT` turns the vault off.

**PII vault** (`src/security/pii-vault.ts`, `pii-redactor.ts`, `value-forms.ts`): card numbers, Aadhaar numbers, UPI IDs, one-time codes and cookie values are swapped for handles (`[CARD_1]`, `[OTP_2]` …) in LLM payloads and logs; `reveal()` swaps them back only inside typing tools. Every vault value is registered, so a page or tool result that shows it gets the token back, including trimmed, whitespace-collapsed or encoded forms. Values are kept in process memory only (capped); `protect()` has a memo (`ATLAS_NO_PROTECT_CACHE` disables) and `ATLAS_NATIVE_PROTECT` opts into the native linear-time version. Conversation text is masked before it is written to disk (`protectForDisk`), and `at-rest-scrub.ts` masks older rows once.

---

## 6. Deployment

### Local-first design

Bhai is designed to run on the user's own machine. All memory (SQLite, embeddings, browser profile, research results) stays local. The Convex backend is the only external dependency.

### Convex environments

| Environment | URL | When used |
|-------------|-----|-----------|
| Development | `avid-finch-726.convex.cloud` | Default (`ATLAS_ENV` not set) |
| Production | `avid-finch-726.convex.cloud` | `ATLAS_ENV=prod` (currently the same deployment id as dev in `src/config/keys.ts`) |
| Custom | `CONVEX_URL` / `CONVEX_SITE_URL` | Override either individually |

### Platform binaries (native Rust)

The native module is pre-compiled per platform. Falls back to pure-JS if unavailable.

| Platform | Binary filename |
|---------|----------------|
| macOS Apple Silicon | `atlas-native.darwin-arm64.node` |
| macOS Intel | `atlas-native.darwin-x64.node` |
| Windows x64 | `atlas-native.win32-x64-msvc.node` |
| Linux x64 | `atlas-native.linux-x64-gnu.node` |
| Linux ARM64 | `atlas-native.aarch64-unknown-linux-gnu.node` |

### Build commands

```bash
# Install Node.js dependencies
npm install

# Build Rust native module (requires Rust toolchain)
npm run build:native

# Compile Swift helpers (macOS only)
npm run build:helpers    # OCR + location + AX Swift helpers (macOS; the Mac builds fail without them)
npm run build:ocr        # OCR screen helper only
npm run build:location   # GPS/location helper only

# TypeScript compilation
npm run build            # tsc → dist/

# Everything at once
npm run build:all

# Start Convex dev backend
npx convex dev

# Run in development (hot reload)
npm run dev

# Run in production
npm start
```

### Desktop packaging

```bash
cd desktop && npm install

npm run build:mac    # macOS DMG (uses create-dmg.sh)
npm run build:win    # Windows NSIS installer
```

### System requirements

| Component | Minimum |
|-----------|---------|
| Node.js | >= 20.19 or >= 22.12 (older skips rolldown's native binding and Vitest won't start) |
| Rust toolchain | Latest stable (for native build) |
| RAM | 2 GB recommended |
| macOS | 13+ (for Swift helpers) |
| Docker | Optional (for sandboxed code execution) |

---

## 7. Configuration Reference

All configuration is via `.env` (copy from `.env.example`).

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs allowed to use the bot |
| `ATLAS_OTPLESS_USER_ID` | OTPless user ID for account authentication |

### Optional — Channels

| Variable | Description |
|----------|-------------|
| `EMAIL_USER` | IMAP/SMTP email address |
| `EMAIL_PASSWORD` | Email app password |
| `EMAIL_WHITELIST` | Comma-separated allowed sender addresses |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application ID |
| `DISCORD_ALLOWED_USER_IDS` | Allowed Discord user IDs |
| `DISCORD_NOTIFICATIONS_CHANNEL_ID` | Channel for proactive messages |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `SLACK_ALLOWED_USER_IDS` | Allowed Slack user IDs |
| `SLACK_DEFAULT_CHANNEL` | Default Slack channel |
| `MATRIX_HOMESERVER` | Matrix homeserver URL |
| `MATRIX_USER_ID` | Matrix user ID |
| `MATRIX_PASSWORD` | Matrix password |
| `MATRIX_ALLOWED_ROOMS` | Allowed room IDs |
| `PRIMARY_CHANNEL` | Default channel for proactive messages (default: `telegram`) |
| `WIDGET_TOKEN` | Authentication token for web widget |

### Optional — AI / Models

| Variable | Description |
|----------|-------------|
| `ATLAS_EMBEDDING_MODEL` | `minilm` (default, 384-dim) or `nomic` (768→256-dim) |
| `HF_TOKEN` | HuggingFace token (required for Nomic gated model) |
| `LIVE_VOICE_NAME` | Voice name for live voice mode |
| `LIVE_VOICE_BACKEND` | `gemini-live`, `openai-realtime`, or `hybrid` |
| `NOPECHA_API_KEY` | Free CAPTCHA solving (100/day) |
| `CAPTCHA_API_KEY` | 2captcha paid API key |
| `PEXELS_API_KEY` | Pexels stock footage for Video Studio |
| `RUNWAY_API_KEY` | Runway ML for AI video generation |

### Optional — Proactive kill-switches

| Variable | Effect |
|----------|--------|
| `ATLAS_PROACTIVE_DISABLE=true` | Globally disable all proactive messages |
| `ATLAS_PROACTIVE_DISABLE_SOURCES=csv` | Disable specific intent sources |
| `ATLAS_PROACTIVE_DISABLE_CHANNELS=csv` | Disable specific channels |
| `ATLAS_PROACTIVE_SHADOW=true` | Compose messages but never send (debug mode) |
| `ATLAS_PROACTIVE_DEBUG=false` | Suppress proactive debug logs |

### Optional — Feature flags

| Variable | Effect |
|----------|--------|
| `ATLAS_ENV=prod` | Use production Convex deployment |
| `ATLAS_AGENT_WORKTREE=true` | Enable git worktree isolation for parallel coders |
| `ATLAS_NO_CODE_CRITIC=true` | Skip compile/test/lint/SAST in swarm synthesis |
| `ATLAS_NO_CODEBASE_INDEX=true` | Disable codebase indexing |
| `ATLAS_NO_POST_EDIT_DIAGNOSTICS=true` | Don't attach LSP diagnostics to edit results |
| `ATLAS_NO_CODING_THINKING=true` | Disable extended thinking for coding tasks |
| `ATLAS_NO_CODING_ESCALATION=true` | Don't force Pro tier for coding |
| `ATLAS_INDEX_DEPTH=symbols\|imports\|calls` | Override auto-depth picker |
| `ATLAS_CODE_PARSER=regex` | Force legacy regex extractors (skip tree-sitter) |
| `ATLAS_MULTI_TREE_SITTER=true` | Enable Python/Rust/Go tree-sitter (unstable) |
| `ATLAS_TOOL_DEBUG=off\|verbose` | Tool breadcrumb verbosity |
| `ATLAS_POST_SYNTHESIS_BUDGET_MS` | Wall-clock cap for code-critic + multi-critic + verifier (default 90000) |
| `ATLAS_NO_COST_ROUTING=true` | Disable the cost-aware Opus-cap routing net |
| `ATLAS_NO_MEMORY_GATE=true` | Disable the memory write value-gate (emergency rollback) |
| `ATLAS_MEMORY_GATE_SHADOW=false` | Switch the value-gate from shadow (default) to enforcing mode |
| `ATLAS_NO_SESSION_SEARCH=true` / `ATLAS_CORPUS_MAX_MESSAGES=<n>` | Disable the `session_search` corpus tool / cap stored messages |
| `ATLAS_NO_META_INTERVENTIONS=true` | Disable metacognition interventions |
| `ATLAS_NO_META_VOC=true` / `ATLAS_METACOG_SHADOW=true` | Disable the VOC cost threshold / keep Tier-C calibration in shadow |
| `ATLAS_NO_METACOG_LOG=true` | Don't write the metacognition outcome log |
| `ATLAS_NO_THREAT_SCAN=true` / `ATLAS_NO_UNTRUSTED_WRAP=true` | Disable threat-pattern scanning / untrusted tool-result fencing |
| `ATLAS_NO_OSV_CHECK=true` | Skip the OSV malware pre-install check for MCP packages |
| `ATLAS_NO_FORGE=true` / `ATLAS_NO_FORGE_VERIFIER=true` | Disable Skill Forge entirely / its closed-loop verifier |
| `ATLAS_FORGE_DREAM_OPUS=true` | Route dream-replay tool synthesis to Opus + max thinking |
| `ATLAS_NO_RECOVERY_JITTER=true` | Disable full-jitter exponential backoff in error-recovery |
| `ATLAS_TOOL_LOOP_HARDSTOP` / `ATLAS_NO_PROGRESS_LIMIT` | Tune / disable the per-turn identical-args tool-loop guardrail |
| `ATLAS_LLM_ATTEMPT_TIMEOUT_MS` / `ATLAS_TOOL_ROUTER_TIMEOUT_MS` | Per-attempt LLM HTTP timeout (default 25000) / tool-router classifier timeout (default 5000) |
| `ATLAS_LLM_CACHE_THRESHOLD=<0..1>` | Semantic response cache hit threshold (default 0.97) |
| `ATLAS_NO_GUI_FASTPATH=true` / `ATLAS_ALWAYS_ORCHESTRATE=true` | Plan even single-target GUI/messaging actions |
| `ATLAS_NO_DYNAMIC_ORCHESTRATOR=true` / `ATLAS_ORCH_SHADOW=true` | Force every plan to Sonnet / log the chosen tier but route to Sonnet |
| `ATLAS_NO_DYNAMIC_BROWSER_ROUTING=true` | Restore "any action browser/OS tool → Sonnet" |
| `ATLAS_NO_WHATSAPP_TOOL_GATING=true` | Offer WhatsApp tools even when WhatsApp isn't connected |
| `ATLAS_NO_VAULT=true` | Turn the secrets vault off |
| `ATLAS_NO_PROTECT_CACHE=true` | Disable the `protect()` memo in `pii-vault.ts` |
| `ATLAS_CAPTCHA_MODELS=csv` / `ATLAS_CAPTCHA_HANDOFF_MS=<ms>` | Override the picture-CAPTCHA solver models / owner-handoff wait |

### Optional — Vision Navigation

| Variable | Effect |
|----------|--------|
| `ATLAS_VISION_PROFILE=lite\|standard` | Override the capability-detector's profile (`standard` is the one real setup; `lite` also skips OmniParser; a stored `full` reads as `standard`) |
| `ATLAS_NO_CLICK_MEMORY=true` | Disable persistent click-memory recall / record |
| `ATLAS_NO_DRIFT_CALIBRATION=true` | Disable per-monitor affine drift correction |
| `ATLAS_NO_CLOUD_GROUNDING=true` | Disable the cloud-grounding cascade tier |
| `ATLAS_NO_OMNIPARSER=true` | Force-skip the OmniParser tier (it only runs when its deps and weights are present, which no install ships) |
| `ATLAS_NO_SMARTCLICK_VERIFY=true` / `ATLAS_NO_SMARTCLICK_SELFCORRECT=true` | Trust vision-tier clicks without before/after verification / disable one-shot self-correction |
| `ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT=true` | Trust a caller-passed `screenshot_base64` instead of re-capturing at click time |
| `ATLAS_NO_AX_RETRY=true` / `ATLAS_AX_RETRY_DELAY_MS=<ms>` | Disable cold-window AX re-dump / tune its settle delay (default 250) |
| `ATLAS_NO_WINDOW_SCOPED_CAPTURE=true` | Force `os_smart_click` to full-screen capture instead of window-region |
| `ATLAS_AX_BATCH=true` / `ATLAS_AX_MSG_TIMEOUT_MS=<ms>` | Opt-in batched AX attribute reads / per-call AX messaging timeout (100–5000) |
| `ATLAS_NATIVE_AX=true` | Opt-in: route AX tree flatten/find through `native/src/ax_walker.rs` (TS is faster for trees <200 nodes) |
| `ATLAS_NO_AGENT_CURSOR=true` | No ghost cursor / "Bhai is in control" glow |

### Optional — Native Rust opt-ins / overrides

| Variable | Effect |
|----------|--------|
| `ATLAS_NO_NATIVE_SANITIZER=true` | Force TypeScript fallback for outbound secrets scrubbing (default is native — 1.9–3.4× faster) |
| `ATLAS_NATIVE_VAD=true` | Opt-in: libfvad barge-in for hybrid voice (requires native binary built with cargo feature `vad`; gracefully falls back to RMS gate if missing) |
| `ATLAS_NATIVE_PROTECT=true` | Opt-in: native linear-time `maskCredentials` / `findPii` (`pii_protect.rs`, byte-identical to the TS) |
| `ATLAS_VAD_MODE=0..3` | libfvad aggressiveness — 0 quality / 3 very aggressive (default 2) |
| `ATLAS_NATIVE_SPREADING=true` | Opt-in: route SAN BFS through `native/src/spreading.rs` (only wins on >1000-node induced graphs) |
| `ATLAS_NATIVE_AX=true` | See Vision Navigation table above |

### Optional — Voice

| Variable | Description |
|----------|-------------|
| `LIVE_VOICE_NAME` | Gemini voices: Aoede, Charon, Kore, Fenrir, Puck. OpenAI voices: alloy, shimmer, echo |
| `LIVE_VOICE_BACKEND` | Force backend: `gemini-live`, `openai-realtime`, or `hybrid` (auto-detect if empty) |
| `LIVE_VOICE_ENABLED` | Set to `false` to disable live voice entirely |
| `WAKE_WORD_ENABLED` | Enable wake word detection (default `false`) |

Note: `GOOGLE_API_KEY` and `OPENAI_API_KEY` for live voice backends are stored in Convex env vars (server-side) and fetched via `/api/keys/voice`.

### Optional — Marketing Brain

Replace `{brand}` with your brand slug (lowercase, hyphens). Example: `IG_USER_ID_acme-io=123456789`.

**Instagram (Meta Graph API):**

| Variable | Description |
|----------|-------------|
| `IG_USER_ID_{brand}` | Instagram Business Account ID |
| `IG_ACCESS_TOKEN_{brand}` | Meta Page Access Token (60-day, auto-refresh) |

**LinkedIn:**

| Variable | Description |
|----------|-------------|
| `LI_ACCESS_TOKEN_{brand}` | LinkedIn API access token |
| `LI_ORG_ID_{brand}` | Company Page numeric ID (optional — for org posts) |

**TikTok, X (Twitter), Facebook, YouTube:**

| Variable | Description |
|----------|-------------|
| `TIKTOK_ACCESS_TOKEN_{brand}` | TikTok API access token |
| `X_API_KEY_{brand}` | Twitter/X API key |
| `X_API_SECRET_{brand}` | Twitter/X API secret |
| `X_ACCESS_TOKEN_{brand}` | OAuth access token |
| `X_ACCESS_SECRET_{brand}` | OAuth access token secret |
| `FB_PAGE_ID_{brand}` | Facebook Page ID |
| `FB_ACCESS_TOKEN_{brand}` | Facebook Page access token |

**Reddit:**

| Variable | Description |
|----------|-------------|
| `REDDIT_CLIENT_ID_{brand}` | Reddit app client ID |
| `REDDIT_CLIENT_SECRET_{brand}` | Reddit app client secret |
| `REDDIT_REFRESH_TOKEN_{brand}` | Long-lived refresh token |

**Product Hunt & shared services:**

| Variable | Description |
|----------|-------------|
| `PH_API_TOKEN` | Product Hunt API token |
| `APIFY_TOKEN` | Apify — trend research + competitor scraping |
| `APOLLO_API_KEY` | Apollo.io — lead finding |
| `HUNTER_API_KEY` | Hunter.io — email verification |
| `RUNWAY_API_KEY` | Runway ML — AI video generation |
| `PHANTOMBUSTER_API_KEY` | LinkedIn automation (optional, ToS risk) |
| `PEXELS_API_KEY` | Stock video fallback (optional — raises rate limits) |

### Optional — Developer / Debugging

These flags are intended for developers working on Bhai itself. All default OFF (feature enabled).

| Variable | Effect |
|----------|--------|
| `ATLAS_DATA_DIR` | Override the `data/` directory location |
| `ATLAS_USER_DATA_DIR` | Electron `userData` path (used for wizard seed) |
| `ATLAS_WORKSPACE` | Override workspace root (default: `~/Desktop/Bhai Files`) |
| `MEMORY_DEBUG=true` | Verbose memory subsystem logging |
| `ATLAS_TOOL_DEBUG=off\|verbose` | Tool breadcrumb verbosity |
| `ATLAS_TS_DEBUG=true` | Verbose tree-sitter grammar-load logging |
| `ATLAS_DISABLE_BUILTIN_HOOKS=true` | Drop the built-in LSP pre-edit PreToolUse hook |
| `ATLAS_NO_ARCHITECTURE_INJECTION=true` | Skip `<architecture>` block on first iteration |
| `ATLAS_NO_REPO_MAP=true` | Skip `<repo_map>` block on first iteration |
| `ATLAS_NO_SAST=true` | Skip Semgrep in code-critic |
| `ATLAS_NO_AGENT_WORKTREE=true` | Force-off git worktree isolation even if `ATLAS_AGENT_WORKTREE=true` |
| `ATLAS_WAVE_SPECULATION_CAP` | Integer (default `1`) or `off` — cap on concurrent speculative executions per wave |
| `ATLAS_NO_CODER_SPECULATION=true` | Disable racing alternative approaches on coder steps |
| `ATLAS_POST_SYNTHESIS_BUDGET_MS` | Wall-clock cap on code-critic + multi-critic + MoA chain (default 90000 ms) |
| `ATLAS_PROACTIVE_V2_SCHEDULER=false` | Fall back to Composer-only dispatch (no scheduler, no inbox) |
| `ATLAS_PROACTIVE_V2_INBOX=true` | Enable the Phase 4 proactive inbox |
| `ATLAS_AUTO_PLAN_MODE=true` | Opt-in automatic entry into plan mode on first user message |
| `ATLAS_INDEX_ASYNC=force\|never` | Override the block-vs-async codebase index timing picker |
| `CONVEX_URL` | Override Convex deployment URL (both dev and prod) |
| `CONVEX_SITE_URL` | Override Convex HTTP site URL |

### Default-on kill-switches summary

The environment variables listed below all default to the feature being ON. Setting any of them to `"true"` disables the feature. Use this to regression-isolate when a subsystem misbehaves:

- Coding escalation: `ATLAS_NO_CODING_ESCALATION`
- Extended thinking for coding: `ATLAS_NO_CODING_THINKING`
- Coder speculation: `ATLAS_NO_CODER_SPECULATION`
- Git worktree isolation: `ATLAS_NO_AGENT_WORKTREE` (note the inverse — the positive flag is `ATLAS_AGENT_WORKTREE=true`)
- Built-in PreToolUse hooks: `ATLAS_DISABLE_BUILTIN_HOOKS`
- Code critic: `ATLAS_NO_CODE_CRITIC`
- Post-edit LSP diagnostics: `ATLAS_NO_POST_EDIT_DIAGNOSTICS`
- SAST (Semgrep): `ATLAS_NO_SAST`
- Codebase index: `ATLAS_NO_CODEBASE_INDEX`
- Architecture injection: `ATLAS_NO_ARCHITECTURE_INJECTION`
- Repo map injection: `ATLAS_NO_REPO_MAP`
- Proactive globally: `ATLAS_PROACTIVE_DISABLE`
- Vision-nav click memory: `ATLAS_NO_CLICK_MEMORY`
- Vision-nav drift calibration: `ATLAS_NO_DRIFT_CALIBRATION`
- Native secrets sanitizer: `ATLAS_NO_NATIVE_SANITIZER`
- Dynamic orchestrator / GUI fast path: `ATLAS_NO_DYNAMIC_ORCHESTRATOR`, `ATLAS_NO_GUI_FASTPATH`
- Dynamic browser routing: `ATLAS_NO_DYNAMIC_BROWSER_ROUTING`
- Cloud grounding / smart-click verification: `ATLAS_NO_CLOUD_GROUNDING`, `ATLAS_NO_SMARTCLICK_VERIFY`
- Agent cursor: `ATLAS_NO_AGENT_CURSOR`
- Vault: `ATLAS_NO_VAULT`

---

## Appendix A — File Tree Summary

```
Bhai/
├── src/                        (TypeScript source, ~580 non-test files; ~770 incl. tests)
│   ├── index.ts                (entry point, boot sequence)
│   ├── agent.ts                (runAgent, core loop)
│   ├── llm.ts / llm-middleware.ts / llm-cache.ts / llm-parsers/
│   ├── crypto-transport.ts     (ECDH + AES-256-GCM)
│   ├── crypto-kdf.ts / context-scrubber.ts
│   ├── model-router.ts         (Rust wrapper — tiers + cost-aware routing)
│   ├── tool-router.ts          (semantic tool selection)
│   ├── memory/                 (59 files + code-parse/ — incl. value-gate, playbooks, at-rest-scrub, compression-template, Memory Studio)
│   ├── screen/                 (16 files — Vision Navigation: capability detector, perception router, click memory, drift calibration, cloud grounding, AX dump, agent cursor)
│   ├── agents/                 (36 files — swarm, mesh, long-task, sub-agent, metacognition, verify-before-done, etc.)
│   ├── forge/                  (17 files — Skill Forge: dynamic-tool synthesis + verifier + kernel sandbox shim)
│   ├── tools/                  (141 files)
│   │   ├── browser/            (27 files — dual-backend automation, CAPTCHA solver, vault typing)
│   │   ├── coding/             (31 files — design docs, LSP, codebase index)
│   │   ├── session-search.ts   (FTS5 conversation-corpus recall)
│   │   ├── vault.ts / site-task.ts / site-skill-mint.ts / send-ledger.ts
│   │   └── os-smart-click.ts / os-computer-action.ts / os-grounding.ts / os-inspect.ts / platform.ts
│   ├── skills/                 (loader + site/ — Site Skills runtime, drift repair, skill minter)
│   ├── research/               (11 files — deep research engine)
│   ├── proactive/              (60 files — heartbeat, dreaming, composer, dispatch, inbox, monitors, sources, telemetry)
│   ├── harness/                (17 files — Meta-Harness optimizer)
│   ├── video-studio/           (25 files — AI video editing)
│   ├── marketing/              (29 files — Marketing Brain)
│   ├── voice/                  (22 files incl. live/ 19 — TTS, STT, live voice, Kokoro local TTS)
│   ├── social/                 (emotion-detector.ts — lexicon + punctuation heuristic)
│   ├── documents/              (10 files — block-based doc renderer + templates)
│   ├── location/               (7 files — GPS → Wi-Fi → IP fallback)
│   ├── planning/               (MCTS, hierarchical)
│   ├── mcp/                    (Model Context Protocol)
│   ├── commands/               (slash commands — /recap, /doctor)
│   ├── diagnostics/            (/doctor system probe)
│   ├── overlay/                (Electron overlay chat server + overlay.html)
│   ├── prompts/                (5 files — dynamic assembly + persona-bias + watermark)
│   ├── hooks/ cron/            (3 + 3 files — built-in tool hooks, cron schedules)
│   └── security/               (22 files — threat patterns, URL/SSRF guard, OSV check, skill scanner, secrets sanitizer, PII vault, vault, consent, allowlist, sandbox)
├── native/                     (Rust, 80 modules)
│   ├── src/
│   │   ├── ax_walker.rs        (cross-OS AX flatten/find — opt-in)
│   │   ├── pcm_vad.rs          (libfvad barge-in — cargo feature `vad`, opt-in)
│   │   ├── secrets_sanitizer.rs (default-ON, 1.9–3.4× faster than TS)
│   │   ├── forge_sandbox/      (kernel-sandbox supervisor: seccomp/Landlock · sandbox-exec · AppContainer)
│   │   └── … more modules
│   └── Cargo.toml
├── convex/                     (serverless backend — 27 tables)
│   ├── schema.ts
│   ├── http.ts
│   ├── claude.ts / credit_cost.ts (Claude proxy + billing)
│   ├── crypto.ts
│   ├── bhaiMail*.ts / telegramManaged.ts / devices.ts / stt.ts / grok.ts / userAddenda.ts
│   └── store/
├── desktop/                    (Electron app + overlay window)
│   ├── installer/              (phase runner — background setup)
│   ├── wizard/                 (first-run wizard — sign in, connect Chrome, Ready Hub)
│   ├── setup/                  (wizard-scoped WhatsApp pairing)
│   └── components/ pages/ vault-store.js agent-cursor.js
├── chrome-extension/           (MV3 companion extension — native messaging + /discover handshake)
├── portals/
│   ├── admin-panel/            (Next.js admin dashboard)
│   └── developer-portal/       (Next.js developer portal)
├── skills/                     (built-in markdown skills + Convex skill dirs)
├── prompts/                    (server-side prompt source)
├── scripts/                    (Swift helpers — OCR, GPS, AX dump — Convex seeds, hotkeys)
├── data/                       (runtime state — gitignored)
│   ├── memory.db               (SQLite, WAL)
│   ├── click-memory.db         (vision-nav learnt click sites)
│   ├── codebase-index/
│   ├── agent-worktrees/
│   ├── long-tasks/
│   ├── research/
│   ├── browser-profile/
│   ├── video-projects/
│   ├── harness/runs/
│   ├── proactive-config.json
│   └── audit.jsonl
└── .env                        (user config)
```

---

## Appendix B — Performance Highlights

- **Vector ops (native Rust):** 15–20× faster than pure JS for cosine similarity, top-K search, batch similarity
- **Tool routing:** semantic selection via MiniLM embeddings loads only the needed ~15–36 tools per request (out of 100+)
- **Memory fan-out:** 12 retrieval systems execute in parallel, total latency bounded by the slowest single retrieval (~150–300 ms in practice)
- **Prompt caching:** Anthropic cache breakpoints on system prompt + tools schema + conversation history reduce token costs by up to 90% on repeated context
- **LLM response cache:** semantic LRU (cosine ≥ 0.97 by default, 10-minute TTL) catches exact repeats and near-paraphrases of simple queries
- **Incremental codebase index:** Merkle-hashed file tracking means a refresh after small edits touches only changed files
- **Model cascading:** trivial tasks hit Haiku (0.25 credits); complex tasks auto-escalate to Opus (2 credits) — average spend stays low while peak capability is always reachable
- **Tool result truncation:** per-tool smart truncation (shell keeps tail, JSON prunes trees, browser keeps IDs, files keep head + tail) prevents token-bloat feedback loops

---

## Appendix C — Glossary

- **Bhai** — Advanced Technology for Logical Autonomous Systems
- **ECDH** — Elliptic-Curve Diffie-Hellman key exchange
- **AES-256-GCM** — Authenticated encryption with associated data, 256-bit key, Galois/Counter Mode
- **HNSW** — Hierarchical Navigable Small World (approximate nearest-neighbor search)
- **FTS5** — SQLite Full-Text Search version 5 (with BM25 ranking)
- **BM25** — Best Match 25, a probabilistic relevance ranking function
- **MiniLM** — small sentence-transformer model (all-MiniLM-L6-v2, 384-dim embeddings)
- **SAST** — Static Application Security Testing (Semgrep in Bhai)
- **LSP** — Language Server Protocol
- **MCP** — Model Context Protocol
- **OCC** — Optimistic Concurrency Control (used by Convex for credit deduction)
- **RRF** — Reciprocal Rank Fusion (blends multiple ranked lists)
- **OTPless** — third-party authentication service used for account identity
- **NSGA-II** — Non-dominated Sorting Genetic Algorithm II (multi-objective optimization)
- **TextGrad** — Text-based gradient analogue for LLM output critique
- **SAC-DR** — Self-Alignment via Cognitive Dissonance Resolution (reflection algorithm)
- **SOFAI-LM** — Slow-Fast AI for Language Models (metacognition framework)
- **SAN** — Spreading Activation Network (memory retrieval boost)
- **A2A** — Agent-to-Agent protocol (Google)
- **DAG** — Directed Acyclic Graph
- **WAL** — Write-Ahead Logging (SQLite mode)
- **DND** — Do Not Disturb (proactive silencing)
- **XOR key** — runtime key used to decrypt `.env.enc` in the desktop app

---

*Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.*
*Website: [tryatlasagi.com](https://tryatlasagi.com) · [xagilab.com](https://xagilab.com)*
