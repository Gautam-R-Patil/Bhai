// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A session of one-off lookups isn't kept as a memory; one with a plan is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-reflect-"));

const llmFor = (summary: object) => ({
    chat: vi.fn(async ({ systemPrompt }: { systemPrompt?: string }) => ({
        choices: [
            {
                message: {
                    content: systemPrompt?.includes("summarizer")
                        ? JSON.stringify(summary)
                        : '{"traits":[],"identity_updates":[],"emotions":[],"episodes":[],"dominant_tone":"neutral"}',
                },
            },
        ],
    })),
});

const history = [
    { role: "user", content: "what time is it in Tokyo, and what's 17 times 23?" },
    { role: "assistant", content: "12:35 PM in Tokyo, and 17 × 23 = 391." },
] as never;

it("keeps a session summary as a memory only when something in it lasts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sqlite = await import("../sqlite.js");
    await sqlite.initMemoryDB();
    const { runReflection } = await import("../reflection.js");
    const count = () =>
        (sqlite.getRawDb()?.prepare("SELECT COUNT(*) AS n FROM memories WHERE category = 'session_summary'").get() as {
            n: number;
        }).n;

    await runReflection(
        llmFor({ summary: "Quick lookups: Tokyo time and a sum.", highlights: [], lasting: false }) as never,
        history,
        "s1",
        "",
    );
    expect(count()).toBe(0);

    await runReflection(
        llmFor({ summary: "Owner planned a Tokyo trip for December and wants hotel options.", highlights: [], lasting: true }) as never,
        history,
        "s2",
        "",
    );
    expect(count()).toBe(1);
});
