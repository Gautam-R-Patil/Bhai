// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, listProjects, loadProject } from "../project.js";

const TEST_DATA_DIR = join(tmpdir(), `atlas-video-test-${process.pid}`);
process.env.ATLAS_DATA_DIR = TEST_DATA_DIR;

let sampleInputA: string;
let sampleInputB: string;

beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    sampleInputA = join(TEST_DATA_DIR, "clip_a.mp4");
    sampleInputB = join(TEST_DATA_DIR, "clip_b.mp4");
    writeFileSync(sampleInputA, "fake-mp4-content-a");
    writeFileSync(sampleInputB, "fake-mp4-content-b");
});

afterEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.env.ATLAS_DATA_DIR = TEST_DATA_DIR;
});

describe("createProject", () => {
    it("returns a Project with well-formed fields", async () => {
        const project = await createProject([sampleInputA]);
        expect(project.id).toMatch(/^vid_\d{4}_\d{2}_\d{2}_\d{2}$/);
        expect(project.inputs).toHaveLength(1);
        expect(project.rootDir).toContain("video-projects");
        expect(project.timelinePath).toMatch(/timeline\.json$/);
        expect(project.planPath).toMatch(/edit_plan\.json$/);
        expect(project.rendersDir).toMatch(/renders$/);
    });

    it("copies input files into the inputs/ subdirectory", async () => {
        const project = await createProject([sampleInputA, sampleInputB]);
        const inputsDir = join(project.rootDir, "inputs");
        expect(existsSync(inputsDir)).toBe(true);
        expect(existsSync(join(inputsDir, "clip_a.mp4"))).toBe(true);
        expect(existsSync(join(inputsDir, "clip_b.mp4"))).toBe(true);
    });

    it("writes project.json with metadata", async () => {
        const project = await createProject([sampleInputA]);
        const metaPath = join(project.rootDir, "project.json");
        expect(existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        expect(meta.id).toBe(project.id);
        expect(meta.createdAt).toBeTruthy();
        expect(Array.isArray(meta.inputs)).toBe(true);
        expect(Array.isArray(meta.hashes)).toBe(true);
        expect(meta.hashes).toHaveLength(1);
    });

    it("creates all required subdirectories", async () => {
        const project = await createProject([sampleInputA]);
        expect(existsSync(join(project.rootDir, "inputs"))).toBe(true);
        expect(existsSync(join(project.rootDir, "cache"))).toBe(true);
        expect(existsSync(project.rendersDir)).toBe(true);
    });

    it("auto-increments the NN suffix on same-day ID collision", async () => {
        const p1 = await createProject([sampleInputA]);
        const p2 = await createProject([sampleInputB]);
        expect(p1.id).not.toBe(p2.id);
        const prefix = p1.id.slice(0, "vid_2026_04_18".length);
        expect(p2.id.startsWith(prefix)).toBe(true);
        const n1 = parseInt(p1.id.slice(-2), 10);
        const n2 = parseInt(p2.id.slice(-2), 10);
        expect(n2).toBe(n1 + 1);
    });
});

describe("loadProject", () => {
    it("create then load roundtrip returns identical id and inputs", async () => {
        const original = await createProject([sampleInputA]);
        const loaded = await loadProject(original.id);
        expect(loaded.id).toBe(original.id);
        expect(loaded.rootDir).toBe(original.rootDir);
        expect(loaded.timelinePath).toBe(original.timelinePath);
        expect(loaded.planPath).toBe(original.planPath);
        expect(loaded.rendersDir).toBe(original.rendersDir);
    });

    it("throws if project id does not exist", async () => {
        await expect(loadProject("vid_2026_01_01_99")).rejects.toThrow();
    });
});

describe("listProjects", () => {
    it("returns an empty array when no projects exist", async () => {
        const list = await listProjects();
        expect(Array.isArray(list)).toBe(true);
        expect(list).toHaveLength(0);
    });

    it("returns projects with newest first ordering", async () => {
        const p1 = await createProject([sampleInputA]);
        await new Promise((r) => setTimeout(r, 10));
        const p2 = await createProject([sampleInputB]);
        const list = await listProjects();
        expect(list[0].id).toBe(p2.id);
        expect(list[1].id).toBe(p1.id);
    });
});
