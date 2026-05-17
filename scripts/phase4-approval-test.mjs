#!/usr/bin/env node
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Phase 4 approval-gate test — exercises the user-facing approval flow.
//
// Validates:
//   1. approve_dynamic_tool rejects banned quotes ("ok", "yes", ...)
//   2. approve_dynamic_tool rejects too-short quotes
//   3. approve_dynamic_tool refuses to run outside awaiting_dynamic_tool_approval mode
//   4. approve_dynamic_tool refuses if slug doesn't match the pending slug
//   5. Happy path: enter mode + valid quote → approval succeeds
//   6. After approval, plan-mode returns to "act"
//   7. revoke_dynamic_tool exits awaiting mode if pending slug matches

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "atlas-phase4-approval-"));
process.env.ATLAS_HOME = tmpHome;

const PASS = (msg) => console.log(`\x1b[32m✅ PASS\x1b[0m ${msg}`);
const FAIL = (msg, detail) => {
    console.error(`\x1b[31m❌ FAIL\x1b[0m ${msg}`);
    if (detail !== undefined) console.error("  detail:", detail);
    process.exitCode = 1;
};
const INFO = (msg) => console.log(`\x1b[36mℹ️\x1b[0m  ${msg}`);

async function run() {
    INFO(`tmpHome = ${tmpHome}`);

    const planMode = await import("../dist/agents/plan-mode.js");
    const orchestrator = await import("../dist/forge/orchestrator.js");
    const supervisor = await import("../dist/forge/sandbox-supervisor.js");
    const forgeApproval = await import("../dist/tools/forge-approval.js");
    const createTool = await import("../dist/tools/create-tool.js");
    const library = await import("../dist/forge/library.js");

    if (!supervisor.isNativeAvailable()) {
        FAIL("native not loaded");
        return;
    }

    // Initialise forge — opens library, sets _ready, registers registry hook.
    const registry = new Map();
    createTool.setRegistryRef(registry);
    await orchestrator.initForge({
        embedFn: async () => new Float32Array(384), // dummy embedder for tests
    });
    if (!orchestrator.isForgeReady()) {
        FAIL("forge failed to init");
        return;
    }
    INFO("forge initialised");

    // Prepare a fake "synthesized" tool on disk (skip the verifier — we're
    // testing the approval gate, not the synthesis path).
    const slug = "phase4_approval_test";
    const handlerCode = "return { ok: true, in: input };";
    const wrapped = `module.exports = async function(input) {\n${handlerCode}\n};\n`;
    const handlerHash = createHash("sha256").update(wrapped).digest("hex").substring(0, 16);

    await supervisor.installPersistedTool(slug, handlerCode, {
        slug,
        description: "Approval-gate test tool",
        capabilities: { fs_read: [], fs_write: [], net: [], exec: [] },
        parametersSchema: { type: "object", properties: {} },
        version: "0.1.0",
        approvedAt: 0, // not yet approved
        userQuote: "",
        handlerHash,
    });
    // Production flow has synthesizeTool insert the library row before
    // installPersistedTool — we bypass synthesizeTool here, so insert manually.
    library.insertTool({
        slug,
        description: "Approval-gate test tool",
        schemaJson: "{}",
        handlerHash,
        embedding: new Float32Array(384),
        source: "synchronous",
        createdAt: Date.now(),
    });
    library.setLifecycleState(slug, "awaiting_approval");
    INFO("fixture: manifest + library row persisted with awaiting_approval state");

    // ── Test 1: agent tool rejects banned phrase (≥10 chars, exact-match) ────
    const bannedR = JSON.parse(
        await forgeApproval.approveDynamicToolTool.handler({
            slug,
            user_quote: "looks good", // 10 chars, in banned set
        }),
    );
    if (bannedR.ok === false && /generic|verbatim/i.test(bannedR.error ?? "")) {
        PASS('agent-tool reject: user_quote="looks good" (banned, ≥10 chars) rejected');
    } else {
        FAIL("agent-tool should reject banned quote", bannedR);
    }

    // ── Test 2: agent tool rejects too-short quote ───────────────────────────
    const shortR = JSON.parse(
        await forgeApproval.approveDynamicToolTool.handler({
            slug,
            user_quote: "yep",
        }),
    );
    if (shortR.ok === false && /≥|short|10/i.test(shortR.error ?? "")) {
        PASS('agent-tool reject: user_quote="yep" (<10 chars) rejected');
    } else {
        FAIL("agent-tool should reject short quote", shortR);
    }

    // ── Test 3: refuses outside awaiting_dynamic_tool_approval mode ──────────
    // We're in "act" by default. Even a valid-looking quote must fail.
    const modeR = await orchestrator.approveDynamicTool(
        slug,
        "yes please install the approval-gate test tool",
    );
    if (modeR.ok === false && /awaiting_dynamic_tool_approval|plan-mode/.test(modeR.error)) {
        PASS("orchestrator: refused approval outside awaiting_dynamic_tool_approval mode");
    } else {
        FAIL("orchestrator should require awaiting mode", modeR);
    }

    // Now enter the mode WITH A DIFFERENT SLUG to test slug-mismatch.
    planMode.enterAwaitingDynamicToolApproval("some_other_slug");
    const slugMismatchR = await orchestrator.approveDynamicTool(
        slug,
        "yes please install the approval-gate test tool",
    );
    if (slugMismatchR.ok === false && /slug/.test(slugMismatchR.error)) {
        PASS("orchestrator: refused approval when slug mismatches pending slug");
    } else {
        FAIL("orchestrator should require slug match", slugMismatchR);
    }

    // ── Test 5: happy path — correct mode + correct slug + valid quote ──────
    planMode.enterAwaitingDynamicToolApproval(slug);
    const okR = await orchestrator.approveDynamicTool(
        slug,
        "yes please install the approval-gate test tool",
    );
    if (okR.ok === true && okR.toolName === slug) {
        PASS(`happy path: approval succeeded, toolName=${okR.toolName}`);
    } else {
        FAIL("happy path approval should succeed", okR);
    }

    // ── Test 6: after approval, plan-mode is back to "act" ───────────────────
    const postApproveMode = planMode.getPlanModeState().mode;
    if (postApproveMode === "act") {
        PASS("plan-mode returned to 'act' after approval");
    } else {
        FAIL(`plan-mode should be 'act' after approval, got '${postApproveMode}'`);
    }

    // ── Test 7: revoke from awaiting mode exits cleanly ──────────────────────
    // Re-arm: install another tool, enter awaiting, then revoke.
    const slug2 = "phase4_revoke_test";
    const hash2 = createHash("sha256")
        .update(`module.exports = async function(input) {\n${handlerCode}\n};\n`)
        .digest("hex")
        .substring(0, 16);
    await supervisor.installPersistedTool(slug2, handlerCode, {
        slug: slug2,
        description: "Revoke test",
        capabilities: { fs_read: [], fs_write: [], net: [], exec: [] },
        parametersSchema: { type: "object", properties: {} },
        version: "0.1.0",
        approvedAt: 0,
        userQuote: "",
        handlerHash: hash2,
    });
    library.insertTool({
        slug: slug2,
        description: "Revoke test",
        schemaJson: "{}",
        handlerHash: hash2,
        embedding: new Float32Array(384),
        source: "synchronous",
        createdAt: Date.now(),
    });
    library.setLifecycleState(slug2, "awaiting_approval");
    planMode.enterAwaitingDynamicToolApproval(slug2);
    await orchestrator.revokeDynamicTool(slug2);
    const postRevokeMode = planMode.getPlanModeState().mode;
    if (postRevokeMode === "act") {
        PASS("plan-mode returned to 'act' after revoke of pending slug");
    } else {
        FAIL(`plan-mode should be 'act' after revoke, got '${postRevokeMode}'`);
    }

    // Cleanup
    await supervisor.uninstallPersistedTool(slug).catch(() => {});
    rmSync(tmpHome, { recursive: true, force: true });
    INFO(`cleanup: ${tmpHome} removed`);

    if (process.exitCode) {
        console.error("\n\x1b[31m═══ APPROVAL-GATE TEST FAILED ═══\x1b[0m");
    } else {
        console.log("\n\x1b[32m═══ APPROVAL-GATE TEST PASSED ═══\x1b[0m");
    }
}

run().catch((err) => {
    FAIL("unhandled error", err);
    rmSync(tmpHome, { recursive: true, force: true });
});
