// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A memory forgotten in the app's Memory screen (another process) leaves the bot's
// caches on the bot's next turn, not 10 minutes later.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-forget-sync-"));

const clearResponseCache = vi.fn();
vi.mock("../../llm-cache.js", () => ({ clearCache: clearResponseCache }));

it("a forget logged by another process clears this process's caches once", async () => {
    const sqlite = await import("../sqlite.js");
    const { syncForgetsFromElsewhere } = await import("../forget.js");
    await sqlite.initMemoryDB();
    const raw = sqlite.getRawDb() as NonNullable<ReturnType<typeof sqlite.getRawDb>>;

    syncForgetsFromElsewhere(); // first turn: the baseline
    syncForgetsFromElsewhere();
    expect(clearResponseCache).not.toHaveBeenCalled();

    // What the desktop's memory:studio-forget-memory writes.
    raw.prepare("INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES ('memory', '42', 'x', 'user')").run();
    syncForgetsFromElsewhere();
    expect(clearResponseCache).toHaveBeenCalledTimes(1);
    syncForgetsFromElsewhere(); // nothing new since
    expect(clearResponseCache).toHaveBeenCalledTimes(1);
});
