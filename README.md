<div align="center">
  <img src="./desktop/logo.png" alt="Bhai Logo" width="120" />
  <h1>Bhai</h1>
  <p><b>Advanced Technology for Logical Autonomous Systems</b></p>
  <p>v0.2.1 &middot; Autonomous Personal AI Agent &middot; Built by <a href="https://tryatlasagi.com">XAGI Labs</a></p>
</div>

---

## Overview

**Bhai** is an autonomous personal AI agent engineered for people who want more than a chatbot. It is a continuously running process that takes action, remembers what happened, reasons about what to do next, and keeps working while you sleep. The runtime combines a Node.js/TypeScript orchestration surface (~770 `.ts` files across src/) with a native Rust performance layer (78 `.rs` modules) compiled through napi-rs for SIMD-accelerated vector math, routing, memory operations, and cross-OS accessibility-tree walking.

Bhai is built for operators, founders, and researchers who need a single system that can drive a browser, write and ship code, run deep research, orchestrate multi-agent swarms, manage a marketing funnel across nine social platforms, and hold a real conversation across Telegram, Discord, Slack, Matrix, WhatsApp, email, and a native desktop overlay — all from one codebase, one memory, and one identity.

What makes Bhai different is that it is **not stateless**. A 70-module organic memory system (SQLite + HNSW vectors + knowledge graph) captures episodic trajectory, emotional tone, user models, traits, goals, and task learnings. Writes pass through an LLM value-gate that rejects low-signal noise before it reaches the store, context compression preserves a structured 13-section continuity summary across long sessions, and a full conversation corpus is searchable via FTS5. A nightly dream-replay pass consolidates the day, decays irrelevant data every six hours, and seeds the next morning's proactive brief. The agent also reasons about its own reasoning via a tiered metacognition engine and a meta-harness optimizer that tunes 30+ internal dimensions through NSGA-II Pareto search.

Security and privacy are foundational rather than bolted on. Every LLM call is proxied through a Convex backend with end-to-end ECDH P-256 + AES-256-GCM encryption — API keys never leave the server, system prompts never leave the server, and the client device only ever holds a short-lived session token bound to its ECDH shared key. All memory, all browser profile state, and all generated artifacts live locally on the user's machine.

---

## Feature Highlights

