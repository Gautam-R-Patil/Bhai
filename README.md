<div align="center">
  <img src="./desktop/logo.png" alt="A.T.L.A.S Logo" width="120" />
  <h1>A.T.L.A.S</h1>
  <p><b>Autonomous Thinking, Learning & Acting System</b></p>
  <p>v0.2.0 &mdash; A continuously running, proactive personal AI agent</p>
</div>

---

## Overview

**A.T.L.A.S** is an autonomous personal AI agent built with Node.js/TypeScript and a native Rust performance layer. It goes beyond conversational chatbots — it possesses autonomous computer use, deep research capabilities, multi-agent orchestration, and long-running async workflows. It reaches users through **Telegram**, **Discord**, **Slack**, **Matrix**, **WhatsApp**, a **desktop overlay (Electron)**, and **email**.

Key highlights:

- **Multi-vector organic memory** — 39-module memory system with knowledge graphs, episodic recall, emotional state, dream-based consolidation, and HNSW vector search
- **Native Rust acceleration** — 48 Rust modules compiled via napi-rs with SIMD operations for ~15-20x speedup on vector math, model routing, and memory operations
- **Dynamic LLM routing** — Cost-optimized model selection across Opus, Sonnet, Haiku, GPT-5.x, and Gemini with automatic cascade escalation on errors
- **Semantic tool selection** — MiniLM embedding-based routing across 20+ tool categories (58 tool files), not keyword matching
- **Four-tier agent orchestration** — Sub-Agent → Swarm → Mesh (parallel DAG) → Long-Task (multi-phase with checkpointing)
- **Deep research engine** — Background research with hypothesis generation, credibility scoring, and up to 500 sources
- **End-to-end encrypted LLM proxy** — ECDH P-256 + AES-256-GCM; API keys never leave the Convex backend
- **Proactive behaviors** — Heartbeat engine, scheduled tasks, nightly "dream" reflection during detected sleep windows

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Channels                                    │
│   Telegram  ·  Discord  ·  Slack  ·  Matrix  ·  WhatsApp           │
│   Desktop Overlay (Electron)  ·  Email (IMAP/SMTP)                  │
│   Canvas (WebSocket)                                                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                      Agent Loop (src/agent.ts)                      │
│  Memory retrieval (12 systems) → Model routing → Semantic tool      │
│  selection → LLM call → Tool execution → Completion check           │
│  Max 200 iterations · Cascade escalation · Mid-session credit gate  │
└────┬──────────────┬──────────────┬──────────────┬───────────────────┘
     │              │              │              │
┌────▼────┐  ┌──────▼──────┐  ┌───▼───┐  ┌──────▼──────┐
│ Memory  │  │   Agents    │  │ Tools │  │  Research   │
│ 39 files│  │  26 files   │  │58 files│  │  11 files   │
└─────────┘  └─────────────┘  └───────┘  └─────────────┘
     │              │              │              │
┌────▼──────────────▼──────────────▼──────────────▼───────────────────┐
│                   Native Rust Layer (48 .rs files)                   │
│  SIMD vectors · Model router · HNSW · Swarm/Mesh · Metacognition    │
└─────────────────────────────────────────────────────────────────────┘
     │
