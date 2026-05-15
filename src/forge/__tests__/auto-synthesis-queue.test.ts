// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForge, shutdownForge } from "../orchestrator.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("auto-synthesis queue", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-aq-"));
        originalEnv = process.env.ATLAS_HOME;
        process.env.ATLAS_HOME = join(tmpDir, ".atlas");
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = originalEnv;
    });

    it("queueSynthesisCandidate persists to forge-pending.json", async () => {
        const { queueSynthesisCandidate } = await import("../orchestrator.js");
        await queueSynthesisCandidate({
            name: "auto_sms",
            description: "Send SMS via Twilio",
            parametersSchema: { type: "object", properties: {}, required: [] },
            persistent: false,
            source: "synchronous",
        });

        const pendingPath = join(process.env.ATLAS_HOME!, "data", "forge-pending.json");
        expect(existsSync(pendingPath)).toBe(true);
        const pending = JSON.parse(readFileSync(pendingPath, "utf-8"));
        expect(pending.candidates).toHaveLength(1);
        expect(pending.candidates[0].description).toBe("Send SMS via Twilio");
        expect(pending.candidates[0].name).toBe("auto_sms");
    });

    it("queueing the same description twice does not create duplicate entries", async () => {
        const { queueSynthesisCandidate } = await import("../orchestrator.js");
        await queueSynthesisCandidate({
            name: "x", description: "test description",
            parametersSchema: {}, persistent: false, source: "synchronous",
        });
        await queueSynthesisCandidate({
            name: "x", description: "test description",
            parametersSchema: {}, persistent: false, source: "synchronous",
        });
        const pending = JSON.parse(readFileSync(join(process.env.ATLAS_HOME!, "data", "forge-pending.json"), "utf-8"));
        expect(pending.candidates).toHaveLength(1);
    });

    it("consumeNextPendingCandidate FIFO-pops the queue", async () => {
        const { queueSynthesisCandidate, consumeNextPendingCandidate } = await import("../orchestrator.js");
        await queueSynthesisCandidate({
            name: "first", description: "first one", parametersSchema: {}, persistent: false, source: "synchronous",
        });
        await queueSynthesisCandidate({
            name: "second", description: "second one", parametersSchema: {}, persistent: false, source: "synchronous",
        });

        const first = consumeNextPendingCandidate();
        expect(first?.name).toBe("first");

        const second = consumeNextPendingCandidate();
        expect(second?.name).toBe("second");

        const third = consumeNextPendingCandidate();
        expect(third).toBeNull();
    });

    it("consumeNextPendingCandidate returns null when queue is empty", async () => {
        const { consumeNextPendingCandidate } = await import("../orchestrator.js");
        const result = consumeNextPendingCandidate();
        expect(result).toBeNull();
    });

    it("queueSynthesisCandidate is no-op when forge not ready", async () => {
        shutdownForge();
        const { queueSynthesisCandidate } = await import("../orchestrator.js");
        await queueSynthesisCandidate({
            name: "should_not_persist", description: "ignored", parametersSchema: {}, persistent: false, source: "synchronous",
        });
        const pendingPath = join(process.env.ATLAS_HOME!, "data", "forge-pending.json");
        expect(existsSync(pendingPath)).toBe(false);
    });
});
