<div align="center">
  <img src="./desktop/logo.png" alt="Bhai Logo" width="120" />
  <h1>Bhai</h1>
  <p><b>A proactive personal AI agent that remembers, acts, and keeps working.</b></p>
  <p>v0.2.1 &middot; Autonomous Personal AI Agent &middot; Built by TRUSCOR Private Limited</p>
</div>

---

## Overview

**Bhai** is an autonomous personal AI agent engineered for people who want more than a chatbot. It is a continuously running process that takes action, remembers what happened, reasons about what to do next, and keeps working while you sleep. The runtime combines a Node.js/TypeScript orchestration surface (~910 `.ts` files under `src/`, tests included) with a native Rust performance layer (80 `.rs` modules) compiled through napi-rs for SIMD-accelerated vector math, routing, memory operations, and cross-OS accessibility-tree walking.

Bhai is built for operators, founders, and researchers who need a single system that can drive a browser, write and ship code, run deep research, orchestrate multi-agent swarms, manage a marketing funnel across nine social platforms, and hold a real conversation across Telegram, Discord, Slack, Matrix, WhatsApp, email, and a desktop app and overlay — all from one codebase, one memory, and one identity.

What makes Bhai different is that it is **not stateless**. An 89-file organic memory system (SQLite + HNSW vectors + knowledge graph) captures episodic trajectory, emotional tone, user models, traits, goals, and task learnings. Writes pass through an LLM value-gate that rejects low-signal noise before it reaches the store, context compression preserves a structured 13-section continuity summary across long sessions, and a full conversation corpus is searchable via FTS5. A nightly dream-replay pass consolidates the day, decays irrelevant data every six hours, and seeds the next morning's proactive brief. The agent also reasons about its own reasoning via a tiered metacognition engine and a meta-harness optimizer that tunes 30+ internal dimensions through NSGA-II Pareto search.

Security and privacy are foundational rather than bolted on. Every LLM call is proxied through a Convex backend with end-to-end ECDH P-256 + AES-256-GCM encryption — API keys never leave the server, system prompts never leave the server, and the client device only ever holds a short-lived session token bound to its ECDH shared key. All memory, all browser profile state, and all generated artifacts live locally on the user's machine. Saved secrets sit in an encrypted vault the agent can use but never read, and secrets saved to memory before at-rest masking existed are scrubbed once on upgrade.

---

## Feature Highlights