- **Multi-Channel Presence** — First-class integrations with Telegram, Discord, Slack, Matrix, WhatsApp (Baileys), IMAP/SMTP email, a native Electron desktop overlay, a WebSocket canvas surface, and an embeddable web widget.
- **Organic Memory** — 70 memory modules spanning core store, knowledge graph, HNSW vector index, episodic milestones, emotional trajectory, traits, identity, session, relationship, world/user/self models, working memory, Hopfield associative recall, active inference, prospective, counterfactual, temporal cache, project memory, Memory Studio insights, and nightly dream replay. An LLM value-gate guards every write (shadow mode by default), a structured 13-section template carries continuity through context compression, and `session_search` exposes the full conversation corpus over FTS5.
- **Native Rust Acceleration** — 78 Rust modules (SIMD via `wide`/`simsimd`, `rayon` parallelism) delivering ~15-20x speedup on vector ops, model routing, HNSW search, swarm/mesh orchestration, metacognition, MCTS, the harness optimizer, secrets sanitization, and cross-OS AX tree walking.
- **Vision Navigation** — Tiered Perception Cascade (`src/screen/`) for autonomous computer use. Capability detector auto-picks one of three profiles (Lite/Standard/Full) on boot; perception-router walks click-memory → AX exact → AX fuzzy → OmniParser → UI-TARS → cloud grounding (Qwen) with confidence gating; persistent click-memory + per-monitor drift calibration learn across sessions. `os_smart_click` auto-captures a window-scoped screenshot, activates the target app, and verifies vision-tier clicks (re-grounding on a verified miss). UI-TARS quants are health-checked and auto-pulled; OmniParser self-provisions its venv + weights. `os_smart_click` is the agent's primary GUI interaction tool.
- **Semantic Tool Selection** — MiniLM 384-dim embeddings route user intent across 20+ tool categories and 120+ tool implementations. A `request_tools` meta-tool lets the agent expand its surface mid-task.
- **Four-Tier Orchestration** — Sub-Agent (specialized roles), Swarm (decomposition + evaluator-optimizer), Mesh (parallel DAG with layered recovery), Long-Task (multi-phase checkpointed execution up to 100 phases).
- **Deep Research** — Three-phase research engine, 12 pluggable search backends, up to 500 sources per run, hypothesis generation and testing, source credibility scoring, relevance reranking.
- **E2E Encrypted LLM Proxy** — ECDH P-256 + AES-256-GCM on top of HTTPS; 24h session tokens; atomic credit deduction; system prompts assembled server-side.
- **Proactive Behaviors** — Heartbeat engine with per-channel postures (calm / active / ambient), nightly dream replay during detected sleep windows, quiet-hours guard, urgency bypass rules, shadow mode for dry runs. 110+ files spanning observer pipeline, composer fast-path, intent sources (calendar, news, stale email, weather, tasks, onboarding graduation, source gates), telemetry, and the proactive inbox.
- **Memory Studio** — Interactive graph viewer with edit/pin/forget controls and AI-generated insights over the local memory database (`src/memory/studio-graph.ts`, `studio-insights.ts`).
- **Video Studio** — Project-scoped video pipeline (49 files) with AI edit planning, scene detection, beat sync, FFmpeg render stage, and reproducible hash-addressed inputs.
- **Meta-Harness Self-Optimizer** — 30+ tunable dimensions (weights, thresholds, k-values, phase ratios) tuned via NSGA-II Pareto search, GP surrogate modeling, and TextGrad-style prompt refinement.
- **A2A Protocol** — Google Agent-to-Agent protocol for inter-agent delegation and negotiation across trusted peers.
- **CAPTCHA Solver** — Four-tier ladder: passive detection, audio-challenge bypass, NopeCHA, 2captcha fallback.
- **Voice Mode** — Local ASR/TTS (Whisper, Kokoro), ElevenLabs TTS, Gemini Live voice, OpenAI Realtime voice, libfvad-backed barge-in detection (opt-in), wake-word detection, Telegram voice-note pipeline.
- **Marketing Brain** — Native integrations with Instagram, LinkedIn, TikTok, X/Twitter, Facebook Pages, YouTube, Reddit, Product Hunt, plus content calendars, cold outreach, lead finding, and trend research.
- **Coding Pipeline** — Design-doc gating, LSP integration, per-repo codebase index (SQLite + tree-sitter + FTS5 BM25), agent git worktrees for parallel coders, code critic (compile/test/lint/SAST), and walkthrough generation.
- **Tiered Metacognition** — The agent assesses its own reasoning between iterations: content-aware loop detection, an intervention dispatcher (escalate / replan / critics / ask-user), a value-of-computation cost threshold that suppresses low-payoff interventions, and shadow-mode confidence calibration. A per-turn guardrail also kills identical-args tool-call loops.
- **Cost-Aware Routing** — On top of the Light/Pro/Heavy tiers, a native cost router down-routes casual chat to cheap rungs (GPT-5 nano / mini), gates Opus to genuinely complex work, and tracks each model's context window for token-aware pruning and failover.
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
│70 mod│ │50 mod │ │ 120+ t  │ │ 11 mod │ │110+ mod │ │ 23 mod  │
└──────┘ └───────┘ └─────────┘ └────────┘ └─────────┘ └─────────┘
   │         │          │          │          │           │
