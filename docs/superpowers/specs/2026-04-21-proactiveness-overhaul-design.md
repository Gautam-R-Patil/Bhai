# ATLAS Proactiveness Overhaul — Design Spec

**Date:** 2026-04-21
**Status:** Approved (pending user spec review)
**Author:** Claude (with Dheeraj)

---

## Background & Motivation

Two problems, one root cause.

**Bug** — ATLAS is sending third-person deliberation to users as if it were the message itself. Screenshot from WhatsApp, 2026-04-21:

> "Dheeraj's been away for 8+ hours and was working on that Midnight Library bookstore project last night — probably worth a quick recap of where he left off before diving back in, especially since it's morning and momentum matters for design work."

This is the LLM's *internal reasoning about whether to send* being sent as the outbound text. Also occurring on Telegram. Every channel is affected because the leak lives in `src/proactive/inner-thoughts.ts::formThought()` — channel-agnostic.

**Ask** — Make ATLAS feel more alive, more helpful, less robotic. Research converges on: observe/await/execute mode discipline, Bailey-Konstan interruption-cost timing, latent-topic monitors, context fact-checking, agent-inbox separation.

**Root cause (both problems):** there is no clear boundary between *internal reasoning about the user* and *outbound messages to the user*. The current pipeline is monolithic — `innerThoughtsTick()` produces a string, which is sent directly to `onNotification()` → channel `sendMessage`. No transformation, no voice enforcement, no cadence beyond DND, no intent typing, no composer step.

The fix is to split the pipeline into three stages with a typed object flowing between them, and to move most of the decision logic into Rust (both for performance on hot paths and to ship proprietary logic compiled, not in readable JS).

---

## Goals

1. **Structurally prevent the third-person leak** — the fix must be impossible to reintroduce accidentally from new intent sources.
2. **Make ATLAS feel alive** — high-signal proactive behaviors: latent-topic monitors, calendar fusion, memory anticipation, meeting follow-ups.
3. **Protect IP** — voice-defining prompts in Convex; decision logic in compiled Rust.
4. **Per-channel discipline** — calm on WhatsApp, active on Telegram, ambient on overlay (user-configurable).
5. **Fail-closed** — when in doubt, silence beats noise.

## Non-goals

- Training a "should I speak?" ML classifier (YAGNI — Bailey-Konstan heuristic gets 80% of the benefit; revisit once telemetry is collected).
- Redesigning any existing non-proactive subsystem (memory, tools, agent loop stay untouched).
- Changing user-facing commands or personality (Composer reads persona; persona unchanged).

---

## Architecture

Three stages with a typed object between them. One Rust-owned scheduler is the traffic cop.

```
┌────────────────────────────────────────────────────────────────┐
│  INTENT SOURCES  (independent, fail-isolated)                   │
│   latent-topic-monitor   memory-anticipation   calendar-fact-  │
│   calendar-fusion        stale-todo            check           │
│   meeting-followup       habit-anomaly         env-context     │
│   long-task-status       convex-notifications                  │
│                    │  emit ProactiveIntent                     │
└────────────────────┼───────────────────────────────────────────┘
                     ▼
┌────────────────────────────────────────────────────────────────┐
│  SCHEDULER  [Rust: native/src/proactive_scheduler.rs]           │
│   • semantic dedup (cosine > 0.9 in 6h window)                 │
│   • expiry                                                      │
│   • per-channel queues                                          │
│   • boundary detector (idle, app-switch, unlock, meeting-end)  │
│   • posture gate (calm/active/ambient, per-channel)            │
│   • DND + rate limit                                            │
│   • urgent bypass                                               │
└────────────────────┬───────────────────────────────────────────┘
                     ▼ (intent + channel + persona)
┌────────────────────────────────────────────────────────────────┐
│  COMPOSER  [prompt: Convex system_prompts]                      │
│   • template fast-path  →  Haiku LLM fallback                   │
│   • STRICT second-person prompt                                 │
│   • persona tone + channel conventions                          │
│   • recent-send registry (don't repeat)                         │
│   • mode tag: fyi / question / review                           │
└────────────────────┬───────────────────────────────────────────┘
                     ▼
         ┌───────────┴───────────┐
         ▼                       ▼
    Chat channels         Overlay inbox
   (tg/wa/discord/        (review-mode items
    slack/matrix/          stack here; chat
    email)                 fallback when offline)
         │
         ▼
    Telemetry (ProactiveOutcome → SQLite)
```

