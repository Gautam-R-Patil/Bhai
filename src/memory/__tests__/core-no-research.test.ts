// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Core memory rides along every turn: research belongs to recall-by-topic, not there.
// Three research runs had filled 9 of its 10 slots with metro timelines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-core-"));

it("keeps research out of the core list, however important", async () => {
    const sqlite = await import("../sqlite.js");
    await sqlite.initMemoryDB();
    const raw = sqlite.getRawDb() as NonNullable<ReturnType<typeof sqlite.getRawDb>>;
    const ins = raw.prepare("INSERT INTO memories (content, category, importance) VALUES (?, ?, ?)");
    for (let i = 0; i < 12; i++) ins.run(`[Research: metro] finding ${i}`, "research", 10);
    ins.run("Owner prefers short, direct answers", "preference", 6);
    ins.run("Owner's sister is Priya", "fact", 5);

    const core = sqlite.getCoreMemory(10).map((m) => m.content);
    expect(core).toContain("Owner prefers short, direct answers");
    expect(core).toContain("Owner's sister is Priya");
    expect(core.some((c) => c.startsWith("[Research:"))).toBe(false);
});
