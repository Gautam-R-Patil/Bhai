// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, insertTool } from "../library.js";
import { lookupTool } from "../lookup.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("forge lookup pipeline", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "forge-lk-")); openLibrary(join(tmpDir, "lib.db")); });
    afterEach(() => { closeLibrary(); rmSync(tmpDir, { recursive: true, force: true }); });

    it("returns null when library is empty", async () => {
        const hit = await lookupTool({
            description: "extract PDF tables",
            embedFn: async () => vector(0),
            functionGemmaFn: async () => null,
        });
        expect(hit).toBeNull();
    });

    it("returns hit when description matches existing tool", async () => {
        insertTool({
            slug: "extract_pdf",
            description: "Extract tables from a PDF file",
            schemaJson: JSON.stringify({ type: "object", properties: { path: { type: "string" } } }),
            handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        const hit = await lookupTool({
            description: "extract PDF tables",  // similar wording — FTS will match
            embedFn: async () => vector(0),    // identical embedding for test purposes
            functionGemmaFn: async () => null, // FG returns nothing, force fallback to embedding path
        });

        expect(hit).not.toBeNull();
        expect(hit!.slug).toBe("extract_pdf");
        expect(hit!.matchSimilarity).toBeGreaterThan(0.85);
        expect(hit!.source).toBe("library_embedding");
    });

    it("returns hit via FunctionGemma when available", async () => {
        insertTool({
            slug: "send_sms",
            description: "Send an SMS message",
            schemaJson: "{}", handlerHash: "x", embedding: vector(5),
            source: "synchronous", createdAt: Date.now(),
        });

        const hit = await lookupTool({
            description: "text message to phone",
            embedFn: async () => vector(99),  // unrelated to send_sms embedding
            functionGemmaFn: async () => ({ toolName: "send_sms", confidence: 0.92, parameters: {}, source: "function-gemma" }),
        });

        expect(hit).not.toBeNull();
        expect(hit!.slug).toBe("send_sms");
        expect(hit!.source).toBe("function_gemma");
        expect(hit!.matchSimilarity).toBe(0.92);
    });

    it("FunctionGemma low confidence falls through to embedding lookup", async () => {
        insertTool({
            slug: "send_sms",
            description: "Send an SMS",
            schemaJson: "{}", handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        const hit = await lookupTool({
            description: "Send SMS",
            embedFn: async () => vector(0),  // matches send_sms by embedding
            functionGemmaFn: async () => ({ toolName: "send_sms", confidence: 0.6, parameters: {}, source: "function-gemma" }),
        });

        // FunctionGemma's 0.6 < 0.8 threshold → falls through; embedding path catches it
        expect(hit).not.toBeNull();
        expect(hit!.source).toBe("library_embedding");
    });

    it("FunctionGemma claims a slug that doesn't exist → falls through", async () => {
        const hit = await lookupTool({
            description: "anything",
            embedFn: async () => vector(0),
            functionGemmaFn: async () => ({ toolName: "ghost_tool", confidence: 0.95, parameters: {}, source: "function-gemma" }),
        });
        expect(hit).toBeNull();
    });

    it("returns null when both FunctionGemma and embedding lookup miss", async () => {
        insertTool({
            slug: "send_sms",
            description: "Send SMS",
            schemaJson: "{}", handlerHash: "x", embedding: vector(100),
            source: "synchronous", createdAt: Date.now(),
        });

        const hit = await lookupTool({
            description: "totally unrelated query about quantum physics",
            embedFn: async () => vector(0), // way off from vector(100), cosine well under 0.85
            functionGemmaFn: async () => null,
        });
        expect(hit).toBeNull();
    });

    it("returns null when ATLAS_NO_FORGE_LOOKUP=true", async () => {
        insertTool({
            slug: "x", description: "x",
            schemaJson: "{}", handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        process.env.ATLAS_NO_FORGE_LOOKUP = "true";
        try {
            const hit = await lookupTool({
                description: "x",
                embedFn: async () => vector(0),
                functionGemmaFn: async () => null,
            });
            expect(hit).toBeNull();
        } finally {
            delete process.env.ATLAS_NO_FORGE_LOOKUP;
        }
    });

    it("FunctionGemma throws → falls through to embedding lookup", async () => {
        insertTool({
            slug: "recover_me", description: "this is recoverable",
            schemaJson: "{}", handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        const hit = await lookupTool({
            description: "this is recoverable",
            embedFn: async () => vector(0),
            functionGemmaFn: async () => { throw new Error("ollama down"); },
        });

        // FG threw → caught by try/catch → fall through → FTS+embedding find the match
        expect(hit).not.toBeNull();
        expect(hit!.slug).toBe("recover_me");
        expect(hit!.source).toBe("library_embedding");
    });
});
