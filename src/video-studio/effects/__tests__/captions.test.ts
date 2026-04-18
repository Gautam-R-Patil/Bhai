// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transcript } from "../../analyze/transcribe.js";
import { generateCaptionsASS } from "../captions.js";

const SAMPLE_TRANSCRIPT: Transcript = {
    language: "en",
    segments: [
        {
            start: 0,
            end: 2,
            text: "Hello world this is Atlas",
            words: [
                { word: "Hello", start: 0.0, end: 0.4, confidence: 0.95 },
                { word: "world", start: 0.45, end: 0.9, confidence: 0.95 },
                { word: "this", start: 1.1, end: 1.35, confidence: 0.95 },
                { word: "is", start: 1.4, end: 1.55, confidence: 0.95 },
                { word: "Atlas", start: 1.6, end: 2.0, confidence: 0.95 },
            ],
        },
    ],
};

describe("generateCaptionsASS", () => {
    let outDir: string;
    beforeEach(async () => {
        outDir = await fs.mkdtemp(join(tmpdir(), "captions-test-"));
    });
    afterEach(async () => {
        await fs.rm(outDir, { recursive: true, force: true });
    });

    it("writes a file at outputPath and returns that path", async () => {
        const outPath = join(outDir, "test.ass");
        const result = await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "minimal" }, outPath);
        expect(result).toBe(outPath);
        const stat = await fs.stat(outPath);
        expect(stat.size).toBeGreaterThan(0);
    });

    it("ASS header contains required sections", async () => {
        const outPath = join(outDir, "header.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "minimal" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        expect(content).toContain("[Script Info]");
        expect(content).toContain("ScriptType: v4.00+");
        expect(content).toContain("[V4+ Styles]");
        expect(content).toContain("[Events]");
    });

    it("karaoke tags map word duration to centiseconds", async () => {
        const outPath = join(outDir, "karaoke.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "reel_karaoke" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        expect(content).toContain("{\\k40}");
        expect(content).toContain("{\\k45}");
    });

    it("reel_karaoke uses large bold font (size >= 60)", async () => {
        const outPath = join(outDir, "reel.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "reel_karaoke" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        const styleMatch = content.match(/Style: Atlas,.+?,(\d+),/);
        expect(styleMatch).not.toBeNull();
        expect(Number.parseInt(styleMatch?.[1] ?? "0", 10)).toBeGreaterThanOrEqual(60);
    });

    it("minimal uses small bottom-aligned font (size <= 36)", async () => {
        const outPath = join(outDir, "minimal.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "minimal" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        const styleMatch = content.match(/Style: Atlas,.+?,(\d+),/);
        expect(Number.parseInt(styleMatch?.[1] ?? "99", 10)).toBeLessThanOrEqual(36);
    });

    it("bold style uses Impact or Arial Black", async () => {
        const outPath = join(outDir, "bold.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "bold" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        expect(content).toMatch(/Style: Atlas,(Impact|Arial Black)/);
    });

    it("respects custom highlightColor (ASS BGR hex)", async () => {
        const outPath = join(outDir, "color.ass");
        await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "reel_karaoke", highlightColor: "#FF0000" }, outPath);
        const content = await fs.readFile(outPath, "utf-8");
        expect(content).toContain("&H000000FF&");
    });
});