┌────▼────────────────────────────────────────────────────────────────┐
│                   Convex Backend (convex/)                           │
│  LLM proxy (E2E encrypted) · Sessions · Credits · Store · Prompts   │
└─────────────────────────────────────────────────────────────────────┘
```

### Source Layout

```
src/                        # 237 TypeScript files across 29 subdirectories
├── index.ts                # Boot sequence (ordered + parallelized init)
├── agent.ts                # Core agent loop
├── llm.ts                  # LLM client (proxied through Convex)
├── llm-middleware.ts        # LLM middleware layer
├── llm-cache.ts            # Semantic response cache
├── crypto-transport.ts     # ECDH + AES-256-GCM encrypted fetch
├── model-router.ts         # Model selection (wraps native Rust)
├── tool-router.ts          # Semantic tool selection via embeddings
├── language.ts             # Adaptive language detection & matching
├── telegram.ts             # Telegram channel
├── discord.ts              # Discord channel
├── slack.ts                # Slack channel (via @slack/bolt)
├── matrix.ts               # Matrix channel
│
├── agents/                 # 26 files — four-tier orchestration
│   ├── sub-agent.ts        #   Specialized roles (researcher, coder, browser, system)
│   ├── swarm.ts            #   Task decomposition → Mesh execution
│   ├── mesh.ts             #   Parallel DAG engine with error recovery
│   ├── long-task.ts        #   Multi-phase executor with checkpointing
│   ├── evaluator.ts        #   Quality scoring with retry loop
│   ├── replanner.ts        #   Mid-execution plan revision
│   ├── metacognition.ts    #   Self-monitoring and reasoning-about-reasoning
│   ├── mixture.ts          #   Mixture of Agents for complex tasks
│   ├── speculative.ts      #   Races alternative approaches
│   └── ...                 #   error-recovery, handoff, blackboard, etc.
│
├── memory/                 # 39 files — organic memory system
│   ├── sqlite.ts           #   Primary store (remember/recall/core memory)
│   ├── knowledge-graph.ts  #   Entity-relationship graph
│   ├── vector-index.ts     #   HNSW approximate nearest neighbor
│   ├── embeddings.ts       #   Text embedding generation
│   ├── reflection.ts       #   Nightly dream replay & decay
│   ├── emotional.ts        #   Emotional trajectory tracking
│   ├── episodic.ts         #   Episodic milestone memory
│   ├── hopfield-memory.ts  #   Associative recall
│   ├── active-inference.ts #   Predictive reasoning
│   ├── world-model.ts      #   Internal world state model
│   └── ...                 #   identity, traits, session, relationship, etc.
│
├── tools/                  # 58 files — tool implementations
│   ├── browser/            #   15 files (core, navigation, interaction, extraction, ...)
│   ├── shell.ts            #   Secure shell execution
│   ├── files.ts            #   File system operations
│   ├── deep-research.ts    #   Research tool entry point
│   ├── memory-tools.ts     #   Memory read/write tools
│   ├── github-api.ts       #   GitHub integration
│   ├── google-api.ts       #   Google APIs (Calendar, Drive, Gmail)
│   ├── generate-image.ts   #   Image generation
│   ├── system-controls.ts  #   OS-level controls
│   └── ...                 #   email, macos, sonos, blender, etc.
│
├── research/               # 11 files — deep research engine
│   ├── executor.ts         #   Research loop (up to 500 sources)
│   ├── engines.ts          #   Search provider abstraction
│   ├── hypothesis-engine.ts#   Hypothesis generation & testing
│   ├── credibility-model.ts#   Source credibility assessment
│   ├── scoring.ts          #   Relevance scoring
│   └── ...                 #   fetcher, persistence, analysis, profiles
│
├── planning/               # Hierarchical planning, MCTS, logic verification
├── execution/              # Speculative execution patterns
├── social/                 # Theory of mind, pragmatics, emotion detection
├── models/                 # Local model integrations (ASR, OCR, TTS, vision)
├── config/                 # Key management, paths, protected config loader
├── notifications/          # Push notification delivery
├── mcp/                    # Model Context Protocol server integration
├── plugins/                # Plugin system for extending capabilities
├── proactive/              # Heartbeat engine, dreaming, proactive behaviors
├── security/               # Sandboxing, input validation, Docker isolation
├── voice/                  # Voice processing, transcription, TTS, live voice mode
├── canvas/                 # WebSocket-based canvas channel
├── commands/               # Slash-command parsing
├── skills/                 # Skill file loader (frontmatter markdown)
├── store/                  # Skill marketplace functionality
├── types/                  # Shared TypeScript type definitions
├── utils/                  # JSON extraction, system resources, UUID
├── overlay/                # Inline overlay HTML
└── prompts/                # Prompt template helpers

native/src/                 # 48 Rust files — SIMD-accelerated core
├── lib.rs                  # napi-rs entry point
├── model_router.rs         # Task classification & cost/speed/quality scoring
├── tool_router.rs          # Embedding similarity & co-occurrence learning
├── hnsw.rs                 # Approximate nearest neighbor search
├── memory_state.rs         # Entity relationships & spreading activation
├── reflection_core.rs      # Dream replay consolidation
├── swarm.rs, mesh.rs       # Agent orchestration counterparts
├── metacognition.rs        # Advanced reasoning engine
├── mcts_engine.rs          # Monte Carlo Tree Search
├── active_inference.rs     # Predictive inference
├── world_model.rs          # World state modeling
├── hopfield.rs             # Hopfield network memory
├── sleep_gate.rs           # Memory consolidation gating
└── ...                     # working_memory, user_model, credibility_model, etc.

convex/                     # Convex backend
├── http.ts                 # HTTP actions — LLM proxy with E2E encryption
├── sessions.ts             # Session token management
├── accounts.ts             # Credit tracking with atomic deduction
├── schema.ts               # 11 tables (accounts, sessions, store_items, ...)
├── systemContent.ts        # Server-side system prompts
└── store/                  # Store-related backend functions