**Location split:**
- **Rust** — scheduler, matcher, intent validator, boundary detector, priority scoring, dedup, telemetry ring buffer
- **Convex (server-side)** — Composer system prompt, monitor-rule parser prompt
- **TypeScript (thin)** — intent-source adapters, WebSocket handlers, channel send helpers, napi glue

---

## Data Types

### ProactiveIntent

```typescript
// src/proactive/intent.ts — TS shim; validation in Rust
type ProactiveIntent = {
  id: string;                       // stable
  source: IntentSource;
  mode: "fyi" | "question" | "review";
  urgency: "urgent" | "normal" | "ambient";
  channelPreference: Channel | "any";
  topic: string;
  topicEmbedding: number[];         // 384-dim MiniLM
  evidence: Evidence[];
  payload: { kind: string; [k: string]: unknown };
  suggestedAction?: { toolCalls: ToolCall[]; summary: string };
  createdAt: number;
  expiresAt: number;
};

type IntentSource =
  | "latent_topic_monitor" | "memory_anticipation" | "calendar_fact_check"
  | "calendar_fusion"      | "stale_todo"          | "meeting_followup"
  | "habit_anomaly"        | "env_context"         | "long_task_status"
  | "convex_notification";

type Channel =
  | "whatsapp" | "telegram" | "discord" | "slack"
  | "matrix"   | "email"    | "overlay";
```

### MonitorRule

```typescript
type MonitorRule = {
  id: string;
  userPhrase: string;
  topic: string;
  topicEmbedding: number[];
  scope: {
    channels: Channel[];            // ["*"] = all
    groups?: string[];
    senders?: string[];
    excludeSelf: boolean;           // default true
  };
  urgency: "urgent" | "normal" | "ambient";
  action: {
    defaultMode: "fyi" | "question" | "review";
    suggestedFollowup?: string;
  };
  threshold: number;                // cosine cutoff, default 0.82
  cooldownMinutes: number;          // default 60
  active: boolean;
  lastFiredAt?: number;
  expiresAt?: number;
  createdAt: number;
};
```

### InboxItem

```typescript
type InboxItem = {
  intent: ProactiveIntent;
  status: "pending" | "approved" | "rejected" | "deferred" | "expired";
  composedText: string;
  createdAt: number;
  userActionAt?: number;
  userAction?: "approve" | "reject" | "defer" | "edit";
  editedText?: string;
  executionStatus?: "idle" | "running" | "done" | "failed";
  executionResult?: string;
};
```

### ProactiveOutcome (telemetry)

```typescript
type ProactiveOutcome = {
  intentId: string;
  source: IntentSource;
  channel: Channel;
  decision: "enqueued" | "dropped" | "released" | "dispatched";
  dropReason?: "expired" | "dedup" | "skip_composer" | "posture_blocked";
  dispatchedAt?: number;
  userReplied: boolean;
  userReplyLatencyMs?: number;
  userReplySentiment?: "positive" | "neutral" | "negative";
  userMarkedUseful?: boolean;
};
```

---

## Components

### Intent Sources (10 total)

Each implements a single method: `collectIntents(ctx): ProactiveIntent[]`. Wrapped in try/catch by the Observer — one failure can't block siblings. No LLM calls except in MemoryAnticipation and MeetingFollowup.

| # | Source | Trigger | Default mode | Rust vs TS |
|---|---|---|---|---|
| 1 | LatentTopicMonitor | inbound text matches rule (cosine > threshold) | question | Rust matcher; TS CRUD |
| 2 | MemoryAnticipation | time + traits + session summary → useful thought | fyi | Rust scoring; TS LLM hop |
| 3 | CalendarFactCheck | statement contradicts calendar/email | question | Rust scorer; TS fetch |
| 4 | CalendarFusion | event shift → downstream impact | fyi | Rust impact graph; TS provider |
| 5 | StaleTodo | deadline near + no activity | fyi/question | Rust scoring; TS source |
| 6 | MeetingFollowup | meeting ended + transcript ready | review | Rust action planner; TS transcript |
| 7 | HabitAnomaly | normal routine not observed | fyi | Rust (extends `habit_detector.rs`) |
| 8 | EnvContext | weather/commute/flight delta crosses threshold | fyi | Rust delta; TS provider |
| 9 | LongTaskStatus | background task done / needs input | review | TS event hook |
| 10 | ConvexNotification | credit warnings, pending store actions | fyi | TS webhook |

