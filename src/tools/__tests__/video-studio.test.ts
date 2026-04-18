// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    videoAnalyze,
    videoCreateProject,
    videoFfmpeg,
    videoListProjects,
    videoPatchPlan,
    videoPlanEdit,
    videoRender,
} from "../video-studio.js";

const TEST_DATA_DIR = join(tmpdir(), `atlas-video-tools-test-${process.pid}`);
process.env.ATLAS_DATA_DIR = TEST_DATA_DIR;

beforeAll(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
});

afterAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("video-studio tool schemas", () => {
    const tools = [
        videoCreateProject,
        videoAnalyze,
        videoPlanEdit,
        videoRender,
        videoPatchPlan,
        videoFfmpeg,
        videoListProjects,
    ];
    it.each(tools)("each tool has function-type schema with video_ name", (tool) => {
        expect(tool.schema.type).toBe("function");
        expect(tool.schema.function.name).toMatch(/^video_/);
    });
});

describe("videoPlanEdit handler (must run before LLM client is injected)", () => {
    it("returns error when LLM client not initialized", async () => {
        const out = await videoPlanEdit.handler({
            projectId: "vid_test_00",
            userIntent: "ignored",
        });
        const parsed = JSON.parse(out);
        expect(parsed).toHaveProperty("error");
    });
});

describe("videoCreateProject handler", () => {
    it("returns error on missing inputs", async () => {
        const out = await videoCreateProject.handler({});
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("returns error when inputs is not an array", async () => {
        const out = await videoCreateProject.handler({ inputs: "not-an-array" });
        expect(JSON.parse(out)).toHaveProperty("error");
    });
});

describe("videoListProjects handler", () => {
    it("returns success with empty array when no projects", async () => {
        const out = await videoListProjects.handler({});
        const parsed = JSON.parse(out);
        expect(parsed.success).toBe(true);
        expect(Array.isArray(parsed.projects)).toBe(true);
    });
});

describe("videoFfmpeg safety gate", () => {
    it("rejects http:// URLs", async () => {
        const out = await videoFfmpeg.handler({
            args: ["-i", "http://evil.com/x.mp4", "out.mp4"],
        });
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(JSON.parse(out).error).toMatch(/unsafe/i);
    });

    it("rejects https:// URLs", async () => {
        const out = await videoFfmpeg.handler({
            args: ["-i", "https://example.com/x.mp4", "out.mp4"],
        });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects path traversal with ..", async () => {
        const out = await videoFfmpeg.handler({
            args: ["-i", "/tmp/../etc/passwd", "out.mp4"],
        });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects absolute path outside allowlist", async () => {
        const out = await videoFfmpeg.handler({
            args: ["-i", "/etc/passwd", "out.mp4"],
        });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("runs ffmpeg -version (no -i) to confirm safety gate doesn't false-positive", async () => {
        const out = await videoFfmpeg.handler({ args: ["-version"] });
        const parsed = JSON.parse(out);
        if (parsed.error) {
            expect(parsed.error).not.toMatch(/unsafe/i);
        } else {
            expect(parsed.success).toBe(true);
        }
    }, 15_000);

    it("accepts path inside /tmp/ (gate passes; ffmpeg may still fail)", async () => {
        const out = await videoFfmpeg.handler({
            args: ["-i", "/tmp/nonexistent.mp4", "-f", "null", "-"],
        });
        const parsed = JSON.parse(out);
        if (parsed.error) expect(parsed.error).not.toMatch(/unsafe/i);
    }, 15_000);

    it("accepts path inside data/video-projects/ (gate passes)", async () => {
        const insideAllowlist = join(TEST_DATA_DIR, "video-projects", "nonexistent.mp4");
        const out = await videoFfmpeg.handler({
            args: ["-i", insideAllowlist, "-f", "null", "-"],
        });
        const parsed = JSON.parse(out);
        if (parsed.error) expect(parsed.error).not.toMatch(/unsafe/i);
    }, 15_000);

    it("rejects uppercase HTTP:// scheme", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "HTTP://evil.com/x.mp4", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(JSON.parse(out).error).toMatch(/unsafe/i);
    });

    it("rejects mixed-case HttPs:// scheme", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "HttPs://example.com/x.mp4", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects file:// scheme", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "file:///etc/passwd", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects rtmp:// scheme", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "rtmp://attacker/stream", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects concat: pseudo-scheme", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "concat:/tmp/a.mp4|/tmp/b.mp4", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("rejects relative input path", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "foo.mp4", "/tmp/out.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(JSON.parse(out).error).toMatch(/relative/i);
    });

    it("rejects output path outside allowlist", async () => {
        const out = await videoFfmpeg.handler({ args: ["-i", "/tmp/x.mp4", "/etc/bad.mp4"] });
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(JSON.parse(out).error).toMatch(/output/i);
    });
});

describe("videoPatchPlan handler", () => {
    it("returns error when project doesn't exist", async () => {
        const out = await videoPatchPlan.handler({
            projectId: "vid_missing_99",
            patch: [],
        });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("returns error when patch is not an array", async () => {
        const out = await videoPatchPlan.handler({
            projectId: "vid_missing_99",
            patch: "not-an-array",
        });
        expect(JSON.parse(out)).toHaveProperty("error");
    });
});

describe("videoAnalyze handler", () => {
    it("returns error for missing project", async () => {
        const out = await videoAnalyze.handler({ projectId: "vid_nonexistent_99" });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("returns error when projectId is missing", async () => {
        const out = await videoAnalyze.handler({});
        expect(JSON.parse(out)).toHaveProperty("error");
    });
});

describe("videoRender handler", () => {
    it("returns error for missing project", async () => {
        const out = await videoRender.handler({ projectId: "vid_nonexistent_99" });
        expect(JSON.parse(out)).toHaveProperty("error");
    });

    it("returns error when projectId is missing", async () => {
        const out = await videoRender.handler({});
        expect(JSON.parse(out)).toHaveProperty("error");
    });
});