┌──▼─────────▼──────────▼──────────▼──────────▼───────────▼───────────────────┐
│                     Native Rust Layer (78 .rs modules)                       │
│  SIMD vectors · Model router · HNSW · Swarm/Mesh · Metacognition · MCTS      │
│  Harness optimizer · Hopfield · Active inference · Credibility · Proactive   │
│  AX walker · Secrets sanitizer · PCM VAD · Spreading · Query classifier      │
└─────────────────────────────────────────────────────────────────────────────┘
    │
┌───▼──────────────────────────────────────────────────────────────────────────┐
│                           Convex Backend (convex/)                           │
│  LLM proxy (E2E encrypted) · Sessions (24h TTL) · Credits (atomic)           │
│  Rate limits · Store marketplace · System prompts · System skills            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Source Layout

```
src/                                  # ~770 TypeScript files (incl. tests)
├── index.ts                          # Ordered + parallelized boot sequence
├── agent.ts                          # Core agent loop (runAgent)
├── llm.ts                            # LLM client (proxied through Convex)
├── llm-middleware.ts                 # Pre/post LLM middleware layer
├── llm-cache.ts                      # Semantic response cache (cosine > 0.88)
├── llm-parsers/                      # 6 files — provider-specific response parsers
├── crypto-transport.ts               # ECDH P-256 + AES-256-GCM encrypted fetch
├── crypto-kdf.ts                     # Machine-stable secret KDF
├── context-scrubber.ts               # Secrets-scrubbing pass for outbound payloads
├── model-router.ts                   # Model tier selection (wraps native Rust)
├── tool-router.ts                    # Semantic tool selection via MiniLM
├── language.ts                       # Adaptive language detection & matching
├── alive-ux.ts                       # Centralized personality + phrasing
├── network-health.ts                 # Online/degraded/offline monitor
├── account-guard.ts session.ts       # Credit/session middleware
├── telegram.ts | discord.ts | slack.ts | matrix.ts | whatsapp.ts | email.ts
│
├── agents/                           # 50 files — four-tier orchestration
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
├── memory/                           # 70 files — organic memory system
│   ├── sqlite.ts                     # Primary store (remember / recall / core)
│   ├── knowledge-graph.ts vector-index.ts embeddings.ts embedding-cache.ts
│   ├── resolve-embedding.ts memory-tiers.ts fts5-query.ts
│   ├── reflection.ts                 # Nightly dream replay + decay
│   ├── emotional.ts episodic.ts identity.ts traits.ts session.ts
│   ├── relationship.ts self-state.ts self-model.ts goals.ts anticipation.ts briefing.ts
│   ├── working-memory.ts hopfield-memory.ts spreading-activation.ts
│   ├── world-model.ts user-model.ts active-inference.ts counterfactual.ts prospective.ts
│   ├── sleep-gate.ts surprise-gate.ts reranker.ts strategy-library.ts self-evolving.ts
│   ├── value-gate.ts gate-audit.ts            # LLM write value-gate + JSONL audit (10MB rotation)
│   ├── compression-template.ts                # Structured 13-section continuity summary
│   ├── codebase-sidecar.ts codebase-merkle.ts codebase-index.ts code-parse/
│   ├── multimodal.ts multimodal-embedding.ts project-memory.ts memory-informed-planning.ts
│   ├── studio-graph.ts studio-insights.ts    # Memory Studio (graph viewer + AI insights)
│   ├── supabase.ts                            # Optional cloud sync (off by default)
│   └── classifier.ts context-pruning.ts consolidation.ts temporal-cache.ts
│
├── screen/                           # 23 files — Vision Navigation subsystem
│   ├── capability-detector.ts        # Picks Lite/Standard/Full profile at boot
│   ├── perception-router.ts          # Tiered Perception Cascade (memory→AX→OmniParser→UI-TARS→cloud)
│   ├── ax-dump.ts                    # Cross-OS accessibility tree dumping (TS + native fallback)
│   ├── omniparser.ts omniparser-setup.ts  # OmniParser captions + venv/weights auto-provisioner
│   ├── ui-tars.ts                    # UI-TARS grounding + inference health-check + auto-pull
│   ├── cloud-grounding.ts            # Cloud VLM grounding tier (Qwen3.7-plus → Qwen3-VL-235B)
│   ├── click-memory.ts               # Persistent learnt-click recall (data/click-memory.db)
│   ├── drift-calibration.ts          # Per-monitor affine drift correction
│   ├── outcome-classifier.ts         # Click-success vs miss classification feedback
│   ├── spawn-detached.ts             # Detached background pulls (survive bot exit)
│   ├── computer-action.ts            # Structured action schema (mouse/keyboard/scroll)
│   └── screen-dimensions.ts          # Multi-monitor coord-system reconciliation
│
├── tools/                            # 149 files — tool implementations
│   ├── browser/                      # 21 files — Playwright + Chrome Extension backends
│   ├── coding/                       # 34 files — edit/write/grep/glob/lsp/git/codebase
│   ├── os-smart-click.ts             # Primary GUI click tool (uses perception-router)
│   ├── os-computer-action.ts os-grounding.ts os-inspect.ts
│   ├── platform.ts platform-info.ts platform-bridge.ts macos.ts linux.ts windows.ts
│   ├── shell.ts files.ts memory-tools.ts session-search.ts deep-research.ts
│   ├── github-api.ts google-api.ts spotify.ts apple-notes.ts sonos.ts
│   ├── generate-image.ts blender.ts audio-visualize.ts video-studio.ts
│   └── tool-intelligence.ts create-tool.ts repo-map.ts
│
├── forge/                            # 52 files — Skill Forge (dynamic-tool synthesis + Rust kernel sandbox)
├── research/                         # 11 files — deep research engine
├── harness/                          # 25 files — Meta-harness registry + optimizer
├── video-studio/                     # 49 files — Project-scoped video pipeline
├── marketing/                        # 29 files — 9-platform marketing brain
├── proactive/                        # 111 files — heartbeat, dreaming, composer, dispatch, inbox, monitors, sources
├── planning/                         # 4 files — MCTS, hierarchical planner, logic verifier
├── execution/                        # Speculative execution patterns
├── social/                           # emotion-detector.ts (lexicon + punctuation heuristic)
├── models/                           # 5 files — Local ASR/TTS/OCR/vision + FunctionGemma
├── voice/                            # 31 files (incl. live/, 26) — TTS, transcription, live voice
├── documents/                        # 10 files — block-based doc renderer + templates
├── config/                           # Keys, paths, protected config loader
├── security/                         # 17 files — threat patterns, URL/SSRF guard, OSV check, skill scanner, secrets sanitizer, allowlist, sandbox
├── mcp/                              # 2 files — Model Context Protocol + gitmcp bridge
├── diagnostics/                      # /doctor system probe (Convex, session, credits, native, env, memory)
├── hooks/                            # 3 files — Built-in pre/post tool hooks
├── cron/                             # 6 files — Schedule parser + store + tick
├── skills/                           # 3 files — Skill loader (frontmatter markdown)
├── store/                            # 6 files — Marketplace + hot-reload + sideload
├── canvas/                           # WebSocket canvas channel
├── commands/                         # Slash command parsing (/recap, /doctor, ...)
├── location/                         # 7 files — GPS → Wi-Fi → IP fallback
├── notifications/                    # Web-push delivery
├── widget/                           # Embeddable chat widget IIFE
├── overlay/                          # Electron overlay chat server + overlay.html
├── setup/                            # Wizard + profile + persona seeding
└── prompts/                          # 8 files — Dynamic prompt assembly + persona bias + watermark

native/src/                           # 78 Rust modules (napi-rs + SIMD)
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

convex/                               # Serverless backend (30 .ts files)
├── http.ts                           # LLM proxy with E2E encryption
├── sessions.ts accounts.ts crypto.ts systemContent.ts
├── schema.ts                         # accounts, sessions, rate_limits, llm_usage/log, store, system content, waitlist, prompt addenda
└── store/                            # items, submissions, developers, installs, reviews

desktop/                              # Electron app (setup wizard, panel, tray)
├── installer/                        # Phase runner — Ollama, Python venv, vision deps
├── wizard/                           # First-run wizard (incl. vision-intelligence tier step)
└── components/ detection/ migration/ hostinger-upload/

chrome-extension/                     # User-side Chrome automation bridge
portals/                              # Next.js admin-panel + developer-portal
prompts/                              # Source-of-truth for seeded system prompts
skills/                               # Source-of-truth for seeded skills
scripts/                              # Swift helpers (OCR, GPS, AX dump), Convex seeds, hotkeys
```