### Scheduler [`native/src/proactive_scheduler.rs`]

**Release decision:**
```
for each queued intent (highest priority first):
  if expired         → drop + log
  if dedup_hit       → drop + log
  if dnd_active      → keep queued (unless urgent + after urgent_allowed_after)
  if rate_exceeded   → keep queued
  if posture.boundary_only AND !in_boundary_window
                     → keep queued (unless urgent)
  if gap_since_last < posture.min_gap_minutes
                     → keep queued (unless urgent)
  → release this intent, update rate counters, emit dispatch event
```

**Priority formula:**
```
priority = base_urgency × freshness × posture_weight × source_weight
  base_urgency:   urgent=100, normal=10, ambient=1
  freshness:      exp(-age_min / intent.expires_in_min)
  posture_weight: ambient=0.3 for non-user-defined sources (latent_topic_monitor
                  treated as user-defined, weight 1.0); calm=0.7; active=1.0
  source_weight:  LatentTopicMonitor=1.5, CalendarFactCheck=1.3,
                  MeetingFollowup=1.2, CalendarFusion=1.0, LongTaskStatus=1.0,
                  HabitAnomaly=0.9, StaleTodo=0.9, ConvexNotification=0.8,
                  EnvContext=0.8, MemoryAnticipation=0.7
                  (auto-adjusts based on rejection rate, bounded [0.2, 2.0])
```

**Boundary events** (emitted from `src/proactive/activity.ts` + `environment-sensors.ts` as `BoundaryEvent` enum into Rust):
- `idle_start` (no input >2min), `idle_end`
- `app_switch` (NSWorkspace / equivalent)
- `screen_lock`, `screen_unlock`
- `meeting_end` (calendar + presence correlation)
- `typing_stopped` (60s since last keystroke in tracked apps)

**Posture presets** (per-channel, `data/proactive-config.json`):

| preset | maxPerDay | minGapMin | heartbeatMin | boundaryOnly | urgentBypass |
|---|---|---|---|---|---|
| calm | 3 | 120 | 120 | ✓ | ✓ |
| active | 8 | 45 | 60 | ✗ | ✓ |
| ambient | 1 | 360 | 240 | ✓ | ✓ |

Defaults: `whatsapp=calm, telegram=active, overlay=ambient`. User changes via chat (`atlas, set whatsapp to ambient`) → parsed in TS → `setPosture()` napi call → hot reload in Rust.

**DND** — `src/proactive/dnd.ts` extended: per-channel night windows + global `urgent_allowed_after` (default 07:00). Urgent bypasses boundary gate but NOT night window.

### Composer [`src/proactive/composer.ts` + Convex `system_prompts`]

The only code in the system that produces outbound proactive text.

**Flow:**
1. Template fast-path (deterministic, no LLM) — handles `long_task_status`, `convex_notification`, `stale_todo_simple`, `calendar_fusion`.
2. LLM fallback (Haiku-4.5) — handles nuanced intents. Fetches prompt from Convex via existing `fetchSystemPrompt("proactive-composer")` pattern. Returns `{ text, modeTag, skip: boolean }` as JSON.
3. Fail-closed: malformed / `skip:true` → return null → silence.

**Convex-hosted system prompt (`proactive-composer`):**
```
You are ATLAS composing a proactive message to your user.
Input: a structured ProactiveIntent + channel + persona tone + recent sends.
Output: ONE message addressed to the user.

ABSOLUTE RULES:
1. SECOND PERSON. "You" — never "Dheeraj", never "the user", never "he/they".
2. NO META-REASONING. Banned phrases: "might be worth", "probably useful",
   "worth a quick recap", "been away for X hours", "could be helpful",
   "just checking in", "wanted to ask", "a quick thought".
3. NO REPETITION. `recentSends` is provided — do not restate its themes.
4. MODE DISCIPLINE:
   - fyi:      state the fact. No question mark at end.
   - question: exactly one question.
   - review:   end with ONE action phrased as approve/defer/skip.
5. CHANNEL LENGTHS:
   - telegram/whatsapp/slack/discord: fyi≤2, question≤3, review≤4 sentences
   - overlay/email:                   fyi≤4, question≤5, review≤7 sentences
6. Emoji only if persona.tone contains "warm". Max one.
7. If evidence is too thin to obey every rule: return {"skip": true}.

Respond: {"text": "...", "modeTag": "fyi|question|review", "skip": false}
```