- **Multi-Channel Presence** — First-class integrations with Telegram, Discord, Slack, Matrix, WhatsApp (Baileys), IMAP/SMTP email, an Electron desktop app with overlay chat, a WebSocket canvas surface, and an embeddable web widget. Setup is near one-click: Telegram bots are created through Telegram's managed-bot flow (no BotFather copy-paste), WhatsApp links Bhai's own number by QR code or pairing code, and Bhai can get its own mailbox (`<name>.bhai@xagilab.com`) in one click.
- **Organic Memory** — 89 memory files spanning core store, knowledge graph, HNSW vector index, episodic milestones, emotional trajectory, traits, identity, session, relationship, world/user/self models, working memory, Hopfield associative recall, active inference, prospective, counterfactual, temporal cache, project memory, Memory Studio insights, and nightly dream replay. An LLM value-gate guards every write (shadow mode by default), a structured 13-section template carries continuity through context compression, and `session_search` exposes the full conversation corpus over FTS5.
- **Native Rust Acceleration** — 80 Rust modules (SIMD via `wide`/`simsimd`, `rayon` parallelism) delivering ~15-20x speedup on vector ops, model routing, HNSW search, swarm/mesh orchestration, metacognition, MCTS, the harness optimizer, secrets sanitization, and cross-OS AX tree walking.
- **Vision Navigation** — Tiered Perception Cascade (`src/screen/`) for autonomous computer use. One setup for everyone, no local ML download: click-memory → AX exact → AX fuzzy → cloud grounding (a single Haiku call, re-grounded on Sonnet after a verified miss) with confidence gating; persistent click-memory + per-monitor drift calibration learn across sessions. `os_smart_click` captures a fresh window-scoped screenshot, activates the target app, and verifies vision-tier clicks (re-grounding once on a verified miss). Computer-use runs show a ghost cursor and a "Bhai is in control" edge glow.
- **Semantic Tool Selection** — MiniLM 384-dim embeddings route user intent across 20+ tool categories and 100+ tool implementations. A `request_tools` meta-tool lets the agent expand its surface mid-task.
- **Four-Tier Orchestration** — Sub-Agent (specialized roles), Swarm (decomposition + evaluator-optimizer), Mesh (parallel DAG with layered recovery), Long-Task (multi-phase checkpointed execution up to 100 phases).
- **Deep Research** — Three-phase research engine, 13 pluggable search backends (Parallel Search first, then Tavily, Exa, Bing, SearXNG, Brave, DuckDuckGo, Wikipedia, Mojeek, and academic sources), up to 500 sources per run, hypothesis generation and testing, source credibility scoring, relevance reranking.
- **Reliability Layer** — Per-turn nudges stripped at turn end; a send ledger refuses duplicate messages/files to the same recipient within 10 min; a task contract ("on it — …; done = …") whose done-criterion is checked before finishing; an honest `[[STUCK]]` report instead of silent give-up or faked success; a done receipt screenshot after verified GUI work; step heartbeats ("step N · status · Ns"); and playbooks that store a verified win's tool steps (no secrets) for replay.
- **Secrets Vault** — Logins, API keys, cards and UPI IDs live in the desktop app's encrypted store (Electron safeStorage). The model sees only labels and `{{vault:…}}` tokens; values resolve inside typing tools only, on the domain they are locked to, and are masked in any output. Card use needs a per-item, per-amount owner authorization; the CVV is never stored.
- **Site Skills** — Per-site task recipes (`skill.json` + `skill.cjs`, run by `src/skills/site/`) that Bhai can mint from a successful run, with drift detection, consent gates and spend caps.
- **E2E Encrypted LLM Proxy** — ECDH P-256 + AES-256-GCM on top of HTTPS; 24h session tokens; atomic credit deduction; system prompts assembled server-side.
- **Proactive Behaviors** — Heartbeat engine with per-channel postures (calm / active / ambient), nightly dream replay during detected sleep windows, quiet-hours guard, urgency bypass rules, shadow mode for dry runs. 110+ files spanning observer pipeline, composer fast-path, intent sources (calendar, news, stale email, weather, tasks, onboarding graduation, source gates), telemetry, and the proactive inbox.
- **Memory Studio** — Interactive graph viewer (opened from desktop Settings) with edit/pin/forget controls and AI-generated insights over the local memory database (`src/memory/studio-graph.ts`, `studio-insights.ts`).
- **Video Studio** — Project-scoped video pipeline (49 files) with AI edit planning, scene detection, beat sync, FFmpeg render stage, and reproducible hash-addressed inputs.
- **Meta-Harness Self-Optimizer** — 30+ tunable dimensions (weights, thresholds, k-values, phase ratios) tuned via NSGA-II Pareto search, GP surrogate modeling, and TextGrad-style prompt refinement.
- **A2A Protocol** — Google Agent-to-Agent protocol for inter-agent delegation and negotiation across trusted peers.
- **CAPTCHA Solver** — Detection plus a solver ladder (audio-challenge transcription, vision solve, NopeCHA, 2captcha fallback) in `src/tools/browser/captcha*.ts`; falls back to a human handoff.
- **Desktop App** — Electron app with first-run wizard, Settings (search, personality presets, Data & privacy, update channel), Account (devices list), Channels, Memory and Vault pages, tray, and the agent cursor. Personality presets: casual_playful, professional_concise, warm_supportive, direct_terse, unhinged (18+, owner-only, served by Grok).
- **Voice Mode** — Local ASR/TTS (Whisper, Kokoro), ElevenLabs TTS, Gemini Live voice, OpenAI Realtime voice, libfvad-backed barge-in detection (opt-in), wake-word detection, Telegram voice-note pipeline.
- **Marketing Brain** — Native integrations with Instagram, LinkedIn, TikTok, X/Twitter, Facebook Pages, YouTube, Reddit, Product Hunt, plus content calendars, cold outreach, lead finding, and trend research.
- **Coding Pipeline** — Design-doc gating, LSP integration, per-repo codebase index (SQLite + tree-sitter + FTS5 BM25), agent git worktrees for parallel coders, code critic (compile/test/lint/SAST), and walkthrough generation.
- **Tiered Metacognition** — The agent assesses its own reasoning between iterations: content-aware loop detection, an intervention dispatcher (escalate / replan / critics / ask-user), a value-of-computation cost threshold that suppresses low-payoff interventions, and shadow-mode confidence calibration. A per-turn guardrail also kills identical-args tool-call loops.
- **Cost-Aware Routing** — Every request lands on one of three Claude models (Haiku / Sonnet / Opus). A task classifier sets the tier (chat / simple / standard / complex), casual chat runs on Haiku with thinking off, and Opus is gated to explicit or genuinely complex work. Browser and desktop work routes by complexity.
- **Defense in Depth** — Centralized threat-pattern scanning (prompt injection / exfil / bidi spoofing), an SSRF + cloud-metadata-floor URL guard, untrusted-tool-result fencing against indirect prompt injection, OSV malware (`MAL-*`) pre-install checks for MCP packages, and an outbound secrets sanitizer that redacts API keys, DB connection strings, and URL userinfo before any payload leaves the device.
- **Diagnostics** — `/recap` summarizes the last *n* turns with zero AI cost; `/doctor` probes Convex connectivity, session/credit state, the native binary, environment, and memory health.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Channels                                    │
│   Telegram · Discord · Slack · Matrix · WhatsApp · Email (IMAP/SMTP)        │
│   Desktop Overlay (Electron) · Canvas (WS) · Web Widget · Voice Live        │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                       Agent Loop (src/agent.ts)                              │
│  Credit gate → Context pruning → 12-system memory retrieval (parallel)       │
│  → Model router → Semantic tool selection → LLM call → Tool exec             │
│  → Cascade escalation → Completion check  [max 200 iter · mid-session gate]  │
└─┬──────────┬──────────┬──────────┬──────────┬──────────┬────────────────────┘
  │          │          │          │          │          │