---

## Core Systems

### LLM Client & Transport

The `LLMClient` is created once at boot by `createLLMClient(config)` and dependency-injected into every subsystem (agent, swarm, research, memory writes, marketing, etc.). `.chat()` builds messages, adds dynamic context (clock, widget hints), and POSTs to `${convexSiteUrl}/api/llm/chat` via `encryptedFetch()`, which runs ECDH P-256 key exchange on first use and wraps every subsequent request body in AES-256-GCM. The server prepends its own system prompt from the `system_prompts` table before forwarding to OpenRouter. Client-side layers add a semantic response cache (cosine ≥ 0.88, 10 min TTL, 200-entry LRU; bypassed for tool-call and thinking-mode requests) and adaptive language matching across Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, Latin scripts, and Romanized Hindi.

### Model Router

A thin TypeScript wrapper (`src/model-router.ts`) around a native Rust binary (`native/src/model_router.rs`). Decision inputs: iteration count, error count, last tool calls, media presence, user hint (`"simple"`/`"complex"`), coding complexity class. Falls back to pure JS if the native module fails to load.

| Tier | Cost | Models | Primary Use |
|------|------|--------|-------------|
| Light | 0.25 credits | Claude Haiku 4.5, Gemini 3 Flash / Flash Lite, Nova Lite / Micro, GPT-5 nano / mini | Casual chat, simple retrieval, chime-in decisions |
| Pro | 1 credit | Claude Sonnet 4.6 / 4.5, Gemini 3.1 Pro, Nova Pro | Browser automation, tool calling, coding |
| Heavy | 3 credits | Claude Opus 4.6 | Complex reasoning, deep research, planning |