**Recent-sends registry:** last 10 proactive messages per channel, kept in Rust, passed into Composer to prevent repetition.

**Mode visibility:**
- Chat: leading emoji — 💡 fyi, ❓ question, ✅ review
- Overlay: explicit `[FYI|Ask|Review]` tag + filter controls

### Latent-Topic Monitor [`native/src/proactive_monitor.rs` + `src/proactive/monitor-commands.ts`]

**NL rule creation** (Convex prompt, slug `monitor-rule-parser`):
```
Extract a MonitorRule from the user's natural-language request.
Defaults: channels=["*"], urgency="normal", mode="question",
threshold=0.82, cooldown=60.
Return JSON matching the schema. Ask a clarifying question
in a "needsClarification" field if scope is ambiguous.
```

**Matcher** — called on every inbound message across every channel:
```rust
pub struct MonitorMatcher {
    rules: Vec<MonitorRule>,
    rule_embeddings: Array2<f32>,   // stacked for batch SIMD
}

impl MonitorMatcher {
    pub fn check(&self, msg_emb: &[f32], channel: &str, sender: &str)
        -> Vec<RuleHit> {
        // 1. filter by scope + active + cooldown
        // 2. batched cosine similarity (SIMD, vector.rs)
        // 3. return hits above threshold
    }
}
```

Hook: one line in each channel's receive handler:
```typescript
const hits = monitorMatcher.check(embedMessage(msg), channel, senderId);
for (const hit of hits) observer.emitLatentTopicHit(hit, msg);
```

**Chat commands** (owner-only, any channel):

| Command | Action |
|---|---|
| `monitor me when X` / `ping me if X` | create |
| `list monitors` / `show monitors` | numbered list |
| `delete monitor N` / `stop monitor N` | soft delete |
| `pause monitor N` / `resume monitor N` | toggle |
| `edit monitor N urgency urgent` | update field |
| `monitor help` | usage |

Regex first-pass for common shapes; LLM fallback for complex cases.

**Privacy property:** rule embeddings and matched messages stay on-device. Only the NL parser round-trips (once, at rule creation).

### Agent Inbox [`src/overlay/inbox.ts` + chat adapters]

Review-mode intents stack in the overlay instead of interrupting chat.

**WebSocket events (on existing overlay WS):**

| Direction | Event | Payload |
|---|---|---|
| server→client | `inbox:state` | full list on connect |
| server→client | `inbox:item_added` | new item |
| server→client | `inbox:item_updated` | status/executionStatus change |
| client→server | `inbox:approve` | `{ id }` |
| client→server | `inbox:reject` | `{ id, reason? }` |
| client→server | `inbox:edit` | `{ id, newText }` |
| client→server | `inbox:defer` | `{ id, until }` |

**Execution on Approve:**
1. Mark `status=approved`, `executionStatus=running`
2. Run `intent.suggestedAction.toolCalls` via `runAgent(…, { isOwner: true, internalOrigin: true })`
3. Stream status back via `inbox:item_updated`
4. On completion, show inline result
5. Telemetry: `approved → executed → outcome`

**Chat-channel fallback** (overlay offline >30s):

| Channel | Pattern |
|---|---|
| Telegram | `InlineKeyboardMarkup` — callback_data routes to inbox handlers |
| WhatsApp | Baileys interactive buttons where supported; else "Reply 1/2/3" |
| Discord | Message components (buttons) |
| Slack | Block Kit buttons |
| Email | Signed magic links (GET `/inbox/action?id=…&action=approve&sig=…`) |
| Matrix | `m.notice` buttons + reactions fallback |

**Defer options:** 1h / 3h / tomorrow 9am / this weekend / custom. Deferred items reused same `composedText`, re-scheduled at `deferred_until`.

**What's NOT in the inbox:**
- `fyi` mode items for chat channels → ship to chat as briefs
- `question` mode for chat → ask on chat (deferred question feels weird)
- Only `review` mode always goes to inbox + chat fallback. `fyi` and `question` are chat-primary.

### Telemetry & Self-Tuning

