# Proactiveness Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild ATLAS proactive messaging as typed Observer → Scheduler → Composer pipeline. Structurally prevent the third-person leak. Add latent-topic monitors, boundary-aware timing, and an agent-inbox surface. Move decision logic to Rust; keep voice-defining prompts in Convex.

**Architecture:** Intent sources emit `ProactiveIntent` objects (typed, never narrative strings). A Rust `proactive_scheduler` queues them, applies dedup / boundary / posture / DND gates, and releases to the Composer. The Composer (Convex-hosted prompt) produces second-person channel-appropriate text. Review-mode items surface in an overlay inbox with chat fallback. All existing direct `send*ProactiveMessage` callback sites route through the new pipeline.

**Tech Stack:** TypeScript (ES modules, NodeNext), Rust (napi-rs, wide SIMD, rayon), Convex (system_prompts), SQLite (better-sqlite3), Vitest (tests), Biome (lint).

**Spec:** `docs/superpowers/specs/2026-04-21-proactiveness-overhaul-design.md`

**Reference paths used throughout (verified 2026-04-21):**
- Heartbeat: `src/proactive/heartbeat.ts` — `startHeartbeat` signature at L47-50, `innerThoughtsTick` call at L169-206
- Inner thoughts: `src/proactive/inner-thoughts.ts` — `formThought()` at L198-246 (the bug)
- Activity: `src/proactive/activity.ts` — `describePresence` at L199
- Dispatch: `src/index.ts` — `startHeartbeat(...)` call at L455-486 with `onNotification` callback
- WhatsApp send: `src/whatsapp.ts:1578` — `sendWhatsAppProactiveMessage(message, filePath?)`
- Telegram send: `src/telegram.ts:1606` — `sendProactiveMessage(bot, config, message, filePath?)`
- Overlay WS: `src/overlay/overlay-chat.ts`
- Native lib entry: `native/src/lib.rs` L55-84 (module `pub use` block)
- Convex prompts: `convex/systemContent.ts` (`getPromptBySlug`), seed script `scripts/seed-system-content.ts`
- SQLite init: `src/memory/sqlite.ts:146`
- Test runner: Vitest (already installed; `npm test` = `vitest run`)

---

## Phase 0 — Foundations

Zero user-visible change. Types, Rust stubs, SQLite migrations, Convex prompt seeding, config file.

### Task 0.1: Create `ProactiveIntent` type module

**Files:**
- Create: `src/proactive/intent.ts`

- [ ] **Step 1: Write the failing test**

Create `src/proactive/intent.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateIntent, makeIntentId, type ProactiveIntent } from "./intent.js";

describe("ProactiveIntent", () => {
  it("validates a well-formed intent", () => {
    const intent: ProactiveIntent = {
      id: "test-1",
      source: "memory_anticipation",
      mode: "fyi",
      urgency: "normal",
      channelPreference: "any",
      topic: "sample",
      topicEmbedding: new Array(384).fill(0),
      evidence: [],
      payload: { kind: "simple_note", note: "hi" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    expect(validateIntent(intent).ok).toBe(true);
  });

  it("rejects intent with wrong embedding length", () => {
    const intent: ProactiveIntent = {
      id: "test-2",
      source: "memory_anticipation",
      mode: "fyi",
      urgency: "normal",
      channelPreference: "any",
      topic: "sample",
      topicEmbedding: [0, 0, 0],
      evidence: [],
      payload: { kind: "simple_note" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const r = validateIntent(intent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/embedding/i);
  });

  it("generates unique intent ids", () => {
    const a = makeIntentId("memory_anticipation");
    const b = makeIntentId("memory_anticipation");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^memory_anticipation_/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proactive/intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/proactive/intent.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
export type IntentSource =
  | "latent_topic_monitor" | "memory_anticipation" | "calendar_fact_check"
  | "calendar_fusion" | "stale_todo" | "meeting_followup"
  | "habit_anomaly" | "env_context" | "long_task_status"
  | "convex_notification";

export type Channel =
  | "whatsapp" | "telegram" | "discord" | "slack"
  | "matrix" | "email" | "overlay";

export type ProactiveMode = "fyi" | "question" | "review";
export type Urgency = "urgent" | "normal" | "ambient";

export type Evidence = {
  label: string;
  value: string;
  source?: string;
};

export type SuggestedToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

export type SuggestedAction = {
  toolCalls: SuggestedToolCall[];
  summary: string;
};

export type ProactiveIntent = {
  id: string;
  source: IntentSource;
  mode: ProactiveMode;
  urgency: Urgency;
  channelPreference: Channel | "any";
  topic: string;
  topicEmbedding: number[];
  evidence: Evidence[];
  payload: { kind: string; [k: string]: unknown };
  suggestedAction?: SuggestedAction;
  createdAt: number;
  expiresAt: number;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

const VALID_SOURCES: IntentSource[] = [
  "latent_topic_monitor", "memory_anticipation", "calendar_fact_check",
  "calendar_fusion", "stale_todo", "meeting_followup",
  "habit_anomaly", "env_context", "long_task_status",
  "convex_notification",
];
const VALID_MODES: ProactiveMode[] = ["fyi", "question", "review"];
const VALID_URGENCIES: Urgency[] = ["urgent", "normal", "ambient"];

export function validateIntent(i: ProactiveIntent): ValidationResult {
  if (!i.id || typeof i.id !== "string") return { ok: false, error: "id missing" };
  if (!VALID_SOURCES.includes(i.source)) return { ok: false, error: `bad source: ${i.source}` };
  if (!VALID_MODES.includes(i.mode)) return { ok: false, error: `bad mode: ${i.mode}` };
  if (!VALID_URGENCIES.includes(i.urgency)) return { ok: false, error: `bad urgency: ${i.urgency}` };
  if (!Array.isArray(i.topicEmbedding) || i.topicEmbedding.length !== 384) {
    return { ok: false, error: "embedding must be length 384" };
  }
  if (!i.payload?.kind) return { ok: false, error: "payload.kind missing" };
  if (typeof i.createdAt !== "number") return { ok: false, error: "createdAt missing" };
  if (typeof i.expiresAt !== "number") return { ok: false, error: "expiresAt missing" };
  if (i.expiresAt <= i.createdAt) return { ok: false, error: "expiresAt <= createdAt" };
  if (i.mode === "review" && !i.suggestedAction) {
    return { ok: false, error: "review mode requires suggestedAction" };
  }
  return { ok: true };
}

export function makeIntentId(source: IntentSource): string {
  return `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/proactive/intent.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/proactive/intent.ts src/proactive/intent.test.ts
git commit -m "proactive: add ProactiveIntent type + validator (Phase 0)"
```

---

### Task 0.2: Add SQLite migrations for new tables

**Files:**
- Modify: `src/memory/sqlite.ts` (append to the existing schema init around L146)
- Create: `src/memory/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/memory/migrations.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { initSqliteSchema } from "./sqlite.js";

