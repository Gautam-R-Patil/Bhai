> **Status: HISTORICAL analysis (Hermes comparison, written before the Oct 2026 reliability layer).** Not a live spec. Implementation status of the proposed metacognition upgrade is **unverified**; `src/agents/metacognition.ts` exists. The logprobs track depended on a `convex/http.ts` allowlist edit; `logprobs` does not appear in `convex/http.ts` today, and LLM calls now go to the Claude API (`convex/claude.ts`) rather than OpenRouter, so that track is effectively superseded. File names are bare (`metacognition.ts`, `evaluator.ts`, etc. live under `src/agents/`; `reflection.ts`/`task-learnings.ts` under `src/memory/`).

This is the key Track-2 result, and it's decisive:

- **`openrouterBody` is an explicit allowlist** (lines 690-704) — `logprobs`/`top_logprobs` are NOT forwarded. Adding them requires a `convex/http.ts` edit + redeploy.
- **`responseData` is returned verbatim** via `buildResponse(responseData, ...)` (line 786 / confirmed earlier at 129-equivalent). So IF logprobs were forwarded AND the provider returned them, they would survive the encrypted round-trip — `buildResponse` JSON-stringifies the whole object.

So Track 2 is gated on a server deploy (whitelist line) plus whether OpenRouter+Anthropic actually emit token logprobs. That confirms the design's "feasibility spike" framing exactly. I have everything I need. Let me write the plan.

I have verified every load-bearing claim against the actual source. I'm ready to write the plan.

---

# Improving Bhai Metacognition — Architect's Plan

## 1. Where Bhai metacognition stands today

