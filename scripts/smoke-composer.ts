// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Smoke test for the Composer end-to-end against real Convex + real LLM.
// Simulates exactly what the heartbeat pipeline does: builds a ProactiveIntent
// with content typical of the leak bug, runs it through compose(), and prints
// whether the output is safe or rejected.
//
// Usage:
//   npx tsx scripts/smoke-composer.ts
// Respects CONVEX_URL env var (default: dev).

import { loadConfig } from "../src/config.js";
import { createLLMClient } from "../src/llm.js";
import { initSession } from "../src/session.js";
import { compose } from "../src/proactive/composer.js";
import { makeIntentId, type ProactiveIntent } from "../src/proactive/intent.js";

async function run() {
    console.log("🚬 Composer smoke test");
    console.log("   CONVEX_URL:", process.env.CONVEX_URL ?? "(default zany-kudu-607 dev)");

    // Boot session (auth needed for /api/system/prompt + /api/llm/chat)
    const config = loadConfig();
    const ok = await initSession();
    if (!ok) {
        console.error("❌ initSession failed — cannot proceed");
        process.exit(1);
    }
    console.log("✅ session established");

    const llm = createLLMClient(config);

    // Case A: a safe intent that the Composer SHOULD handle via LLM (no template)
    const safeIntent: ProactiveIntent = {
        id: makeIntentId("memory_anticipation"),
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "any",
        topic: "morning check",
        topicEmbedding: new Array(384).fill(0),
        evidence: [{ label: "timeOfDay", value: "morning" }],
        payload: {
            kind: "memory_anticipation",
            hint: "You were working on the Midnight Library website hero layout yesterday and left it mid-edit.",
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60 * 60_000,
    };

    console.log("\nCase A — normal memory_anticipation (expect second-person text)");
    const a = await compose(safeIntent, "whatsapp", { tone: "warm" }, [], { llm });
    if (a === null) {
        console.log("   → NULL (Composer refused to speak — fail-closed)");
    } else {
        console.log(`   → "${a.text}"`);
        console.log(`   mode: ${a.modeTag}`);
        const lower = a.text.toLowerCase();
        const bad = /\bthe user\b|\buser (is|was|has|will|would|might|should|could|seems)\b/.test(lower);
        const bannedHit = ["might be worth", "been away for", "worth a quick", "might be useful"].find((p) => lower.includes(p));
        if (bad) console.log("   ❌ third-person leaked through!");
        if (bannedHit) console.log(`   ❌ banned phrase leaked through: "${bannedHit}"`);
        if (!bad && !bannedHit) console.log("   ✅ clean output");
    }

    // Case B: a template-path intent (should produce deterministic text, no LLM call)
    const tplIntent: ProactiveIntent = {
        id: makeIntentId("long_task_status"),
        source: "long_task_status",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "whatsapp",
        topic: "task done",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "long_task_status", task: "deep research", summary: "23 sources indexed." },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
    console.log("\nCase B — long_task_status (template fast-path, no LLM)");
    const b = await compose(tplIntent, "whatsapp", { tone: "neutral" }, [], { llm });
    console.log(`   → ${b === null ? "NULL" : `"${b.text}"`}`);
    if (b?.text === "Done with deep research. 23 sources indexed.") {
        console.log("   ✅ template matched expected output");
    }

    // Case C: a "leak-shaped" hint — force the LLM to get a prompt that TEMPTS
    // it to generate third-person text. The system prompt + filter must still
    // keep it clean.
    const temptingIntent: ProactiveIntent = {
        ...safeIntent,
        id: makeIntentId("memory_anticipation"),
        payload: {
            kind: "memory_anticipation",
            hint: "The user (Dheeraj) has been away from his laptop for 8+ hours. He was working on the Midnight Library bookstore project last night. It's now morning.",
        },
    };
    console.log("\nCase C — leak-shaped prompt (SYSTEM prompt + filters must keep it clean)");
    const c = await compose(temptingIntent, "whatsapp", { tone: "warm" }, [], { llm });
    if (c === null) {
        console.log("   → NULL (Composer rejected it — either prompt said skip or filter caught)");
    } else {
        console.log(`   → "${c.text}"`);
        const lower = c.text.toLowerCase();
        const bad = /\bthe user\b|\buser (is|was|has|will|would|might|should|could|seems)\b/.test(lower) ||
            lower.includes("dheeraj") || lower.includes("been away for");
        console.log(bad ? "   ❌ LEAK!" : "   ✅ clean");
    }

    console.log("\nsmoke done.");
    process.exit(0);
}

run().catch((e) => {
    console.error("smoke failed:", e);
    process.exit(1);
});