Coding intent forces tier ≤ Pro via `maybeEscalateForCoding`. Errors accumulate → cascade escalation steps up the ladder automatically. A cost-aware net (native `select_dynamic_model`) down-routes the cheapest user-facing rungs to GPT-5 nano (`pn≤3 & score≤15`) / GPT-5 mini (`pn≤4 & score≤25`) and gates Opus to genuinely complex work; disable with `ATLAS_NO_COST_ROUTING`. The router is also context-window-aware per model, driving token-aware pruning and failover. A dedicated `tool_synthesis` task type routes Skill Forge synthesis to Sonnet (or Opus in dream-replay). Qwen3.7-plus / Qwen3-VL-235B back the Vision-Nav cloud-grounding tier rather than the agent loop.

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

Additional optimization and reliability layers: evaluator scoring, replanner, mixture-of-agents, speculative racing, metacognition, multi-critic review, code-critic (compile/test/lint/SAST with Semgrep), TextGrad refinement, self-editor, self-heal, per-coder git worktrees, shared blackboard.

### Tool Router

Semantic selection using MiniLM embeddings (384-dim, `@xenova/transformers`). On boot each tool category description is embedded and cached. Per message: user query is embedded, cosine similarity selects the top-K categories, tool schemas for those categories are loaded into the LLM call. A `request_tools` meta-tool lets the agent request additional categories mid-task. Optional FunctionGemma fallback (270M model via Ollama) provides zero-cost routing at ~85% accuracy. 20+ categories cover core, memory, browser, file_system, shell, system_control, media, integrations, research, coding, marketing, and more.

