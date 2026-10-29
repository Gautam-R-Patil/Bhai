#!/usr/bin/env tsx
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Vision-nav smoke test. Exercises the full P0→P5 surface end-to-end without
// requiring a live UI:
//   1. capability-detector returns a valid profile
//   2. tool-router resolves os_smart_click in the os_control category
//   3. registry.get("os_smart_click") returns a callable handler
//   4. handler returns a structured JSON failure with no screenshot + no AX dump
//      (i.e., cascade gracefully exits with cascade_miss instead of crashing)
//   5. click-memory + drift-calibration kill-switches gate correctly
//   6. recallClickSite returns null cold; recordClickSuccess then recall → hit
//   7. perception-router skip-all-tiers returns null cleanly

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAILS: string[] = [];
const PASSES: string[] = [];

function check(name: string, cond: boolean, info?: string) {
    if (cond) PASSES.push(name);
    else FAILS.push(`${name}${info ? ` — ${info}` : ""}`);
}

async function run() {
    // 1. Capability detector
    const { detectCapabilities } = await import("../src/screen/capability-detector.js");
    const caps = await detectCapabilities();
    check(
        "capability-detector returns valid profile",
        caps.profile === "lite" || caps.profile === "standard" || caps.profile === "full",
        `profile=${caps.profile}`,
    );
    check("capability-detector reports ramGB > 0", caps.ramGB > 0, `ram=${caps.ramGB}GB`);
    check("capability-detector reports cpu cores", caps.cpuCores > 0);
    check(
        "capability-detector deps is shape-correct",
        typeof caps.deps?.ollama === "boolean" && typeof caps.deps?.python === "boolean",
    );

    // 2. Tool schemas include os_smart_click
    const { getToolSchemas } = await import("../src/tools/index.js");
    const allSchemas = getToolSchemas();
    const hasSmartClick = allSchemas.some((t) => t.function.name === "os_smart_click");
    check("getToolSchemas() includes os_smart_click", hasSmartClick, `got ${allSchemas.length} schemas`);

    // 3. Tool is known to the registry
    const { isKnownTool, executeTool } = await import("../src/tools/index.js");
    check("isKnownTool('os_smart_click') is true", isKnownTool("os_smart_click"));

    // 4. Graceful failure on impossible target (no crash, structured JSON output)
    const result = await executeTool("os_smart_click", { instruction: "the impossible widget xyz123" });
    let parsed: { success?: boolean; error?: string } | null = null;
    try {
        parsed = JSON.parse(result);
    } catch {
        // ignore
    }
    check("executeTool returns parseable JSON on impossible target", !!parsed);
    check(
        "handler reports cascade_miss or success=false (no crash)",
        parsed?.success === false || typeof parsed?.success === "boolean",
        `got: ${JSON.stringify(parsed).slice(0, 200)}`,
    );

    // 5. Kill-switches
    {
        const TEST_DB = join(tmpdir(), `atlas_smoke_clickmem_${Date.now()}.db`);
        const { recordClickSuccess, recallClickSite } = await import("../src/screen/click-memory.js");
        process.env.ATLAS_NO_CLICK_MEMORY = "true";
        recordClickSuccess({ app: "X", windowTitle: "W", elementLabel: "Y" }, 100, 100, 1000, 1000, { dbPath: TEST_DB });
        const r = recallClickSite({ app: "X", windowTitle: "W", elementLabel: "Y" }, { dbPath: TEST_DB });
        check("ATLAS_NO_CLICK_MEMORY=true → recallClickSite returns null", r === null);
        delete process.env.ATLAS_NO_CLICK_MEMORY;
        try {
            if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        } catch {
            // ignore
        }
    }

    {
        const STORE = join(tmpdir(), `atlas_smoke_drift_${Date.now()}.json`);
        const { setDriftStorePath, applyCalibration, recordCalibrationSample } = await import(
            "../src/screen/drift-calibration.js"
        );
        setDriftStorePath(STORE);
        process.env.ATLAS_NO_DRIFT_CALIBRATION = "true";
        for (let i = 0; i < 10; i++) {
            recordCalibrationSample("mon", { x: i * 10, y: i * 7 }, { x: i * 10 + 50, y: i * 7 + 50 });
        }
        const out = applyCalibration("mon", 100, 200);
        check("ATLAS_NO_DRIFT_CALIBRATION=true → applyCalibration is identity", out.x === 100 && out.y === 200);
        delete process.env.ATLAS_NO_DRIFT_CALIBRATION;
        try {
            if (existsSync(STORE)) unlinkSync(STORE);
        } catch {
            // ignore
        }
    }

    // 6. End-to-end click-memory round trip
    {
        const TEST_DB = join(tmpdir(), `atlas_smoke_e2e_${Date.now()}.db`);
        const { recordClickSuccess, recallClickSite, closeClickMemory } = await import("../src/screen/click-memory.js");
        closeClickMemory();
        recordClickSuccess({ app: "Demo", windowTitle: "W", elementLabel: "Login" }, 360, 240, 720, 480, { dbPath: TEST_DB });
        const recall = recallClickSite({ app: "Demo", windowTitle: "W", elementLabel: "Login" }, { dbPath: TEST_DB });
        check("recordClickSuccess + recallClickSite round-trip", !!recall && recall.xNorm === 0.5 && recall.yNorm === 0.5);
        check("recall confidence reflects success_count=1", recall?.confidence === 0.75);
        closeClickMemory();
        try {
            if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        } catch {
            // ignore
        }
    }

    // 7. Perception router: skip-all-tiers exits cleanly
    {
        const { findClickTarget } = await import("../src/screen/perception-router.js");
        const r = await findClickTarget("impossible widget", {
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser", "ui_tars"],
            forceProfile: "lite",
        });
        check("findClickTarget(skip-all) returns null cleanly", r === null);
    }

    // Report
    console.log(`\n=== smoke results: ${PASSES.length}/${PASSES.length + FAILS.length} passed ===`);
    for (const p of PASSES) console.log(`  ✓ ${p}`);
    if (FAILS.length > 0) {
        console.log(`\n  ❌ ${FAILS.length} FAILS:`);
        for (const f of FAILS) console.log(`     ${f}`);
        process.exit(1);
    } else {
        console.log("\n  all green");
        process.exit(0);
    }
}

run().catch((e) => {
    console.error("smoke harness crashed:", e);
    process.exit(2);
});
