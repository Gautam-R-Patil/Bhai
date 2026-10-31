> **Status: HISTORICAL analysis (Hermes comparison, written before the Oct 2026 reliability layer).** Not a live spec. Implementation status is **unverified** per item. Note the claim that `incrementHits` has zero callers refers to the code of that date. Modules named here live under `src/memory/` (`value-gate`, `strategy-library`, `self-model`, `task-learnings`), `src/agents/` and `src/prompts/` (`prompt-evolver.ts`); `self-improvement-synthesis.ts` is at `src/proactive/` and `critics.ts` at `src/forge/`. LLM routing is now Claude-only via Convex (see CLAUDE.md).

All load-bearing claims verified: `incrementHits` exists but has zero callers (dead), `maybeCreateSkill` is wired into swarm:337 / long-task:601, reflection uses fresh throwaway prompts (line 653), SAST critic has exactly 19 rules, `systemContent.ts:284` injects addenda without calling `incrementHits`, and the `decay` reason is a type affordance with no emission site. The corrected findings hold. Writing the report.

---

# Hermes Self-Improvement vs. Bhai — Architect's Verdict

## 1. How Hermes's self-improvement loop actually works

Hermes self-improves through **four pillars**, all anchored on a skill-centric model and originating from the Nous trajectory-training pipeline.

**Pillar 1 — Per-turn background-review fork (`agent/background_review.py`, `agent/conversation_loop.py`).** Not literally every turn — interval-gated. After a qualifying response, the conversation loop spawns a **daemon-thread forked `AIAgent`** (`name="bg-review"`, `max_iterations=16`, `quiet_mode=True`) when one of two counters trips: memory review every **≥10 user turns** (`_memory_nudge_interval`, `agent_init.py:1067`) or skill review every **≥10 accumulated tool iterations** (`_skill_nudge_interval`, `agent_init.py:1187`, reset when `skill_manage` fires). The fork inherits the parent's provider/model/credentials and a runtime tool-whitelist (`set_thread_tool_whitelist`) of memory+skills tools only — all else denied at dispatch. It runs one of three prompts (`_MEMORY`/`_SKILL`/`_COMBINED_REVIEW_PROMPT`) with an explicit pro-active bias ("most sessions produce a skill update") and a multi-paragraph anti-poisoning capture taxonomy.
- **Key architectural choice — cache reuse:** the fork sets `review_agent._cached_system_prompt = agent._cached_system_prompt` *verbatim*, pins `session_id`, and copies `tools[]` byte-identically so the outbound request rides the parent's **warmed prefix cache** (~26% measured Sonnet-4.5 cost cut per the contributor's own PR; locked by `tests/run_agent/test_background_review_cache_parity.py`).

**Pillar 2 — Inactivity curator (`agent/curator.py`).** Fires when `idle ≥ 2h` AND `now − last_run ≥ 7d`. Two layers:
- **Layer 1 (zero-LLM):** `apply_automatic_transitions()` walks `skill_usage` and runs `active → stale(30d) → archived(90d)`, reactivating on reuse. Clock = derived `last_used/viewed/patched` timestamps in `.usage.json` sidecars.
- **Layer 2 (LLM):** `run_curator_review()` forks an `AIAgent` on the **auxiliary client** (separate model slot — deliberately *never* touches the main prompt cache) running `CURATOR_REVIEW_PROMPT`, doing **umbrella-class consolidation** (merge-into-umbrella / create-umbrella / demote-to-subfile), with a 3-signal reconciler against hallucinated umbrellas.
- **Key choices — archive-never-delete** (move to `.archive/`, `restore_skill` recovers; pre-run `tar.gz` snapshot); **agent-created-only** (`is_agent_created` gate; hub/bundled skills off-limits); **pinned-exempt**.

**Pillar 3 — `skill_manage` create/patch (`tools/skill_manager_tool.py`).** Authors procedural **markdown** skills (`SKILL.md` + `references/templates/scripts`). `_patch_skill` uses fuzzy find-replace with whitespace normalization and **atomic rollback** (`tempfile + os.replace`). QC is text-only by default: name/frontmatter/size validation. SAST (`skills_guard.scan_skill`) is **opt-in** — `guard_agent_created` defaults `False` (rationale: the agent can already run the same code via `terminal()` ungated).

