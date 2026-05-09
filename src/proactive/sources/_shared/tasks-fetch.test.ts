// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../tools/google-api.js", () => ({
    listGoogleTasksRaw: vi.fn(async () => [
        {
            id: "task1",
            title: "[!] Finish report",
            due: "2026-05-09T00:00:00Z",
            status: "needsAction",
        },
        {
            id: "task2",
            title: "[?] Maybe read docs",
            due: undefined,
            status: "needsAction",
        },
        {
            id: "task3",
            title: "Normal task",
            due: "2026-05-08T00:00:00Z",
            status: "needsAction",
        },
    ]),
}));

import { fetchTasksToday, _resetTasksCache } from "./tasks-fetch.js";
import { listGoogleTasksRaw } from "../../../tools/google-api.js";

describe("tasks-fetch", () => {
    beforeEach(() => {
        _resetTasksCache();
        vi.mocked(listGoogleTasksRaw).mockClear();
    });

    it("returns tasks with correct Rust-shaped fields", async () => {
        const tasks = await fetchTasksToday();
        expect(tasks).toHaveLength(3);
        expect(tasks[0].id).toBe("task1");
        expect(tasks[0].title).toBe("[!] Finish report");
        expect(tasks[0].completed).toBe(false);
        expect(typeof tasks[0].dueMs).toBe("number");
    });

    it("parses [!] prefix as high priority", async () => {
        const tasks = await fetchTasksToday();
        expect(tasks[0].priority).toBe("high");
    });

    it("parses [?] prefix as low priority", async () => {
        const tasks = await fetchTasksToday();
        expect(tasks[1].priority).toBe("low");
    });

    it("defaults plain titles to normal priority", async () => {
        const tasks = await fetchTasksToday();
        expect(tasks[2].priority).toBe("normal");
    });

    it("parses ! prefix (without brackets) as high priority", async () => {
        vi.mocked(listGoogleTasksRaw).mockResolvedValueOnce([
            { id: "x", title: "! urgent thing", due: undefined, status: "needsAction" },
        ]);
        const tasks = await fetchTasksToday();
        expect(tasks[0].priority).toBe("high");
    });

    it("dueMs is undefined when due is absent", async () => {
        const tasks = await fetchTasksToday();
        expect(tasks[1].dueMs).toBeUndefined();
    });

    it("caches within TTL — only one API call", async () => {
        await fetchTasksToday();
        await fetchTasksToday();
        expect(listGoogleTasksRaw).toHaveBeenCalledTimes(1);
    });

    it("graceful-empty when API returns nothing", async () => {
        vi.mocked(listGoogleTasksRaw).mockResolvedValueOnce([]);
        const tasks = await fetchTasksToday();
        expect(tasks).toHaveLength(0);
    });
});
