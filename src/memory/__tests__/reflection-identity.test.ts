// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Reflection's identity updates name fields the model chose: a project string written over the
// projects list made the identity snippet throw, and the owner was treated as a new user.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-reflect-identity-"));

const signals = {
    traits: [],
    identity_updates: [
        { field: "projects", value: "Midnight Library", explicit: true },
        { field: "preferences", value: "dark mode", explicit: true },
        { field: "location", value: "Pune", explicit: true },
    ],
    emotions: [],
    episodes: [],
    dominant_tone: "neutral",
};
const llm = {
    chat: vi.fn(async ({ systemPrompt }: { systemPrompt?: string }) => ({
        choices: [
            {
                message: {
                    content: systemPrompt?.includes("summarizer")
                        ? JSON.stringify({ summary: "Owner talked about Midnight Library.", highlights: [], lasting: false })
                        : JSON.stringify(signals),
                },
            },
        ],
    })),
};

it("reflection adds a stated project to the list and refuses unknown identity fields", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sqlite = await import("../sqlite.js");
    const identity = await import("../identity.js");
    identity.initIdentityDB(await sqlite.initMemoryDB());
    identity.updateIdentityProfile({ projects: ["Bhai"], preferences: { detail_level: "brief" } });
    const { runReflection } = await import("../reflection.js");

    await runReflection(
        llm as never,
        [
            { role: "user", content: "I'm working on Midnight Library now, and I moved to Pune last month" },
            { role: "assistant", content: "Nice, good luck with Midnight Library and the move." },
        ] as never,
        "s1",
        "",
    );

    const p = identity.getIdentityProfile();
    expect(p.projects).toEqual(["Bhai", "Midnight Library"]);
    expect(p.preferences).toEqual({ detail_level: "brief" });
    expect(identity.getFieldValue(p.location)).toBe("Pune");
    expect(identity.getIdentityPromptSnippet()).toContain("Midnight Library");

    // A profile an older reflection already wrote a string into reads back as a list.
    sqlite
        .getRawDb()
        ?.prepare("UPDATE user_profiles SET profile_json = ? WHERE user_id = 'default'")
        .run(JSON.stringify({ user_id: "default", projects: "Midnight Library" }));
    expect(identity.getIdentityProfile().projects).toEqual(["Midnight Library"]);
    expect(() => identity.getIdentityPromptSnippet()).not.toThrow();
});
