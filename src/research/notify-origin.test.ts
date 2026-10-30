// © 2024-2026 XAGI Labs Private Limited
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createNotify, setDeepResearchNotifier, setOverlayResearchProgress } from "./index.js";
import { registerChannelSender } from "../tools/channel-send.js";

const telegram = { channel: "telegram", userId: "1", isOwner: true } as never;
const overlay = { channel: "overlay", userId: "local", isOwner: true } as never;

describe("research notifications follow where research was asked", () => {
    it("progress shows on the computer only, never as a chat message", async () => {
        const channels = vi.fn(async () => {});
        const tg = vi.fn(async () => true);
        const bar = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        setOverlayResearchProgress(bar);
        registerChannelSender("telegram", tg);
        await createNotify(telegram)("Phase 1 round 4/8");
        expect(bar).toHaveBeenCalledWith("Phase 1 round 4/8");
        expect(tg).not.toHaveBeenCalled();
        expect(channels).not.toHaveBeenCalled();
    });

    it("an important notice goes to the channel it was asked on, not every channel", async () => {
        const channels = vi.fn(async () => {});
        const tg = vi.fn(async () => true);
        setDeepResearchNotifier(channels);
        setOverlayResearchProgress(vi.fn(async () => {}));
        registerChannelSender("telegram", tg);
        await createNotify(telegram)("❌ failed", true);
        expect(tg).toHaveBeenCalledWith("❌ failed", undefined);
        expect(channels).not.toHaveBeenCalled();
    });

    it("when that channel can't take it, every channel does, so it isn't lost", async () => {
        const channels = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        registerChannelSender("telegram", vi.fn(async () => false));
        await createNotify(telegram)("❌ failed", true);
        expect(channels).toHaveBeenCalledWith("❌ failed");
    });

    it("asked on the computer: an important notice goes to the computer", async () => {
        const channels = vi.fn(async () => {});
        const bar = vi.fn(async () => true);
        setDeepResearchNotifier(channels);
        registerChannelSender("overlay", bar);
        await createNotify(overlay)("❌ failed", true);
        expect(bar).toHaveBeenCalledWith("❌ failed", undefined);
        expect(channels).not.toHaveBeenCalled();
    });
});

describe("boot recovery", () => {
    it("a running research whose process is gone is interrupted, however recent", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-recover-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const now = new Date().toISOString();
        const entry = (id: string, pid?: number) => ({ id, topic: id, profile: "quick", status: "running", startedAt: now, updatedAt: now, sourcesProcessed: 0, findingsCount: 0, pid });
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [entry("research_1_1", 2 ** 22 + 12345), entry("research_2_2", process.ppid), entry("research_3_3")],
        }));
        const { recoverInterruptedResearches } = await import("./persistence.js");
        const { interrupted } = await recoverInterruptedResearches();
        // Dead pid: cut off. Live pid (another process still running it) and no pid with a fresh update: left alone.
        expect(interrupted.map((e) => e.id)).toEqual(["research_1_1"]);
        vi.unstubAllEnvs();
    });
});

describe("auto-resume after a restart", () => {
    it("counts the try before running it and stops after two", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-resume-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const id = "research_7_7";
        const now = new Date().toISOString();
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [{ id, topic: "t", profile: "quick", status: "running", startedAt: now, updatedAt: now, sourcesProcessed: 0, findingsCount: 0, pid: 2 ** 22 + 54321 }],
        }));
        const p = await import("./persistence.js");
        await p.saveResearchState({
            research: { id, topic: "t", profile: "quick", status: "running", depth: 1, maxSources: 5, sourcesProcessed: 0, roundsCompleted: 0, findingsCount: 0, currentPhase: 2, startedAt: now, updatedAt: now, report: "", reportFile: "", autoResumes: 2 },
            allFindings: [], allSources: [], visitedUrls: [], usedQueries: [], pendingQueries: [], rounds: [], currentRound: 0,
        });
        const r = await import("./index.js");
        await r.initDeepResearch();
        await r.resumeInterruptedResearch();
        // Already tried twice: left interrupted, not restarted.
        expect((await p.loadResearchState(id))?.research.autoResumes).toBe(2);
        expect((await p.getIndexEntry(id))?.status).toBe("interrupted");
        vi.unstubAllEnvs();
    });
});