┌─▼────┐ ┌───▼───┐ ┌────▼────┐ ┌───▼────┐ ┌───▼─────┐ ┌──▼──────┐
│Memory│ │Agents │ │  Tools  │ │Research│ │Proactive│ │ Screen  │
│89 fil│ │60 fil │ │ 205 fil │ │ 18 fil │ │ 94 fil  │ │ 34 fil  │
└──────┘ └───────┘ └─────────┘ └────────┘ └─────────┘ └─────────┘
   │         │          │          │          │           │
┌──▼─────────▼──────────▼──────────▼──────────▼───────────▼───────────────────┐
│                     Native Rust Layer (80 .rs modules)                       │
│  SIMD vectors · Model router · HNSW · Swarm/Mesh · Metacognition · MCTS      │
│  Harness optimizer · Hopfield · Active inference · Credibility · Proactive   │
│  AX walker · Secrets sanitizer · PCM VAD · Spreading · Query classifier      │
└─────────────────────────────────────────────────────────────────────────────┘
    │
┌───▼──────────────────────────────────────────────────────────────────────────┐
│                           Convex Backend (convex/)                           │
│  LLM proxy (E2E encrypted) · Sessions (24h TTL) · Credits (atomic)           │
│  Devices · Bhai mail · Telegram managed bots · STT · Store · System prompts  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Source Layout

