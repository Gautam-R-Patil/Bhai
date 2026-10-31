// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe as suite, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, doneToday } from "../activity.js";

suite("dashboard activity", () => {
    it("words outcomes and skips looking around", () => {
        expect(describe({ tool: "set_reminder", success: true, args: { description: "Check the oven" } })).toBe("Set a reminder: Check the oven");
        expect(describe({ tool: "spotify", success: true, args: { action: "play", query: "Shape of You" } })).toBe("Played Shape of You on Spotify");
        expect(describe({ tool: "spotify", success: true, args: { action: "pause" } })).toBeNull();
        expect(describe({ tool: "os_screenshot", success: true, args: {} })).toBeNull();
        expect(describe({ tool: "web_search", success: true, args: { query: "x" } })).toBeNull();
        expect(describe({ tool: "set_reminder", success: false, args: { description: "x" } })).toBeNull();
        expect(describe({ tool: "write", success: true, args: { file_path: "/Users/a/notes/plan.md" } })).toBe("Saved plan.md");
    });

    it("lists today's, newest first, without repeats", () => {
        const now = new Date(2026, 9, 30, 12, 0);
        const at = (h, m) => new Date(2026, 9, now.getDate(), h, m).toISOString();
        const lines = [
            { ts: new Date(2026, 9, 29, 23, 0).toISOString(), tool: "set_volume", success: true, args: {} },
            { ts: at(9, 0), tool: "set_reminder", success: true, args: { description: "Stretch" } },
            { ts: at(9, 5), tool: "os_click_id", success: true, args: { id: 4 } },
            { ts: at(9, 10), tool: "set_volume", success: true, args: {} },
            { ts: at(9, 11), tool: "set_volume", success: true, args: {} },
        ];
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "act-")), "audit.jsonl");
        fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
        expect(doneToday(file, now).map((d) => d.text)).toEqual(["Changed the volume", "Set a reminder: Stretch"]);
        expect(doneToday(path.join(os.tmpdir(), "missing-audit.jsonl"), now)).toEqual([]);
    });
});
