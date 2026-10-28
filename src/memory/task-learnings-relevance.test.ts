// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("task learnings recall", () => {
    it("only recalls learnings that share words with the task", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-"));
        process.env.ATLAS_DATA_DIR = dir;
        const recent = new Date().toISOString();
        fs.writeFileSync(
            path.join(dir, "task-learnings.json"),
            JSON.stringify({
                learnings: [
                    { id: "l1", category: "app", taskPattern: "read result from Calculator display", context: "Calculator", whatWorked: [], whatFailed: ["Could not read the display"], tips: [], successScore: 0, timesReinforced: 1, lastSeen: recent },
                ],
            }),
        );
        const { initTaskLearnings, recallLearnings } = await import("./task-learnings.js");
        initTaskLearnings();
        expect(recallLearnings("open my Downloads folder in Finder")).toHaveLength(0);
        expect(recallLearnings("use the calculator to add two numbers")).toHaveLength(1);
    });
});