- Every enqueue / drop / release / dispatch → ring buffer in Rust, flushed every 60s to SQLite `proactive_outcomes` table.
- Reply within 10min tracked; sentiment via existing `emotion-detector.ts`.
- Rejection rate per `{source × channel}` auto-adjusts `source_weight` in priority formula, bounded `[0.2, 2.0]`. Pure counter — no model training.

---

## Storage

### SQLite (in `data/memories.db`)

**New tables:**

```sql
CREATE TABLE monitor_rules (
  id TEXT PRIMARY KEY,
  user_phrase TEXT NOT NULL,
  topic TEXT NOT NULL,
  topic_embedding BLOB NOT NULL,      -- Float32Array(384)
  scope_json TEXT NOT NULL,
  urgency TEXT NOT NULL,
  action_json TEXT NOT NULL,
  threshold REAL NOT NULL,
  cooldown_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE inbox_items (
  intent_id TEXT PRIMARY KEY,
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL,
  composed_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_action_at INTEGER,
  user_action TEXT,
  edited_text TEXT,
  execution_status TEXT,
  execution_result TEXT
);
CREATE INDEX idx_inbox_status ON inbox_items(status, created_at);

CREATE TABLE proactive_outcomes (
  intent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  decision TEXT NOT NULL,
  drop_reason TEXT,
  dispatched_at INTEGER,
  user_replied INTEGER NOT NULL DEFAULT 0,
  user_reply_latency_ms INTEGER,
  user_reply_sentiment TEXT,
  user_marked_useful INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_outcomes_source_channel ON proactive_outcomes(source, channel, created_at);
```

### Config file

`data/proactive-config.json`:
```json
{
  "postures": {
    "whatsapp": "calm",
    "telegram": "active",
    "overlay": "ambient",
    "discord": "calm",
    "slack": "calm",
    "matrix": "calm",
    "email": "ambient"
  },
  "urgentAllowedAfter": "07:00",
  "nightWindows": {
    "default": { "start": "22:30", "end": "07:00" }
  }
}
```

### Convex (new seed content)

Two new `system_prompts` slugs: `proactive-composer`, `monitor-rule-parser`. Seeded via existing `scripts/seed-system-content.ts`.

---

## Migration / Rollout

Staged, flag-gated, reversible. Each phase independently shippable.

| Phase | Content | Flag | Default |
|---|---|---|---|
| 0 | Foundations — types, Rust stubs, SQLite migrations, Convex prompts seeded | (none) | always on |
| 1 | **Composer ships** — wraps existing `innerThoughtsTick` output, fixes the bug | `ATLAS_PROACTIVE_V2_COMPOSER` | **ON** |
| 2 | Scheduler + boundary events | `ATLAS_PROACTIVE_V2_SCHEDULER` | **ON** |
| 3 | Intent sources (one flag each, enabled incrementally in this order: MemoryAnticipation → HabitAnomaly → LongTaskStatus → ConvexNotification → CalendarFusion → EnvContext → StaleTodo → CalendarFactCheck → MeetingFollowup → LatentTopicMonitor) | `ATLAS_PROACTIVE_V2_SOURCE_<name>` | per-source |
| 4 | Inbox (overlay + chat fallback) | `ATLAS_PROACTIVE_V2_INBOX` | on once stable |
| 5 | Delete legacy paths — remove direct `sendWhatsAppProactiveMessage` callbacks from `index.ts`, delete old `innerThoughtsTick` direct path | (flag removal) | post-stable |

**Kill switches** (convention matches existing `ATLAS_NO_*`):

| Flag | Effect |
|---|---|
| `ATLAS_PROACTIVE_DISABLE=true` | global mute, emergency stop |
| `ATLAS_PROACTIVE_DISABLE_SOURCES=csv` | disable specific sources |
| `ATLAS_PROACTIVE_DISABLE_CHANNELS=csv` | mute specific channels |
| `ATLAS_PROACTIVE_SHADOW=true` | dry-run: runs pipeline, logs decisions, doesn't send |

**Chat commands** (owner):
- `atlas, shut up` → global kill for 24h
- `atlas resume` → unset
- `atlas proactive status` → last 20 decisions with reasons
- `atlas proactive stats` → weekly digest per source per channel

---

## Testing