### Deep Research

Background research engine with its own execution loop. `executor.ts` drives up to 500 sources; `engines.ts` abstracts 12 pluggable search backends; `fetcher.ts` handles HTML → text; `hypothesis-engine.ts` generates and tests hypotheses; `credibility-model.ts` scores source reliability; `scoring.ts` + reranker handle relevance; results persist to `data/research/` as markdown.

### Proactive Engine

Per-channel posture drives delivery cadence. Each channel maps to one of three presets:

| Posture | Max/day | Min gap | Heartbeat | Boundary only | Urgent bypass |
|---------|---------|---------|-----------|---------------|---------------|
| calm    | 3       | 120 min | 120 min   | yes           | yes           |
| active  | 8       | 45 min  | 60 min    | no            | yes           |
| ambient | 1       | 360 min | 240 min   | yes           | yes           |

Defaults: WhatsApp/Discord/Slack/Matrix → calm; Telegram → active; Overlay/Email → ambient. Config in `data/proactive-config.json`, reloads at runtime. Night windows (default 22:30-07:00) throttle deliveries; `urgentAllowedAfter` sets the earliest non-urgent hour. Kill-switches per source and per channel; shadow mode composes and logs without delivering.

### Vision Navigation

Autonomous GUI control without depending on a single cloud VLM. `src/screen/capability-detector.ts` profiles the host machine at boot (RAM, CPU, GPU class, free disk, Ollama presence) and picks one of three profiles:

| Profile  | When picked                              | Stack |
|----------|------------------------------------------|-------|
| Lite     | Low-spec Windows / no GPU / Ollama missing | AX tree only |
| Standard | Typical laptop with ≥8 GB RAM             | AX + OmniParser captions |
| Full     | Apple-silicon or discrete GPU + Ollama    | AX + OmniParser + UI-TARS grounding |

The Tiered Perception Cascade (`perception-router.ts`) walks `click-memory recall → AX exact → AX fuzzy → OmniParser → UI-TARS → cloud grounding` and stops at the first tier whose confidence clears the gate (memory 0.90, AX exact 0.95 / fuzzy 0.80, OmniParser 0.80, UI-TARS 0.70, cloud grounding 0.60). The **cloud-grounding tier** (Qwen3.7-plus → Qwen3-VL-235B fallback) fires on Lite/Standard and degraded-Full hosts when local tiers miss, so even GPU-less machines get a working grounder. An AX cold-window retry re-dumps the tree once after both AX tiers miss (freshly-activated windows often have an incomplete first dump).