describe("proactive subsystem migrations", () => {
  const db = new Database(":memory:");
  beforeAll(() => initSqliteSchema(db));

  it("creates monitor_rules table", () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_rules'").get() as { name?: string } | undefined;
    expect(row?.name).toBe("monitor_rules");
  });
  it("creates inbox_items table with status index", () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_items'").get() as { name?: string } | undefined;
    expect(t?.name).toBe("inbox_items");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_status'").get() as { name?: string } | undefined;
    expect(idx?.name).toBe("idx_inbox_status");
  });
  it("creates proactive_outcomes table", () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_outcomes'").get() as { name?: string } | undefined;
    expect(t?.name).toBe("proactive_outcomes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/migrations.test.ts`
Expected: FAIL — `initSqliteSchema` doesn't know about these tables (OR the function doesn't accept a db arg; adapt based on actual signature).

- [ ] **Step 3: Extract + extend schema init**

Open `src/memory/sqlite.ts`. If `initSqliteSchema` is not already exported or is inlined, refactor the `CREATE TABLE memories ...` block (L146+) into an exported `initSqliteSchema(db: Database.Database): void` function. Then append these statements inside it:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_rules (
    id TEXT PRIMARY KEY,
    user_phrase TEXT NOT NULL,
    topic TEXT NOT NULL,
    topic_embedding BLOB NOT NULL,
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
  CREATE TABLE IF NOT EXISTS inbox_items (
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
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, created_at);
  CREATE TABLE IF NOT EXISTS proactive_outcomes (
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
  CREATE INDEX IF NOT EXISTS idx_outcomes_source_channel
    ON proactive_outcomes(source, channel, created_at);
`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/migrations.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Verify prod DB still opens**

Run: `npm run typecheck && npm run build`
Expected: no errors. Start ATLAS once (`npm run dev` briefly, Ctrl-C after boot completes) and confirm `data/memories.db` still opens with no "table already exists" errors.

- [ ] **Step 6: Commit**

```bash
git add src/memory/sqlite.ts src/memory/migrations.test.ts
git commit -m "proactive: add SQLite tables for monitor_rules, inbox_items, outcomes (Phase 0)"
```

---

### Task 0.3: Seed Convex system_prompts for proactive

**Files:**
- Create: `prompts/proactive-composer.md`
- Create: `prompts/monitor-rule-parser.md`
- Modify: `scripts/seed-system-content.ts` (include new slugs if the script enumerates)

- [ ] **Step 1: Create `prompts/proactive-composer.md`**

```markdown
---
slug: proactive-composer
description: Composer prompt for proactive messages. STRICT second-person, fail-closed.
---
You are ATLAS composing a proactive message to your user.
Input: a structured ProactiveIntent + channel + persona tone + recent sends.
Output: ONE message addressed to the user.

ABSOLUTE RULES:
1. SECOND PERSON. "You" — never the user's name, never "the user", never "he/she/they".
2. NO META-REASONING. Banned phrases (case-insensitive substring match):
   "might be worth", "probably useful", "worth a quick recap",
   "been away for", "could be helpful", "just checking in",
   "wanted to ask", "a quick thought", "might be good to", "worth checking".
3. NO REPETITION. `recentSends` is provided — do not restate its themes or openers.
4. MODE DISCIPLINE:
   - fyi:      state the fact. No question mark at end.
   - question: exactly one question mark.
   - review:   end with ONE action phrased as approve/defer/skip.
5. CHANNEL LENGTHS (sentences):
   - telegram / whatsapp / slack / discord: fyi≤2, question≤3, review≤4
   - overlay / email:                       fyi≤4, question≤5, review≤7
6. Emoji only if persona.tone contains "warm". Max one.
7. If evidence is too thin to obey every rule: return {"skip": true}.

Respond as pure JSON: {"text": "...", "modeTag": "fyi|question|review", "skip": false}
```

- [ ] **Step 2: Create `prompts/monitor-rule-parser.md`**

```markdown
---
slug: monitor-rule-parser
description: Parse user natural-language requests into MonitorRule JSON.
---
Extract a MonitorRule from the user's natural-language request.

Defaults if unspecified: channels=["*"], urgency="normal", mode="question",
threshold=0.82, cooldown=60, excludeSelf=true.

Return JSON exactly matching:
{
  "topic": string,                       // canonical short description
  "scope": {
    "channels": string[],                // or ["*"]
    "groups"?: string[],
    "senders"?: string[],
    "excludeSelf": boolean
  },
  "urgency": "urgent"|"normal"|"ambient",
  "action": {
    "defaultMode": "fyi"|"question"|"review",
    "suggestedFollowup"?: string
  },
  "threshold": number,                   // [0.6, 0.95]
  "cooldownMinutes": number,             // >= 5
  "expiresAt"?: number                   // ms epoch, if time-bounded
}

If scope is ambiguous, return {"needsClarification": "question text"} instead.
```

- [ ] **Step 3: Seed to Convex**

Run: `npx tsx scripts/seed-system-content.ts`
Expected: the two new slugs show up as upserted. If the script doesn't enumerate the directory, add the slugs to whatever list it uses.

- [ ] **Step 4: Verify via query**

Run a quick ts snippet (or the existing Convex dashboard) to confirm `getPromptBySlug({ slug: "proactive-composer" })` returns the content.

- [ ] **Step 5: Commit**

```bash
git add prompts/proactive-composer.md prompts/monitor-rule-parser.md scripts/seed-system-content.ts
git commit -m "proactive: seed Convex system prompts for composer + monitor parser (Phase 0)"
```

---

### Task 0.4: Create proactive-config.json + loader

**Files:**
- Create: `src/proactive/config.ts`
- Create: `src/proactive/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProactiveConfig, getPosture, setPosture, type ProactiveConfig } from "./config.js";

describe("proactive config", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atlas-proactive-"));
    file = join(dir, "proactive-config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns defaults when file missing", () => {
    const c = loadProactiveConfig(file);
    expect(c.postures.whatsapp).toBe("calm");
    expect(c.postures.telegram).toBe("active");
    expect(c.postures.overlay).toBe("ambient");
  });

  it("reads + persists posture changes", () => {
    const c = loadProactiveConfig(file);
    setPosture(c, "whatsapp", "ambient", file);
    const reloaded = loadProactiveConfig(file);
    expect(reloaded.postures.whatsapp).toBe("ambient");
    expect(getPosture(reloaded, "whatsapp")).toBe("ambient");
  });

  it("rejects unknown channel", () => {
    const c = loadProactiveConfig(file);
    expect(() => setPosture(c, "xmpp" as any, "calm", file)).toThrow(/channel/i);
  });

  it("rejects unknown preset", () => {
    const c = loadProactiveConfig(file);
    expect(() => setPosture(c, "whatsapp", "spammy" as any, file)).toThrow(/preset/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proactive/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/proactive/config.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "./intent.js";

export type Posture = "calm" | "active" | "ambient";
export type ProactiveConfig = {
  postures: Record<Channel, Posture>;
  urgentAllowedAfter: string;            // "HH:MM"
  nightWindows: { default: { start: string; end: string } };
};

const VALID_CHANNELS: Channel[] = [
  "whatsapp","telegram","discord","slack","matrix","email","overlay",
];
const VALID_POSTURES: Posture[] = ["calm","active","ambient"];

const DEFAULTS: ProactiveConfig = {
  postures: {
    whatsapp: "calm",
    telegram: "active",
    overlay:  "ambient",
    discord:  "calm",
    slack:    "calm",
    matrix:   "calm",
    email:    "ambient",
  },
  urgentAllowedAfter: "07:00",
  nightWindows: { default: { start: "22:30", end: "07:00" } },
};

export function loadProactiveConfig(path: string): ProactiveConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { ...DEFAULTS, ...raw, postures: { ...DEFAULTS.postures, ...(raw.postures ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function getPosture(cfg: ProactiveConfig, ch: Channel): Posture {
  return cfg.postures[ch] ?? "calm";
}

export function setPosture(
  cfg: ProactiveConfig,
  channel: Channel,
  preset: Posture,
  path: string,
): void {
  if (!VALID_CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`);
  if (!VALID_POSTURES.includes(preset)) throw new Error(`unknown preset: ${preset}`);
  cfg.postures[channel] = preset;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

export const POSTURE_PARAMS: Record<Posture, {
  maxPerDay: number;
  minGapMin: number;
  heartbeatMin: number;
  boundaryOnly: boolean;
  urgentBypass: boolean;
}> = {
  calm:    { maxPerDay: 3, minGapMin: 120, heartbeatMin: 120, boundaryOnly: true,  urgentBypass: true },
  active:  { maxPerDay: 8, minGapMin: 45,  heartbeatMin: 60,  boundaryOnly: false, urgentBypass: true },
  ambient: { maxPerDay: 1, minGapMin: 360, heartbeatMin: 240, boundaryOnly: true,  urgentBypass: true },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/proactive/config.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/proactive/config.ts src/proactive/config.test.ts
git commit -m "proactive: config loader + posture presets (Phase 0)"
```

---

### Task 0.5: Rust module stubs in native/

**Files:**
- Create: `native/src/proactive_scheduler.rs`
- Create: `native/src/proactive_monitor.rs`
- Create: `native/src/proactive_intent.rs`
- Modify: `native/src/lib.rs` (extend the `pub use` block at L55-84)

- [ ] **Step 1: Create `native/src/proactive_intent.rs`**

```rust
// © 2024-2026 XAGI Labs Private Limited
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustProactiveIntent {
    pub id: String,
    pub source: String,
    pub mode: String,
    pub urgency: String,
    pub channel_preference: String,
    pub topic: String,
    pub topic_embedding: Vec<f64>, // napi can't do f32 directly in arrays
    pub payload_kind: String,
    pub created_at: f64,
    pub expires_at: f64,
}

#[napi(object)]
pub struct RustValidationResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[napi]
pub fn validate_intent_rust(intent: RustProactiveIntent) -> RustValidationResult {
    if intent.id.is_empty() {
        return RustValidationResult { ok: false, error: Some("id missing".into()) };
    }
    if intent.topic_embedding.len() != 384 {
        return RustValidationResult {
            ok: false,
            error: Some(format!("embedding must be length 384, got {}", intent.topic_embedding.len())),
        };
    }
    if intent.expires_at <= intent.created_at {
        return RustValidationResult { ok: false, error: Some("expiresAt <= createdAt".into()) };
    }
    RustValidationResult { ok: true, error: None }
}
```

- [ ] **Step 2: Create `native/src/proactive_scheduler.rs` stub**

```rust
// © 2024-2026 XAGI Labs Private Limited
// Stub — full implementation lands in Phase 2.
use napi_derive::napi;

#[napi]
pub fn proactive_scheduler_ping() -> String {
    "proactive_scheduler v0".into()
}
```

- [ ] **Step 3: Create `native/src/proactive_monitor.rs` stub**

```rust
// © 2024-2026 XAGI Labs Private Limited
// Stub — full implementation lands in Phase 3 (LatentTopicMonitor).
use napi_derive::napi;

#[napi]
pub fn proactive_monitor_ping() -> String {
    "proactive_monitor v0".into()
}
```

- [ ] **Step 4: Wire into `native/src/lib.rs`**

Open `native/src/lib.rs`. Find the `pub use` block around L55-84. Append:

```rust
mod proactive_intent;
mod proactive_scheduler;
mod proactive_monitor;

pub use proactive_intent::*;
pub use proactive_scheduler::*;
pub use proactive_monitor::*;
```

Also add the `mod` declarations at the top of the file if the existing pattern uses explicit `mod` declarations (check surrounding lines).

- [ ] **Step 5: Build native**

Run: `npm run build:native`
Expected: success. If missing `serde_json` or `serde`, they're already in `native/Cargo.toml` L12-33 (verified).

- [ ] **Step 6: Smoke test from TS**

Create `scripts/smoke-proactive-native.ts`:

```typescript
import * as native from "../native/index.js";
console.log((native as any).proactiveSchedulerPing?.());
console.log((native as any).proactiveMonitorPing?.());
console.log((native as any).validateIntentRust?.({
  id: "x", source: "memory_anticipation", mode: "fyi", urgency: "normal",
  channelPreference: "any", topic: "t",
  topicEmbedding: new Array(384).fill(0),
  payloadKind: "k", createdAt: 1, expiresAt: 2,
}));
```

Run: `npx tsx scripts/smoke-proactive-native.ts`
Expected output: `"proactive_scheduler v0"`, `"proactive_monitor v0"`, `{ ok: true, error: null }`.

- [ ] **Step 7: Commit**

```bash
git add native/src/proactive_intent.rs native/src/proactive_scheduler.rs native/src/proactive_monitor.rs native/src/lib.rs scripts/smoke-proactive-native.ts
git commit -m "proactive: add Rust module stubs + intent validator (Phase 0)"
```

---

### Task 0.6: Kill-switch env vars + debug logger

**Files:**
- Create: `src/proactive/kill-switches.ts`
- Modify: `.env.example` (document new vars)

- [ ] **Step 1: Write the failing test**

Create `src/proactive/kill-switches.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isProactiveDisabled, isSourceDisabled, isChannelDisabled, isShadowMode, debugProactive } from "./kill-switches.js";

describe("proactive kill switches", () => {
  const original = { ...process.env };
  beforeEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith("ATLAS_PROACTIVE")) delete process.env[k]; });
  afterEach(() => { process.env = { ...original }; });

  it("defaults all off", () => {
    expect(isProactiveDisabled()).toBe(false);
    expect(isSourceDisabled("memory_anticipation")).toBe(false);
    expect(isChannelDisabled("whatsapp")).toBe(false);
    expect(isShadowMode()).toBe(false);
  });

  it("respects global disable", () => {
    process.env.ATLAS_PROACTIVE_DISABLE = "true";
    expect(isProactiveDisabled()).toBe(true);
  });

  it("parses CSV source list", () => {
    process.env.ATLAS_PROACTIVE_DISABLE_SOURCES = "memory_anticipation,env_context";
    expect(isSourceDisabled("memory_anticipation")).toBe(true);
    expect(isSourceDisabled("env_context")).toBe(true);
    expect(isSourceDisabled("stale_todo")).toBe(false);
  });

  it("parses CSV channel list", () => {
    process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS = "whatsapp";
    expect(isChannelDisabled("whatsapp")).toBe(true);
    expect(isChannelDisabled("telegram")).toBe(false);
  });

  it("shadow mode flag", () => {
    process.env.ATLAS_PROACTIVE_SHADOW = "true";
    expect(isShadowMode()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proactive/kill-switches.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/proactive/kill-switches.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { IntentSource, Channel } from "./intent.js";

function isTrue(v: string | undefined): boolean { return v === "true" || v === "1"; }
function parseCsv(v: string | undefined): Set<string> {
  if (!v) return new Set();
  return new Set(v.split(",").map(s => s.trim()).filter(Boolean));
}

export function isProactiveDisabled(): boolean {
  return isTrue(process.env.ATLAS_PROACTIVE_DISABLE);
}
export function isSourceDisabled(src: IntentSource): boolean {
  return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_SOURCES).has(src);
}
export function isChannelDisabled(ch: Channel): boolean {
  return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS).has(ch);
}
export function isShadowMode(): boolean {
  return isTrue(process.env.ATLAS_PROACTIVE_SHADOW);
}

export function debugProactive(
  event: string,
  ctx: Record<string, unknown>
): void {
  if (process.env.ATLAS_PROACTIVE_DEBUG === "false") return;
  const flat = Object.entries(ctx).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  console.log(`🔔 [proactive] ${event} | ${flat}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/proactive/kill-switches.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Update `.env.example`**

Append near the existing `ATLAS_EMBEDDING_MODEL=minilm` line:

```bash
# Proactive subsystem kill switches (all default to OFF / feature enabled)
# ATLAS_PROACTIVE_DISABLE=true              # emergency global mute
# ATLAS_PROACTIVE_DISABLE_SOURCES=memory_anticipation,env_context
# ATLAS_PROACTIVE_DISABLE_CHANNELS=whatsapp,telegram
# ATLAS_PROACTIVE_SHADOW=true               # runs pipeline, doesn't send
# ATLAS_PROACTIVE_DEBUG=false               # silence debug logs
# ATLAS_PROACTIVE_V2_COMPOSER=true          # Phase 1 flag (default ON)
# ATLAS_PROACTIVE_V2_SCHEDULER=true         # Phase 2 flag (default ON)
# ATLAS_PROACTIVE_V2_INBOX=true             # Phase 4 flag
```

- [ ] **Step 6: Commit**

```bash
git add src/proactive/kill-switches.ts src/proactive/kill-switches.test.ts .env.example
git commit -m "proactive: kill-switch env vars + debug logger (Phase 0)"
```

---

## Phase 1 — Composer ships (THE BUG FIX)

After this phase, the third-person leak is structurally impossible. This is the single ship-point we must hit regardless of whether later phases land.

### Task 1.1: Channel-agnostic proactive dispatch helper

Problem: today `src/index.ts` L455-486 hard-codes the fan-out to WhatsApp/Telegram. We need a single `dispatchProactiveMessage(channel, text, mode)` that can route to any channel, so Phase 2 scheduler has one exit point.

**Files:**
- Create: `src/proactive/dispatch.ts`
- Create: `src/proactive/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchProactiveMessage, registerChannelSender } from "./dispatch.js";

describe("dispatchProactiveMessage", () => {
  beforeEach(() => {
    // registry reset via re-register
    for (const ch of ["whatsapp","telegram","discord","slack","matrix","email","overlay"] as const) {
      registerChannelSender(ch, async () => {});
    }
  });

  it("routes to the registered sender for the given channel", async () => {
    const sent: string[] = [];
    registerChannelSender("whatsapp", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("whatsapp", "hello", "fyi");
    expect(sent).toEqual(["hello"]);
  });

  it("throws on unknown channel", async () => {
    await expect(dispatchProactiveMessage("xmpp" as any, "x", "fyi")).rejects.toThrow(/channel/i);
  });

  it("adds mode prefix emoji for chat channels", async () => {
    const sent: string[] = [];
    registerChannelSender("telegram", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("telegram", "msg", "question");
    expect(sent[0]).toMatch(/^❓ /);
  });

  it("no emoji prefix for overlay / email", async () => {
    const sent: string[] = [];
    registerChannelSender("overlay", async (text) => { sent.push(text); });
    await dispatchProactiveMessage("overlay", "msg", "fyi");
    expect(sent[0]).toBe("msg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/proactive/dispatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/proactive/dispatch.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { Channel, ProactiveMode } from "./intent.js";
import { isChannelDisabled, isProactiveDisabled, isShadowMode, debugProactive } from "./kill-switches.js";

export type ChannelSender = (text: string) => Promise<void>;
const senders = new Map<Channel, ChannelSender>();

export function registerChannelSender(channel: Channel, sender: ChannelSender): void {
  senders.set(channel, sender);
}

const EMOJI: Record<ProactiveMode, string> = { fyi: "💡", question: "❓", review: "✅" };
const PREFIXED_CHANNELS: Channel[] = ["whatsapp","telegram","discord","slack","matrix"];

export async function dispatchProactiveMessage(
  channel: Channel,
  text: string,
  mode: ProactiveMode,
): Promise<void> {
  if (isProactiveDisabled()) { debugProactive("suppressed_global", { channel }); return; }
  if (isChannelDisabled(channel)) { debugProactive("suppressed_channel", { channel }); return; }
  if (!senders.has(channel)) throw new Error(`no sender for channel: ${channel}`);
  const prefixed = PREFIXED_CHANNELS.includes(channel) ? `${EMOJI[mode]} ${text}` : text;
  if (isShadowMode()) { debugProactive("shadow_dispatch", { channel, mode, text: prefixed.slice(0,80) }); return; }
  await senders.get(channel)!(prefixed);
  debugProactive("dispatched", { channel, mode, text: prefixed.slice(0,80) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/proactive/dispatch.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Register channel senders at boot**

In `src/index.ts`, near the imports at the top, add:

```typescript
import { registerChannelSender } from "./proactive/dispatch.js";
```

After Telegram init (find where `bot` is available and the other channels are set up), add:

```typescript
registerChannelSender("whatsapp", async (text) => { await sendWhatsAppProactiveMessage(text); });
registerChannelSender("telegram", async (text) => { await sendProactiveMessage(bot, config, text); });
// overlay: use existing overlay-chat broadcast fn (find export in src/overlay/overlay-chat.ts)
// Register ONLY the channels that exist in this installation; others stay unregistered and throw on attempt (caught by scheduler).
```

Fill in overlay / discord / slack / matrix / email registrations from the existing channel init sites — search each channel file for a "send" or "broadcast" export. If a channel doesn't have a proactive-capable send, leave it unregistered for now.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/proactive/dispatch.ts src/proactive/dispatch.test.ts src/index.ts
git commit -m "proactive: dispatch registry (single exit point for proactive sends)"
```

---

### Task 1.2: Composer — template fast-path + LLM fallback

**Files:**
- Create: `src/proactive/composer.ts`
- Create: `src/proactive/composer-templates.ts`
- Create: `src/proactive/composer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { compose } from "./composer.js";
import type { ProactiveIntent } from "./intent.js";

const baseIntent: ProactiveIntent = {
  id: "t1", source: "long_task_status", mode: "fyi", urgency: "normal",
  channelPreference: "any", topic: "task", topicEmbedding: new Array(384).fill(0),
  evidence: [], payload: { kind: "long_task_status", task: "migration", summary: "done" },
  createdAt: Date.now(), expiresAt: Date.now() + 60_000,
};

describe("Composer template fast path", () => {
  it("produces deterministic text for long_task_status", async () => {
    const r = await compose(baseIntent, "whatsapp", { tone: "neutral" }, [], { llm: null });
    expect(r?.text).toBe("Done with migration. done");
    expect(r?.modeTag).toBe("fyi");
  });
  it("returns null when required payload field missing", async () => {
    const broken = { ...baseIntent, payload: { kind: "long_task_status" } };
    const r = await compose(broken, "whatsapp", { tone: "neutral" }, [], { llm: null });
    expect(r).toBeNull();
  });
});

describe("Composer LLM fallback fail-closed", () => {
  it("returns null when LLM returns skip:true", async () => {
    const fakeLlm = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"skip": true}' } }],
      }),
    } as any;
    const memoryIntent: ProactiveIntent = { ...baseIntent,
      source: "memory_anticipation",
      payload: { kind: "memory_anticipation", hint: "complex" },
    };
    const r = await compose(memoryIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });
    expect(r).toBeNull();
  });
  it("returns null when LLM returns malformed JSON", async () => {
    const fakeLlm = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "this is not JSON" } }],
      }),
    } as any;
    const memoryIntent: ProactiveIntent = { ...baseIntent,
      source: "memory_anticipation",
      payload: { kind: "memory_anticipation", hint: "x" },
    };
    const r = await compose(memoryIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });
    expect(r).toBeNull();
  });
  it("returns text when LLM returns well-formed response", async () => {
    const fakeLlm = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"text":"You left the homepage mid-layout. Resume now?","modeTag":"question","skip":false}' } }],
      }),
    } as any;
    const memoryIntent: ProactiveIntent = { ...baseIntent,
      source: "memory_anticipation", mode: "question",
      payload: { kind: "memory_anticipation", hint: "x" },
    };
    const r = await compose(memoryIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });
    expect(r?.text).toMatch(/you/i);
    expect(r?.modeTag).toBe("question");
  });
});

describe("Composer regression — the bug examples must not slip through", () => {
  const leakExamples = [
    "Dheeraj's been away for 8+ hours and was working on that Midnight Library bookstore project last night — probably worth a quick recap of where he left off before diving back in, especially since it's morning and momentum matters for design work.",
    "Dheeraj is in the middle of a dev project (Code is open) on an afternoon in Thiruvananthapuram — might be useful to remind him about the Midnight Library website he started scoping out yesterday, or check if he needs a quick break/focus session with Spotify already running.",
  ];
  for (const leak of leakExamples) {
    it(`rejects leak: "${leak.slice(0, 40)}..."`, async () => {
      const fakeLlm = {
        chat: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ text: leak, modeTag: "fyi", skip: false }) } }],
        }),
      } as any;
      const memoryIntent: ProactiveIntent = { ...baseIntent,
        source: "memory_anticipation",
        payload: { kind: "memory_anticipation", hint: "x" },
      };
      const r = await compose(memoryIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });
      // Either null (rejected by post-filter) OR text not containing banned phrases
      if (r !== null) {
        const lower = r.text.toLowerCase();
        expect(lower).not.toContain("dheeraj");
        expect(lower).not.toContain("been away for");
        expect(lower).not.toContain("worth a quick");
        expect(lower).not.toContain("might be useful");
      } else {
        expect(r).toBeNull();
      }
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/proactive/composer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/proactive/composer-templates.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { ProactiveIntent, Channel } from "./intent.js";

type TemplateFn = (i: ProactiveIntent) => string | null;

export const TEMPLATES: Record<string, Partial<Record<Channel, TemplateFn>>> = {
  long_task_status: {
    whatsapp: (i) => {
      const { task, summary } = i.payload as { task?: string; summary?: string };
      if (!task || !summary) return null;
      return `Done with ${task}. ${summary}`;
    },
    telegram: (i) => {
      const { task, summary } = i.payload as { task?: string; summary?: string };
      if (!task || !summary) return null;
      return `Done with ${task}. ${summary}`;
    },
  },
  convex_notification: {
    whatsapp: (i) => {
      const { warning } = i.payload as { warning?: string };
      if (!warning) return null;
      return `Heads up — ${warning}`;
    },
    telegram: (i) => {
      const { warning } = i.payload as { warning?: string };
      if (!warning) return null;
      return `Heads up — ${warning}`;
    },
  },
  stale_todo_simple: {
    whatsapp: (i) => {
      const { days, deadline, todo } = i.payload as { days?: number; deadline?: string; todo?: string };
      if (days == null || !deadline || !todo) return null;
      return `${days}d to ${deadline}. ${todo}`;
    },
  },
  calendar_fusion: {
    whatsapp: (i) => {
      const { event, newTime, impacted } = i.payload as { event?: string; newTime?: string; impacted?: string };
      if (!event || !newTime || !impacted) return null;
      return `${event} moved to ${newTime} — your ${impacted} now overlaps`;
    },
  },
};

export function tryTemplate(intent: ProactiveIntent, channel: Channel): string | null {
  const fn = TEMPLATES[intent.payload.kind]?.[channel];
  return fn ? fn(intent) : null;
}
```

- [ ] **Step 4: Implement `src/proactive/composer.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { LLMClient } from "../llm.js";
import { fetchSystemPrompt } from "../config/system-prompts.js";
import type { ProactiveIntent, Channel, ProactiveMode } from "./intent.js";
import { tryTemplate } from "./composer-templates.js";
import { extractJson } from "../utils/json-extract.js";
import { debugProactive } from "./kill-switches.js";

export type Persona = { tone: string };
export type ComposerResult = { text: string; modeTag: ProactiveMode };

const BANNED_PHRASES = [
  "might be worth", "probably useful", "worth a quick recap",
  "been away for", "could be helpful", "just checking in",
  "wanted to ask", "a quick thought", "might be good to", "worth checking",
];

export async function compose(
  intent: ProactiveIntent,
  channel: Channel,
  persona: Persona,
  recentSends: string[],
  deps: { llm: LLMClient | null },
): Promise<ComposerResult | null> {
  // 1. Template fast path
  const tpl = tryTemplate(intent, channel);
  if (tpl !== null) {
    if (containsBannedPhrase(tpl) || mentionsThirdPerson(tpl, persona)) {
      debugProactive("composer_template_rejected", { id: intent.id, reason: "post_filter" });
      return null;
    }
    return { text: tpl, modeTag: intent.mode };
  }

  // 2. LLM fallback
  if (!deps.llm) {
    debugProactive("composer_skipped_no_llm", { id: intent.id, kind: intent.payload.kind });
    return null;
  }

  let systemPrompt: string;
  try {
    systemPrompt = await fetchSystemPrompt("proactive-composer");
  } catch (e) {
    debugProactive("composer_prompt_fetch_failed", { id: intent.id, err: (e as Error).message });
    return null;
  }

  const userPayload = {
    intent: {
      source: intent.source,
      mode: intent.mode,
      urgency: intent.urgency,
      topic: intent.topic,
      evidence: intent.evidence,
      payload: intent.payload,
    },
    channel,
    personaTone: persona.tone,
    recentSends,
    timeOfDay: hourBucket(),
  };

  let content: string | undefined;
  try {
    const res = await deps.llm.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      modelOverride: "anthropic/claude-haiku-4.5",
      maxTokens: 200,
    });
    content = res?.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    debugProactive("composer_llm_failed", { id: intent.id, err: (e as Error).message });
    return null;
  }
  if (!content) return null;

  const parsed = extractJson<{ text?: string; modeTag?: ProactiveMode; skip?: boolean }>(content);
  if (!parsed || parsed.skip === true || !parsed.text) {
    debugProactive("composer_skip", { id: intent.id, hasText: !!parsed?.text, skip: parsed?.skip });
    return null;
  }
  const text = parsed.text.trim();
  if (containsBannedPhrase(text) || mentionsThirdPerson(text, persona)) {
    debugProactive("composer_post_filter_rejected", { id: intent.id });
    return null;
  }
  return { text, modeTag: (parsed.modeTag ?? intent.mode) };
}

function containsBannedPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.some(p => lower.includes(p));
}

function mentionsThirdPerson(text: string, _persona: Persona): boolean {
  // Conservative: reject messages that reference "the user" / "user has" / obvious third-person patterns.
  const lower = text.toLowerCase();
  if (/\bthe user\b/.test(lower)) return true;
  if (/\buser (is|has|was|might|should|could|seems)\b/.test(lower)) return true;
  return false;
}

function hourBucket(): string {
  const h = new Date().getHours();
  if (h < 5) return "late_night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "late_night";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/proactive/composer.test.ts`
Expected: all passing. If `mentionsThirdPerson` flags the leak examples correctly, the regression tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/composer.ts src/proactive/composer-templates.ts src/proactive/composer.test.ts
git commit -m "proactive: Composer with template fast-path + LLM fallback + banned-phrase filter (Phase 1)"
```

---

### Task 1.3: Wire Composer into existing heartbeat path (the actual bug fix)

**Files:**
- Modify: `src/proactive/heartbeat.ts` (the `innerThoughtsTick` branch at L169-206)
- Modify: `src/index.ts` (the `onNotification` callback at L455-486)
- Create: `src/proactive/intent-from-thought.ts` — adapter that wraps legacy thought output as a `ProactiveIntent`

- [ ] **Step 1: Create adapter + test**

Create `src/proactive/intent-from-thought.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { intentFromThought } from "./intent-from-thought.js";

describe("intentFromThought adapter", () => {
  it("wraps a legacy thought string as a memory_anticipation intent", () => {
    const i = intentFromThought("the user has been away", { hourNow: 10 });
    expect(i.source).toBe("memory_anticipation");
    expect(i.mode).toBe("fyi");
    expect(i.payload.kind).toBe("memory_anticipation");
    expect(i.payload.hint).toBe("the user has been away");
    expect(i.topicEmbedding.length).toBe(384);
  });
});
```

Create `src/proactive/intent-from-thought.ts`:

```typescript
// © 2024-2026 XAGI Labs Private Limited
import { makeIntentId, type ProactiveIntent } from "./intent.js";

export function intentFromThought(
  rawThought: string,
  ctx: { hourNow: number },
): ProactiveIntent {
  const now = Date.now();
  return {
    id: makeIntentId("memory_anticipation"),
    source: "memory_anticipation",
    mode: "fyi",
    urgency: "normal",
    channelPreference: "any",
    topic: rawThought.slice(0, 80),
    topicEmbedding: new Array(384).fill(0),  // real embedding injected in Phase 2
    evidence: [{ label: "hourNow", value: String(ctx.hourNow) }],
    payload: { kind: "memory_anticipation", hint: rawThought },
    createdAt: now,
    expiresAt: now + 60 * 60_000,
  };
}
```

- [ ] **Step 2: Run adapter test**

Run: `npx vitest run src/proactive/intent-from-thought.test.ts`
Expected: PASS.

- [ ] **Step 3: Modify `src/index.ts` onNotification to route through Composer + dispatch**

Open `src/index.ts` near L455. Replace the `onNotification` callback body. The old body (rough shape) was:

```typescript
onNotification: async (message) => {
  console.log(`💓 Proactive: ${message.substring(0, 100)}...`);
  await sendWhatsAppProactiveMessage(message);
  await sendProactiveMessage(bot, config, message);
  // ...
},
```

Replace with:

```typescript
onNotification: async (message) => {
  if (process.env.ATLAS_PROACTIVE_V2_COMPOSER !== "false") {
    const { intentFromThought } = await import("./proactive/intent-from-thought.js");
    const { compose } = await import("./proactive/composer.js");
    const { dispatchProactiveMessage } = await import("./proactive/dispatch.js");
    const intent = intentFromThought(message, { hourNow: new Date().getHours() });
    for (const channel of ["telegram", "whatsapp"] as const) {
      const composed = await compose(intent, channel, { tone: "warm" }, [], { llm });
      if (composed) {
        await dispatchProactiveMessage(channel, composed.text, composed.modeTag).catch(err => {
          console.log(`proactive dispatch failed for ${channel}:`, err.message);
        });
      }
    }
    return;
  }
  // Legacy path (flag disabled)
  console.log(`💓 Proactive (legacy): ${message.substring(0, 100)}...`);
  await sendWhatsAppProactiveMessage(message).catch(() => {});
  await sendProactiveMessage(bot, config, message).catch(() => {});
},
```

**Note:** `llm` must be in scope where `startHeartbeat` is called. If not, capture it from the outer scope where `startHeartbeat` receives `llm` as its first arg.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Start ATLAS briefly: `npm run dev`. Observe logs. Send yourself a test message via the existing `/atlas` overlay or a CLI that forces a heartbeat tick. Confirm any proactive message that shows up is second-person and within length limits. If nothing ships (Composer rejecting everything), inspect `🔔 [proactive] composer_*` log lines for the reason.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/intent-from-thought.ts src/proactive/intent-from-thought.test.ts src/index.ts
git commit -m "proactive: route legacy heartbeat thoughts through Composer (BUG FIX) (Phase 1)"
```

---

### Task 1.4: Regression snapshot — the four leak examples

**Files:**
- Create: `src/proactive/leak-regression.test.ts`

This is the file you'll add to forever when new leaks are reported.

- [ ] **Step 1: Create the regression file**

```typescript
// © 2024-2026 XAGI Labs Private Limited
// Regression tests — every reported third-person leak becomes a test here.
// If this file ever goes empty, it stays — as documentation.
import { describe, it, expect, vi } from "vitest";
import { compose } from "./composer.js";
import type { ProactiveIntent } from "./intent.js";

const LEAKS = [
  "Dheeraj's been away for 8+ hours and was working on that Midnight Library bookstore project last night — probably worth a quick recap of where he left off before diving back in, especially since it's morning and momentum matters for design work.",
  "Dheeraj's been away for 8+ hours and was mid-conversation about building the Midnight Library website — might be good to recap where that left off and ask if he wants to continue or needs a different direction now that it's morning.",
  "Dheeraj is in the middle of a dev project (Code is open) on an afternoon in Thiruvananthapuram — might be useful to remind him about the Midnight Library website he started scoping out yesterday, or check if he needs a quick break/focus session with Spotify already running.",
  "Last phase: deployment setup + final checks. You're literally minutes away from having a production-ready site 🎯",
];

const baseIntent: ProactiveIntent = {
  id: "leak-test", source: "memory_anticipation", mode: "fyi", urgency: "normal",
  channelPreference: "any", topic: "x", topicEmbedding: new Array(384).fill(0),
  evidence: [], payload: { kind: "memory_anticipation", hint: "x" },
  createdAt: Date.now(), expiresAt: Date.now() + 60_000,
};

describe("leak regression — rejected text must NEVER be dispatched", () => {
  for (const [i, leak] of LEAKS.entries()) {
    it(`leak ${i+1} is rejected`, async () => {
      const fakeLlm = {
        chat: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ text: leak, modeTag: "fyi", skip: false }) } }],
        }),
      } as any;
      const r = await compose(baseIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });
      if (r !== null) {
        const lower = r.text.toLowerCase();
        expect(lower).not.toContain("dheeraj");
        expect(lower).not.toContain("been away for");
        expect(lower).not.toContain("worth a quick");
        expect(lower).not.toContain("might be useful");
        expect(lower).not.toContain("might be good to");
      }
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/proactive/leak-regression.test.ts`
Expected: all passing (because Composer post-filter should reject these).

- [ ] **Step 3: Commit**

```bash
git add src/proactive/leak-regression.test.ts
git commit -m "proactive: regression tests for the four third-person leak examples (Phase 1)"
```

---

### 🚢 SHIP POINT — end of Phase 1

At this commit:
- The third-person bug can no longer leak from heartbeat → any channel.
- Composer is the only code producing proactive text.
- All regression examples are enforced by CI.

You can stop here if you want to pause and observe user-visible behavior for a week before continuing. Everything below this point is the "feel alive" work.

---

## Phase 2 — Scheduler + boundary events

Move from "every heartbeat tries to send" to "intents are queued and released only when it's the right moment." Rust owns the queue and the release decision.

### Task 2.1: Full `proactive_scheduler.rs` implementation

**Files:**
- Modify: `native/src/proactive_scheduler.rs` (replace the stub)
- Modify: `native/src/lib.rs` (already has `pub use proactive_scheduler::*;`)

- [ ] **Step 1: Replace the stub with the real scheduler**

```rust
// © 2024-2026 XAGI Labs Private Limited
use napi_derive::napi;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct QueuedIntent {
    pub id: String,
    pub source: String,
    pub mode: String,
    pub urgency: String,
    pub channel: String,
    pub topic_embedding: Vec<f64>,
    pub created_at: f64,
    pub expires_at: f64,
    pub posture_weight: f64,
    pub source_weight: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PostureParams {
    pub channel: String,
    pub max_per_day: u32,
    pub min_gap_min: u32,
    pub heartbeat_min: u32,
    pub boundary_only: bool,
    pub urgent_bypass: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ReleaseResult {
    pub released: Vec<String>,    // intent ids to dispatch
    pub dropped: Vec<DropEntry>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DropEntry {
    pub id: String,
    pub reason: String,
}

struct ChannelState {
    queue: VecDeque<QueuedIntent>,
    posture: PostureParams,
    last_sent_ms: f64,
    sent_today: u32,
    day_bucket: i64,       // day index for daily reset
    boundary_window_until_ms: f64,
    dnd_active: bool,
    recent_topic_embeddings: VecDeque<(f64, Vec<f64>)>, // (ts_ms, emb) for dedup
}

static STATE: Lazy<Arc<Mutex<HashMap<String, ChannelState>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
fn day_index(ms: f64) -> i64 { (ms / 86_400_000.0) as i64 }

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..a.len().min(b.len()) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    if na == 0.0 || nb == 0.0 { return 0.0; }
    dot / (na.sqrt() * nb.sqrt())
}

#[napi]
pub fn scheduler_configure(posture: PostureParams) {
    let mut st = STATE.lock();
    let entry = st.entry(posture.channel.clone()).or_insert_with(|| ChannelState {
        queue: VecDeque::new(),
        posture: posture.clone(),
        last_sent_ms: 0.0,
        sent_today: 0,
        day_bucket: day_index(now_ms()),
        boundary_window_until_ms: 0.0,
        dnd_active: false,
        recent_topic_embeddings: VecDeque::new(),
    });
    entry.posture = posture;
}

#[napi]
pub fn scheduler_enqueue(intent: QueuedIntent) -> String {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&intent.channel) {
        Some(c) => c,
        None => return "no_posture_configured".into(),
    };
    let now = now_ms();
    // daily reset
    let today = day_index(now);
    if today != cs.day_bucket { cs.day_bucket = today; cs.sent_today = 0; }
    // dedup check: cosine > 0.9 in last 6h
    let six_h_ago = now - 6.0*3600.0*1000.0;
    cs.recent_topic_embeddings.retain(|(ts, _)| *ts >= six_h_ago);
    for (_, emb) in cs.recent_topic_embeddings.iter() {
        if cosine(&intent.topic_embedding, emb) > 0.9 { return "dedup".into(); }
    }
    cs.queue.push_back(intent);
    "enqueued".into()
}

#[napi]
pub fn scheduler_mark_boundary(channel: String, window_ms: f64) {
    let mut st = STATE.lock();
    if let Some(cs) = st.get_mut(&channel) {
        cs.boundary_window_until_ms = now_ms() + window_ms;
    }
}

#[napi]
pub fn scheduler_set_dnd(channel: String, active: bool) {
    let mut st = STATE.lock();
    if let Some(cs) = st.get_mut(&channel) { cs.dnd_active = active; }
}

fn priority(q: &QueuedIntent, now: f64) -> f64 {
    let base = match q.urgency.as_str() { "urgent" => 100.0, "normal" => 10.0, _ => 1.0 };
    let age_min = ((now - q.created_at) / 60_000.0).max(0.0);
    let life_min = ((q.expires_at - q.created_at) / 60_000.0).max(1.0);
    let freshness = (-age_min / life_min).exp();
    base * freshness * q.posture_weight * q.source_weight
}

#[napi]
pub fn scheduler_try_release(channel: String) -> ReleaseResult {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&channel) {
        Some(c) => c,
        None => return ReleaseResult { released: vec![], dropped: vec![] },
    };
    let now = now_ms();
    let mut released: Vec<String> = Vec::new();
    let mut dropped: Vec<DropEntry> = Vec::new();

    // expire
    cs.queue.retain(|q| {
        if q.expires_at < now {
            dropped.push(DropEntry { id: q.id.clone(), reason: "expired".into() });
            false
        } else { true }
    });

    // sort by priority desc
    let mut sorted: Vec<QueuedIntent> = cs.queue.drain(..).collect();
    sorted.sort_by(|a, b| priority(b, now).partial_cmp(&priority(a, now)).unwrap_or(std::cmp::Ordering::Equal));

    let p = cs.posture.clone();
    let boundary_active = now <= cs.boundary_window_until_ms;

    for q in sorted {
        let urgent = q.urgency == "urgent";
        // rate limit
        if cs.sent_today >= p.max_per_day && !(urgent && p.urgent_bypass) {
            cs.queue.push_back(q); continue;
        }
        // gap
        let gap_ok = (now - cs.last_sent_ms) >= (p.min_gap_min as f64) * 60_000.0;
        if !gap_ok && !(urgent && p.urgent_bypass) { cs.queue.push_back(q); continue; }
        // dnd
        if cs.dnd_active && !(urgent && p.urgent_bypass) { cs.queue.push_back(q); continue; }
        // boundary
        if p.boundary_only && !boundary_active && !(urgent && p.urgent_bypass) { cs.queue.push_back(q); continue; }

        cs.last_sent_ms = now;
        cs.sent_today += 1;
        cs.recent_topic_embeddings.push_back((now, q.topic_embedding.clone()));
        released.push(q.id);
    }

    ReleaseResult { released, dropped }
}

#[napi]
pub fn scheduler_debug_state(channel: String) -> String {
    let st = STATE.lock();
    match st.get(&channel) {
        Some(cs) => format!(
            "queue={} sent_today={} last_sent={} boundary_until={} dnd={}",
            cs.queue.len(), cs.sent_today, cs.last_sent_ms, cs.boundary_window_until_ms, cs.dnd_active
        ),
        None => "no posture configured".into(),
    }
}
```

- [ ] **Step 2: Add `once_cell` dep if missing**

Open `native/Cargo.toml`. If `once_cell` isn't in `[dependencies]`, add:

```toml
once_cell = "1.20"
```

- [ ] **Step 3: Build native**

Run: `npm run build:native`
Expected: success.

- [ ] **Step 4: Unit tests in Rust**

Create `native/src/proactive_scheduler_test.rs` (append a `#[cfg(test)] mod tests { ... }` inside `proactive_scheduler.rs` OR create a sibling test file and include it). Minimum tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() { let mut st = STATE.lock(); st.clear(); }

    #[test]
    fn dedup_rejects_same_topic() {
        fresh();
        scheduler_configure(PostureParams {
            channel: "t".into(), max_per_day: 10, min_gap_min: 0,
            heartbeat_min: 60, boundary_only: false, urgent_bypass: true,
        });
        let mk = |id: &str| QueuedIntent {
            id: id.into(), source: "x".into(), mode: "fyi".into(), urgency: "normal".into(),
            channel: "t".into(), topic_embedding: vec![1.0, 0.0, 0.0],
            created_at: now_ms(), expires_at: now_ms() + 60_000.0,
            posture_weight: 1.0, source_weight: 1.0,
        };
        assert_eq!(scheduler_enqueue(mk("a")), "enqueued");
        // Release so dedup vector is populated
        let r = scheduler_try_release("t".into());
        assert!(r.released.contains(&"a".to_string()));
        // Second enqueue same embedding -> dedup
        assert_eq!(scheduler_enqueue(mk("b")), "dedup");
    }

    #[test]
    fn boundary_gate_holds_non_urgent() {
        fresh();
        scheduler_configure(PostureParams {
            channel: "t".into(), max_per_day: 10, min_gap_min: 0,
            heartbeat_min: 60, boundary_only: true, urgent_bypass: true,
        });
        let q = QueuedIntent {
            id: "q".into(), source: "x".into(), mode: "fyi".into(), urgency: "normal".into(),
            channel: "t".into(), topic_embedding: vec![1.0, 0.0], created_at: now_ms(),
            expires_at: now_ms() + 60_000.0, posture_weight: 1.0, source_weight: 1.0,
        };
        scheduler_enqueue(q);
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty()); // held (no boundary)
        scheduler_mark_boundary("t".into(), 60_000.0);
        let r2 = scheduler_try_release("t".into());
        assert_eq!(r2.released.len(), 1);
    }

    #[test]
    fn urgent_bypasses_boundary() {
        fresh();
        scheduler_configure(PostureParams {
            channel: "t".into(), max_per_day: 10, min_gap_min: 0,
            heartbeat_min: 60, boundary_only: true, urgent_bypass: true,
        });
        let q = QueuedIntent {
            id: "u".into(), source: "x".into(), mode: "question".into(), urgency: "urgent".into(),
            channel: "t".into(), topic_embedding: vec![1.0, 0.0], created_at: now_ms(),
            expires_at: now_ms() + 60_000.0, posture_weight: 1.0, source_weight: 1.5,
        };
        scheduler_enqueue(q);
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released, vec!["u".to_string()]);
    }
}
```

Run tests: `cd native && cargo test` — all three should pass.

- [ ] **Step 5: Commit**

```bash
git add native/src/proactive_scheduler.rs native/Cargo.toml
git commit -m "proactive: full scheduler impl in Rust (priority, dedup, boundary, DND, rate) (Phase 2)"
```

---

### Task 2.2: Boundary event emitter on activity/environment signals

**Files:**
- Modify: `src/proactive/activity.ts` (add a BoundaryEventEmitter hook)
- Create: `src/proactive/boundary-events.ts`
- Create: `src/proactive/boundary-events.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { BoundaryBus } from "./boundary-events.js";

describe("BoundaryBus", () => {
  it("fires subscribers when an idle event is emitted", () => {
    const bus = new BoundaryBus();
    const spy = vi.fn();
    bus.subscribe(spy);
    bus.emit({ kind: "idle_start", ts: 1 });
    expect(spy).toHaveBeenCalledWith({ kind: "idle_start", ts: 1 });
  });
  it("debounces rapid identical events within 500ms", () => {
    const bus = new BoundaryBus();
    const spy = vi.fn();
    bus.subscribe(spy);
    bus.emit({ kind: "idle_start", ts: 1 });
    bus.emit({ kind: "idle_start", ts: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("allows different kinds through", () => {
    const bus = new BoundaryBus();
    const spy = vi.fn();
    bus.subscribe(spy);
    bus.emit({ kind: "idle_start", ts: 1 });
    bus.emit({ kind: "screen_lock", ts: 100 });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/proactive/boundary-events.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/proactive/boundary-events.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
export type BoundaryEventKind =
  | "idle_start" | "idle_end"
  | "app_switch"
  | "screen_lock" | "screen_unlock"
  | "meeting_end"
  | "typing_stopped";

export type BoundaryEvent = { kind: BoundaryEventKind; ts: number; meta?: Record<string, unknown> };

export class BoundaryBus {
  private subs: Array<(e: BoundaryEvent) => void> = [];
  private lastByKind = new Map<BoundaryEventKind, number>();

  subscribe(fn: (e: BoundaryEvent) => void): () => void {
    this.subs.push(fn);
    return () => { this.subs = this.subs.filter(x => x !== fn); };
  }

  emit(e: BoundaryEvent): void {
    const last = this.lastByKind.get(e.kind) ?? -Infinity;
    if (e.ts - last < 500) return;
    this.lastByKind.set(e.kind, e.ts);
    for (const s of this.subs) {
      try { s(e); } catch { /* subscriber errors isolated */ }
    }
  }
}

export const globalBoundaryBus = new BoundaryBus();
```

- [ ] **Step 4: Hook into activity.ts**

Open `src/proactive/activity.ts`. Find where presence transitions are detected (whatever function updates `UserPresence`). Add calls to `globalBoundaryBus.emit(...)` at the right transition points:

- When idle duration crosses 2 min → `emit({ kind: "idle_start", ts: Date.now() })`
- When input resumes after idle → `emit({ kind: "idle_end", ts: Date.now() })`
- When foreground app changes → `emit({ kind: "app_switch", ts: Date.now(), meta: { from, to } })`

Similarly in `src/proactive/environment-sensors.ts` for screen_lock/unlock if that's detected there. If those signals don't exist yet, skip adding new OS integration — just wire the existing transitions.

- [ ] **Step 5: Run test**

Run: `npx vitest run src/proactive/boundary-events.test.ts`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/boundary-events.ts src/proactive/boundary-events.test.ts src/proactive/activity.ts src/proactive/environment-sensors.ts
git commit -m "proactive: boundary event bus + hooks into activity/environment (Phase 2)"
```

---

### Task 2.3: Observer service — owns enqueue, dispatch, lifecycle

**Files:**
- Create: `src/proactive/observer.ts`
- Create: `src/proactive/observer.test.ts`
- Modify: `src/index.ts` (bootstrap Observer; replace the onNotification from Phase 1)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Observer } from "./observer.js";
import type { ProactiveIntent } from "./intent.js";

describe("Observer", () => {
  let obs: Observer;
  beforeEach(() => { obs = new Observer({ llm: null as any, configPath: ":memory:" }); });
  afterEach(() => { obs.stop(); });

  it("enqueues a valid intent", () => {
    const intent: ProactiveIntent = {
      id: "o1", source: "long_task_status", mode: "fyi", urgency: "normal",
      channelPreference: "telegram", topic: "t", topicEmbedding: new Array(384).fill(0),
      evidence: [], payload: { kind: "long_task_status", task: "m", summary: "s" },
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    };
    expect(obs.enqueue(intent)).toBe(true);
  });

  it("rejects invalid intent", () => {
    const bad: any = { id: "x" };
    expect(obs.enqueue(bad)).toBe(false);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/proactive/observer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/proactive/observer.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { LLMClient } from "../llm.js";
import { validateIntent, type ProactiveIntent, type Channel } from "./intent.js";
import { loadProactiveConfig, getPosture, POSTURE_PARAMS, type ProactiveConfig } from "./config.js";
import { compose } from "./composer.js";
import { dispatchProactiveMessage } from "./dispatch.js";
import { globalBoundaryBus, type BoundaryEvent } from "./boundary-events.js";
import { isProactiveDisabled, isSourceDisabled, debugProactive } from "./kill-switches.js";
import * as native from "../../native/index.js";

const SOURCE_WEIGHTS: Record<string, number> = {
  latent_topic_monitor: 1.5,
  calendar_fact_check: 1.3,
  meeting_followup: 1.2,
  calendar_fusion: 1.0,
  long_task_status: 1.0,
  habit_anomaly: 0.9,
  stale_todo: 0.9,
  convex_notification: 0.8,
  env_context: 0.8,
  memory_anticipation: 0.7,
};

export type ObserverDeps = { llm: LLMClient | null; configPath: string };

export class Observer {
  private cfg: ProactiveConfig;
  private intentsById = new Map<string, ProactiveIntent>();
  private recentSendsByChannel = new Map<Channel, string[]>();
  private unsubBoundary: (() => void) | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private deps: ObserverDeps) {
    this.cfg = loadProactiveConfig(deps.configPath);
    this.configureAllPostures();
  }

  start(): void {
    this.unsubBoundary = globalBoundaryBus.subscribe((e) => this.onBoundary(e));
    this.tickTimer = setInterval(() => this.tickAll(), 30_000); // sweep every 30s for gap/rate-based releases
  }

  stop(): void {
    if (this.unsubBoundary) this.unsubBoundary();
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  enqueue(intent: ProactiveIntent): boolean {
    if (isProactiveDisabled()) { debugProactive("observer_enqueue_suppressed", { id: intent.id }); return false; }
    if (isSourceDisabled(intent.source)) { debugProactive("observer_enqueue_source_disabled", { id: intent.id, source: intent.source }); return false; }
    const v = validateIntent(intent);
    if (!v.ok) { debugProactive("observer_enqueue_invalid", { id: intent.id, error: v.error }); return false; }

    const channel: Channel = intent.channelPreference === "any" ? "telegram" : intent.channelPreference;
    const posture = getPosture(this.cfg, channel);
    const postureWeight = posture === "ambient" && intent.source !== "latent_topic_monitor" ? 0.3
                         : posture === "calm" ? 0.7 : 1.0;
    this.intentsById.set(intent.id, intent);

    const nativeRes = (native as any).schedulerEnqueue?.({
      id: intent.id,
      source: intent.source,
      mode: intent.mode,
      urgency: intent.urgency,
      channel,
      topicEmbedding: intent.topicEmbedding.map(n => Number(n)),
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
      postureWeight,
      sourceWeight: SOURCE_WEIGHTS[intent.source] ?? 1.0,
    });
    debugProactive("observer_enqueued", { id: intent.id, channel, nativeRes });
    return nativeRes === "enqueued";
  }

  onBoundary(e: BoundaryEvent): void {
    debugProactive("boundary_event", { kind: e.kind, ts: e.ts });
    for (const ch of Object.keys(this.cfg.postures) as Channel[]) {
      (native as any).schedulerMarkBoundary?.(ch, 120_000); // 2-min window
      this.releaseChannel(ch).catch(err => debugProactive("release_err", { ch, err: (err as Error).message }));
    }
  }

  async tickAll(): Promise<void> {
    // Task 3.1 adds: collect intents from registered sources and enqueue them here
    for (const ch of Object.keys(this.cfg.postures) as Channel[]) {
      await this.releaseChannel(ch).catch(err => debugProactive("release_err", { ch, err: (err as Error).message }));
    }
  }

  private async releaseChannel(channel: Channel): Promise<void> {
    const r = (native as any).schedulerTryRelease?.(channel) as { released: string[]; dropped: Array<{id:string;reason:string}> } | undefined;
    if (!r) return;
    for (const d of r.dropped) debugProactive("dropped", { id: d.id, reason: d.reason });
    for (const id of r.released) {
      const intent = this.intentsById.get(id);
      if (!intent) continue;
      const recent = this.recentSendsByChannel.get(channel) ?? [];
      const composed = await compose(intent, channel, { tone: "warm" }, recent, { llm: this.deps.llm });
      if (!composed) continue;
      try {
        await dispatchProactiveMessage(channel, composed.text, composed.modeTag);
        const updated = [composed.text, ...recent].slice(0, 10);
        this.recentSendsByChannel.set(channel, updated);
      } finally {
        this.intentsById.delete(id);
      }
    }
  }

  private configureAllPostures(): void {
    for (const ch of Object.keys(this.cfg.postures) as Channel[]) {
      const p = POSTURE_PARAMS[getPosture(this.cfg, ch)];
      (native as any).schedulerConfigure?.({
        channel: ch,
        maxPerDay: p.maxPerDay,
        minGapMin: p.minGapMin,
        heartbeatMin: p.heartbeatMin,
        boundaryOnly: p.boundaryOnly,
        urgentBypass: p.urgentBypass,
      });
    }
  }
}

let _observer: Observer | null = null;
export function getObserver(): Observer | null { return _observer; }
export function setObserver(o: Observer): void { _observer = o; }
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/proactive/observer.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Bootstrap Observer in src/index.ts**

After the Composer-wrapping edit from Task 1.3, add Observer bootstrap. Near the top-level of `src/index.ts` init (after memory init, before heartbeat), insert:

```typescript
if (process.env.ATLAS_PROACTIVE_V2_SCHEDULER !== "false") {
  const { Observer, setObserver } = await import("./proactive/observer.js");
  const { join } = await import("node:path");
  const obs = new Observer({ llm, configPath: join(process.cwd(), "data", "proactive-config.json") });
  obs.start();
  setObserver(obs);
  console.log("💓 Proactive Observer started (V2 scheduler)");
}
```

And modify the `onNotification` callback from Task 1.3 to delegate to Observer when available:

```typescript
onNotification: async (message) => {
  const { getObserver } = await import("./proactive/observer.js");
  const obs = getObserver();
  if (obs && process.env.ATLAS_PROACTIVE_V2_SCHEDULER !== "false") {
    const { intentFromThought } = await import("./proactive/intent-from-thought.js");
    obs.enqueue(intentFromThought(message, { hourNow: new Date().getHours() }));
    return;
  }
  // Phase 1 fallback (Composer without Scheduler)
  // ... (keep the Phase 1 code path unchanged)
},
```

- [ ] **Step 6: Typecheck + native rebuild**

Run: `npm run build:native && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/proactive/observer.ts src/proactive/observer.test.ts src/index.ts
git commit -m "proactive: Observer service + scheduler bootstrap (Phase 2)"
```

---

### Task 2.4: Chat commands — posture + shut up + status

**Files:**
- Create: `src/proactive/chat-commands.ts`
- Create: `src/proactive/chat-commands.test.ts`
- Modify: each channel's owner-message handler to consult `tryProactiveCommand` before falling through to `runAgent`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryProactiveCommand } from "./chat-commands.js";

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "atlas-cc-")); file = join(dir, "cfg.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tryProactiveCommand", () => {
  it("sets posture on a channel", () => {
    const r = tryProactiveCommand("atlas, set whatsapp to ambient", { configPath: file });
    expect(r?.reply).toMatch(/whatsapp/i);
    expect(r?.reply).toMatch(/ambient/i);
  });
  it("shut up sets global disable", () => {
    const r = tryProactiveCommand("atlas, shut up", { configPath: file });
    expect(r?.reply).toMatch(/quiet/i);
    expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
    delete process.env.ATLAS_PROACTIVE_DISABLE;
  });
  it("resume clears disable", () => {
    process.env.ATLAS_PROACTIVE_DISABLE = "true";
    const r = tryProactiveCommand("atlas resume", { configPath: file });
    expect(r?.reply).toMatch(/resuming/i);
    expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
  });
  it("non-command returns null", () => {
    expect(tryProactiveCommand("hello", { configPath: file })).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/proactive/chat-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import { loadProactiveConfig, setPosture, type Posture } from "./config.js";
import type { Channel } from "./intent.js";

export type CmdResult = { reply: string } | null;

const CHANNELS = ["whatsapp","telegram","discord","slack","matrix","email","overlay"] as const;
const POSTURES: Posture[] = ["calm","active","ambient"];

export function tryProactiveCommand(
  text: string,
  opts: { configPath: string },
): CmdResult {
  const lower = text.trim().toLowerCase();
  if (/^(atlas,?\s+)?shut up$/.test(lower)) {
    process.env.ATLAS_PROACTIVE_DISABLE = "true";
    return { reply: "Going quiet. Say 'atlas resume' when you want me back." };
  }
  if (/^(atlas,?\s+)?resume$/.test(lower) || lower === "atlas resume") {
    delete process.env.ATLAS_PROACTIVE_DISABLE;
    return { reply: "Resuming proactive messages." };
  }
  const setMatch = lower.match(/^(atlas,?\s+)?set\s+(\w+)\s+to\s+(\w+)$/);
  if (setMatch) {
    const [, , ch, preset] = setMatch;
    if (!CHANNELS.includes(ch as any)) return { reply: `Unknown channel: ${ch}. Options: ${CHANNELS.join(", ")}.` };
    if (!POSTURES.includes(preset as any)) return { reply: `Unknown preset: ${preset}. Options: ${POSTURES.join(", ")}.` };
    const cfg = loadProactiveConfig(opts.configPath);
    setPosture(cfg, ch as Channel, preset as Posture, opts.configPath);
    return { reply: `Got it — ${ch} is now on ${preset} posture.` };
  }
  if (/^(atlas,?\s+)?proactive\s+status$/.test(lower)) {
    const cfg = loadProactiveConfig(opts.configPath);
    const lines = Object.entries(cfg.postures).map(([ch, p]) => `• ${ch}: ${p}`);
    return { reply: "Current postures:\n" + lines.join("\n") };
  }
  return null;
}
```

- [ ] **Step 4: Verify pass**

Run: `npx vitest run src/proactive/chat-commands.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Wire into Telegram + WhatsApp handlers**

In `src/telegram.ts` find the handler for owner messages (where `runAgent` is called). Before the `runAgent` call:

```typescript
import { tryProactiveCommand } from "./proactive/chat-commands.js";
// ...
const pc = tryProactiveCommand(text, { configPath: join(process.cwd(), "data", "proactive-config.json") });
if (pc) { await ctx.reply(pc.reply); return; }
```

Do the same in `src/whatsapp.ts` owner-handler.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/chat-commands.ts src/proactive/chat-commands.test.ts src/telegram.ts src/whatsapp.ts
git commit -m "proactive: chat commands for posture / shut up / resume / status (Phase 2)"
```

---

## Phase 3 — Intent sources (enable one at a time)

Each source implements `collectIntents(ctx) → ProactiveIntent[]`. Order of enable: MemoryAnticipation (replaces current inner-thoughts) → HabitAnomaly → LongTaskStatus → ConvexNotification → CalendarFusion → EnvContext → StaleTodo → CalendarFactCheck → MeetingFollowup → LatentTopicMonitor.

Each task below is independent. Ship one, observe a week, ship the next.

### Task 3.1: Source interface + registry

**Files:**
- Create: `src/proactive/sources/source.ts`
- Create: `src/proactive/sources/registry.ts`
- Create: `src/proactive/sources/registry.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { SourceRegistry } from "./registry.js";
import type { IntentSource } from "./source.js";

describe("SourceRegistry", () => {
  it("runs all sources and collects their intents", async () => {
    const reg = new SourceRegistry();
    reg.register({
      name: "memory_anticipation",
      async collectIntents() {
        return [{
          id: "a", source: "memory_anticipation", mode: "fyi", urgency: "normal",
          channelPreference: "any", topic: "t", topicEmbedding: new Array(384).fill(0),
          evidence: [], payload: { kind: "x" },
          createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        }];
      },
    });
    const intents = await reg.collectAll({} as any);
    expect(intents.length).toBe(1);
  });
  it("isolates failures — one throwing source doesn't kill others", async () => {
    const reg = new SourceRegistry();
    reg.register({ name: "habit_anomaly", async collectIntents() { throw new Error("boom"); } });
    reg.register({
      name: "long_task_status",
      async collectIntents() {
        return [{
          id: "b", source: "long_task_status", mode: "fyi", urgency: "normal",
          channelPreference: "any", topic: "t", topicEmbedding: new Array(384).fill(0),
          evidence: [], payload: { kind: "long_task_status", task: "m", summary: "s" },
          createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        }];
      },
    });
    const intents = await reg.collectAll({} as any);
    expect(intents.length).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/proactive/sources/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/proactive/sources/source.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { ProactiveIntent, IntentSource } from "../intent.js";
export type { IntentSource };
export type SourceCtx = { now: number; /* extended per-source */ };
export interface IntentSourceModule {
  name: IntentSource;
  collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]>;
}
```

- [ ] **Step 4: Implement `src/proactive/sources/registry.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { ProactiveIntent } from "../intent.js";
import type { IntentSourceModule, SourceCtx } from "./source.js";
import { isSourceDisabled, debugProactive } from "../kill-switches.js";

export class SourceRegistry {
  private sources: IntentSourceModule[] = [];
  register(src: IntentSourceModule): void { this.sources.push(src); }
  async collectAll(ctx: SourceCtx): Promise<ProactiveIntent[]> {
    const out: ProactiveIntent[] = [];
    await Promise.all(this.sources.map(async (s) => {
      if (isSourceDisabled(s.name)) return;
      try {
        const intents = await s.collectIntents(ctx);
        out.push(...intents);
      } catch (err) {
        debugProactive("source_failed", { source: s.name, err: (err as Error).message });
      }
    }));
    return out;
  }
}
```

- [ ] **Step 5: Verify pass**

Run: `npx vitest run src/proactive/sources/registry.test.ts`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add src/proactive/sources/source.ts src/proactive/sources/registry.ts src/proactive/sources/registry.test.ts
git commit -m "proactive: source registry with fail-isolation (Phase 3)"
```

---

### Task 3.2: MemoryAnticipation source (replaces current inner-thoughts flow)

**Files:**
- Create: `src/proactive/sources/memory-anticipation.ts`
- Create: `src/proactive/sources/memory-anticipation.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { makeMemoryAnticipationSource } from "./memory-anticipation.js";

describe("memory_anticipation source", () => {
  it("returns empty when tick returns null", async () => {
    const s = makeMemoryAnticipationSource({
      tick: async () => null, embedText: async () => new Array(384).fill(0),
    });
    const out = await s.collectIntents({ now: Date.now() });
    expect(out.length).toBe(0);
  });
  it("wraps thought as intent with 384-len embedding", async () => {
    const s = makeMemoryAnticipationSource({
      tick: async () => "some thought",
      embedText: async () => new Array(384).fill(0.01),
    });
    const out = await s.collectIntents({ now: Date.now() });
    expect(out.length).toBe(1);
    expect(out[0].source).toBe("memory_anticipation");
    expect(out[0].topicEmbedding.length).toBe(384);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run src/proactive/sources/memory-anticipation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import { makeIntentId, type ProactiveIntent } from "../intent.js";
import type { IntentSourceModule } from "./source.js";

export type MemoryAnticipationDeps = {
  tick: () => Promise<string | null>;
  embedText: (text: string) => Promise<number[]>;
};

export function makeMemoryAnticipationSource(deps: MemoryAnticipationDeps): IntentSourceModule {
  return {
    name: "memory_anticipation",
    async collectIntents(ctx) {
      const thought = await deps.tick();
      if (!thought) return [];
      const embedding = await deps.embedText(thought);
      const now = ctx.now;
      const intent: ProactiveIntent = {
        id: makeIntentId("memory_anticipation"),
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "ambient",
        channelPreference: "any",
        topic: thought.slice(0, 80),
        topicEmbedding: embedding,
        evidence: [],
        payload: { kind: "memory_anticipation", hint: thought },
        createdAt: now,
        expiresAt: now + 60 * 60_000,
      };
      return [intent];
    },
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `npx vitest run src/proactive/sources/memory-anticipation.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Register in Observer bootstrap (src/index.ts)**

After `obs.start()` in the Observer bootstrap block, register the source:

```typescript
const { makeMemoryAnticipationSource } = await import("./proactive/sources/memory-anticipation.js");
const { tick: innerThoughtsTick } = await import("./proactive/inner-thoughts.js");
const { embedText } = await import("./memory/embeddings.js");  // verify actual export name
obs.registerSource(makeMemoryAnticipationSource({
  tick: () => innerThoughtsTick({
    presence: /* fetch current presence */ undefined as any,
    monitorAlerts: null,
    hourNow: new Date().getHours(),
  }),
  embedText: (t) => embedText(t),
}));
```

You will also need to add `registerSource(src)` method on `Observer` that forwards to an internal `SourceRegistry`, and have the `tickAll()` method call `registry.collectAll(...)` then enqueue each result. Update `observer.ts`:

```typescript
// add to Observer class
private registry = new SourceRegistry();
registerSource(src: IntentSourceModule): void { this.registry.register(src); }

// in tickAll, BEFORE the per-channel release loop, add:
const intents = await this.registry.collectAll({ now: Date.now() });
for (const i of intents) this.enqueue(i);
```

- [ ] **Step 6: Commit**

```bash
git add src/proactive/sources/memory-anticipation.ts src/proactive/sources/memory-anticipation.test.ts src/proactive/observer.ts src/index.ts
git commit -m "proactive: memory_anticipation source registered with Observer (Phase 3)"
```

---

### Task 3.3–3.5: Remaining deterministic sources

For each source below, follow the same pattern as 3.2: write failing test, implement, register. Implementations are deterministic (no LLM) so they're short.

**Task 3.3: HabitAnomaly** — extends existing `src/proactive/habit-detector.ts`. Emit `fyi` intent when a tracked habit hasn't been observed at its usual time (e.g., user usually opens Notion at 9am, it's 11am and hasn't). Payload: `{ kind: "habit_anomaly", habit, expectedAt, observedAt: null }`. Template text: "You usually open {habit} by {expectedAt} — heads up you haven't today."

**Task 3.4: LongTaskStatus** — hook into the existing `long-task.ts` completion callback. When a long task finishes or needs input, emit `review` intent with `suggestedAction`. Payload: `{ kind: "long_task_status", task, summary, taskId }`. Already has a template in Phase 1.

**Task 3.5: ConvexNotification** — hook to existing Convex account/credit webhooks. Emit `fyi` when credit balance crosses a threshold or store submission state changes. Payload: `{ kind: "convex_notification", warning }`. Already has a template.

Each of 3.3, 3.4, 3.5 follows this task skeleton:

- [ ] **Step 1:** Write `src/proactive/sources/{name}.test.ts` with 2-3 tests asserting empty-when-quiet and correct-intent-shape-when-triggered.
- [ ] **Step 2:** `npx vitest run src/proactive/sources/{name}.test.ts` → FAIL.
- [ ] **Step 3:** Implement `src/proactive/sources/{name}.ts` exporting `make{Name}Source(deps)`.
- [ ] **Step 4:** Verify PASS.
- [ ] **Step 5:** Register in Observer bootstrap.
- [ ] **Step 6:** Commit with message `proactive: {name} source (Phase 3)`.

---

### Task 3.6–3.7: LLM-assisted sources (CalendarFusion, EnvContext, StaleTodo, CalendarFactCheck, MeetingFollowup)

Same task skeleton. The only additional consideration: these sources may need an internal LLM call to produce the payload (e.g., MeetingFollowup's suggestedAction requires drafting a follow-up action from a transcript). Use Haiku-4.5 to keep cost low; fetch any source-specific prompts from Convex via `fetchSystemPrompt` (seed any new prompt slugs in Task 3.8).

Commit each source individually, one per commit, for clean rollback.

---

### Task 3.8: Seed any additional Convex prompts

**Files:**
- Create: any additional `prompts/*.md` files needed by 3.6-3.7 (e.g., `meeting-followup-drafter.md`)
- Run: `npx tsx scripts/seed-system-content.ts`
- Commit.

---

### Task 3.9: LatentTopicMonitor — Rust matcher + CRUD + hooks

This is the highest-leverage feature. Gets its own full task breakdown.

**Files:**
- Modify: `native/src/proactive_monitor.rs` (replace stub)
- Create: `src/proactive/monitors/monitor-store.ts` (SQLite CRUD over `monitor_rules` table)
- Create: `src/proactive/monitors/monitor-parser.ts` (NL → MonitorRule via Convex prompt)
- Create: `src/proactive/monitors/monitor-commands.ts` (chat commands for list/delete/pause/resume/edit)
- Create: `src/proactive/sources/latent-topic-monitor.ts` (source that gets invoked from channel receive-hooks)
- Modify: each channel receive handler to call the matcher on inbound messages

- [ ] **Step 1: Rust matcher**

Replace `native/src/proactive_monitor.rs` with:

```rust
// © 2024-2026 XAGI Labs Private Limited
use napi_derive::napi;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MonitorRuleRust {
    pub id: String,
    pub topic_embedding: Vec<f64>,
    pub scope_channels: Vec<String>,   // includes "*" wildcard
    pub scope_senders: Option<Vec<String>>,
    pub exclude_self: bool,
    pub threshold: f64,
    pub cooldown_minutes: f64,
    pub active: bool,
    pub last_fired_at: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct RuleHit {
    pub rule_id: String,
    pub score: f64,
}

static RULES: Lazy<Arc<RwLock<HashMap<String, MonitorRuleRust>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

#[napi]
pub fn monitor_load_rules(rules: Vec<MonitorRuleRust>) {
    let mut st = RULES.write();
    st.clear();
    for r in rules { st.insert(r.id.clone(), r); }
}

#[napi]
pub fn monitor_upsert_rule(rule: MonitorRuleRust) {
    let mut st = RULES.write();
    st.insert(rule.id.clone(), rule);
}

#[napi]
pub fn monitor_delete_rule(id: String) {
    let mut st = RULES.write();
    st.remove(&id);
}

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..a.len().min(b.len()) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    if na == 0.0 || nb == 0.0 { return 0.0; }
    dot / (na.sqrt() * nb.sqrt())
}

#[napi]
pub fn monitor_check(msg_embedding: Vec<f64>, channel: String, sender: String, now_ms: f64) -> Vec<RuleHit> {
    let st = RULES.read();
    let mut hits: Vec<RuleHit> = Vec::new();
    for r in st.values() {
        if !r.active { continue; }
        if !(r.scope_channels.iter().any(|c| c == "*" || c == &channel)) { continue; }
        if let Some(senders) = &r.scope_senders {
            if !senders.iter().any(|s| s == &sender) { continue; }
        }
        if r.exclude_self && sender == "self" { continue; }
        let cooldown_ms = r.cooldown_minutes * 60_000.0;
        if now_ms - r.last_fired_at < cooldown_ms { continue; }
        let score = cosine(&msg_embedding, &r.topic_embedding);
        if score > r.threshold {
            hits.push(RuleHit { rule_id: r.id.clone(), score });
        }
    }
    hits
}

#[napi]
pub fn monitor_mark_fired(id: String, ts_ms: f64) {
    let mut st = RULES.write();
    if let Some(r) = st.get_mut(&id) { r.last_fired_at = ts_ms; }
}
```

Cargo test:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_above_threshold() {
        let r = MonitorRuleRust {
            id: "r1".into(), topic_embedding: vec![1.0, 0.0, 0.0],
            scope_channels: vec!["*".into()], scope_senders: None, exclude_self: true,
            threshold: 0.5, cooldown_minutes: 0.0, active: true, last_fired_at: 0.0,
        };
        monitor_load_rules(vec![r]);
        let hits = monitor_check(vec![0.9, 0.1, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(hits.len(), 1);
    }
    #[test]
    fn cooldown_suppresses() {
        let r = MonitorRuleRust {
            id: "r2".into(), topic_embedding: vec![1.0, 0.0, 0.0],
            scope_channels: vec!["*".into()], scope_senders: None, exclude_self: true,
            threshold: 0.5, cooldown_minutes: 60.0, active: true, last_fired_at: 1000.0,
        };
        monitor_load_rules(vec![r]);
        // still in cooldown (less than 60 min elapsed)
        let hits = monitor_check(vec![1.0, 0.0, 0.0], "whatsapp".into(), "alice".into(), 1500.0);
        assert_eq!(hits.len(), 0);
    }
}
```

Run: `cd native && cargo test monitor` → both passing.

- [ ] **Step 2: monitor-store.ts (SQLite CRUD)**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Channel } from "../intent.js";

export type MonitorRule = {
  id: string;
  userPhrase: string;
  topic: string;
  topicEmbedding: number[];
  scope: { channels: Channel[] | ["*"]; groups?: string[]; senders?: string[]; excludeSelf: boolean };
  urgency: "urgent" | "normal" | "ambient";
  action: { defaultMode: "fyi" | "question" | "review"; suggestedFollowup?: string };
  threshold: number;
  cooldownMinutes: number;
  active: boolean;
  lastFiredAt: number;
  expiresAt?: number;
  createdAt: number;
};

export class MonitorStore {
  constructor(private db: Database.Database) {}
  insert(r: Omit<MonitorRule, "id" | "createdAt" | "active" | "lastFiredAt">): MonitorRule {
    const rule: MonitorRule = {
      ...r,
      id: randomUUID(),
      active: true,
      lastFiredAt: 0,
      createdAt: Date.now(),
    };
    const emb = Buffer.from(new Float32Array(rule.topicEmbedding).buffer);
    this.db.prepare(
      `INSERT INTO monitor_rules (id, user_phrase, topic, topic_embedding, scope_json,
       urgency, action_json, threshold, cooldown_minutes, active, last_fired_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rule.id, rule.userPhrase, rule.topic, emb, JSON.stringify(rule.scope),
      rule.urgency, JSON.stringify(rule.action), rule.threshold, rule.cooldownMinutes,
      rule.active ? 1 : 0, rule.lastFiredAt, rule.expiresAt ?? null, rule.createdAt,
    );
    return rule;
  }
  list(onlyActive = true): MonitorRule[] {
    const rows = this.db.prepare(
      `SELECT * FROM monitor_rules ${onlyActive ? "WHERE active = 1" : ""} ORDER BY created_at DESC`,
    ).all() as any[];
    return rows.map(this.rowToRule);
  }
  delete(id: string): void {
    this.db.prepare(`UPDATE monitor_rules SET active = 0 WHERE id = ?`).run(id);
  }
  setActive(id: string, active: boolean): void {
    this.db.prepare(`UPDATE monitor_rules SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  }
  markFired(id: string, ts: number): void {
    this.db.prepare(`UPDATE monitor_rules SET last_fired_at = ? WHERE id = ?`).run(ts, id);
  }
  private rowToRule = (row: any): MonitorRule => {
    const embBuf: Buffer = row.topic_embedding;
    const emb = Array.from(new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4));
    return {
      id: row.id, userPhrase: row.user_phrase, topic: row.topic,
      topicEmbedding: emb, scope: JSON.parse(row.scope_json),
      urgency: row.urgency, action: JSON.parse(row.action_json),
      threshold: row.threshold, cooldownMinutes: row.cooldown_minutes,
      active: row.active === 1, lastFiredAt: row.last_fired_at,
      expiresAt: row.expires_at ?? undefined, createdAt: row.created_at,
    };
  };
}
```

Tests in `monitor-store.test.ts`: insert/list/delete/setActive/markFired round-trips against `:memory:` DB. Use `initSqliteSchema` from Task 0.2.

- [ ] **Step 3: monitor-parser.ts (NL → MonitorRule)**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { LLMClient } from "../../llm.js";
import { fetchSystemPrompt } from "../../config/system-prompts.js";
import { extractJson } from "../../utils/json-extract.js";

export type ParsedRule = {
  topic: string;
  scope: { channels: string[]; groups?: string[]; senders?: string[]; excludeSelf: boolean };
  urgency: "urgent" | "normal" | "ambient";
  action: { defaultMode: "fyi" | "question" | "review"; suggestedFollowup?: string };
  threshold: number;
  cooldownMinutes: number;
  expiresAt?: number;
};
export type ParseResult = { kind: "ok"; rule: ParsedRule } | { kind: "clarify"; question: string } | { kind: "error"; error: string };

export async function parseMonitorRule(userPhrase: string, llm: LLMClient): Promise<ParseResult> {
  let prompt: string;
  try { prompt = await fetchSystemPrompt("monitor-rule-parser"); }
  catch (e) { return { kind: "error", error: (e as Error).message }; }
  const res = await llm.chat({
    messages: [{ role: "system", content: prompt }, { role: "user", content: userPhrase }],
    modelOverride: "anthropic/claude-haiku-4.5",
    maxTokens: 400,
  });
  const content = res?.choices?.[0]?.message?.content?.trim();
  if (!content) return { kind: "error", error: "empty response" };
  const parsed = extractJson<any>(content);
  if (!parsed) return { kind: "error", error: "malformed JSON" };
  if (parsed.needsClarification) return { kind: "clarify", question: parsed.needsClarification };
  if (!parsed.topic) return { kind: "error", error: "missing topic" };
  return { kind: "ok", rule: {
    topic: parsed.topic,
    scope: { channels: parsed.scope?.channels ?? ["*"], groups: parsed.scope?.groups, senders: parsed.scope?.senders, excludeSelf: parsed.scope?.excludeSelf ?? true },
    urgency: parsed.urgency ?? "normal",
    action: { defaultMode: parsed.action?.defaultMode ?? "question", suggestedFollowup: parsed.action?.suggestedFollowup },
    threshold: Math.max(0.6, Math.min(0.95, parsed.threshold ?? 0.82)),
    cooldownMinutes: Math.max(5, parsed.cooldownMinutes ?? 60),
    expiresAt: parsed.expiresAt,
  }};
}
```

Test with a mocked LLM returning a known JSON.

- [ ] **Step 4: monitor-commands.ts (chat)**

Extend the `tryProactiveCommand` from Task 2.4 to also handle:

| Command | Action |
|---|---|
| `monitor me when X` / `ping me if X` | create (calls parser + store.insert + native.monitor_upsert_rule) |
| `list monitors` | render numbered list |
| `delete monitor N` | store.delete + native.monitor_delete_rule |
| `pause monitor N` / `resume monitor N` | store.setActive + native upsert |

Tests for each command.

- [ ] **Step 5: Wire matcher into channel receive hooks**

For each of `src/telegram.ts`, `src/whatsapp.ts`, `src/discord.ts`, `src/slack.ts`, `src/matrix.ts`, `src/email.ts`, and the overlay WS receive path:

```typescript
import { monitorCheck } from "../native/index.js";  // or however native is imported
import { embedText } from "./memory/embeddings.js";
// ...
// After receiving a message, before normal processing:
const emb = await embedText(messageText);
const hits = monitorCheck(emb.map(Number), channelName, senderId, Date.now());
for (const hit of hits) {
  await observer.enqueue(buildIntentFromHit(hit, messageText, channelName));
  monitorMarkFired(hit.rule_id, Date.now());
}
```

Where `buildIntentFromHit` composes a `ProactiveIntent` from the rule record + matched message.

- [ ] **Step 6: End-to-end smoke test**

Create a test monitor via chat: `atlas, ping me if anyone mentions hackathon sponsors in build3`. Have a second account post a message containing "hackathon sponsor". Verify ATLAS sends a second-person, channel-appropriate proactive message (not third-person deliberation).

- [ ] **Step 7: Commit**

One commit per file group:
```bash
git commit -m "proactive: Rust matcher for latent-topic monitors (Phase 3.9)"
git commit -m "proactive: MonitorStore SQLite CRUD"
git commit -m "proactive: NL monitor-rule parser via Convex prompt"
git commit -m "proactive: chat commands for monitors"
git commit -m "proactive: hook matcher into channel receive handlers"
```

---

## Phase 4 — Agent Inbox

Surfaces review-mode intents in the desktop overlay with chat-channel fallback.

### Task 4.1: InboxStore (SQLite) + InboxManager

**Files:**
- Create: `src/proactive/inbox/store.ts`
- Create: `src/proactive/inbox/manager.ts`
- Create: `src/proactive/inbox/store.test.ts`

- [ ] **Step 1: Failing tests + implementation**

Follow the same TDD skeleton as MonitorStore:

```typescript
// store.ts — InboxItem CRUD + status transitions
// manager.ts — holds current items in memory, broadcasts WS events, handles approve/reject/defer/edit actions
```

`InboxStore` methods: `add(item)`, `get(id)`, `listPending()`, `listAll()`, `update(id, patch)`, `expireOld(olderThan)`.

`InboxManager` methods: `enqueue(intent, composedText)`, `approve(id)`, `reject(id)`, `defer(id, until)`, `edit(id, newText)`. Each emits a WS event via the overlay's existing broadcast function.

Tests cover: add + listPending; approve → status transition; defer + re-release after the deferred_until time.

- [ ] **Step 2: Commit**

```bash
git commit -m "proactive: inbox store + manager (Phase 4)"
```

---

### Task 4.2: Overlay panel UI

**Files:**
- Modify: `src/overlay/overlay.html` (add the Inbox panel DOM + WS handlers)
- Modify: `src/overlay/overlay-chat.ts` (add inbox:* event handlers)

- [ ] **Step 1: Add DOM for the inbox panel**

In `overlay.html`, near the chat message list, add:

```html
<section id="atlas-inbox" class="atlas-inbox" hidden>
  <header>
    <h3>ATLAS Inbox</h3>
    <span id="inbox-count" class="badge">0</span>
  </header>
  <ul id="inbox-list"></ul>
</section>
```

Plus CSS for the layout shown in the spec mockup.

- [ ] **Step 2: WS client handlers in overlay.html script**

```javascript
socket.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "inbox:state":      renderInbox(msg.items); break;
    case "inbox:item_added": addInboxItem(msg.item); break;
    case "inbox:item_updated": updateInboxItem(msg.item); break;
  }
});

function sendInboxAction(action, id, extra = {}) {
  socket.send(JSON.stringify({ type: `inbox:${action}`, id, ...extra }));
}
```

With per-item button wiring for approve/reject/edit/defer.

- [ ] **Step 3: Server-side handlers in overlay-chat.ts**

Parse incoming `inbox:*` events and delegate to the InboxManager. Broadcast `inbox:item_updated` on every state change.

- [ ] **Step 4: Commit**

```bash
git commit -m "proactive: overlay inbox panel + WS protocol (Phase 4)"
```

---

### Task 4.3: Chat-channel fallback when overlay is offline >30s

**Files:**
- Create: `src/proactive/inbox/chat-fallback.ts`
- Modify: `src/telegram.ts`, `src/whatsapp.ts`, `src/discord.ts`, `src/slack.ts` — add button callback handlers routing to InboxManager

- [ ] **Step 1: Implement `chat-fallback.ts`**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type { Channel } from "../intent.js";
import type { InboxItem } from "./store.js";

let overlayLastSeen = 0;
export function touchOverlayHeartbeat(): void { overlayLastSeen = Date.now(); }
export function isOverlayLive(): boolean { return Date.now() - overlayLastSeen < 30_000; }

export function renderInteractiveMessage(item: InboxItem, channel: Channel): { text: string; buttons?: Array<{ id: string; label: string }> } {
  const buttons = [
    { id: `inbox:approve:${item.intent.id}`, label: "Approve" },
    { id: `inbox:defer:${item.intent.id}:3h`, label: "Defer 3h" },
    { id: `inbox:reject:${item.intent.id}`, label: "Skip" },
  ];
  return { text: item.composedText, buttons };
}
```

- [ ] **Step 2: Telegram buttons**

In `telegram.ts`, use `InlineKeyboardMarkup`:

```typescript
bot.api.sendMessage(chatId, item.composedText, {
  reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.label, callback_data: b.id }))] },
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data ?? "";
  if (!data.startsWith("inbox:")) return;
  const [, action, id, extra] = data.split(":");
  const { getInboxManager } = await import("./proactive/inbox/manager.js");
  getInboxManager()?.handleAction(id, action as any, extra);
  await ctx.answerCallbackQuery({ text: "ok" });
});
```

- [ ] **Step 3: WhatsApp / Discord / Slack / Matrix / Email**

Follow platform-specific button/callback patterns per the spec:
- WhatsApp: Baileys `interactiveMessage` with buttons
- Discord: `components: [ActionRowBuilder.buttons]`
- Slack: Block Kit buttons
- Matrix: `m.notice` + fallback reactions
- Email: signed magic links (GET `/inbox/action?id=...&action=approve&sig=...`) — add signed-URL generator + HTTP handler

- [ ] **Step 4: Commit**

One commit per channel adapter:
```bash
git commit -m "proactive: inbox telegram buttons (Phase 4.3)"
# etc.
```

---

## Phase 5 — Delete legacy paths + telemetry + self-tuning

### Task 5.1: Delete legacy direct-send paths

- [ ] **Step 1: Remove `sendWhatsAppProactiveMessage` / `sendProactiveMessage` as direct callbacks from `src/index.ts`**

The onNotification callback should ONLY delegate to Observer. Remove the Phase 1 fallback path:

```typescript
onNotification: async (message) => {
  const { getObserver } = await import("./proactive/observer.js");
  const obs = getObserver();
  if (!obs) return;
  const { intentFromThought } = await import("./proactive/intent-from-thought.js");
  obs.enqueue(intentFromThought(message, { hourNow: new Date().getHours() }));
},
```

- [ ] **Step 2: Mark the old `innerThoughtsTick`-direct path as deprecated**

In `src/proactive/heartbeat.ts`, keep calling `innerThoughtsTick` (as a data source) but remove the direct `onNotification(thought)` dispatch. The Observer is responsible for all dispatch now.

- [ ] **Step 3: Remove flag defaults that remain true**

`ATLAS_PROACTIVE_V2_COMPOSER` and `ATLAS_PROACTIVE_V2_SCHEDULER` flags become no-ops (always on). Delete their env checks. Keep the `DISABLE` flags.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git commit -m "proactive: remove legacy direct-send paths (Phase 5)"
```

---

### Task 5.2: Telemetry logger

**Files:**
- Create: `src/proactive/telemetry.ts`
- Create: `src/proactive/telemetry.test.ts`
- Modify: `src/proactive/observer.ts` (call logger at each decision point)

- [ ] **Step 1: Implement writer**

```typescript
// © 2024-2026 XAGI Labs Private Limited
import type Database from "better-sqlite3";
import type { IntentSource, Channel } from "./intent.js";

export type ProactiveOutcome = {
  intentId: string;
  source: IntentSource;
  channel: Channel;
  decision: "enqueued" | "dropped" | "released" | "dispatched";
  dropReason?: string;
  dispatchedAt?: number;
  userReplied: boolean;
  userReplyLatencyMs?: number;
  userReplySentiment?: "positive" | "neutral" | "negative";
  userMarkedUseful?: boolean;
};

export class TelemetryLogger {
  constructor(private db: Database.Database) {}
  log(o: ProactiveOutcome): void {
    this.db.prepare(
      `INSERT INTO proactive_outcomes (intent_id, source, channel, decision, drop_reason,
       dispatched_at, user_replied, user_reply_latency_ms, user_reply_sentiment,
       user_marked_useful, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      o.intentId, o.source, o.channel, o.decision, o.dropReason ?? null,
      o.dispatchedAt ?? null, o.userReplied ? 1 : 0, o.userReplyLatencyMs ?? null,
      o.userReplySentiment ?? null, o.userMarkedUseful == null ? null : (o.userMarkedUseful ? 1 : 0),
      Date.now(),
    );
  }
  rejectionRate(source: IntentSource, channel: Channel, sinceMs: number): number {
    const row = this.db.prepare(
      `SELECT SUM(CASE WHEN user_reply_sentiment='negative' OR user_marked_useful=0 THEN 1 ELSE 0 END) AS neg,
              COUNT(*) AS tot FROM proactive_outcomes
       WHERE source=? AND channel=? AND dispatched_at >= ?`,
    ).get(source, channel, sinceMs) as { neg: number; tot: number };
    if (!row || row.tot === 0) return 0;
    return row.neg / row.tot;
  }
}
```

- [ ] **Step 2: Instrument Observer + Composer + dispatch**

Wire `TelemetryLogger.log(...)` at every decision point (enqueue ok/invalid, compose skip, dispatch success/fail).

- [ ] **Step 3: Weekly digest command**

Extend `tryProactiveCommand` with `atlas proactive stats`:

```typescript
if (/^(atlas,?\s+)?proactive\s+stats$/.test(lower)) {
  const { getTelemetry } = ...;
  const tl = getTelemetry();
  const since = Date.now() - 7 * 86400000;
  const sources: IntentSource[] = ["latent_topic_monitor","memory_anticipation","calendar_fact_check","calendar_fusion","stale_todo","meeting_followup","habit_anomaly","env_context","long_task_status","convex_notification"];
  const channels: Channel[] = ["whatsapp","telegram","overlay"];
  const lines: string[] = ["Proactive stats (last 7d):"];
  for (const s of sources) for (const c of channels) {
    const r = tl.rejectionRate(s, c, since);
    if (r > 0) lines.push(`• ${s}/${c}: ${(r*100).toFixed(0)}% negative`);
  }
  return { reply: lines.join("\n") };
}
```

- [ ] **Step 4: Commit**

```bash
git commit -m "proactive: telemetry logger + stats command (Phase 5)"
```

---

### Task 5.3: Self-tuning source weights

**Files:**
- Modify: `src/proactive/observer.ts` — read rejection rate from telemetry on a slow interval (every hour), adjust `SOURCE_WEIGHTS` in memory, bound `[0.2, 2.0]`.

- [ ] **Step 1: Implement**

In `Observer`:

```typescript
private tuningTimer: NodeJS.Timeout | null = null;
private dynamicWeights: Record<string, number> = { ...SOURCE_WEIGHTS };

private startSelfTuning(telemetry: TelemetryLogger) {
  this.tuningTimer = setInterval(() => {
    const since = Date.now() - 7 * 86400000;
    for (const source of Object.keys(SOURCE_WEIGHTS)) {
      // average rejection rate across all channels
      const rates = (["whatsapp","telegram","overlay"] as Channel[])
        .map(c => telemetry.rejectionRate(source as IntentSource, c, since));
      const avg = rates.reduce((a,b)=>a+b,0) / rates.length;
      const base = SOURCE_WEIGHTS[source] ?? 1.0;
      const adjusted = base * (1 - avg);  // higher rejection → lower weight
      this.dynamicWeights[source] = Math.max(0.2, Math.min(2.0, adjusted));
    }
  }, 60 * 60 * 1000);
}
```

Use `this.dynamicWeights[source]` instead of `SOURCE_WEIGHTS[source]` in `enqueue`.

- [ ] **Step 2: Commit**

```bash
git commit -m "proactive: self-tuning source weights based on rejection rate (Phase 5)"
```

---

### Task 5.4: Structured `proactive.log` file

**Files:**
- Modify: `src/proactive/kill-switches.ts::debugProactive` to also write JSON lines to `data/logs/proactive.log` (rotate daily, keep 7 days)

- [ ] **Step 1: Implement rotating file writer + stderr**

```typescript
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "data", "logs");
const LOG_FILE = () => join(LOG_DIR, `proactive-${new Date().toISOString().slice(0,10)}.log`);

export function debugProactive(event: string, ctx: Record<string, unknown>): void {
  if (process.env.ATLAS_PROACTIVE_DEBUG === "false") return;
  // stderr
  const flat = Object.entries(ctx).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  console.log(`🔔 [proactive] ${event} | ${flat}`);
  // file
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE(), JSON.stringify({ ts: Date.now(), event, ...ctx }) + "\n");
    // prune logs older than 7 days
    const cutoff = Date.now() - 7 * 86400_000;
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith("proactive-") || !f.endsWith(".log")) continue;
      const day = Date.parse(f.replace("proactive-","").replace(".log","") + "T00:00:00Z");
      if (!Number.isNaN(day) && day < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* log best-effort */ }
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "proactive: structured JSON log with 7-day rotation (Phase 5)"
```

---

## Final Checklist

Before declaring done:

- [ ] All 4 leak-regression tests pass (`npx vitest run src/proactive/leak-regression.test.ts`)
- [ ] `npm test` passes across all added suites
- [ ] `cd native && cargo test` passes
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run build` + `npm run build:native` both succeed
- [ ] `data/proactive-config.json` created on first boot; persists posture changes
- [ ] Telegram + WhatsApp both route through Observer (no direct proactive-send calls remain in `src/index.ts`)
- [ ] Convex `system_prompts` contains `proactive-composer` and `monitor-rule-parser`
- [ ] `atlas proactive status`, `atlas proactive stats`, `atlas, shut up`, `atlas resume` all work on Telegram + WhatsApp
- [ ] `monitor me when X` creates a rule that fires on a matching inbound message
- [ ] Overlay inbox receives a `review` intent end-to-end; approving executes the suggested action
- [ ] Running ATLAS for 24h shows < 5 legacy `inner-thoughts` log lines (indicating the old path is not being used)
- [ ] `data/logs/proactive-*.log` rotates older than 7 days are pruned