desktop/                    # Electron desktop app
├── main.js                 # Electron main process
├── panel.html              # Overlay panel UI
├── wizard.html             # Setup wizard
├── auth.html               # Authentication flow
└── ...                     # Preload scripts, styles, build config

overlay-app/                # Standalone overlay frontend
portals/
├── admin-panel/            # Admin dashboard
└── developer-portal/       # Developer-facing portal

prompts/                    # System prompt sources
├── identity.md             # Agent identity definition
├── rules.md                # Core behavioral rules
├── rules-mac.md            # macOS-specific rules
├── rules-windows.md        # Windows-specific rules
├── browsing.md             # Browser automation prompts
└── thinking.md             # Reasoning mode prompts

skills/                     # Built-in skill definitions (frontmatter markdown)
├── full_stack_developer.md
├── data_scientist.md
├── research_analyst.md
├── security_auditor.md
├── ui_ux_designer.md
└── ...                     # 12 skill files including Convex integrations

scripts/                    # Utility scripts
├── ocr_screen.swift        # macOS OCR helper (compiled to ocr_screen_bin)
├── seed-store.ts           # Seed store database
├── seed-system-content.ts  # Seed system prompts
└── ...                     # Hotkey scripts, overlay helpers
```

---

## Core Systems

### LLM Client & Encrypted Transport

All LLM calls are proxied through the Convex backend — the client never holds API keys.

1. `createLLMClient()` returns an `LLMClient` with a `.chat()` method
2. `.chat()` builds a message array with dynamic context (clock, widget hints) and sends to the Convex HTTP endpoint
3. Transport uses ECDH P-256 key exchange + AES-256-GCM encryption on top of HTTPS
4. Server prepends its own system prompt before forwarding to the LLM provider via OpenRouter

Additional client-side layers:
- **Semantic response cache** — Embedding-based similarity (cosine > 0.95), 10min TTL, 200 entries LRU
- **Adaptive language matching** — Unicode script analysis + keyword heuristics, supports Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, Latin-script languages, and Romanized Hindi/Hinglish

### Model Router

Native Rust binary (napi-rs) with JS fallback. Decision factors: iteration count, error count, last tool calls, media presence, user hints.

| Tier | Cost | Models | Use Case |
|------|------|--------|----------|
| Light | 0.25 credits | Haiku, Flash | Casual chat, simple retrieval |
| Pro | 1 credit | Sonnet, GPT-5.3 | Browser automation, tool calling |
| Heavy | 3 credits | Opus, GPT-5.4 | Complex reasoning, deep research |

### Memory System (39 modules)

All local SQLite (`data/memories.db`). No data leaves the user's machine.

| Layer | Purpose |
|-------|---------|
| Core store | `remember()`, `recall()`, `getCoreMemory()` |
| Knowledge graph | Entity-relationship map (people, tools, preferences) |
| Vector index | HNSW approximate nearest neighbor for semantic recall |
| Episodic & emotional | Interaction trajectory, emotional state, milestones |
| Identity & traits | Persistent agent personality with token-budgeted injection |
| Working memory | Short-term context + Hopfield associative recall |
| World & user models | Predictive models of environment and user behavior |
| Active inference | Predictive and counterfactual reasoning |
| Reflection | Nightly dream replay consolidation; decay every 6h |
| Task learnings | Persisted strategies for recurring task types |
| Strategy library | Reusable patterns from past executions |
| Sleep/surprise gates | Memory consolidation gating mechanisms |

12 memory systems fire in parallel on the first iteration of each agent invocation, with a total budget of ~2-3K tokens to avoid prompt bloat.

### Agent Orchestration (26 modules)

Four-tier execution model for tasks of increasing complexity:

| Tier | Description | Limits |
|------|-------------|--------|
| **Sub-Agent** | Specialized roles (researcher, coder, browser, system, general) with scoped tools, loop detection, error-driven model escalation | Per-iteration cost tracking |
| **Swarm** | Decomposes complex tasks into sub-agent steps, executes via Mesh, evaluator-optimizer loop | Max 20 steps |
| **Mesh** | Parallel DAG execution with critical path scheduling, layered error recovery (retry→rephrase→reroute→skip) | Dynamic role assignment |
| **Long-Task** | Multi-phase executor with checkpointing every 60s | 200 iter/phase, 30min/phase, 100 phases max |

Additional layers: evaluator scoring, replanning, mixture-of-agents, speculative racing, metacognition, multi-critic review, textgrad refinement, self-editing, and shared blackboard context.

### Tool Router

Semantic selection using MiniLM embeddings (384-dim):
- On boot: each tool category description is embedded and cached
- Per message: query embedded → cosine similarity → top-K categories loaded
- A `request_tools` meta-tool lets the agent request additional tools mid-task
- 20+ categories: core, memory, browser, file_system, shell, system_control, media, integrations, etc.

### Deep Research (11 modules)

Background research engine with its own execution loop:
- Search provider abstraction with multiple engines
- Content extraction and HTML→text conversion
- Hypothesis generation and testing
- Source credibility assessment
- Relevance scoring and reranking
- Results persisted to `data/research/` as markdown

### Proactive Engine

- **Heartbeat** — Periodic check-ins and scheduled task execution
- **Dream replay** — Detects user sleep (2h inactivity during 11pm-6am IST), harvests pending tasks, executes via sub-agents, delivers results on first morning message
- **Memory decay** — Runs every 6h to age out irrelevant data

---

## Getting Started

### Prerequisites

- Node.js >= 20
- Rust toolchain (for native module — optional, JS fallback available)
- Docker (optional, for sandboxed execution)

### Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your tokens (see Configuration below)

# Build everything (native Rust + OCR + TypeScript)
npm run build:all

# Start Convex backend
npx convex dev

# Run the agent
npm run dev          # Development (hot reload)
npm start            # Production
```

