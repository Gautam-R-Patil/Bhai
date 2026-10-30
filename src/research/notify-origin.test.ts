// © 2024-2026 XAGI Labs Private Limited
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createNotify, setDeepResearchNotifier, setOverlayResearchProgress } from "./index.js";
import { registerChannelSender } from "../tools/channel-send.js";

const dnd = vi.hoisted(() => ({ on: false }));
vi.mock("../proactive/dnd.js", () => ({ shouldSuppressMessage: async () => dnd.on }));

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
        expect(tg).toHaveBeenCalledWith("❌ failed", undefined, undefined, undefined, "1");
        expect(channels).not.toHaveBeenCalled();
    });

    it("when that channel can't take it, every channel does, so it isn't lost", async () => {
        const channels = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        registerChannelSender("telegram", vi.fn(async () => false));
        await createNotify(telegram)("❌ failed", true);
        expect(channels).toHaveBeenCalledWith("❌ failed");
    });

    it("held by Do Not Disturb on its channel: not sent to every other channel instead", async () => {
        const channels = vi.fn(async () => {});
        setDeepResearchNotifier(channels);
        registerChannelSender("telegram", vi.fn(async () => false));
        dnd.on = true;
        await createNotify(telegram)("❌ failed", true);
        dnd.on = false;
        expect(channels).not.toHaveBeenCalled();
    });

    it("asked from no chat (voice, a sub-agent): goes to the computer and the primary channel, not every channel", async () => {
        const channels = vi.fn(async () => {});
        const bar = vi.fn(async () => true);
        const tg = vi.fn(async () => true);
        setDeepResearchNotifier(channels);
        registerChannelSender("overlay", bar);
        registerChannelSender("telegram", tg);
        await createNotify(undefined)("❌ failed", true);
        expect(bar).toHaveBeenCalledWith("❌ failed", undefined);
        // A sub-agent's research was often asked on a chat: the owner may be waiting there.
        expect(tg).toHaveBeenCalledWith("❌ failed", undefined);
        expect(channels).not.toHaveBeenCalled();
    });

    it("asked on the computer: an important notice goes to the computer", async () => {
        const channels = vi.fn(async () => {});
        const bar = vi.fn(async () => true);
        setDeepResearchNotifier(channels);
        registerChannelSender("overlay", bar);
        await createNotify(overlay)("❌ failed", true);
        expect(bar).toHaveBeenCalledWith("❌ failed", undefined, undefined, undefined, "local");
        expect(channels).not.toHaveBeenCalled();
    });

    it("asked in an owner's Discord DM: the sender is told which owner, so it reaches that DM", async () => {
        const dc = vi.fn(async () => true);
        registerChannelSender("discord", dc);
        await createNotify({ channel: "discord", userId: "B", isOwner: true } as never)("❌ failed", true);
        expect(dc).toHaveBeenCalledWith("❌ failed", undefined, undefined, undefined, "B");
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

    it("a running research last updated before the machine booted is interrupted, even if its pid is reused", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-reboot-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const os = (await import("node:os")).default;
        const uptime = vi.spyOn(os, "uptime").mockReturnValue(60); // booted a minute ago
        const before = new Date(Date.now() - 120_000).toISOString();
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [{ id: "research_4_4", topic: "t", profile: "quick", status: "running", startedAt: before, updatedAt: before, sourcesProcessed: 0, findingsCount: 0, pid: process.ppid }],
        }));
        const { recoverInterruptedResearches } = await import("./persistence.js");
        expect((await recoverInterruptedResearches()).interrupted.map((e) => e.id)).toEqual(["research_4_4"]);
        uptime.mockRestore();
        vi.unstubAllEnvs();
    });

    it("prunes old failed checkpoints and ones the index no longer lists", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-prune-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const now = new Date().toISOString();
        const entry = (id: string, updatedAt: string) => ({ id, topic: id, profile: "quick", status: "failed", startedAt: updatedAt, updatedAt, sourcesProcessed: 0, findingsCount: 0 });
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({ version: 1, researches: [entry("research_1_1", old), entry("research_2_2", now)] }));
        const p = await import("./persistence.js");
        for (const id of ["research_1_1", "research_2_2", "research_3_3", "research_4_4"]) {
            await p.saveResearchState({
                research: { id, topic: "t", profile: "quick", status: "failed", depth: 1, maxSources: 5, sourcesProcessed: 0, roundsCompleted: 0, findingsCount: 0, currentPhase: 1, startedAt: now, updatedAt: now, report: "", reportFile: "" },
                allFindings: [], allSources: [], visitedUrls: [], usedQueries: [], pendingQueries: [], rounds: [], currentRound: 0,
            });
        }
        const monthAgo = new Date(old);
        utimesSync(join(dir, "research", "research_3_3.state.json"), monthAgo, monthAgo);
        await p.pruneFinishedStates();
        // Recent failure kept for resume_id; month-old failure and the month-old unlisted one gone; a fresh unlisted one kept.
        expect(readdirSync(join(dir, "research")).sort()).toEqual(["research_2_2.state.json", "research_4_4.state.json"]);
        vi.unstubAllEnvs();
    });

    it("a lost or unreadable index deletes no checkpoints", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-prune-corrupt-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const now = new Date().toISOString();
        const p = await import("./persistence.js");
        await p.saveResearchState({
            research: { id: "research_5_5", topic: "t", profile: "quick", status: "completed", depth: 1, maxSources: 5, sourcesProcessed: 0, roundsCompleted: 0, findingsCount: 0, currentPhase: 3, startedAt: now, updatedAt: now, report: "", reportFile: "" },
            allFindings: [], allSources: [], visitedUrls: [], usedQueries: [], pendingQueries: [], rounds: [], currentRound: 0,
        });
        const old = new Date(Date.now() - 30 * 86_400_000);
        utimesSync(join(dir, "research", "research_5_5.state.json"), old, old);
        writeFileSync(join(dir, "research-index.json"), "{ truncated");
        await p.pruneFinishedStates();
        expect(readdirSync(join(dir, "research"))).toEqual(["research_5_5.state.json"]);
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

    it("re-sends the answer of a research that finished just before the restart", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-undelivered-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const now = new Date().toISOString();
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [{ id: "research_8_8", topic: "t", profile: "quick", status: "completed", startedAt: now, updatedAt: now, sourcesProcessed: 3, findingsCount: 3, reportFile: "/r.md", delivered: false }],
        }));
        const r = await import("./index.js");
        const card = vi.fn(async () => true);
        r.setOverlayResearchResult(card);
        await r.initDeepResearch();
        await r.resumeInterruptedResearch();
        expect(card).toHaveBeenCalledWith(expect.stringContaining("/r.md"), "research_8_8", "/r.md");
        expect((await (await import("./persistence.js")).getIndexEntry("research_8_8"))?.delivered).toBe(true);
        vi.unstubAllEnvs();
    });

    it("at boot, waits for the computer to connect instead of marking an unsent answer delivered", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-resend-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const id = "research_10_10";
        const now = new Date().toISOString();
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [{ id, topic: "t", profile: "quick", status: "completed", startedAt: now, updatedAt: now, sourcesProcessed: 3, findingsCount: 3, reportFile: "/r.md", delivered: false }],
        }));
        const p = await import("./persistence.js");
        await p.saveResearchState({
            research: { id, topic: "t", profile: "quick", status: "completed", depth: 1, maxSources: 5, sourcesProcessed: 3, roundsCompleted: 1, findingsCount: 3, currentPhase: 3, startedAt: now, updatedAt: now, report: "", reportFile: "/r.md", origin: { channel: "overlay", userId: "local", isOwner: true } },
            allFindings: [], allSources: [], visitedUrls: [], usedQueries: [], pendingQueries: [], rounds: [], currentRound: 0,
        });
        const r = await import("./index.js");
        const channels = vi.fn(async () => {});
        r.setDeepResearchNotifier(channels);
        // No window yet at the first try; it connects before the next.
        const card = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
        r.setOverlayResearchResult(card);
        await r.initDeepResearch();
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        let done = false;
        const resending = r.resumeInterruptedResearch().then(() => { done = true; });
        while (!done) await vi.advanceTimersByTimeAsync(1_000);
        await resending;
        vi.useRealTimers();
        expect(card).toHaveBeenCalledTimes(2);
        expect(channels).not.toHaveBeenCalled();
        expect((await p.getIndexEntry(id))?.delivered).toBe(true);
        vi.unstubAllEnvs();
    });

    it("won't resume a cancelled research (its old run may still be finishing)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "research-cancelled-"));
        vi.stubEnv("ATLAS_DATA_DIR", dir);
        vi.resetModules();
        const id = "research_9_9";
        const now = new Date().toISOString();
        writeFileSync(join(dir, "research-index.json"), JSON.stringify({
            version: 1,
            researches: [{ id, topic: "t", profile: "quick", status: "cancelled", startedAt: now, updatedAt: now, sourcesProcessed: 0, findingsCount: 0 }],
        }));
        const p = await import("./persistence.js");
        await p.saveResearchState({
            research: { id, topic: "t", profile: "quick", status: "cancelled", depth: 1, maxSources: 5, sourcesProcessed: 0, roundsCompleted: 0, findingsCount: 0, currentPhase: 1, startedAt: now, updatedAt: now, report: "", reportFile: "" },
            allFindings: [], allSources: [], visitedUrls: [], usedQueries: [], pendingQueries: [], rounds: [], currentRound: 0,
        });
        const r = await import("./index.js");
        r.setDeepResearchLLM({} as never);
        expect(JSON.parse(await r.deepResearch.handler({ resume_id: id })).error).toMatch(/cancelled/);
        vi.unstubAllEnvs();
    });
});
