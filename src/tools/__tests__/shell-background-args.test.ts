// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { shellExecBackground, shellWaitProcess } from "../shell-monitor.js";

describe.skipIf(process.platform === "win32")("shell_exec_background args", () => {
    it("keeps each arg one literal: sh -c 'sleep …; echo …' runs as written", async () => {
        const started = JSON.parse(String(await shellExecBackground.handler({ command: "sh", args: ["-c", "sleep 0.2; echo build-done"] })));
        expect(started.success).toBe(true);
        const done = String(await shellWaitProcess.handler({ process_id: started.process_id, timeout_seconds: 5 }));
        expect(done).toContain("build-done");
        expect(done).not.toMatch(/usage: sleep/i);
    });
});