ATLAS has no test suite today. This change introduces one, **scoped to the proactive subsystem only** — justified because silent proactive bugs have high user-visible cost, and the bug we're fixing would have been caught by one snapshot test. Uses `node:test` (Node 20 built-in, zero dep).

**Coverage:**

| Area | Tests |
|---|---|
| `proactive_scheduler` (Rust) | dedup, priority ordering, boundary gate, DND, urgency bypass — Cargo unit tests |
| Composer prompt | snapshot: known intent + persona → output must be 2nd-person, no banned phrases, within length |
| **Regression suite for THE BUG** | the four screenshot examples as test cases → assert output does NOT contain "been away for X hours", "worth a quick recap", etc. |
| LatentTopicMonitor matcher | SIMD cosine hit rate at thresholds 0.75, 0.82, 0.9 |
| Intent source isolation | mock one source to throw → assert others still run |
| End-to-end | synthetic signal → dispatched message, asserting Composer contract |

---

## Observability

- Structured `data/logs/proactive.log` — `{intentId, source, channel, decision, reason, ts}`, 7-day rotation, JSON-per-line, grep-friendly.
- Debug log follows existing `src/utils/debug-log.ts` format: `🔧 [proactive] channel=X source=Y | id — action`.
- Silenced via `ATLAS_PROACTIVE_DEBUG=false`.

---

## IP Protection Summary

| Piece | Location | Accessible to user how |
|---|---|---|
| Composer system prompt | Convex `system_prompts` | Only via authenticated API proxy |
| Monitor-rule parser prompt | Convex `system_prompts` | Only via authenticated API proxy |
| Priority scoring formula | compiled Rust (`proactive_scheduler.rs`) | Binary only, no JS |
| Boundary detection logic | compiled Rust | Binary only |
| Semantic dedup | compiled Rust | Binary only |
| Intent validation | compiled Rust | Binary only |
| Self-tuning weights | compiled Rust + SQLite counters | Binary only |
| Banned-phrases list | inside Convex prompt | Server-side only |

TypeScript layer is a thin shim (napi glue + WebSocket handlers + channel send helpers). All decision-making logic and voice definitions are either in compiled Rust binaries or in Convex server prompts.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Phase 1 ships but silences too many intents (Composer returns `skip:true` too often) | Shadow-mode rollout (`ATLAS_PROACTIVE_SHADOW=true`) logs decisions for 48h before going live. Adjust prompt on observed skip rate. |
| Latent-topic monitor generates false positives | Default `threshold=0.82` (tuned), per-rule cooldown, two-layer dedup (per-rule + scheduler semantic). Chat commands to tune threshold per rule. |
| Overlay inbox grows unbounded | Auto-expire items after 7 days. "Dismiss all" action. |
| Rust crash takes down proactive subsystem | All napi calls wrapped in try/catch on TS side; fallback path is pure-TS degraded mode (no dedup, no boundary gate, still fixes the bug via Composer). |
| New intent source leaks third-person text | Structurally impossible: all outbound goes through Composer, Composer prompt banned-phrases list is append-only. Regression suite enforces. |
| User wants to turn it all off | `atlas, shut up` + `ATLAS_PROACTIVE_DISABLE=true` env. |

---

## Out of Scope (for this spec)

- Training a "should I speak?" classifier (revisit after 90 days of telemetry)
- Cross-device state sync for the inbox (overlay on one Mac only, for now)
- Voice-channel proactive (live mode) — separate design
- Proactive behavior inside `awaiting_approval` plan mode — should not proactive-send in that state at all, handled by scheduler gate

---

## Open Questions

None at spec finalization time. All scope decisions made during brainstorming:
- Scope: full overhaul ✓
- Surface: chat + desktop overlay inbox ✓
- Posture: user-configurable per channel, sensible defaults ✓
- Monitor config: natural-language via chat ✓
- Timing: boundary-preferring with urgency bypass ✓
- IP: Rust + Convex prompts ✓

---

## Success Criteria

1. Zero third-person leaks in 30-day post-rollout window (regression suite + telemetry audit).
2. Proactive-send rejection rate < 20% per-channel on defaults.
3. User-reported "feels alive" via explicit thumbs-up on ≥ 30% of messages within 60 days.
4. `atlas proactive stats` shows signal-to-noise > 2.0 (useful / dismissed) per source after 30 days.
5. Median time from boundary event to release < 2 seconds (Rust scheduler).