`os_smart_click` is the primary GUI tool: it auto-captures a screenshot (window-scoped via `screencapture -R` when the focused window's bounds are known, else full-screen), activates the target app first, then runs the cascade. Vision-tier clicks (OmniParser / UI-TARS / cloud) are verified with a before/after capture and `classifyOutcome`; a `no_op`/`wrong_target` records a click-miss, returns `click_unverified` instead of a false success, and triggers one self-correcting re-ground past the failed tier (AX/memory tiers stay trusted, no verify). UI-TARS quants are smoke-tested for vision inference (`isUITarsHealthy`) so a pulled-but-broken GGUF skips straight to cloud grounding; missing quants auto-pull (detached) on Full hosts, and OmniParser self-provisions its venv + `icon_detect` weights, gated by `omniParserWeightsPresent()`.

Successful clicks feed `click-memory.ts` (SQLite at `data/click-memory.db`) and `drift-calibration.ts` (per-monitor affine correction) so the agent gets faster and more accurate over time. Override the picked profile with `ATLAS_VISION_PROFILE=lite|standard|full`. Kill-switches: `ATLAS_NO_CLICK_MEMORY`, `ATLAS_NO_DRIFT_CALIBRATION`, `ATLAS_NO_CLOUD_GROUNDING`, `ATLAS_NO_OMNIPARSER` / `ATLAS_NO_OMNIPARSER_AUTOSETUP`, `ATLAS_NO_UI_TARS_AUTOPULL`, `ATLAS_NO_UITARS_HEALTHCHECK`, `ATLAS_NO_SMARTCLICK_VERIFY` / `ATLAS_NO_SMARTCLICK_SELFCORRECT`, `ATLAS_NO_AX_RETRY`, `ATLAS_NO_WINDOW_SCOPED_CAPTURE`, `ATLAS_NATIVE_AX` (opt-in Rust walker).

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

OpenRouter and Convex keys are bundled with the app — end users do not configure them. Only the channel credentials below need to be filled in.

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
| `ATLAS_VISION_PROFILE` | No | Override capability-detector pick: `lite` / `standard` / `full` |
| `ATLAS_NO_CLICK_MEMORY` | No | Disable persistent click-memory recall/record |
| `ATLAS_NO_DRIFT_CALIBRATION` | No | Disable per-monitor drift correction |
| `ATLAS_NO_CLOUD_GROUNDING` | No | Disable the Qwen cloud-grounding cascade tier |
| `ATLAS_NO_OMNIPARSER_AUTOSETUP` | No | Skip background OmniParser venv/weights provisioning |
| `ATLAS_NO_UI_TARS_AUTOPULL` | No | Don't auto-pull the UI-TARS quant on Full hosts |
| `ATLAS_NO_SMARTCLICK_VERIFY` | No | Trust vision-tier clicks without before/after verification |
| `ATLAS_NATIVE_AX` | No | Opt-in Rust accessibility-tree walker (off by default) |
| `ATLAS_NATIVE_VAD` / `ATLAS_VAD_MODE` | No | Opt-in libfvad barge-in (hybrid voice only); aggressiveness 0–3 |
| `ATLAS_NO_COST_ROUTING` | No | Disable the cost-aware Opus-cap routing net |
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
- **OpenAI-compatible types** — All LLM interactions use `openai` package types regardless of provider, since Convex proxies through OpenRouter
- **Plan-mode runtime gating** — `plan` / `spec` / `awaiting_approval` / `awaiting_dynamic_tool_approval` / `act` each have explicit tool allowlists enforced before and during LLM calls
- **Graceful shutdown** — Every subsystem registers cleanup handlers

---

## Runtime Data

All runtime artifacts live under `data/` (gitignored). User-facing artifacts (design docs, walkthroughs, scaffolded projects, generated images) land under `~/Desktop/Bhai Files/` instead.

```
data/
├── memory.db                        # SQLite — all memory subsystems
├── codebase-index/<repo-hash>.db    # Per-repo tree-sitter + FTS5 index
├── click-memory.db                  # Persistent learnt-click sites (Vision Nav)
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
| LLM providers | OpenRouter — Anthropic (Opus/Sonnet/Haiku 4.x), Google Gemini (2.x/3.x), Amazon Nova, OpenAI GPT-5 (nano/mini), DeepSeek, GLM, Qwen |
| Embeddings | MiniLM 384-dim default, Nomic 768→256-dim optional (`@xenova/transformers`) |
| Browser automation | Playwright 1.50 + Chrome Extension dual backend |
| Vision-nav models | OmniParser (captions) + UI-TARS (grounding) via Ollama; Qwen3.7-plus / Qwen3-VL-235B cloud-grounding fallback |
| Desktop | Electron 40+ with `electron-builder`, `bytenode` protected modules |
| Telegram | `grammy` 1.35 |
| Discord | `discord.js` 14 + `@discordjs/voice` |
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
| Linting / testing | Biome 2, Vitest 3, tsx 4 |

---

*Proprietary software. Copyright &copy; 2024-2026 XAGI Labs Private Limited. All rights reserved.*

*Website: [tryatlasagi.com](https://tryatlasagi.com)*
