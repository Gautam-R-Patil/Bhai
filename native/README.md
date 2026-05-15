# A.T.L.A.S Native Module

64-module Rust performance layer for A.T.L.A.S. Exposes SIMD-accelerated vector math, the model/tool routers, HNSW search, swarm/mesh orchestration state, MCTS, the meta-harness optimizer, the outbound secrets sanitizer, and more, to TypeScript via napi-rs. Every consumer of this binary has a pure-JS fallback in `src/` — `src/native/index.ts` loads the `.node` file at runtime and gracefully falls back if it's missing.

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs/):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
2. **Node.js >= 20**
3. (Optional) **C toolchain** — only required if building with the `vad` cargo feature (libfvad). Skipped by default.

## Building

From the `native/` directory:

```bash
npm install        # installs napi-cli and dev deps
npm run build      # release build (default features)
```

Build with libfvad-backed VAD for hybrid voice barge-in:

```bash
cd native
npx napi build --features vad --release
```

Output is a platform-specific `.node` file written to `native/`:

| Platform | Binary |
|----------|--------|
| macOS Apple Silicon | `atlas-native.darwin-arm64.node` |
| macOS Intel | `atlas-native.darwin-x64.node` |
| Windows x64 | `atlas-native.win32-x64-msvc.node` |
| Linux x64 | `atlas-native.linux-x64-gnu.node` |
| Linux ARM64 | `atlas-native.aarch64-unknown-linux-gnu.node` |

## Build profile

`Cargo.toml` `[profile.release]`:

- `opt-level = 3`
- `lto = true` (whole-program LTO)
- `codegen-units = 1`
- `panic = "abort"`
- `strip = true` (stripped binaries)

## Module map (64 .rs files in `src/`)

| Group | Files | Purpose |
|-------|-------|---------|
| Vector math | `vector.rs`, `batch.rs`, `hnsw.rs` | SIMD dot-product, cosine similarity, batch + ANN search |
| Routing | `model_router.rs`, `tool_router.rs`, `tool_analytics.rs`, `query_classifier.rs` | Model tier + tool category selection |
| Memory hot path | `memory_state.rs`, `memory_tiers.rs`, `knowledge_graph.rs`, `hopfield.rs`, `spreading.rs`, `temporal_cache.rs`, `consolidation.rs`, `context_pruning.rs`, `sleep_gate.rs`, `surprise_gate.rs`, `reflection_core.rs`, `session_memory.rs`, `working_memory.rs`, `task_learnings.rs`, `traits_engine.rs` | Memory reads, scoring, decay |
| Agents | `agent_core.rs`, `swarm.rs`, `mesh.rs`, `sub_agent.rs`, `long_task.rs` | Orchestration state + scheduling helpers |
| Reasoning | `metacognition.rs`, `mcts_engine.rs`, `active_inference.rs`, `logic_engine.rs`, `process_reward.rs`, `pattern_speculator.rs`, `prompt_evaluator.rs` | Inference + planning kernels |
| World/user models | `world_model.rs`, `user_model.rs`, `credibility_model.rs` | Predictive state |
| Proactive | `proactive_scheduler.rs`, `proactive_monitor.rs`, `proactive_intent.rs`, `proactive_calendar.rs`, `proactive_news.rs`, `proactive_stale_email.rs`, `proactive_tasks.rs`, `proactive_weather.rs`, `proactive_source_gate.rs`, `inner_thoughts.rs`, `goal_engine.rs`, `habit_detector.rs`, `notification_tracker.rs` | Intent queue, per-source scoring, rate limit + DND |
| Browser | `browser_agent.rs`, `browser_guard.rs`, `chrome_bridge.rs`, `ip_guard.rs` | Element scoring, stealth, CAPTCHA detection |
| Vision Nav | `ax_walker.rs` (opt-in via `ATLAS_NATIVE_AX=true`) | Cross-OS accessibility-tree flatten/find |
| Voice | `pcm_vad.rs` (cargo feature `vad`, opt-in) | libfvad-backed barge-in for hybrid voice |
| Security | `security.rs`, `secrets_sanitizer.rs` (default-ON, 1.44–2.00× faster than TS) | Encryption helpers + 23-pattern outbound secrets scrubber |
| Research | `research_engine.rs`, `info_gain.rs`, `citation_graph.rs`, `skill_scorer.rs` | Source scoring, info gain, citation graphs |
| Harness | `harness_optimizer.rs` | NSGA-II Pareto + GP surrogate + TextGrad scoring |

`lib.rs` is the napi-rs entry; each module exports its own `#[napi]` functions.

## Performance highlights

| Operation | JS fallback | Native | Speedup |
|-----------|------------|--------|---------|
| cosine similarity (768-dim) | 12 μs | 0.8 μs | 15× |
| findTopK (1000 vectors) | 15 ms | 0.9 ms | 17× |
| batch similarity | 14 ms | 0.7 ms | 20× |
| 23-pattern secrets scan (1KB–100KB) | baseline | 1.44–2.00× faster | — |

## Empirical port rule

This module accreted via the "everything Rust is faster" assumption. After measuring, the actual rule is narrower:

- **Port when** TS is genuinely slow on a hot path **and** Rust has a structural advantage — multi-pattern scanning V8 can't share state across, true CPU parallelism, or large-batch SIMD.
- **Skip when** Node has hardware-accelerated paths (e.g. OpenSSL SHA-NI), inputs are small per-call, or graph BFS is bounded by FFI cost more than work.

See `CLAUDE.md` → "Rust expansion — empirical lessons" for the canonical worked examples (sanitizer wins; sha2 / small-tree AX flatten / spreading BFS lose). New ports ship behind an opt-in kill-switch (`ATLAS_NATIVE_*`) and the default flips to ON only after `scripts/bench-native.ts` shows a measured win across representative inputs.

## Architecture

```
native/
├── Cargo.toml          # Rust dependencies (default + opt-in features)
├── build.rs            # napi-rs build script
├── package.json        # @napi-rs/cli config
├── index.js            # JS wrapper with graceful fallback
├── index.d.ts          # Auto-generated TypeScript definitions
└── src/                # 64 .rs modules (see Module map above)
    ├── lib.rs          # napi-rs entry — re-exports per-module #[napi] fns
    ├── vector.rs / batch.rs / hnsw.rs
    ├── model_router.rs / tool_router.rs / …
    ├── ax_walker.rs                    # opt-in (ATLAS_NATIVE_AX)
    ├── pcm_vad.rs                      # opt-in cargo feature `vad`
    ├── secrets_sanitizer.rs            # default-ON
    └── … 58 more
```
