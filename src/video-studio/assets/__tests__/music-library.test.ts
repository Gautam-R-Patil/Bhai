// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicEntry } from "../music-library.js";
import { downloadMusic, searchMusic } from "../music-library.js";

const TEST_DATA_DIR = join(tmpdir(), `atlas-music-test-${process.pid}`);
process.env.ATLAS_DATA_DIR = TEST_DATA_DIR;

let destDir: string;

beforeAll(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
});

afterAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
    destDir = await fs.mkdtemp(join(TEST_DATA_DIR, "dest-"));
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(destDir, { recursive: true, force: true });
});

describe("searchMusic", () => {
    it("returns all entries when query is empty", async () => {
        const result = await searchMusic({});
        expect(result.length).toBeGreaterThanOrEqual(10);
    });

    it("filters by mood (substring, case-insensitive)", async () => {
        const result = await searchMusic({ mood: "UPBEAT" });
        expect(result.length).toBeGreaterThan(0);
        for (const e of result) {
            expect(e.mood.some((m) => m.toLowerCase().includes("upbeat"))).toBe(true);
        }
    });

    it("filters by bpm within ±10 tolerance", async () => {
        const result = await searchMusic({ bpm: 120 });
        expect(result.length).toBeGreaterThan(0);
        for (const e of result) {
            expect(Math.abs(e.bpm - 120)).toBeLessThanOrEqual(10);
        }
    });

    it("filters by minimum duration", async () => {
        const result = await searchMusic({ duration: 150 });
        for (const e of result) {
            expect(e.durationSec).toBeGreaterThanOrEqual(150);
        }
    });

    it("combines filters with AND logic", async () => {
        const result = await searchMusic({ mood: "chill", bpm: 85 });
        for (const e of result) {
            expect(e.mood.some((m) => m.toLowerCase().includes("chill"))).toBe(true);
            expect(Math.abs(e.bpm - 85)).toBeLessThanOrEqual(10);
        }
    });
});

describe("downloadMusic", () => {
    function makeEntry(): MusicEntry {
        return {
            title: "Test",
            artist: "Test",
            url: `https://example.com/fake-${process.pid}-${Date.now()}-${Math.random()}.mp3`,
            license: "CC0",
            mood: ["test"],
            bpm: 100,
            durationSec: 60,
        };
    }

    it("downloads and writes the file to destDir", async () => {
        const entry = makeEntry();
        const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                statusText: "OK",
                arrayBuffer: async () => fakeBytes.buffer,
            })),
        );

        const outPath = await downloadMusic(entry, destDir);
        expect(outPath).toContain(destDir);
        const content = await fs.readFile(outPath);
        expect(content.length).toBe(5);
    });

    it("second call returns cached bytes without refetching", async () => {
        const entry = makeEntry();
        const fakeBytes = new Uint8Array([10, 20, 30]);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            arrayBuffer: async () => fakeBytes.buffer,
        }));
        vi.stubGlobal("fetch", fetchMock);

        const first = await downloadMusic(entry, destDir);
        const second = await downloadMusic(entry, destDir);

        expect(first).toBe(second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws 'offline' error on network failure", async () => {
        const entry = makeEntry();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("fetch failed");
            }),
        );

        await expect(downloadMusic(entry, destDir)).rejects.toThrow(/offline or network error/);
    });

    it("throws HTTP error on 4xx response", async () => {
        const entry = makeEntry();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: false,
                status: 404,
                statusText: "Not Found",
                arrayBuffer: async () => new ArrayBuffer(0),
            })),
        );

        await expect(downloadMusic(entry, destDir)).rejects.toThrow(/HTTP error 404/);
    });
});
