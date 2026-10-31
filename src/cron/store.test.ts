// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Cron jobs live in the data dir: in the app the working directory is inside the
// bundle, which an update replaces.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("cron jobs are saved under BHAI_DATA_DIR and load back after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-"));
    process.env.BHAI_DATA_DIR = dir;
    try {
        vi.resetModules();
        const first = await import("./store.js");
        const job = await first.addJob({ prompt: "Morning brief", schedule: "every 2h", isOwner: true });
        expect(fs.existsSync(path.join(dir, "cron", "jobs.json"))).toBe(true);

        vi.resetModules();
        const second = await import("./store.js");
        await second.loadJobs();
        expect(second.getJobs().map((j) => j.id)).toEqual([job.id]);
    } finally {
        delete process.env.BHAI_DATA_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
