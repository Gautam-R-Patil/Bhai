#!/usr/bin/env node
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Phase 4 end-to-end test — exercises the full sandbox lifecycle on macOS.
//
// Validates:
//   1. install → invoke (happy path: doubler)
//   2. sandbox fence: handler tries /etc/passwd → denied (cap_denied / EACCES)
//   3. handler-hash tamper detection
//   4. revoke + re-invoke fails
//
// Run: node scripts/phase4-e2e-test.mjs
// Requires: native module built (npm run build:native), dist/ compiled (npm run build).

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "atlas-phase4-e2e-"));
process.env.ATLAS_HOME = tmpHome;
process.env.ATLAS_FORGE_STUB_LLM = "true"; // not used, but defensive
process.env.ATLAS_FORGE_CALL_TIMEOUT_MS = "10000";

const PASS = (msg) => console.log(`\x1b[32m✅ PASS\x1b[0m ${msg}`);
const FAIL = (msg, detail) => {
    console.error(`\x1b[31m❌ FAIL\x1b[0m ${msg}`);
    if (detail !== undefined) console.error("  detail:", detail);
    process.exitCode = 1;
};
const INFO = (msg) => console.log(`\x1b[36mℹ️\x1b[0m  ${msg}`);

async function run() {
    INFO(`tmpHome = ${tmpHome}`);

    // Load the compiled supervisor (uses native binding via createRequire).
    const supervisor = await import("../dist/forge/sandbox-supervisor.js");
    const { isNativeAvailable, installPersistedTool, invokePersistedTool, uninstallPersistedTool } =
        supervisor;

    if (!isNativeAvailable()) {
        FAIL("native module not loaded — cannot test sandbox", null);
        return;
    }
    PASS("native forge module loaded");

    // ── Test 1: install + invoke happy path ───────────────────────────────────
    const happySlug = "phase4_doubler";
    const happyCode = "return { doubled: input.x * 2 };";
    const happyWrapped = `module.exports = async function(input) {\n${happyCode}\n};\n`;
    const happyHash = createHash("sha256").update(happyWrapped).digest("hex").substring(0, 16);

    await installPersistedTool(happySlug, happyCode, {
        slug: happySlug,
        description: "Doubles input.x",
        capabilities: { fs_read: [], fs_write: [], net: [], exec: [] },
        parametersSchema: { type: "object", properties: { x: { type: "number" } } },
        version: "0.1.0",
        approvedAt: Date.now(),
        userQuote: "yes install the doubler for the e2e test please",
        handlerHash: happyHash,
    });
    PASS("install: doubler persisted to disk");

    const happyResult = await invokePersistedTool(happySlug, { x: 21 });
    if (happyResult.ok && happyResult.result?.doubled === 42) {
        PASS(`invoke happy path: 21 → 42 (got ${happyResult.result.doubled})`);
    } else {
        FAIL("invoke happy path: expected {doubled:42}", happyResult);
    }

    // ── Test 2: adversarial — try to read /etc/passwd, expect kernel denial ──
    const evilSlug = "phase4_evil_passwd";
    const evilCode = `
const fs = require("node:fs");
try {
    const data = fs.readFileSync("/etc/passwd", "utf8");
    return { leaked: true, length: data.length, preview: data.substring(0, 50) };
} catch (e) {
    return { denied: true, code: e.code, message: e.message };
}
    `.trim();
    const evilWrapped = `module.exports = async function(input) {\n${evilCode}\n};\n`;
    const evilHash = createHash("sha256").update(evilWrapped).digest("hex").substring(0, 16);

    await installPersistedTool(evilSlug, evilCode, {
        slug: evilSlug,
        description: "Adversarial: tries to read /etc/passwd",
        capabilities: { fs_read: [tmpHome], fs_write: [], net: [], exec: [] },
        parametersSchema: { type: "object", properties: {} },
        version: "0.1.0",
        approvedAt: Date.now(),
        userQuote: "yes install the adversarial test handler for sandbox verification",
        handlerHash: evilHash,
    });
    PASS("install: adversarial /etc/passwd tool persisted");

    const evilResult = await invokePersistedTool(evilSlug, {});
    if (evilResult.ok) {
        const r = evilResult.result ?? {};
        if (r.leaked === true) {
            FAIL("CRITICAL: sandbox bypass — handler read /etc/passwd!", {
                length: r.length,
                preview: r.preview,
            });
        } else if (r.denied === true && /^(EACCES|EPERM)$/i.test(r.code ?? "")) {
            PASS(`sandbox fence: /etc/passwd read → denied:true code=${r.code} (kernel blocked)`);
        } else {
            FAIL("unexpected adversarial result shape", evilResult);
        }
    } else {
        if (evilResult.error.kind === "cap_denied" || evilResult.error.kind === "handler_error") {
            PASS(`sandbox fence: /etc/passwd read → ${evilResult.error.kind} (kernel blocked)`);
        } else {
            FAIL(`unexpected error kind: ${evilResult.error.kind}`, evilResult.error);
        }
    }

    // ── Test 3: handler-hash tamper detection ─────────────────────────────────
    // Overwrite handler.js on disk with malicious code; manifest hash unchanged.
    const tamperPath = join(tmpHome, "store", "dynamic", happySlug, "handler.js");
    writeFileSync(
        tamperPath,
        `module.exports = async function(input) {\n  return { hijacked: true };\n};\n`,
    );
    const tamperResult = await invokePersistedTool(happySlug, { x: 21 });
    if (!tamperResult.ok && tamperResult.error.message.includes("tamper detected")) {
        PASS("tamper detection: post-install handler.js swap refused");
    } else {
        FAIL("CRITICAL: tamper detection bypassed — handler.js swap succeeded", tamperResult);
    }

    // ── Test 4: revoke + re-invoke fails ─────────────────────────────────────
    await uninstallPersistedTool(evilSlug);
    PASS("uninstall: evil slug removed");

    const postRevokeResult = await invokePersistedTool(evilSlug, {});
    if (!postRevokeResult.ok && /not found/i.test(postRevokeResult.error.message)) {
        PASS("post-revoke invoke: manifest not found (tool is gone)");
    } else {
        FAIL("post-revoke: expected 'manifest not found' error", postRevokeResult);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await uninstallPersistedTool(happySlug).catch(() => {});
    rmSync(tmpHome, { recursive: true, force: true });
    INFO(`cleanup: ${tmpHome} removed`);

    if (process.exitCode) {
        console.error("\n\x1b[31m═══ E2E TEST FAILED ═══\x1b[0m");
    } else {
        console.log("\n\x1b[32m═══ E2E TEST PASSED ═══\x1b[0m");
        console.log("Phase 4 sandbox is enforcing the kernel fence end-to-end.");
    }
}

run().catch((err) => {
    FAIL("unhandled error", err);
    rmSync(tmpHome, { recursive: true, force: true });
});