Bhai metacognition is a **fast heuristic signal-counter that almost never acts**. `compute_confidence` in `native/src/metacognition.rs:74` starts at `1.0` and subtracts hand-tuned penalties (error ratio, consecutive errors, response-length variance, iteration count, tool-name loop) — an uncalibrated score whose absolute value is meaningless (the `0.35`/`0.2` cutoffs are arbitrary), with no correlation to actual task outcomes ever measured. It computes a rich `intervention` enum (`none|escalate|replan|critics|ask_user`) every iteration, but `src/agent.ts:1138` consumes only `loopDetected||struggleDetected` to push **one** text nudge (gated by a `metaNudged` latch that fires at most once per turn) and merely *logs* low confidence without acting — the failed "C2" regime (tell the model it's stuck, hope it self-corrects; Mirror arXiv:2604.19809). Loop detection (`detect_loop_pattern_internal`, `metacognition.rs:203`) compares **tool NAMES only** over the last 6 calls, so an identical-args retry loop or a paraphrased no-progress spiral is invisible (name-repeat alone is F1 0.08; arXiv:2511.10650). And `computeReasoningQuality` (`metacognition.ts:228`) — the one outcome signal — is imported at `agent.ts:22` but **never called**, so nothing is logged, nothing is learned, no per-task/per-tier prior is ever formed.

**Confirmed ground truth** (all verified in source, not assumed):
- The per-tool loop at `agent.ts:3040` already carries `r.fnName`, `r.fnArgs` (`agent.ts:467`), `r.isError`, `r.result` on the same object feeding `updateSignals()` at `:3063` — every signal a content-aware detector needs is already in hand.
- `embedText()` (`src/memory/embeddings.ts:377`, MiniLM, normalized) + `cosineSimilarity()` (`:475`) exist and the model is warm.
- `replan()` (`src/agents/replanner.ts:51`), the rephrase template (`error-recovery.ts:175`), the cascade (`agent.ts:2871`, `getCascadeNext`), and `runDreamReplay(llm)` (`reflection.ts:358`, 3am) all exist and are reusable.
- `chooseModel(iteration, lastToolCalls, errorCount, modelHint, userMessage, hasMedia)` (`agent.ts:430`) → `selectForAgent` is a thin wrapper — adding an override param is mechanical.
- **Logprob feasibility (decisive):** `convex/http.ts:690-704` builds `openrouterBody` as an **explicit allowlist** — `logprobs`/`top_logprobs` are NOT in it. But `responseData` is returned **verbatim** through `buildResponse → encryptResponse` (`:726`, `:786`). So logprobs *would* survive the encrypted round-trip if (a) the server whitelist is extended and redeployed, and (b) the provider emits them. This is a server-deploy-gated spike, exactly as the reviewed design scoped it.

## 2. The upgrade plan, tiered by impact/effort

Ordered by impact/effort (best ratio first). Every item fails open to today's exact behavior and ships behind a kill-switch.

---

### TIER A — Pure heuristic, zero added LLM cost (ship first)

#### A1. Content-aware loop detection (replace name-only matching) — **effort S, impact high**

**What:** Replace `detect_loop_pattern_internal` (name-only) with a **canonical step-key** detector and add the three missing OpenHands patterns. Per tool call, TS computes a step key in the loop it already runs:
```
stepKey = fnv1a64( normalizeArgs(fnArgs) + "|" + truncate(result, 256) )
```
`normalizeArgs` = stable sorted-key JSON with volatile fields stripped (`tool_call_id`, `*_id`, timestamps, `_channelContext`, `_originalPrompt` — the latter two are literally set at `agent.ts:528-529`, so they MUST be stripped). The native side compares step-key hashes, not names, over a window reset on each user message:
1. **Action-observation repeat** ≥4 identical → `loopDetected` (the headline identical-args fix).
2. **Action-error repeat** ≥3 same `(fnName, argsHash)` with `isError` → `loopDetected`, intervention biased to `replan`.
3. **Ping-pong** [A,B,A,B,A,B] ≥6 → `loopDetected`.

Keep name-match as a cheap pre-filter. `loopDetected` now means "repeating *without progress*", not "repeating."

**SOTA basis:** OpenHands `StuckDetector` content-normalized `_event_eq` (5-pattern set; docs.openhands.dev/sdk + `stuck.py`); LangChain `ProgressGuardMiddleware` hash(tool,args,error) (Issue #36139); hybrid structural+semantic cycle detection (arXiv:2511.10650, F1 0.72 vs 0.08).

**Bhai changes:**
- `native/src/metacognition.rs` — `MetaSignals` gains `recent_step_hashes_lo/hi: Vec<u32>` (paired u32 halves — avoids napi BigInt marshalling cost); rewrite `detect_loop_pattern_internal` → `detect_step_loop(names, hashes, errors)` with the 3 patterns; bias `intervention` to `replan` on action-error.
- `src/agents/metacognition.ts` — add `normalizeArgs()` + `computeStepKey()` (TS owns the strings); extend `updateSignals()` to accept `fnArgs`, `isError`, `resultDigest`; push the two u32 halves into the native call object.
- `src/agent.ts:3063` — pass `r.fnArgs` + truncated `r.result` into `updateSignals`. **Rename the existing `noProgressStreak` (agent.ts:1131)** to avoid collision with any new streak field.

**Signals added:** `recentStepHashes`, action-error count, ping-pong count.

**Cost model:** Pure heuristic, **zero LLM, ~sub-µs/iter**. TS does one FNV hash over strings it already holds. Net cost ≈ today's `assess()` (already runs every iter).

**Fail-open + kill-switch:** `BHAI_NO_SEMANTIC_LOOP=true` → revert to name-only. Native port ships behind `BHAI_NATIVE_META_LOOP=true` (opt-IN, off day 1) with a byte-identical `*.parity.test.ts` before any default flip — per the CLAUDE.md Rust-rollout rule. TS-only path is fully functional meanwhile; hashing in TS is the measure-first default (FFI tax on a tiny u32 vec likely a wash — defer the Rust port until `bench-native.ts` shows a win).

---

#### A2. Wire the intervention enum to actually act (kill the C2→C4 gap) — **effort S-M, impact very high**

**What:** This is the single biggest behavior change. Replace the `metaNudged` one-shot nudge (`agent.ts:1137-1152`) with an `applyIntervention(assessment, ctx)` dispatcher that **consumes the already-computed `intervention` field** every iteration (cooldown-gated, no latch):
- `escalate` → thread a `metacogForcedTier` override into the next `chooseModel()` call (`agent.ts:1239`) so the **whole next iteration** runs higher-tier (not just the after-the-fact cascade retry at `:2871`). Record via existing `recordQualityFailure`.
- `replan` → fire the existing `replan()` (`replanner.ts:51`) on a compact completed/remaining summary built from `messages`; inject revised steps as a system message; cooldown-gated (`BHAI_META_REPLAN_COOLDOWN`, default 6 iters — hysteresis, MIRA).
- `critics` → fire `multi-critic.ts` **only when a tool-grounded verifier is in scope** (logic-verifier / code-critic / `browser_verify` / process-reward); framed **adversarially** ("enumerate ways this is wrong / find the bug"), never ungrounded self-critique. If no verifier → downgrade to `escalate`.
- `ask_user` → SOFAI feedback-first: inject one rephrase nudge (`error-recovery.ts:175` template) and continue ≤2 iters; surface a real clarifying question via `onProgress` only if still failing.
- `none` → no-op.

This is the "enforce, don't nudge" thesis — emit *guidance* and fire the right tool, don't hard-dictate the next tool.

**SOTA basis:** Mirror C4 architectural-enforcement-beats-self-report (arXiv:2604.19809, ConfFailRate −76%); SOFAI-LM feedback-loop-before-escalation (arXiv:2508.17959 — already cited in `metacognition.ts:8` header but unimplemented); SWE-PRM taxonomy-guided > prescriptive (arXiv:2509.02360); CRITIC tool-grounded > self-critique + Self-Refine caveat (Gou ICLR 2024; Huang arXiv:2310.01798; Madaan NeurIPS 2023).

**Bhai changes:**
- `src/agent.ts:1137-1152` — replace nudge with `await applyIntervention(...)`; remove the `metaNudged` latch; add per-turn cooldown state.
- `src/agent.ts:430-440` — add optional `metacogForcedTier?: string` to `chooseModel`, threaded into `selectForAgent`; consume at `:1239`.
- `src/agents/metacognition.ts` — new `applyIntervention()` + a `runProgressGate()` returning `{intervention, feedbackText, askText}`.
- Reuse `replanner.ts`, `error-recovery.ts`, `multi-critic.ts` as-is.

**Signals added:** None — this is pure *consumption* of existing signals.

**Cost model:** Hot path unchanged. Expensive arms fire **selectively** and rarely: `escalate` = next iter on a higher tier (already budgeted); `replan` = one Pro call, cooldown-gated; `critics` = existing multi-critic capped by `BHAI_POST_SYNTHESIS_BUDGET_MS` (90s) and only when a verifier exists; `ask_user` first arm is a free system message. On healthy turns: zero added cost. On a stuck turn: replaces dozens of wasted iterations.

**Fail-open + kill-switch:** `BHAI_NO_META_INTERVENTIONS=true` → exact current nudge-only behavior. Granular: `BHAI_META_REPLAN_COOLDOWN=int`.

---

#### A3. Close the dead learning loop (log outcomes) — **effort S, impact medium (unblocks everything)**

**What:** Call `computeReasoningQuality(metaState, taskCompleted)` at end-of-turn (currently never called) and persist one row per turn to a new local SQLite `meta_outcomes` table (`data/memories.db`): `{task_type, model_tier, peak_no_progress_streak, max_consecutive_errors, loop_detected, intervention_fired, final_confidence, quality_score, task_completed}`. Also write a one-line verbal reflection to `task-learnings.ts` on struggle (retrieved on the next similar task's iter-1, already wired).

**SOTA basis:** Reflexion verbal RL (arXiv:2303.11366); intrinsic-metacognitive-learning outcome logging (Liu & van der Schaar, ICML 2025, arXiv:2506.05109).

**Bhai changes:**
- `src/agent.ts` success exit (~`:2905`) + failure exits (`:1186`, `:1203`, `:2325`, `:3110`, `:3131`) — call `computeReasoningQuality` + log.
- `src/agents/metacognition.ts` — new `logOutcome(state, taskCompleted, taskType, modelTier)` writing the row.

**Signals added:** None new; persists existing ones as labels.

**Cost model:** One local SQLite write per turn. **Zero LLM, ~0 cost.**

**Fail-open + kill-switch:** `BHAI_NO_METACOG_LOG=true`. Write wrapped in try/catch — failure continues silently.

---

#### A4. Semantic no-progress probe (embedding-novelty) — **effort M, impact high**

**What:** The semantic complement to A1's exact-hash: catches **paraphrased** no-progress that hashing misses. Reuse the `resultTexts`/`finalContent` already built in the `:3040` loop; embed a digest `[${fnName}] ${truncate(result,400)}` once per iteration via `embedText()` into a K=6–8 ring buffer; `progressStall = max cosine` to prior K. Add two `MetaSignals` fields: `noProgressStreak` (++ when cosine > 0.92, reset on novelty) and `meanRecentNovelty`. Native `compute_confidence` gains **Factor 7**: `noProgressStreak ≥ 3 → confidence −= 0.2` (a far stronger stuck signal than the current `iteration>15` term — counts are a weak proxy, arXiv:2506.23274).

**SOTA basis:** SAGE vMF novelty gate (arXiv:2605.30711, skips 16-18% LLM calls); "semantic circularity precedes textual repetition" (arXiv:2601.05693); the no-extra-LLM-call embedding-cosine path (hidden-state probes need logits, unavailable behind the proxy).

**Bhai changes:**
- `src/agents/metacognition.ts` — obs-embedding ring buffer + `progressStall` computation (TS, uses `embedText`+`cosineSimilarity`); pass `noProgressStreak`/`meanRecentNovelty` as scalars into the native call.
- `native/src/metacognition.rs` — add the two scalar fields + Factor 7.
- `src/agent.ts:3062` — embed the per-iter digest (fire-and-forget, batched once/iter).

**Signals added:** `progressStall`, `noProgressStreak`, `meanRecentNovelty`.

**Cost model:** **One MiniLM embed/iter** (~5–20ms, model warm, cached+inflight-deduped) **+ K cosines** (~tens of µs). **Zero LLM, zero credits.** Cosine stays in TS (8×384-dim ≈ 3K mults, sub-µs in V8) — measure before any Rust port; `batch.rs` cosine is the drop-in if a bench later justifies it.

**Fail-open + kill-switch:** `BHAI_NO_PROGRESS_PROBE=true` → freeze `noProgressStreak` at 0, skip the embed. Honest cost note: ship default-OFF until A1 traces prove the embedding catches stuck turns the hash misses — if it doesn't beat A1+guard, **cut it** (per the reviewed design's own discipline).

---

### TIER B — One gated LLM call, fired only when Tier A already smells trouble

#### B1. VOC / cost-aware intervention threshold (think-more-vs-act) — **effort M, impact high**

**What:** Replace the arbitrary fixed `0.2/0.35/0.5` cutoffs with an action-aware threshold `τ = 1 − c_l/c_w` before firing any *expensive* intervention:
- `c_l` = cost of intervening (credit delta from `MODEL_COSTS`: Light 0.25 / Pro 1 / Heavy 3; or ask-user cost from channel posture in `proactive/config.ts`).
- `c_w` = cost of acting-wrong, from a **coarse 3-bucket tool→risk lookup** (read-only / mutating / irreversible-or-spend), seeded from the existing `git_op` safe/confirm/destructive tiers + forge cap tiers. Be honest: a per-tool risk *table* doesn't exist today, so start with ~20 lines of hand-written buckets, default medium.

Decision: destructive pending action + mediocre confidence → intervene unless `P ≥ 0.9`; read-only → `τ ≈ 0.2`, rarely intervene.

**SOTA basis:** Cost-aware escalation `τ=1−c_l/c_w` (arXiv:2604.08588; MICE-for-CATs NAACL 2025; Chow 1970); Russell-Wefald VOC value-thresholding (RaM arXiv:2410.05563; "Knowing When to Quit" arXiv:2604.18419).

**Bhai changes:**
- `src/agents/metacognition.ts` — `shouldThinkMore(assessment, ctx)` VOC gate.
- `src/model-router.ts` — expose `c_l` lookup (reuse `MODEL_COSTS`) + `c_w` bucket helper.

**Signals added:** None — re-thresholds existing confidence.

**Cost model:** A few scalar ops. **Near-zero.** The *point* is to make the expensive arms rarer.

**Fail-open + kill-switch:** `BHAI_NO_META_VOC=true` → fall back to fixed thresholds (A2's behavior).

#### B2. Adversarial-framed progress judge (gated, ≤1 Haiku call/turn) — **effort M, impact high**

**What:** Fires **only** when `(loopDetected || noProgressStreak≥3 || confidence<0.35) && !judgeFired && iter≥4`. ONE Haiku-tier (Light, 0.25cr) **adversarially-framed** call: given the goal + last 6 (action,observation) digests, return `{progress_0_100, stalled, likely_fix: "retry"|"replan"|"escalate"|"ask_user", one_line}`. The `likely_fix` drives A2's dispatcher. Inject `llm` (the agent fn's DI param, `agent.ts:823`) into `metacognition.ts` (which has no LLM import today).

**SOTA basis:** SWE-PRM sparse taxonomy-guided critic (arXiv:2509.02360, +10.6pp, fires every-N not every-iter); adversarial "what can fail?" framing (arXiv:2602.06948 / arXiv:2506.18183, ECE 0.42→0.30, −15pp overconfidence); pre-execution assessment discriminates better than post-hoc (arXiv:2602.06948).

**Bhai changes:**
- `src/agents/metacognition.ts` — `async assessProgressJudge(state, llm, goal, recentDigests)`; inject `llm` via `agent.ts:823`.
- `src/agent.ts:1137` — call inside the gate; wire `likely_fix` to A2's dispatcher.

**Signals added:** LLM-judged `progress`, `stalled`.

**Cost model:** **Exactly ONE Haiku call per stuck turn**, gated so healthy turns never fire it, capped by `BHAI_POST_SYNTHESIS_BUDGET_MS`. Replaces dozens of wasted Opus iterations (SWE-PRM net-cheaper).

**Fail-open + kill-switch:** `BHAI_NO_PROGRESS_JUDGE=true` → no judge; falls back to A1/A4 heuristic + A2 dispatch. `BHAI_PROGRESS_JUDGE_MODEL` overrides tier.

---

### TIER C — Calibration + learned thresholds (offline fit, data-gated)

#### C1. Outcome-calibrated confidence + threshold (Platt/isotonic, fit nightly) — **effort L, impact medium-high (conditional)**

**What:** The current confidence is uncalibrated. **First prove it's even miscalibrated** — compute ECE/Brier on A3's logged outcomes in `reflection.ts`. *If* miscalibrated, fit a per-(taskType×tier) calibrator nightly in `runDreamReplay` (`reflection.ts:358`): Platt cold-start (identity → P≈qRaw, day-1 ≈ today) → isotonic ≥200 samples. `assess()` reads the calibrator + an online adaptive-conformal threshold `κ` (one scalar update per episode, Gibbs-Candès) on the hot path. **Ship in SHADOW mode** (`BHAI_METACOG_SHADOW=true` default) — compute+log `calibratedP/qRaw/outcome` to `data/metacog-outcomes.jsonl` *without acting* until ECE/Brier beats the subtractive baseline (mirrors the value-gate shadow rollout).

**SOTA basis:** Platt/isotonic/temperature scaling + ECE/Brier (Guo ICML 2017; ConfTuner arXiv:2508.18847, −54.7% ECE); online adaptive conformal (Gibbs-Candès 2021; CCPO arXiv:2511.11828, −30% cost); FOK/JOL "raw confidence is not directly actionable" (arXiv:2605.14186).

**Bhai changes:**
- `src/memory/reflection.ts:358` — nightly: read jsonl, compute ECE/Brier, fit Platt/isotonic + seed `κ`, persist to a small `calibrators` table.
- `src/agents/metacognition.ts` — `calibrate(qRaw, ctx)` hot-path read.
- `native/src/metacognition.rs` — apply Platt (a,b passed in). **Keep the FIT in TS** (per-night over a few thousand rows — cheaper than FFI); only per-iter *apply* justifies Rust, opt-in.

**Cost model:** Hot path: one sigmoid or ≤16-knot lookup. Nightly fit rides the existing 3am job — **zero incremental scheduled cost.**

**Fail-open + kill-switch:** `BHAI_NO_CALIBRATED_CONF=true` → raw subtractive heuristic. `BHAI_METACOG_SHADOW=true` (default during rollout). `BHAI_NO_METACOG_CALIBRATION_FIT` → freeze calibrators.

---

### TIER D — Token-logprob confidence (server-deploy-gated SPIKE, conditional)

#### D1. Logprob-based answer/tool-arg confidence — **effort L (incl. server deploy), impact conditional**

**What:** Add `answerTokenConfidence` (length-normalized mean logprob), DeepConf `minGroupConfidence` (weakest-link), and `toolArgConfidence` (logprob of tool-NAME + critical-arg tokens only, *not* prose — naive whole-completion averaging dilutes the signal). **This is a feasibility spike, not a commitment.**

**Confirmed gate (decisive):** `convex/http.ts:690-704` `openrouterBody` is an explicit allowlist — `logprobs`/`top_logprobs` are NOT forwarded. BUT `responseData` is returned **verbatim** (`:726`→`buildResponse`→`encryptResponse`), so they *would* survive the encrypted path. **Before any `src/llm.ts` edit:** prove (1) the `http.ts` whitelist addition + redeploy forwards them, and (2) production models (Anthropic/Gemini/GPT via OpenRouter) actually *return* token logprobs (likely **fails for Anthropic reasoning models**). **If the spike fails, drop D1 entirely** — Tier A still closes 5 of 8 gaps.

**SOTA basis:** Token-logprob confidence (JMIR 2025 e64348, AUROC 0.70-0.87 vs verbalized 0.51-0.70); tool-name/arg targeting (MICE-for-CATs NAACL 2025); DeepConf min/tail (arXiv:2508.15260).

**Bhai changes (explicit, server-side included):**
- `convex/http.ts:690` — add `logprobs`/`top_logprobs` to `openrouterBody` allowlist; redeploy (`npx convex deploy`).
- `src/llm.ts:191` — add `logprobs:true, top_logprobs:5` to `requestBody` behind `BHAI_NO_LOGPROB_CONF`.
- `src/llm.ts:~313` — capture `choices[0].logprobs.content[]` if present; expose `lastLogprobs` side-channel without changing the `ChatCompletion` type; discard silently if absent.
- `src/agents/metacognition.ts` — `computeAnswerTokenConfidence()`/`computeToolArgConfidence()`; fuse as ADDITIONAL inputs (never a hard dependency; `-1.0` sentinel → identity to old behavior).

**Cost model:** **Free** — rides the same chat call, just reads `top_logprobs`. No extra LLM call.

**Fail-open + kill-switch:** `BHAI_NO_LOGPROB_CONF=true`. Absent logprobs → sentinel → byte-identical to no-logprob behavior.

---

### What I deliberately CUT from the reviewed designs

- **LinUCB / contextual-bandit meta-controller (design #3 item 5):** On a single-user local agent, label volume can't support per-(task,tier) bandit heads, and AEL's own "less is more" ablation (arXiv:2604.21725) shows per-tool selection / planner-evolution *degraded* results. Replaced by A3's outcome log + C1's offline ECE check — **let the data decide before building the controller.**

## 3. Cheap-first sequencing

Ship **Tier A entirely before any LLM-judge / learned-controller piece.** Tier A is pure heuristic, zero added LLM cost, and closes the structural gaps:

1. **A3 (outcome log)** — ship *first* even though it's not the flashiest. Everything downstream (C1's ECE check, the "is it even miscalibrated?" question) is blocked without data. One SQLite write, zero risk.
2. **A1 (content-aware loops)** — pure win, no proxy/embedding dependency, immediately fixes the identical-args spiral the current name-only detector misses.
3. **A2 (wire the enum)** — the highest-leverage behavior change; consumes existing signals, no new ML. This is what turns metacognition from "observe" to "act."
4. **A4 (semantic progress probe)** — default-OFF until A3's traces prove it beats A1+guard.

Only **then**, gated on accumulated data:
5. **B1 (VOC threshold)** + **B2 (gated judge)** — one Haiku call, only on already-suspect turns.
6. **C1 (calibration)** — in SHADOW mode, flipped only after ECE/Brier beats baseline on logged sessions.
7. **D1 (logprobs)** — only after the `http.ts` spike proves end-to-end passthrough AND providers emit logprobs.

Native Rust ports (A1's hash compare, C1's apply) ship **opt-IN** (`BHAI_NATIVE_*`), TS-only functional meanwhile, flipped to default-on only after `scripts/bench-native.ts` shows a measured win AND `*.parity.test.ts` passes byte-identical — per CLAUDE.md.

## 4. What to explicitly NOT do

- **No per-iteration LLM judge.** B2 fires ≤1×/turn, gated behind Tier-A heuristics. A SWE-PRM-style critic on *every* iteration burns credits for no payoff (their own finding: sparse cadence is what makes it net-cheaper).
- **No ungrounded self-critique for pure reasoning.** Self-Refine/CRITIC (Huang arXiv:2310.01798; Kamoi TACL 2024) shows it degrades reasoning. Fire `critics` only when a tool-grounded verifier exists.
- **No bandit/RL meta-controller** (cut above) — label volume too low; AEL "less is more."
- **No hidden-state / linear-progress probes** (arXiv:2506.23274) — need logits Bhai can't get behind the Convex proxy.
- **No semantic entropy / self-consistency N-sampling** for per-iter confidence — N× generation cost; Bhai isn't sampling multiple paths per iteration.
- **No premature Rust ports.** A1's hash and A4's cosine stay in TS until benched (FFI tax on tiny inputs is a wash — CLAUDE.md Rust lesson).
- **No duplicating what Bhai already covers:** the `evaluator.ts` 0-100 scoring, `process-reward.ts` PRM, `multi-critic.ts`/`code-critic.ts`, and the `NO_PROGRESS_LIMIT` hard guard (`agent.ts:1130`) already exist — metacognition should *route to* them, not reimplement them. Leave the hard loop-guard untouched as the last-resort backstop.

## 5. First PR — highest-leverage self-contained change

**PR: "Wire metacognition intervention enum to act (+ content-aware loop detection + outcome log)"** — bundles A1 + A2 + A3 because they're tightly coupled (A2 needs A1's better `loopDetected` to be worth acting on; A3 makes the change measurable). All pure-heuristic, zero added LLM cost, fully fail-open.

**File-level plan:**

1. **`native/src/metacognition.rs`**
   - `MetaSignals`: add `recent_step_hashes_lo: Vec<u32>`, `recent_step_hashes_hi: Vec<u32>`, `recent_errors: Vec<bool>`.
   - Rewrite `detect_loop_pattern_internal` → `detect_step_loop()`: action-obs repeat ≥4, action-error repeat ≥3, ping-pong ≥6, over a step-key window; name-match as pre-filter.
   - Bias `intervention` to `replan` on action-error.
   - Keep all existing subtractive math byte-identical (sentinel-safe).

2. **`src/agents/metacognition.ts`**
   - Add `normalizeArgs()` (sorted-key JSON, strip `tool_call_id`/`*_id`/timestamps/`_channelContext`/`_originalPrompt`) + `computeStepKey()` (FNV-1a → two u32 halves).
   - Extend `updateSignals()` signature: `fnArgs`, `isError`, `resultDigest`.
   - New `applyIntervention(assessment, ctx)` dispatcher: escalate/replan/critics(verifier-gated, adversarial)/ask_user(SOFAI feedback-first), with per-turn cooldown.
   - New `logOutcome(state, taskCompleted, taskType, modelTier)` → `meta_outcomes` table.
   - Mirror the JS fallback (`assessJS`, `detectLoopJS`) so non-native path matches.

3. **`src/agent.ts`**
   - `:430` — add `metacogForcedTier?: string` to `chooseModel`, thread into `selectForAgent`; consume at `:1239`.
   - `:1131` — **rename `noProgressStreak`** (collision).
   - `:1137-1152` — replace nudge block with `await applyIntervention(assess(metaState), ctx)`; remove `metaNudged` latch; add cooldown state.
   - `:3063` — pass `r.fnArgs` + `truncate(r.result, 256)` into `updateSignals`.
   - Success exit (`:2905`) + failure exits (`:1186`/`:1203`/`:2325`/`:3110`/`:3131`) — call `computeReasoningQuality` + `logOutcome`.

4. **New `meta_outcomes` table** — raw better-sqlite3 in `data/memories.db` (schema: task_type, model_tier, peak_no_progress_streak, max_consecutive_errors, loop_detected, intervention_fired, final_confidence, quality_score, task_completed, ts).

5. **`native/src/metacognition.parity.test.ts`** — byte-identical step-loop detection TS vs Rust on fixture traces (action-obs/action-error/ping-pong).

6. **`CLAUDE.md`** — document `BHAI_NO_META_INTERVENTIONS`, `BHAI_NO_SEMANTIC_LOOP`, `BHAI_NATIVE_META_LOOP`, `BHAI_META_REPLAN_COOLDOWN`, `BHAI_NO_METACOG_LOG` under Env Kill-Switches.

**Kill-switches:** `BHAI_NO_META_INTERVENTIONS=true` reverts to today's nudge; `BHAI_NO_SEMANTIC_LOOP=true` reverts to name-only; native behind `BHAI_NATIVE_META_LOOP` (opt-IN). **Validation gate:** after a soak, query `meta_outcomes` for intervention-fired-vs-quality correlation; that's the evidence that unblocks Tier B/C.

**Cited paths:** `src/agents/metacognition.ts`, `native/src/metacognition.rs`, `src/agent.ts:430/1131/1137/1239/2871/2905/3040/3063`, `src/agents/replanner.ts:51`, `src/agents/error-recovery.ts:175`, `src/memory/embeddings.ts:377/475`, `src/memory/reflection.ts:358`, `convex/http.ts:690-726`, `native/src/lib.rs:33/103`.

**Cited research:** Mirror C4 (arXiv:2604.19809), SOFAI-LM (arXiv:2508.17959), OpenHands StuckDetector + hybrid cycle detection (arXiv:2511.10650), SAGE novelty (arXiv:2605.30711), SWE-PRM (arXiv:2509.02360), adversarial framing (arXiv:2602.06948 / 2506.18183), cost-aware τ (arXiv:2604.08588; MICE-for-CATs NAACL 2025), VOC (arXiv:2410.05563), Platt/isotonic + ECE/Brier (Guo ICML 2017; arXiv:2508.18847), token-logprob (JMIR 2025 e64348; DeepConf arXiv:2508.15260), Reflexion (arXiv:2303.11366), intrinsic metacognitive learning (arXiv:2506.05109), AEL "less is more" (arXiv:2604.21725).