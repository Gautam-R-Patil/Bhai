// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The 24 category vectors are cached on disk: a restart embeds one probe text, not 24.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tool-router-cache-"));

const { emb } = vi.hoisted(() => ({ emb: { texts: [] as string[], salt: 0 } }));
vi.mock("./memory/embeddings.js", () => {
    const vec = (t: string) => Float32Array.from({ length: 8 }, (_, i) => Math.sin(t.length * (i + 1) + t.charCodeAt(0) + emb.salt));
    return {
        isReady: () => true,
        warmup: async () => {},
        embedBatch: async (texts: string[]) => {
            emb.texts.push(...texts);
            return texts.map(vec);
        },
        embedText: async (t: string) => vec(t),
        cosineSimilarity: () => 0,
        getActiveEmbeddingModel: () => ({ modelName: "test-model" }),
        getActiveDim: () => 8,
        getEffectiveDimension: () => 8,
    };
});
vi.mock("./mcp/client.js", () => ({ getMCPToolSchemas: () => [] }));

async function boot() {
    vi.resetModules();
    emb.texts.length = 0;
    const router = await import("./tool-router.js");
    await router.initToolRouter();
    for (let i = 0; i < 50 && !fs.existsSync(path.join(process.env.ATLAS_DATA_DIR as string, "tool-router-categories.json")); i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    return emb.texts.length;
}

it("re-embeds the categories only when there is no cache or the model changed", async () => {
    const first = await boot();
    expect(first).toBeGreaterThan(20); // probe + every category
    expect(await boot()).toBe(1); // probe only
    emb.salt = 1; // the model now gives different vectors
    expect(await boot()).toBe(first);
});