```
src/                                  # ~910 TypeScript files (incl. tests)
├── index.ts                          # Ordered + parallelized boot sequence
├── agent.ts                          # Core agent loop (runAgent)
├── llm.ts                            # LLM client (proxied through Convex)
├── llm-middleware.ts                 # Pre/post LLM middleware layer
├── llm-cache.ts                      # Semantic response cache (cosine ≥ 0.97)
├── llm-parsers/                      # 11 files — response parsers
├── crypto-transport.ts               # ECDH P-256 + AES-256-GCM encrypted fetch
├── crypto-kdf.ts                     # Machine-stable secret KDF
├── context-scrubber.ts               # Secrets-scrubbing pass for outbound payloads
├── model-router.ts                   # Model tier selection (wraps native Rust)
├── step-status.ts channel-text.ts    # Step heartbeat; stuck-marker / channel text helpers
├── bhai-mail.ts                      # Bhai's own mailbox
├── tool-router.ts                    # Semantic tool selection via MiniLM
├── language.ts                       # Adaptive language detection & matching
├── alive-ux.ts                       # Centralized personality + phrasing
├── network-health.ts                 # Online/degraded/offline monitor
├── account-guard.ts session.ts       # Credit/session middleware
├── telegram.ts | discord.ts | slack.ts | matrix.ts | whatsapp.ts | email.ts
│
├── agents/                           # 60 files — four-tier orchestration
│   ├── sub-agent.ts                  # Specialized roles (researcher/coder/browser/system)
│   ├── swarm.ts  mesh.ts  long-task.ts
│   ├── evaluator.ts replanner.ts mixture.ts speculative.ts
│   ├── metacognition.ts multi-critic.ts code-critic.ts
│   ├── textgrad-refiner.ts self-editor.ts self-heal.ts
│   ├── agent-worktree.ts             # Per-coder git worktree isolation
│   ├── code-action-agent.ts computer-use-agent.ts
│   ├── circuit-breaker.ts human-interrupt.ts tool-output-offload.ts a2a.ts
│   └── error-recovery.ts handoff.ts blackboard.ts decomposition-library.ts
│
├── memory/                           # 89 files — organic memory system
│   ├── sqlite.ts                     # Primary store (remember / recall / core)
│   ├── knowledge-graph.ts vector-index.ts embeddings.ts embedding-cache.ts
│   ├── resolve-embedding.ts memory-tiers.ts fts5-query.ts
│   ├── reflection.ts                 # Nightly dream replay + decay
│   ├── emotional.ts episodic.ts identity.ts traits.ts session.ts
│   ├── relationship.ts self-state.ts goals.ts anticipation.ts
│   ├── working-memory.ts spreading-activation.ts counterfactual.ts
│   ├── sleep-gate.ts surprise-gate.ts reranker.ts strategy-library.ts self-evolving.ts
│   ├── value-gate.ts gate-audit.ts            # LLM write value-gate + JSONL audit (10MB rotation)
│   ├── compression-template.ts                # Structured 13-section continuity summary
│   ├── codebase-sidecar.ts codebase-merkle.ts codebase-index.ts code-parse/
│   ├── multimodal.ts multimodal-embedding.ts project-memory.ts memory-informed-planning.ts
│   ├── studio-graph.ts studio-insights.ts    # Memory Studio (graph viewer + AI insights)
│   ├── playbooks.ts                           # Verified-win tool steps for replay
│   └── classifier.ts context-pruning.ts consolidation.ts temporal-cache.ts
│
├── screen/                           # 34 files — Vision Navigation subsystem
│   ├── capability-detector.ts        # Profile ("standard" / "lite") at boot
│   ├── perception-router.ts          # Tiered Perception Cascade (memory → AX → cloud grounding)
│   ├── ax-dump.ts                    # Cross-OS accessibility tree dumping (TS + native fallback)
│   ├── cloud-grounding.ts            # Cloud grounding tier (Haiku; Sonnet on re-ground)
│   ├── click-memory.ts               # Persistent learnt-click recall (data/click-memory.db)
│   ├── drift-calibration.ts          # Per-monitor affine drift correction
│   ├── outcome-classifier.ts         # Click-success vs miss classification feedback
│   ├── agent-cursor.ts grid-overlay.ts  # Ghost cursor IPC; os_screenshot grid
│   ├── computer-action.ts screen-dimensions.ts frontmost.ts
│   └── omniparser.ts ui-tars.ts      # Legacy tiers; not shipped, skipped unless deps + weights exist
│
├── tools/                            # 205 files — tool implementations
│   ├── browser/                      # 54 files — Playwright + Chrome Extension backends, CAPTCHA, vault typing
│   ├── coding/                       # 102 files — edit/write/grep/glob/lsp/git/codebase
│   ├── os-smart-click.ts             # Primary GUI click tool (uses perception-router)
│   ├── os-computer-action.ts os-grounding.ts os-inspect.ts
│   ├── platform.ts platform-info.ts platform-bridge.ts macos.ts linux.ts windows.ts
│   ├── shell.ts files.ts memory-tools.ts session-search.ts deep-research.ts
│   ├── github-api.ts google-api.ts spotify.ts apple-notes.ts sonos.ts
│   ├── generate-image.ts blender.ts audio-visualize.ts video-studio.ts
│   ├── send-ledger.ts vault.ts site-task.ts site-skill-mint.ts
│   └── tool-intelligence.ts create-tool.ts repo-map.ts
│
├── forge/                            # 52 files — Skill Forge (dynamic-tool synthesis + Rust kernel sandbox)
├── research/                         # 18 files — deep research engine
├── harness/                          # 17 files — Meta-harness registry + optimizer
├── video-studio/                     # 35 files — Project-scoped video pipeline
├── marketing/                        # 29 files — 9-platform marketing brain
├── proactive/                        # 94 files — heartbeat, dreaming, composer, dispatch, inbox, monitors, sources
├── planning/                         # 4 files — MCTS, hierarchical planner, logic verifier
├── execution/                        # Speculative execution patterns
├── social/                           # emotion-detector.ts (lexicon + punctuation heuristic)
├── models/                           # 5 files — Local ASR/TTS/OCR/vision + FunctionGemma
├── voice/                            # 30 files (incl. live/) — TTS, transcription, live voice
├── documents/                        # 10 files — block-based doc renderer + templates
├── config/                           # Keys, paths, protected config loader
├── security/                         # 48 files — threat patterns, URL/SSRF guard, OSV check, vault, PII vault, consent gate, secrets sanitizer, allowlist, sandbox
├── mcp/                              # 2 files — Model Context Protocol + gitmcp bridge
├── diagnostics/                      # /doctor system probe (Convex, session, credits, native, env, memory)
├── hooks/                            # 3 files — Built-in pre/post tool hooks
├── cron/                             # 6 files — Schedule parser + store + tick
├── skills/                           # 27 files — Skill loader + site/ (site-skill runtime)
├── store/                            # 6 files — Marketplace + hot-reload + sideload
├── canvas/                           # WebSocket canvas channel
├── commands/                         # Slash command parsing (/recap, /doctor, ...)
├── location/                         # 7 files — GPS → Wi-Fi → IP fallback
├── notifications/                    # Web-push delivery
├── widget/                           # Embeddable chat widget IIFE
├── overlay/                          # Electron overlay chat server + overlay.html
├── setup/                            # Wizard + profile + persona seeding
└── prompts/                          # 7 files — Dynamic prompt assembly + persona bias + watermark

native/src/                           # 80 Rust modules (napi-rs + SIMD)
├── lib.rs                            # napi-rs entry point
├── vector.rs batch.rs                # SIMD-accelerated vector math
├── model_router.rs tool_router.rs tool_analytics.rs query_classifier.rs
├── hnsw.rs spreading.rs consolidation.rs temporal_cache.rs context_pruning.rs
├── memory_state.rs memory_tiers.rs session_memory.rs knowledge_graph.rs
├── traits_engine.rs task_learnings.rs reflection_core.rs
├── swarm.rs mesh.rs sub_agent.rs long_task.rs agent_core.rs
├── metacognition.rs mcts_engine.rs logic_engine.rs active_inference.rs
├── hopfield.rs working_memory.rs sleep_gate.rs surprise_gate.rs
├── world_model.rs user_model.rs credibility_model.rs
├── inner_thoughts.rs goal_engine.rs habit_detector.rs notification_tracker.rs
├── proactive_intent.rs proactive_scheduler.rs proactive_monitor.rs
├── proactive_calendar.rs proactive_news.rs proactive_stale_email.rs
├── proactive_tasks.rs proactive_weather.rs proactive_source_gate.rs
├── browser_agent.rs browser_guard.rs chrome_bridge.rs
├── ax_walker.rs                      # Cross-OS AX tree walker (opt-in via ATLAS_NATIVE_AX)
├── pcm_vad.rs                        # libfvad-backed barge-in detection (opt-in, cargo feature `vad`)
├── secrets_sanitizer.rs              # Multi-pattern outbound secrets scrubber (default-ON)
├── harness_optimizer.rs              # NSGA-II + GP surrogate
├── research_engine.rs info_gain.rs citation_graph.rs skill_scorer.rs
├── pattern_speculator.rs process_reward.rs prompt_evaluator.rs
├── security.rs ip_guard.rs
└── forge_sandbox/                    # Kernel-sandbox supervisor (seccomp/Landlock · sandbox-exec · AppContainer)

convex/                               # Serverless backend (26 .ts files + store/)
├── http.ts                           # LLM proxy with E2E encryption
├── claude.ts credit_cost.ts          # OpenAI-format → Claude API translation; per-model credit cost
├── grok.ts                           # Unhinged persona (Grok via Azure)
├── sessions.ts accounts.ts crypto.ts systemContent.ts userAddenda.ts
├── otpless.ts devices.ts stt.ts      # Auth, device list, speech-to-text
├── bhaiMail.ts telegramManaged.ts    # Bhai's own mailbox; Telegram managed-bot setup
├── schema.ts                         # accounts, sessions, rate limits, usage, store, system content, devices
└── store/                            # items, submissions, developers, installs, reviews, admins

desktop/                              # Electron app (setup wizard, panel, tray, agent cursor)
├── installer/ wizard/ setup/         # Phase runner, first-run wizard, WhatsApp pairing
├── components/ detection/ migration/ pages/
└── panel.html channels.html          # Settings, Account, Channels, Memory

chrome-extension/                     # User-side Chrome automation bridge (WS + native messaging)
portals/                              # Next.js admin-panel + developer-portal
prompts/                              # Source-of-truth for seeded system prompts
skills/ site-skills/                  # Seeded skills; built-in site skills
docs/                                 # Internal docs
scripts/                              # Swift helpers (OCR, GPS, AX dump), Convex seeds, hotkeys
```