### Desktop App

```bash
cd desktop && npm install
npm start                 # Run locally
npm run build:mac         # Build macOS DMG
npm run build:win         # Build Windows installer
```

### Configuration

Environment variables via `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `ATLAS_OTPLESS_USER_ID` | Yes | OTPless authentication user ID |
| `EMAIL_USER` | No | IMAP/SMTP email address |
| `EMAIL_PASSWORD` | No | Email app password |
| `EMAIL_WHITELIST` | No | Allowed sender addresses |
| `GITHUB_TOKEN` | No | GitHub API token |
| `HF_TOKEN` | No | HuggingFace token (for gated embedding models) |
| `MEMORY_DEBUG` | No | Enable memory subsystem debug logging |

System prompts are assembled from the `prompts/` directory. Skills are loaded from `skills/` (built-in) and `~/.atlas/store/skills` (user-installed).

---

## Key Design Patterns

- **ES Modules** throughout (`"type": "module"`, `NodeNext` resolution)
- **Fail-open architecture** — Native module unavailable → JS fallback; memory crash → agent continues; tool not found → skip and retry
- **Semantic over keyword** — Tool selection, query classification, and memory recall all use transformer embeddings + cosine similarity
- **Parallelization with ordering** — Memory retrieval all parallel; browser tools sequential, others parallel; boot I/O non-blocking
- **Token budget injection** — All memory snippets capped (traits: 600 tokens, total: ~2-3K) to prevent prompt bloat
- **Cascade escalation** — Errors accumulate → auto-upgrade model tier (Haiku → Sonnet → Opus) in both main agent and sub-agents
- **Multi-layer caching** — LLM responses (embedding similarity), tool results (per-tool TTLs), memory queries (temporal cache + bloom filter)
- **Dependency injection** — `LLMClient` created once at boot, passed into all subsystems
- **OpenAI-compatible types** — All LLM interactions use `openai` package types regardless of provider
- **Graceful shutdown** — All subsystems register cleanup handlers

---

## Runtime Data

All runtime artifacts live in `data/` (gitignored):

```
data/
├── memories.db           # SQLite — all memory subsystems
├── long-tasks/           # Checkpoint JSON for resumable long tasks
├── research/             # Saved research results (markdown)
├── browser-profile/      # Persistent Playwright browser profile
├── google-credentials.json
├── google-tokens/        # Google API OAuth tokens
└── decomposition-templates.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 20, TypeScript (ES2022, strict) |
| Native acceleration | Rust (napi-rs), SIMD via `wide`/`simsimd`, `rayon` parallelism |
| Database | SQLite (better-sqlite3) — local only |
| Backend | Convex (serverless functions, real-time sync) |
| LLM providers | OpenRouter (Anthropic, OpenAI, Google) via Convex proxy |
| Embeddings | MiniLM (384-dim) via `@xenova/transformers` |
| Browser | Playwright with persistent profile |
| Desktop | Electron |
| Telegram | grammY framework |
| Discord | discord.js + @discordjs/voice |
| Slack | @slack/bolt |
| Matrix | Matrix protocol client |
| WhatsApp | @whiskeysockets/baileys |
| Email | IMAPFlow + Nodemailer |
| Push notifications | web-push |
| MCP | `@modelcontextprotocol/sdk` |
| Validation | Zod |
| Image processing | Sharp |
| Encryption | AES-256-GCM + ECDH P-256 (native Rust `aes-gcm`) |

---

*Proprietary software. Copyright &copy; 2024-2026 XAGI Labs Private Limited. All rights reserved.*
