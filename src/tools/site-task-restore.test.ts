// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A site task parked on a question survives a bot restart (its checkpoint is on
// disk), and a restored task asks for consent again instead of reusing an old yes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "bhai-data-"));
const runSiteTask = vi.fn();
vi.mock("../config/paths.js", async (orig) => ({ ...(await orig<object>()), getDataDir: () => dataDir }));
vi.mock("./browser/core.js", () => ({ getActivePage: async () => ({ url: () => "https://shop.test/otp" }) }));
vi.mock("../skills/site/runtime.js", async (orig) => ({ ...(await orig<object>()), runSiteTask }));

describe("site_task after a restart", () => {
    it("resumes the parked task from its checkpoint", async () => {
        const { saveCheckpoint } = await import("../skills/site/runtime.js");
        const parked = { taskId: "t1", skillPath: "/s/skill.cjs", skillHash: "h", phase: "after_confirm", status: "needs_user", stepCount: 12, repeats: {}, state: {}, userPrompts: 1 };
        saveCheckpoint(path.join(dataDir, "site-tasks"), parked as never);

        vi.resetModules(); // a fresh process: no task in memory
        const { siteTask } = await import("./site-task.js");
        runSiteTask.mockResolvedValueOnce({ status: "done", summary: "Order placed #7", writeStatus: "applied", task: parked });
        const out = JSON.parse(await siteTask.handler({ action: "resume", answer: "482913" }));
        expect(out.status).toBe("done");
        expect(runSiteTask.mock.calls[0][0]).toMatchObject({ phase: "resume", answer: "482913", task: { taskId: "t1", stepCount: 12 } });
    });
});