---

## Core Systems

### LLM Client & Transport

The `LLMClient` is created once at boot by `createLLMClient(config)` and dependency-injected into every subsystem (agent, swarm, research, memory writes, marketing, etc.). `.chat()` builds messages, adds dynamic context (clock, widget hints), and POSTs to `${convexSiteUrl}/api/llm/chat` via `encryptedFetch()`, which runs ECDH P-256 key exchange on first use and wraps every subsequent request body in AES-256-GCM. The server prepends its own system prompt from the `system_prompts` table before forwarding to the Claude API (`convex/claude.ts` translates the OpenAI-format request; unhinged mode routes to Grok in `convex/grok.ts`). Client-side layers add a semantic response cache (cosine ≥ 0.97 (`ATLAS_LLM_CACHE_THRESHOLD`), 10 min TTL, 200-entry LRU; bypassed for tool-call and thinking-mode requests) and adaptive language matching across Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, Latin scripts, and Romanized Hindi.

### Model Router

A thin TypeScript wrapper (`src/model-router.ts`) around a native Rust binary (`native/src/model_router.rs`). Decision inputs: iteration count, error count, last tool calls, media presence, user hint (`"simple"`/`"complex"`), coding complexity class. Falls back to pure JS if the native module fails to load.

| Tier | Cost | Model | Primary Use |
|------|------|-------|-------------|
| Light | 0.25 credits | Claude Haiku | Chat lane, simple tasks, helper calls (classifier, HyDE, briefing) |
| Pro | 1 credit | Claude Sonnet | Browser automation, tool calling, coding, planning |
| Heavy | 2 credits | Claude Opus | Complex reasoning; gated to explicit asks, `complex` hints, or 3+ errors |

On the first iteration the tool router's classifier also returns a tier (chat / simple / standard / complex): chat runs on Haiku with thinking off, complex gets at least Sonnet, and the planner runs only for multi-step or complex work. Coding intent forces a Pro-tier model via `maybeEscalateForCoding`. Errors accumulate → cascade escalation steps up the ladder (Haiku → Sonnet → Opus). The router is context-window-aware, driving token-aware pruning and failover; `ATLAS_NO_COST_ROUTING` disables the Opus-cap net. A dedicated `tool_synthesis` task type routes Skill Forge synthesis to Sonnet (or Opus in dream-replay).

### Memory System

All local SQLite (`data/memory.db`) — no memory ever leaves the device. Twelve retrieval systems fire in parallel on the first iteration of each agent invocation with a combined ~2-3K token budget. When the context window fills, compression preserves a structured 13-section continuity summary (active task verbatim, completed actions, exact errors, decisions, pending asks, files) that the next iteration parses and extends.

| Layer | Purpose |
|-------|---------|
| Core store | `remember()`, `recall()`, `getCoreMemory()` — primary read/write surface |
| Knowledge graph | Entity-relationship map (people, tools, preferences) |
| Vector index | HNSW approximate nearest neighbor, 384 or 256 dim |
| Episodic & emotional | Interaction trajectory, emotional state, milestone detection |
| Identity & traits | Persistent personality, token-budgeted (traits ≤ 600 tok) |
| Working + Hopfield | Short-term context + associative recall |
| World & user models | Predictive models of environment and user behavior |
| Active / counterfactual / prospective | Predictive reasoning and "what-if" simulation |
| Reflection | Nightly dream replay consolidation; decay every 6h |
| Task learnings + strategy library | Reusable strategies from past executions |
| Sleep / surprise gates | Consolidation gating driven by reward prediction error |
| Value-gate | LLM (Haiku) gate on every write — rejects low-signal noise; sha256-cached, fail-closed, JSONL audit; shadow mode by default |
| Conversation corpus | Full message corpus searchable via `session_search` (FTS5 BM25) |
| Codebase sidecar | Per-repo SQLite index (tree-sitter + FTS5 BM25) |