**Pillar 4 — Usage/provenance + trajectory origin.** `skill_usage.py` (`.usage.json`: `use_count`/`last_used_at`, incremented on `skill_view`/`skill_manage`) feeds the curator's lifecycle. Provenance via `skill_provenance.is_background_review()` ContextVar marks agent-created skills. The **trajectory origin**: `run_agent.py::_save_trajectory` + `batch_runner.py` capture ShareGPT-style JSONL → `trajectory_compressor.py` (1508 LOC, head/tail-protected middle summarization) builds a corpus that **trains the next-gen Nous model** the agent then runs. (`save_trajectories` defaults `False` in the live agent — this is offline org datagen, not the live loop.)

---

## 2. Head-to-head verdict table

| Dimension | Winner | Why |
|---|---|---|
| **Trigger model** | **Hermes** | LLM-driven review fires same-day (every ~10 turns / ~10 tool-iters); Bhai defers heavy LLM consolidation to 3am nightly (`reflection` every 15 turns; synthesis at night). Bhai's per-turn `saveStrategy` is real but heuristic, not reflective authoring. |
| **What's learned** | **Bhai** | Bhai learns 7+ classes (verified executable tools, skills, memory, prompts, reinforcement-scored strategies, self-model, harness-params) vs Hermes's 4 (skills, memory, user-model, trajectories). Strategy/self-model/harness axes have **no Hermes analog**. |
| **Quality control (SAST/tests)** | **Bhai** | Forge mandatorily executes 3-7 tests in a vm sandbox + scores vs `expected_kind` + diagnose-retry + HMAC + boot re-SAST — Hermes never *runs* a skill, and its SAST is **off by default** for agent-created skills. |
| **Lifecycle / consolidation** | **Hermes** | Real activity-driven `active→stale→archived` + cross-skill umbrella consolidation. Bhai has lifecycle only for Forge *tools* (and only via a safety-strike fence); its skills/addenda have **no staleness, and `incrementHits` is dead code**. |
| **Cost model** | **Hermes** | Engineered prefix-cache reuse on the review fork (~26%, parity-tested) + aux-client isolation for the curator. Bhai reflection builds fresh throwaway prompts (cheap in absolute terms but **no cache reuse**). |
| **Closing-the-loop** | **Parity** | Both reuse artifacts. Bhai injects addenda + task-learnings into context (guaranteed next-turn); Hermes reloads skills/memory next session via mandatory index. Each has a dead-on-arrival branch (Hermes trajectory off-by-default; Bhai prompt-evolver + addenda telemetry unwired). |
| **Safety / anti-poisoning** | **Parity** | Hermes: forked-thread tool-whitelist + explicit capture taxonomy + tar.gz snapshots. Bhai: OS-kernel sandbox (sandbox-exec/seccomp/AppContainer) for executable tools + value-gate + secret-sanitizer. Different surfaces, comparable rigor. |

---

## 3. Where Hermes is genuinely better (verified)

1. **Prefix-cache reuse on the review fork.** The single non-obvious systems win. Bhai `reflection.ts:653` builds a fresh "JSON-only summarizer" prompt with zero parent-cache inheritance.
   → **Bhai should adopt:** make `extractSummary`/`extractSignals` ride a *stable, frozen* shared reflection system prompt (no per-session id/timestamp) so the Convex/OpenRouter prefix-cache key is byte-identical run-to-run. **Effort: S.** Highest leverage-per-line.

2. **Real skill/addendum lifecycle + live usage telemetry.** Hermes's `active→stale→archived` is driven by an actually-incremented counter. Bhai's equivalent — `convex/userAddenda.ts:248::incrementHits` — is **defined but never called** (verified zero callers); `systemContent.ts:284` injects addenda without recording hits. No `active→stale→archived` curator exists for skills/addenda (only a blind 7-day `discardStaleDrafts`).
   → **Bhai should adopt:** wire `incrementHits` from `systemContent.ts:284`, then add a nightly staleness sweep in `self-improvement-synthesis.ts` calling the already-existing `deactivateAddendum` on `hits==0` after N days. **Effort: S→M.**

3. **Cross-slug umbrella consolidation.** `runSelfImprovementSynthesis` merges only *within* a single slug; Hermes clusters siblings into one class-level skill with a 3-signal hallucination reconciler.
   → **Bhai should adopt:** a prefix-cluster pass + 3-strategy umbrella in the nightly synthesis. **Effort: M.**

