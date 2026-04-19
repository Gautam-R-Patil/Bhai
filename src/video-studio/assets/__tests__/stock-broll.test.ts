// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockClip } from "../stock-broll.js";
import { downloadStockClip, searchStockVideo, selectDefaultProvider } from "../stock-broll.js";

const TEST_DIR = join(tmpdir(), `atlas-stock-broll-test-${process.pid}`);

beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    delete process.env.PEXELS_API_KEY;
    vi.unstubAllGlobals();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("selectDefaultProvider", () => {
    it("returns 'internet_archive' when PEXELS_API_KEY is not set (keyless default)", () => {
        expect(selectDefaultProvider()).toBe("internet_archive");
    });

    it("returns 'pexels' when PEXELS_API_KEY is set", () => {
        process.env.PEXELS_API_KEY = "test-key";
        expect(selectDefaultProvider()).toBe("pexels");
    });
});

describe("searchStockVideo — Internet Archive (keyless default)", () => {
    function mockIASearch(identifiers: string[]): void {
        const searchResp = {
            ok: true,
            status: 200,
            json: async () => ({
                response: { docs: identifiers.map((id) => ({ identifier: id, title: `title-${id}` })) },
            }),
        };
        const metaResp = (id: string) => ({
            ok: true,
            status: 200,
            json: async () => ({
                files: [
                    { name: "thumb.jpg", format: "JPEG" },
                    {
                        name: `${id}.mp4`,
                        format: "h.264",
                        width: "1280",
                        height: "720",
                        length: "42.5",
                    },
                ],
            }),
        });

        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("advancedsearch.php")) return searchResp;
            const match = url.match(/\/metadata\/([^/?]+)/);
            if (match) return metaResp(decodeURIComponent(match[1]));
            throw new Error(`unexpected fetch URL: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
    }

    it("parses IA search + metadata into StockClip[] when no PEXELS_API_KEY", async () => {
        mockIASearch(["AncientCoinsOfRome", "ApolloLaunch"]);
        const results = await searchStockVideo("rome");
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            durationSec: 42.5,
            height: 720,
            id: "AncientCoinsOfRome",
            provider: "internet_archive",
            width: 1280,
        });
        expect(results[0].url).toContain("archive.org/download/AncientCoinsOfRome");
        expect(results[0].thumbnailUrl).toContain("archive.org/services/img/AncientCoinsOfRome");
    });

    it("returns empty array when IA search returns no docs", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ response: { docs: [] } }),
            }),
        );
        const results = await searchStockVideo("zzz_nothing");
        expect(results).toEqual([]);
    });

    it("filters out IA entries whose metadata has no mp4 file", async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("advancedsearch.php")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        response: {
                            docs: [
                                { identifier: "audio_only", title: "Audio" },
                                { identifier: "has_video", title: "Video" },
                            ],
                        },
                    }),
                };
            }
            if (url.includes("/metadata/audio_only")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ files: [{ name: "song.mp3", format: "MP3" }] }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    files: [{ name: "clip.mp4", format: "h.264", width: "640", height: "480", length: "10" }],
                }),
            };
        });
        vi.stubGlobal("fetch", fetchMock);

        const results = await searchStockVideo("mix");
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("has_video");
    });

    it("surfaces descriptive error on IA search network failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
        await expect(searchStockVideo("ocean")).rejects.toThrow(/Internet Archive search network error/i);
    });

    it("surfaces HTTP error on IA search non-200", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
        await expect(searchStockVideo("ocean")).rejects.toThrow(/Internet Archive search HTTP error 503/i);
    });
});

describe("searchStockVideo — Pexels (when PEXELS_API_KEY is set)", () => {
    beforeEach(() => {
        process.env.PEXELS_API_KEY = "test-key-123";
    });

    it("parses Pexels API response into StockClip[]", async () => {
        const mockResponse = {
            videos: [
                {
                    id: 42,
                    duration: 15,
                    image: "https://example.com/thumb.jpg",
                    video_files: [
                        { width: 1920, height: 1080, link: "https://example.com/hd.mp4", quality: "hd" },
                        { width: 640, height: 360, link: "https://example.com/sd.mp4", quality: "sd" },
                    ],
                },
            ],
        };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockResponse }));

        const results = await searchStockVideo("ocean");
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            durationSec: 15,
            height: 1080,
            id: "42",
            provider: "pexels",
            thumbnailUrl: "https://example.com/thumb.jpg",
            width: 1920,
        });
        expect(results[0].url).toBe("https://example.com/hd.mp4");
    });

    it("returns empty array when API returns no results", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ videos: [] }) }),
        );
        const results = await searchStockVideo("zzz_nonexistent_query");
        expect(results).toEqual([]);
    });

    it("surfaces descriptive error on network failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
        await expect(searchStockVideo("ocean")).rejects.toThrow(/Pexels search network error/i);
    });

    it("surfaces auth-failed error on 401 response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
        await expect(searchStockVideo("ocean")).rejects.toThrow(/auth failed|401/i);
    });

    it("throws when explicitly forced to pexels without a key", async () => {
        delete process.env.PEXELS_API_KEY;
        await expect(searchStockVideo("ocean", { provider: "pexels" })).rejects.toThrow(/PEXELS_API_KEY is not set/i);
    });
});

describe("downloadStockClip", () => {
    function makeClip(id = "99", provider: "pexels" | "internet_archive" = "pexels"): StockClip {
        return {
            durationSec: 10,
            height: 1080,
            id,
            provider,
            thumbnailUrl: undefined,
            url: `https://example.com/clip-${id}.mp4`,
            width: 1920,
        };
    }

    it("downloads the clip and returns the file path", async () => {
        const fakeBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => fakeBytes.buffer }),
        );
        const clip = makeClip("download-1");
        const destDir = join(TEST_DIR, "dest1");
        await fs.mkdir(destDir, { recursive: true });

        const outPath = await downloadStockClip(clip, destDir);
        expect(outPath).toContain(destDir);
        expect(outPath).toMatch(/pexels-download-1\.mp4$/);
        const content = await fs.readFile(outPath);
        expect(content.length).toBe(4);
    });

    it("returns cached path on second download without refetching", async () => {
        const fakeBytes = new Uint8Array([0xaa, 0xbb]);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => fakeBytes.buffer,
        });
        vi.stubGlobal("fetch", fetchMock);

        const clip = makeClip("cache-test");
        const destDir = join(TEST_DIR, "dest2");
        await fs.mkdir(destDir, { recursive: true });

        const first = await downloadStockClip(clip, destDir);
        const second = await downloadStockClip(clip, destDir);
        expect(first).toBe(second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sanitizes IA identifiers with slashes into safe filenames", async () => {
        const fakeBytes = new Uint8Array([0x00]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => fakeBytes.buffer }),
        );
        const clip = makeClip("foo/bar.baz", "internet_archive");
        const destDir = join(TEST_DIR, "dest3");
        await fs.mkdir(destDir, { recursive: true });

        const outPath = await downloadStockClip(clip, destDir);
        expect(outPath).toMatch(/internet_archive-foo_bar\.baz\.mp4$/);
    });
});