### Agent Orchestration

| Tier | Description | Limits |
|------|-------------|--------|
| **Sub-Agent** | Specialized roles (researcher, coder, browser, system, general) with scoped tools, loop detection, `request_tools` expansion, per-iteration cost tracking, partial result streaming | Priority-scaled timeout / model |
| **Swarm** | Decomposes tasks into sub-agent steps, executes via Mesh, synthesizes with evaluator-optimizer loop and replanning; integrates task learnings | Max 20 steps |
| **Mesh** | Parallel DAG executor with critical-path scheduling, layered recovery (retry → rephrase → reroute → skip), structured handoff messages | Dynamic role assignment |
| **Long-Task** | Multi-phase executor with JSON checkpointing every 60s; inter-phase replanning | 200 iter/phase · 30 min/phase · ≤100 phases · ≤3 replans |

Inside swarm runs, explicit external-action tools and shell launchers are held until the owner's fresh yes (`swarm_task confirmed: true`); payments and orders never run in a swarm.

Additional optimization and reliability layers: evaluator scoring, replanner, mixture-of-agents, speculative racing, metacognition, multi-critic review, code-critic (compile/test/lint/SAST with Semgrep), TextGrad refinement, self-editor, self-heal, per-coder git worktrees, shared blackboard.

### Tool Router

Semantic selection using MiniLM embeddings (384-dim, `@xenova/transformers`). On boot each tool category description is embedded and cached. Per message: user query is embedded, cosine similarity selects the top-K categories, tool schemas for those categories are loaded into the LLM call. A `request_tools` meta-tool lets the agent request additional categories mid-task. Optional FunctionGemma fallback (270M model via Ollama) provides zero-cost routing at ~85% accuracy. 20+ categories cover core, memory, browser, file_system, shell, system_control, media, integrations, research, coding, marketing, and more.

### Deep Research

Background research engine with its own execution loop. `executor.ts` drives up to 500 sources; `engines.ts` abstracts 13 pluggable search backends, with Parallel Search (proxied via Convex, key server-side) queried first; `fetcher.ts` handles HTML → text; `hypothesis-engine.ts` generates and tests hypotheses; `credibility-model.ts` scores source reliability; `scoring.ts` + reranker handle relevance; results persist to `data/research/` as markdown.

### Proactive Engine

Per-channel posture drives delivery cadence. Each channel maps to one of three presets:

| Posture | Max/day | Min gap | Heartbeat | Boundary only | Urgent bypass |
|---------|---------|---------|-----------|---------------|---------------|
| calm    | 3       | 120 min | 120 min   | yes           | yes           |
| active  | 8       | 45 min  | 60 min    | no            | yes           |
| ambient | 1       | 360 min | 240 min   | yes           | yes           |

Defaults: WhatsApp/Discord/Slack/Matrix → calm; Telegram → active; Overlay/Email → ambient. Config in `data/proactive-config.json`, reloads at runtime. Night windows (default 22:30-07:00) throttle deliveries; `urgentAllowedAfter` sets the earliest non-urgent hour. Kill-switches per source and per channel; shadow mode composes and logs without delivering.

### Vision Navigation

Autonomous GUI control without a local ML stack. There is one setup for everyone (`standard`); the old Lite/Standard/Full tier picker and the UI-TARS / OmniParser installs are retired (a stored `full` reads as `standard`; `ATLAS_VISION_PROFILE=lite` only also skips OmniParser).

The Tiered Perception Cascade (`perception-router.ts`) walks `click-memory recall → AX exact → AX fuzzy → cloud grounding` and stops at the first tier whose confidence clears the gate. The **cloud-grounding tier** is one Haiku call (Sonnet on a verified-miss re-ground; low thinking, grounding-only prompt, 30s timeout) on a screenshot downscaled to ≤1568px. An AX cold-window retry re-dumps the tree once after both AX tiers miss.

`os_smart_click` is the primary GUI tool: it captures a fresh window-scoped screenshot (`screencapture -R`), activates the target app, then runs the cascade. Vision-tier clicks are verified with a before/after capture and `classifyOutcome`; a `no_op`/`wrong_target` records a click-miss, returns `click_unverified`, and triggers one self-correcting re-ground. Successful clicks feed `click-memory.ts` (`data/click-memory.db`) and `drift-calibration.ts`. Screen-driving tools run sequentially, and screenshots become image parts with only the newest few kept in history.

Kill-switches: `ATLAS_NO_CLICK_MEMORY`, `ATLAS_NO_DRIFT_CALIBRATION`, `ATLAS_NO_CLOUD_GROUNDING`, `ATLAS_NO_SMARTCLICK_VERIFY` / `ATLAS_NO_SMARTCLICK_SELFCORRECT`, `ATLAS_NO_AX_RETRY`, `ATLAS_NO_WINDOW_SCOPED_CAPTURE`, `ATLAS_NO_AGENT_CURSOR`, `ATLAS_NATIVE_AX` (opt-in Rust walker).