4. **Anti-poisoning capture discipline.** Hermes's "describe what the skill SHOULD contain, not actions you took" + "do NOT capture negative tool claims (they harden into refusals the agent cites against itself for months)" is a genuinely insightful prose guard. Bhai's `value-gate.ts` prompt is generic; grep confirms no such taxonomy.
   → **Bhai should adopt:** port the taxonomy into `value-gate.ts` and the `auto-skill-creator` author prompt. **Effort: S.** Most transferable single insight.

5. **SAST breadth.** `skills_guard.py` ships ~120 threat regexes (exfil/persistence/mining/supply-chain/secret-fingerprints/invisible-unicode-as-finding); Bhai `critics.ts` has **exactly 19** (verified), all sandbox-escape-focused, and *strips* bidi without *flagging* it.
   → **Bhai should adopt:** broaden `REGEX_RULES` (additive) + emit bidi as a finding. **Effort: M.**

---

## 4. Where Bhai is already better

These have **no Hermes equivalent**:

- **Forge verifier rigor.** Bhai *executes* synthesized artifacts: `parseEnvelope` (3-7 tests) → acorn compile → 19-rule SAST → vm-sandboxed test runs scored vs 8 `expected_kind` variants → `buildDiagnosePrompt` retry (3×/10×) → `envIsTestSelfBait` anti-cheat. Hermes never compiles or runs a skill — it cannot catch behavioral wrongness, only textual red flags.
- **OS-kernel sandbox** (sandbox-exec/seccomp/AppContainer) for executable dynamic tools, with 3-strike capability-violation auto-archive. Hermes's artifacts are prose; it has no kernel-isolation analog because it needs none — but Bhai auto-creates code that *runs*, a higher bar it clears.
- **HMAC tamper-detection + boot re-SAST + manifest sha256 recheck** defends the at-rest disk-swap threat. Hermes does not re-scan or signature-gate agent-created skills at load.
- **Reinforcement-scored strategy library** (`task-learnings.ts`, `strategy-library.ts`): `timesReinforced`, running-average `successScore`, recency-weighted recall, **per-(app,element) click-offset learning** reused same-session. Hermes buries strategies as prose inside `SKILL.md` — no scored, queryable store.
- **Self-model** (`self-model.ts`) — capability success tracking. No Hermes analog.
- **Harness-optimizer** (`src/harness/`) — NSGA-II/Pareto/TextGrad evolutionary meta-loop tuning 30+ dims and proposing code changes. No Hermes analog.
- **Prompt A/B evolution** (`prompt-evolver.ts`) with EMA metrics + native challenger comparison (currently under-wired, but the machinery exists; Hermes has *zero* prompt-variant machinery — grep-confirmed).
- **Memory depth** — multiple specialized tiers (traits/identity/emotional/episodic/relationship) fed by reflection, vs Hermes's two-file `MEMORY.md`/`USER.md` model.

**Correction to a common misconception:** Bhai *does* auto-author skills — `auto-skill-creator.ts::maybeCreateSkill` (LLM-driven, wired at `swarm.ts:337` and `long-task.ts:601`, fires on ≥5-tool successes) plus the `self_improvement_draft` tool. The gap is not "no authoring" — it's that Bhai authoring is **create-only** (dedup-skips an existing slug instead of patching), fires only on swarm/long-task (not ordinary single-agent turns), and batches to 3am.

---

## 5. Bottom line

Hermes's self-improvement is **better in three specific senses**: it learns *sooner* (same-day interval-gated review vs Bhai's nightly batch), it learns *more cheaply* (engineered prefix-cache reuse — a real, parity-tested win Bhai leaves on the table), and its skill artifacts live in a *real lifecycle* (activity-driven `active→stale→archived` + umbrella consolidation + a usage counter that is actually wired, unlike Bhai's dead `incrementHits`). It is **not better overall**: Bhai learns across a far broader set of artifact classes, and on the one artifact that actually executes code — dynamic tools — Bhai's mandatory compile→SAST→sandboxed-test→retry→HMAC pipeline and OS-kernel sandbox are categorically more rigorous than Hermes's prompt-only, off-by-default skill scan. The honest read: **Hermes has the better *learning cadence and lifecycle management*; Bhai has the better *verification, safety, and breadth*.** The four cheap wins worth porting are cache-reuse for reflection, wiring the dead `incrementHits` + staleness sweep, the anti-poisoning capture taxonomy, and cross-slug umbrella consolidation — none of which require abandoning Bhai's verify-everything, kernel-sandbox stance.