// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { shellExecBackground, shellKillProcess } from "../shell-monitor.js";

describe("shell_kill_process", () => {
    it("kills a tracked process by its OS pid", async () => {
        const started = JSON.parse(String(await shellExecBackground.handler({ command: "sleep 30" })));
        expect(started.success).toBe(true);
        const killed = JSON.parse(String(await shellKillProcess.handler({ process_id: started.pid })));
        expect(killed).toMatchObject({ success: true, process_id: started.process_id });
    });

    it("never kills a pid it did not start", async () => {
        const res = JSON.parse(String(await shellKillProcess.handler({ process_id: String(process.pid) })));
        expect(res.error).toMatch(/not found/);
    });
});