### Video Studio

Project-scoped pipeline under `data/video-projects/vid_YYYY_MM_DD_<n>/`. Inputs are hash-addressed for reproducibility. Stages: ingest → scene detection → beat sync → AI edit planner (LLM-driven timeline JSON) → FFmpeg render. Smoke-testable via `npm run smoke:video`.

### Meta-Harness Optimizer

A registry (`src/harness/registry.ts`) catalogs 30+ tunable dimensions (numeric weights, thresholds, k-values, phase ratios, role prompts) as live get/set descriptors. An NSGA-II Pareto optimizer (`native/src/harness_optimizer.rs`) plus a GP surrogate model and TextGrad-style prompt refinement run offline to tune these dimensions. The active config in `data/harness/active/harness-config.json` overrides defaults at boot; reads go through `getDimensionValue(id) ?? hardcodedDefault` so the system degrades gracefully if the registry is not initialized.

---

## Getting Started

### Prerequisites

- **Node.js 20.19+ or 22.12+** (older 20.x/22.x silently skip Vitest's native bundler binding, so tests can't start)
- **Rust toolchain** — required to build the native module; JS fallback is available but slower
- **Docker** — optional, for sandboxed tool execution
- **Swift** — macOS-only, for the OCR and CoreLocation helpers (skipped automatically elsewhere)

### Setup

```bash
# Install dependencies
npm install

# Copy and edit environment template
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, ATLAS_OTPLESS_USER_ID

# Build native Rust + Swift helpers + TypeScript
npm run build:all

# In one terminal: start Convex dev backend
npx convex dev

# In another terminal: run the agent
npm run dev          # tsx --watch (hot reload)
# OR
npm start            # production (after npm run build)
```

### Desktop App

```bash
cd desktop
npm install
npm start                  # Run Electron locally
npm run build:mac          # Build signed macOS DMG
npm run build:win          # Build Windows NSIS installer
```

### Configuration

LLM provider keys live only in Convex env, and the Convex URLs are bundled with the app — end users do not configure them. Only the channel credentials below need to be filled in (the desktop wizard can set most of them up for you).

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token from `@BotFather` |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `ATLAS_OTPLESS_USER_ID` | Yes | OTPless identity for Convex account |
| `PRIMARY_CHANNEL` | No | `telegram` (default), `whatsapp`, `discord`, `slack`, `overlay`, `email`, `matrix` |
| `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_WHITELIST` | No | IMAP/SMTP credentials + allowed senders |
| `WHATSAPP_ALLOWED_JIDS` | No | Comma-separated WhatsApp JIDs |
| `DISCORD_BOT_TOKEN` / `DISCORD_ALLOWED_USER_IDS` | No | Discord bot credentials |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | No | Slack Socket Mode credentials |
| `MATRIX_HOMESERVER` / `MATRIX_USER_ID` / `MATRIX_PASSWORD` | No | Matrix client credentials |
| `WIDGET_TOKEN` | No | Authenticates the embeddable web widget |
| `GITHUB_TOKEN` | No | GitHub API integration |
| `HF_TOKEN` | No | HuggingFace token (gated embedding models) |
| `ATLAS_EMBEDDING_MODEL` | No | `minilm` (default) or `nomic` |
| `LIVE_VOICE_NAME` / `LIVE_VOICE_BACKEND` | No | Voice preferences (Gemini/OpenAI/hybrid) |
| `ATLAS_VISION_PROFILE` | No | `standard` (default) or `lite` |
| `ATLAS_NO_CLICK_MEMORY` | No | Disable persistent click-memory recall/record |
| `ATLAS_NO_DRIFT_CALIBRATION` | No | Disable per-monitor drift correction |
| `ATLAS_NO_CLOUD_GROUNDING` | No | Disable the cloud-grounding cascade tier |
| `ATLAS_NO_SMARTCLICK_VERIFY` | No | Trust vision-tier clicks without before/after verification |
| `ATLAS_NATIVE_AX` | No | Opt-in Rust accessibility-tree walker (off by default) |
| `ATLAS_NATIVE_VAD` / `ATLAS_VAD_MODE` | No | Opt-in libfvad barge-in (hybrid voice only); aggressiveness 0–3 |
| `ATLAS_NO_COST_ROUTING` | No | Disable the cost-aware Opus-cap routing net |
| `ATLAS_NO_AGENT_CURSOR` | No | No ghost cursor / control glow during computer use |
| `ATLAS_WORKSPACE` | No | Where user-facing artifacts land (default `~/Desktop/Bhai Files`) |
| `ATLAS_NO_MEMORY_GATE` / `ATLAS_MEMORY_GATE_SHADOW` | No | Disable / shadow-only the memory write value-gate |
| `ATLAS_NO_THREAT_SCAN` / `ATLAS_NO_OSV_CHECK` | No | Disable threat-pattern scanning / OSV malware MCP pre-install check |
| `ATLAS_NO_FORGE` / `ATLAS_NO_FORGE_VERIFIER` | No | Disable Skill Forge entirely / its closed-loop verifier |
| `ATLAS_ENV` | No | `prod` to flip Convex client to production deployment |
| `MEMORY_DEBUG` | No | Verbose memory subsystem logging |
| `ATLAS_PROACTIVE_DISABLE` | No | Emergency global mute for proactive sends |
| Marketing platform keys | No | `IG_*`, `LI_*`, `X_*`, `FB_*`, `TIKTOK_*`, `REDDIT_*`, `PH_*` — per-brand suffixed |

---

## Key Design Patterns

- **ES Modules** — `"type": "module"`, `NodeNext` module resolution throughout
- **Fail-open architecture** — Native module unavailable → JS fallback; memory crash → agent continues without persistence; tool not found → skip and try next approach
- **Semantic over keyword** — Tool selection, query classification, and memory recall all use transformer embeddings + cosine similarity, not regex
- **Parallelization with ordering** — Memory retrieval fully parallel; browser tools sequential (shared page state), others parallel; boot I/O non-blocking where safe
- **Token budget injection** — All memory snippets capped (traits ≤ 600 tok, total ≤ 2-3K tok) to prevent prompt bloat
- **Cascade escalation** — Errors accumulate → auto-upgrade to higher-cost tier, both in main agent and sub-agents
- **Multi-layer caching** — LLM responses (embedding similarity), tool results (per-tool TTLs), memory queries (temporal cache + bloom filter)
- **Dependency injection** — `LLMClient` created once at boot and passed into every subsystem; never imported as a singleton
- **OpenAI-compatible types** — All LLM interactions use `openai` package types regardless of provider, since Convex translates them for the Claude API
- **Plan-mode runtime gating** — `plan` / `spec` / `awaiting_approval` / `awaiting_dynamic_tool_approval` / `act` each have explicit tool allowlists enforced before and during LLM calls
- **Never fake done** — Mutating work is verified before the agent says it is finished; otherwise it ends with a `[[STUCK]]` report the channel turns into Retry / Skip / take-over
- **Graceful shutdown** — Every subsystem registers cleanup handlers

---

## Runtime Data

All runtime artifacts live under `data/` (gitignored). User-facing artifacts (design docs, walkthroughs, scaffolded projects, generated images) land under `~/Desktop/Bhai Files/` instead.

```
data/
├── memory.db                        # SQLite — all memory subsystems
├── codebase-index/<repo-hash>.db    # Per-repo tree-sitter + FTS5 index
├── click-memory.db                  # Persistent learnt-click sites (Vision Nav)
├── memory-gate.jsonl                # Write value-gate audit
├── orchestrator-routing.jsonl       # Plan-tier routing log
├── long-tasks/                      # Checkpoint JSON for resumable tasks
├── research/                        # Saved research results (markdown)
├── browser-profile/                 # Persistent Playwright profile (cookies, cache)
├── agent-worktrees/<step-id>/       # Throwaway git worktrees for parallel coders
├── video-projects/vid_YYYY_MM_DD_<n>/  # Video Studio projects
├── harness/active/harness-config.json  # Active meta-harness tuning
├── harness/runs/<run_id>/           # Per-run candidates, traces, leaderboard
├── proactive-config.json            # Per-channel postures, night windows
├── whatsapp-users/                  # Owners, contacts, personas, groups (JSON)
├── google-credentials.json + google-tokens/
├── logs/proactive-<date>.log
└── decomposition-templates.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 20, TypeScript 5.7 (ES2022, strict, NodeNext) |
| Native acceleration | Rust (napi-rs), SIMD via `wide` + `simsimd`, `rayon` parallelism, `aes-gcm` |
| Database | SQLite (`better-sqlite3`) — local only, per-user |
| Backend | Convex 1.34 (serverless functions, real-time sync, HTTP actions) |
| LLM | Claude API via Convex (Haiku / Sonnet / Opus); Grok for the unhinged persona |
| Embeddings | MiniLM 384-dim default, Nomic 768→256-dim optional (`@xenova/transformers`) |
| Browser automation | Playwright 1.51 + Chrome Extension dual backend |
| Vision-nav | Accessibility tree + click memory + cloud grounding (Haiku, then Sonnet); no local models |
| Desktop | Electron 42 with `electron-builder`, `bytenode` protected modules |
| Telegram | `grammy` 1.35 |
| Discord | `discord.js` 14 |
| Slack | `@slack/bolt` 4 (Socket Mode) |
| Matrix | Matrix JS client |
| WhatsApp | `@whiskeysockets/baileys` 7 |
| Email | `imapflow` + `nodemailer` |
| Code parsing | `tree-sitter` 0.22 (TypeScript default; Python/Rust/Go gated) + regex fallback |
| MCP | `@modelcontextprotocol/sdk` 1.9 |
| Voice | Whisper, Kokoro TTS, ElevenLabs, Gemini Live, OpenAI Realtime, libfvad (opt-in) |
| Media | `ffmpeg-static`, `ffprobe-static`, `fluent-ffmpeg`, `sharp`, `pdf-lib`, `pptxgenjs`, `docx` |
| Validation | `zod` 4 |
| Encryption | AES-256-GCM + ECDH P-256 (native Rust + Node `crypto`) |
| Linting / testing | Biome 2, Vitest 4, tsx 4 |

---

*Proprietary software. Copyright &copy; 2024-2026 TRUSCOR Private Limited. All rights reserved.*

*Website: [tryatlasagi.com](https://tryatlasagi.com)*
