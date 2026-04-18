# ATLAS Video Studio — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the core Video Studio pipeline — ingest → analyze → LLM edit plan → FFmpeg render → usable mp4 output — so ATLAS can edit videos end-to-end with captions, reel crop, music, and transitions, cross-platform, with minimal paid API cost.

**Architecture:** Four-layer pipeline built around a single portable artifact, `edit_plan.json`. The LLM writes it, a deterministic renderer compiles it to one `filter_complex` FFmpeg invocation, and the same plan is later (Phase 3) exportable to DaVinci/Premiere via FCPXML. Heavy AI models are lazy-loaded via a Python sidecar (`uv`-managed venv at `data/video-studio/venv/`) — nothing loads at boot. Reuses existing ATLAS infrastructure: `src/models/local-vision.ts` for frame captions, `src/voice/transcribe.ts` for audio, `src/llm.ts` LLMClient (dependency-injected), `src/utils/json-extract.ts` for robust LLM JSON parsing, `zod` for schema validation, tool registration pattern from `src/tools/index.ts`.

**Tech Stack:** TypeScript (ESM + NodeNext resolution), Node.js ≥20, `ffmpeg-static` + `ffprobe-static` (bundled cross-platform binaries), `fluent-ffmpeg` types, `zod` for edit_plan validation, `vitest` for unit tests (newly introduced, scoped to `src/video-studio/**/*.test.ts`), Python sidecar for PySceneDetect / faster-whisper / librosa.

**Approved spec:** `/Users/user/.claude/plans/find-ways-to-improve-tidy-russell.md`.

**Tasks are grouped into 4 layers, each ending with a milestone commit (4 commits total for Phase 1):**
- **Layer A — Foundation** (Tasks 1-4): deps, vitest, ffmpeg-bin util, project lifecycle. End: `feat(video-studio): foundation — deps, project, ffmpeg resolution`
- **Layer B — Analyze** (Tasks 5-9): Python sidecar, scene detect, keyframe captions, transcript, timeline builder. End: `feat(video-studio): analyze pipeline — scenes, keyframes, transcript, timeline`
- **Layer C — Plan + Render** (Tasks 10-14): Zod schema, LLM planner, validator, FilterComplexBuilder, FFmpeg renderer. End: `feat(video-studio): plan schema + validator + ffmpeg renderer`
- **Layer D — Effects + Tools + Wiring** (Tasks 15-22): ASS captions, beat-sync, SFX, music library, 7 tools, registry + router wiring, skill rewrite, smoke test. End: `feat(video-studio): effects, tools, skill, smoke test`

**Testing:** Vitest is introduced as a dev dependency and configured to pick up only `src/video-studio/**/*.test.ts` — existing ATLAS code is not forced to have tests. Every code task follows 5-step TDD (write failing test → run and see it fail → minimal implementation → run test to see it pass → stage/commit).

**Phase 2/3 out of scope:** background removal (BiRefNet), face-tracked auto-crop, FCPXML/DaVinci/Premiere export, style-template memory, generative effects (SadTalker/AnimateDiff). Separate plans after Phase 1 lands.

---


---

## Layer A — Foundation (Tasks 1-4)

*Goal: establish dependencies, ffmpeg binary resolution, the `data/video-projects/<id>/` layout, and vitest so all subsequent layers have a working test harness.*

*Milestone commit at end of Task 4: `feat(video-studio): foundation — deps, project, ffmpeg resolution`*

---

### Task 1: Add Dependencies and Vitest

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/package.json` — add runtime deps and dev deps; add `test` and `test:watch` npm scripts
- Create: `/Users/user/Desktop/ATLAS/vitest.config.ts` — vitest configuration scoped to `src/video-studio/`

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/__tests__/deps.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";

describe("video-studio runtime dependencies", () => {
    it("ffmpeg-static resolves to a non-empty string path", async () => {
        const mod = await import("ffmpeg-static");
        const ffmpegPath = (mod as { default: string | null }).default ?? mod;
        expect(typeof ffmpegPath).toBe("string");
        expect((ffmpegPath as string).length).toBeGreaterThan(0);
    });

    it("ffprobe-static resolves to an object with ffprobePath", async () => {
        const mod = await import("ffprobe-static");
        const info = (mod as { default: { path: string } }).default ?? mod;
        expect(typeof info).toBe("object");
        expect(typeof (info as { path: string }).path).toBe("string");
        expect((info as { path: string }).path.length).toBeGreaterThan(0);
    });

    it("fluent-ffmpeg exports a callable function", async () => {
        const mod = await import("fluent-ffmpeg");
        const ffmpeg = (mod as { default: unknown }).default ?? mod;
        expect(typeof ffmpeg).toBe("function");
    });
});
```

- [ ] **Step 2 — Run the test and confirm it fails**

```bash
cd /Users/user/Desktop/ATLAS
npx vitest run src/video-studio/util/__tests__/deps.test.ts
```

Expected: Module-not-found errors for `ffmpeg-static`, `ffprobe-static`, `fluent-ffmpeg`. Vitest itself also does not exist yet — `npx vitest run` will fail. Both failures are expected and confirm the test is wired correctly.

- [ ] **Step 3 — Minimal implementation: update `package.json` and create `vitest.config.ts`**

Edit `/Users/user/Desktop/ATLAS/package.json`. Add to `"dependencies"`:

```json
"ffmpeg-static": "^5.2.0",
"ffprobe-static": "^3.1.0",
"fluent-ffmpeg": "^2.1.3"
```

Add to `"devDependencies"`:

```json
"@types/fluent-ffmpeg": "^2.1.27",
"@vitest/ui": "^3.2.0",
"vitest": "^3.2.0"
```

Add to `"scripts"` (alongside the existing entries):

```json
"test": "vitest run",
"test:watch": "vitest"
```

The final `scripts` block in `package.json` becomes:

```json
"scripts": {
    "predev": "npm run build:location 2>/dev/null || true",
    "dev": "tsx --watch src/index.ts",
    "build": "node node_modules/typescript/bin/tsc",
    "postbuild": "node -e \"const fs=require('fs');fs.mkdirSync('dist/overlay',{recursive:true});fs.copyFileSync('src/overlay/overlay.html','dist/overlay/overlay.html')\"",
    "start": "node dist/index.js",
    "build:native": "cd native && npm install && npm run build",
    "build:ocr": "swiftc -O scripts/ocr_screen.swift -o scripts/ocr_screen_bin 2>/dev/null || echo 'Swift OCR compilation skipped (non-macOS or no Swift)'",
    "build:location": "swiftc -O scripts/get_location.swift -o scripts/get_location_bin -framework CoreLocation -framework Foundation -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker scripts/LocationInfo.plist 2>/dev/null || echo 'Swift location helper compilation skipped (non-macOS or no Swift)'",
    "build:all": "npm run build:native && npm run build:ocr && npm run build:location && npm run build",
    "lint": "biome check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "bash scripts/patch-baileys.sh 2>/dev/null || true"
}
```

Create `/Users/user/Desktop/ATLAS/vitest.config.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/video-studio/**/*.test.ts"],
        environment: "node",
        testTimeout: 30_000,
        reporters: ["verbose"],
    },
});
```

Run `npm install` to pull the new packages.

- [ ] **Step 4 — Run the test and confirm it passes**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: all three assertions in `deps.test.ts` pass.

- [ ] **Step 5 — Stage changes (no commit yet — Layer A milestone commit is at Task 4)**

```bash
cd /Users/user/Desktop/ATLAS
git add package.json vitest.config.ts src/video-studio/util/__tests__/deps.test.ts
```

---

### Task 2: Postinstall Script for FFmpeg Binary

**Files:**
- Create: `/Users/user/Desktop/ATLAS/scripts/postinstall-video.ts` — resolves ffmpeg-static path and chmods executable on Unix
- Modify: `/Users/user/Desktop/ATLAS/package.json` — chain postinstall hooks

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/__tests__/ffmpeg-executable.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { accessSync, constants } from "node:fs";

describe("ffmpeg-static binary is executable after postinstall", () => {
    it("ffmpeg-static path exists on the filesystem", async () => {
        const mod = await import("ffmpeg-static");
        const ffmpegPath = ((mod as { default: string | null }).default ?? mod) as string;
        expect(typeof ffmpegPath).toBe("string");
        accessSync(ffmpegPath, constants.F_OK);
    });

    it("ffmpeg-static binary is executable", async () => {
        if (process.platform === "win32") return;
        const mod = await import("ffmpeg-static");
        const ffmpegPath = ((mod as { default: string | null }).default ?? mod) as string;
        accessSync(ffmpegPath, constants.X_OK);
    });

    it("ffprobe-static binary is executable", async () => {
        if (process.platform === "win32") return;
        const mod = await import("ffprobe-static");
        const info = ((mod as { default: { path: string } }).default ?? mod) as { path: string };
        accessSync(info.path, constants.X_OK);
    });
});
```

- [ ] **Step 2 — Run the test and confirm it fails**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: the `X_OK` assertions fail on macOS/Linux because npm did not chmod the binaries yet.

- [ ] **Step 3 — Minimal implementation: create postinstall script and chain it**

Create `/Users/user/Desktop/ATLAS/scripts/postinstall-video.ts`:

```typescript
#!/usr/bin/env npx tsx
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { chmodSync, existsSync } from "node:fs";

function ensureExecutable(binaryPath: string, label: string): void {
    if (!binaryPath) {
        console.warn(`[postinstall-video] ${label}: path is empty, skipping`);
        return;
    }
    if (!existsSync(binaryPath)) {
        console.warn(`[postinstall-video] ${label}: binary not found at ${binaryPath}, skipping`);
        return;
    }
    if (process.platform === "win32") {
        console.log(`[postinstall-video] ${label}: Windows — chmod not required`);
        return;
    }
    try {
        chmodSync(binaryPath, 0o755);
        console.log(`[postinstall-video] ${label}: chmod 755 -> ${binaryPath}`);
    } catch (err) {
        console.warn(`[postinstall-video] ${label}: chmod failed (non-fatal): ${(err as Error).message}`);
    }
}

async function main(): Promise<void> {
    try {
        const ffmpegMod = await import("ffmpeg-static");
        const ffmpegPath = ((ffmpegMod as { default: string | null }).default ?? ffmpegMod) as string | null;
        if (ffmpegPath) ensureExecutable(ffmpegPath, "ffmpeg-static");
    } catch (err) {
        console.warn(`[postinstall-video] ffmpeg-static not installed: ${(err as Error).message}`);
    }

    try {
        const ffprobeMod = await import("ffprobe-static");
        const ffprobeInfo = ((ffprobeMod as { default: { path: string } }).default ?? ffprobeMod) as { path: string } | null;
        if (ffprobeInfo?.path) ensureExecutable(ffprobeInfo.path, "ffprobe-static");
    } catch (err) {
        console.warn(`[postinstall-video] ffprobe-static not installed: ${(err as Error).message}`);
    }

    console.log("[postinstall-video] Done.");
}

main().catch((err) => {
    console.warn("[postinstall-video] Unexpected error (non-fatal):", err);
});
```

Modify `/Users/user/Desktop/ATLAS/package.json` — chain postinstall hooks:

```json
"postinstall": "bash scripts/patch-baileys.sh 2>/dev/null || true && npx tsx scripts/postinstall-video.ts 2>/dev/null || true"
```

Run:

```bash
cd /Users/user/Desktop/ATLAS
npx tsx scripts/postinstall-video.ts
```

- [ ] **Step 4 — Run the test and confirm it passes**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: all `ffmpeg-executable.test.ts` assertions pass.

- [ ] **Step 5 — Stage changes**

```bash
cd /Users/user/Desktop/ATLAS
git add scripts/postinstall-video.ts package.json src/video-studio/util/__tests__/ffmpeg-executable.test.ts
```

---

### Task 3: `src/video-studio/util/ffmpeg-bin.ts`

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/util/ffmpeg-bin.ts`

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/__tests__/ffmpeg-bin.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { accessSync, constants } from "node:fs";
import { ffmpegPath, ffprobePath, FFmpegNotInstalledError } from "../ffmpeg-bin.js";

describe("ffmpeg-bin module", () => {
    it("ffmpegPath() returns a non-empty string", () => {
        const p = ffmpegPath();
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
    });

    it("ffprobePath() returns a non-empty string", () => {
        const p = ffprobePath();
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
    });

    it("ffmpegPath() points to an existing file", () => {
        accessSync(ffmpegPath(), constants.F_OK);
    });

    it("ffprobePath() points to an existing file", () => {
        accessSync(ffprobePath(), constants.F_OK);
    });

    it("ffmpegPath() points to an executable binary on unix", () => {
        if (process.platform === "win32") return;
        accessSync(ffmpegPath(), constants.X_OK);
    });

    it("ffprobePath() points to an executable binary on unix", () => {
        if (process.platform === "win32") return;
        accessSync(ffprobePath(), constants.X_OK);
    });

    it("FFmpegNotInstalledError is a proper Error subclass", () => {
        const err = new FFmpegNotInstalledError("ffmpeg");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("FFmpegNotInstalledError");
        expect(err.message).toContain("ffmpeg");
    });
});
```

- [ ] **Step 2 — Run the test and confirm it fails**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: module-not-found for `../ffmpeg-bin.js`.

- [ ] **Step 3 — Minimal implementation**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/ffmpeg-bin.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class FFmpegNotInstalledError extends Error {
    readonly name = "FFmpegNotInstalledError";
    constructor(binary: "ffmpeg" | "ffprobe") {
        super(
            `${binary} binary not found. Run \`npm install\` to restore ffmpeg-static / ffprobe-static, ` +
            `then run \`npx tsx scripts/postinstall-video.ts\` to make them executable.`
        );
    }
}

let _ffmpegPath: string | null | undefined = undefined;
let _ffprobePath: string | null | undefined = undefined;

function resolveFFmpeg(): string {
    if (_ffmpegPath !== undefined) return _ffmpegPath as string;

    let resolved: string | null = null;
    try {
        const mod = require("ffmpeg-static") as string | { default: string | null } | null;
        if (typeof mod === "string") {
            resolved = mod;
        } else if (mod && typeof (mod as { default: string | null }).default === "string") {
            resolved = (mod as { default: string }).default;
        }
    } catch {
        resolved = null;
    }

    if (!resolved || !existsSync(resolved)) {
        throw new FFmpegNotInstalledError("ffmpeg");
    }
    _ffmpegPath = resolved;
    return resolved;
}

function resolveFFprobe(): string {
    if (_ffprobePath !== undefined) return _ffprobePath as string;

    let resolved: string | null = null;
    try {
        const mod = require("ffprobe-static") as { path: string } | { default: { path: string } } | null;
        if (mod && typeof (mod as { path: string }).path === "string") {
            resolved = (mod as { path: string }).path;
        } else if (mod && typeof ((mod as { default: { path: string } }).default)?.path === "string") {
            resolved = (mod as { default: { path: string } }).default.path;
        }
    } catch {
        resolved = null;
    }

    if (!resolved || !existsSync(resolved)) {
        throw new FFmpegNotInstalledError("ffprobe");
    }
    _ffprobePath = resolved;
    return resolved;
}

export function ffmpegPath(): string {
    return resolveFFmpeg();
}

export function ffprobePath(): string {
    return resolveFFprobe();
}
```

- [ ] **Step 4 — Run the test and confirm it passes**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: all 7 assertions pass.

- [ ] **Step 5 — Stage changes**

```bash
cd /Users/user/Desktop/ATLAS
git add src/video-studio/util/ffmpeg-bin.ts src/video-studio/util/__tests__/ffmpeg-bin.test.ts
```

---

### Task 4: `src/video-studio/project.ts` — Project Lifecycle

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/project.ts`

---

- [ ] **Step 1 — Write the failing tests**

Create `/Users/user/Desktop/ATLAS/src/video-studio/__tests__/project.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject, loadProject, listProjects } from "../project.js";

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
        const n1 = parseInt(p1.id.slice(-2));
        const n2 = parseInt(p2.id.slice(-2));
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
```

- [ ] **Step 2 — Run the tests and confirm they fail**

```bash
cd /Users/user/Desktop/ATLAS
npm run test
```

Expected: all tests in `project.test.ts` fail with module-not-found.

- [ ] **Step 3 — Minimal implementation**

Create `/Users/user/Desktop/ATLAS/src/video-studio/project.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Project {
    id: string;
    rootDir: string;
    inputs: string[];
    timelinePath: string;
    planPath: string;
    rendersDir: string;
}

interface ProjectMeta {
    id: string;
    createdAt: string;
    inputs: string[];
    hashes: string[];
}

function getProjectsRoot(): string {
    const dataDir = process.env.ATLAS_DATA_DIR ?? path.resolve("data");
    return path.join(dataDir, "video-projects");
}

function todayPrefix(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `vid_${y}_${m}_${d}`;
}

async function nextDailyId(): Promise<string> {
    const root = getProjectsRoot();
    const prefix = todayPrefix();

    let existingMax = 0;
    try {
        const entries = await fsp.readdir(root);
        for (const entry of entries) {
            if (entry.startsWith(prefix + "_")) {
                const suffix = entry.slice(prefix.length + 1);
                const n = parseInt(suffix, 10);
                if (!isNaN(n) && n > existingMax) existingMax = n;
            }
        }
    } catch {
        // projects root does not exist yet
    }

    const next = existingMax + 1;
    if (next > 99) {
        throw new Error(`Daily video project limit reached (99 projects on ${prefix.slice(4)})`);
    }
    return `${prefix}_${String(next).padStart(2, "0")}`;
}

async function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk as Buffer));
        stream.on("end", () => resolve(hash.digest("hex").slice(0, 16)));
        stream.on("error", reject);
    });
}

function deriveProject(id: string, rootDir: string, inputs: string[]): Project {
    return {
        id,
        rootDir,
        inputs,
        timelinePath: path.join(rootDir, "timeline.json"),
        planPath: path.join(rootDir, "edit_plan.json"),
        rendersDir: path.join(rootDir, "renders"),
    };
}

export async function createProject(inputPaths: string[]): Promise<Project> {
    if (inputPaths.length === 0) {
        throw new Error("createProject requires at least one input file");
    }

    const id = await nextDailyId();
    const root = path.join(getProjectsRoot(), id);

    for (const sub of ["inputs", "cache", "renders"]) {
        await fsp.mkdir(path.join(root, sub), { recursive: true });
    }

    const resolvedInputs: string[] = [];
    const hashes: string[] = [];

    for (const src of inputPaths) {
        const absSource = path.resolve(src);
        const basename = path.basename(absSource);
        const dest = path.join(root, "inputs", basename);
        await fsp.copyFile(absSource, dest);
        resolvedInputs.push(dest);
        hashes.push(await sha256File(dest));
    }

    const meta: ProjectMeta = {
        id,
        createdAt: new Date().toISOString(),
        inputs: resolvedInputs,
        hashes,
    };
    await fsp.writeFile(
        path.join(root, "project.json"),
        JSON.stringify(meta, null, 2),
        "utf8"
    );

    return deriveProject(id, root, resolvedInputs);
}

export async function loadProject(id: string): Promise<Project> {
    const root = path.join(getProjectsRoot(), id);
    const metaPath = path.join(root, "project.json");

    let raw: string;
    try {
        raw = await fsp.readFile(metaPath, "utf8");
    } catch {
        throw new Error(`Project not found: ${id} (expected ${metaPath})`);
    }

    const meta: ProjectMeta = JSON.parse(raw) as ProjectMeta;
    return deriveProject(meta.id, root, meta.inputs);
}

export async function listProjects(): Promise<Project[]> {
    const root = getProjectsRoot();

    let entries: string[];
    try {
        entries = await fsp.readdir(root);
    } catch {
        return [];
    }

    const results: Array<{ project: Project; createdAt: string }> = [];

    for (const entry of entries) {
        if (!entry.startsWith("vid_")) continue;
        const metaPath = path.join(root, entry, "project.json");
        try {
            const raw = await fsp.readFile(metaPath, "utf8");
            const meta: ProjectMeta = JSON.parse(raw) as ProjectMeta;
            results.push({
                project: deriveProject(meta.id, path.join(root, entry), meta.inputs),
                createdAt: meta.createdAt,
            });
        } catch {
            // non-fatal
        }
    }

    results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return results.map((r) => r.project);
}
```

- [ ] **Step 4 — Run the tests and confirm they pass**

```bash
cd /Users/user/Desktop/ATLAS
npm run test && npx tsc --noEmit && npm run lint
```

Expected: all test files green, typecheck clean, lint clean.

- [ ] **Step 5 — Stage all Layer A files and commit the milestone**

```bash
cd /Users/user/Desktop/ATLAS
git add \
    package.json \
    vitest.config.ts \
    scripts/postinstall-video.ts \
    src/video-studio/util/ffmpeg-bin.ts \
    src/video-studio/project.ts \
    src/video-studio/util/__tests__/deps.test.ts \
    src/video-studio/util/__tests__/ffmpeg-executable.test.ts \
    src/video-studio/util/__tests__/ffmpeg-bin.test.ts \
    src/video-studio/__tests__/project.test.ts

git commit -m "feat(video-studio): foundation — deps, project, ffmpeg resolution"
```

---

## Layer B — Analyze pipeline (Tasks 5-9)

*Goal: produce a rich `timeline.json` for every input video — scene boundaries (PySceneDetect), per-scene keyframe captions (existing `local-vision.ts`), word-level transcript (faster-whisper with cloud fallback via existing `voice/transcribe.ts`), merged via a parallel orchestrator.*

*Milestone commit at end of Task 9: `feat(video-studio): analyze pipeline — scenes, keyframes, transcript, timeline`*

---

### Task 5: Python Sidecar — `pyproject.toml`, `scene_detect.py`, `python-sidecar.ts`

**Files:**
- Create: `src/video-studio/python/pyproject.toml`
- Create: `src/video-studio/python/scene_detect.py`
- Create: `src/video-studio/util/python-sidecar.ts`
- Create: `src/video-studio/util/python-sidecar.test.ts`

---

- [ ] **Step 1 — Write `src/video-studio/python/pyproject.toml`**

```toml
[project]
name = "atlas-video-studio"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "scenedetect[opencv]>=0.6",
    "faster-whisper>=1.0",
    "librosa>=0.10",
]
```

- [ ] **Step 2 — Write `src/video-studio/python/scene_detect.py`**

```python
#!/usr/bin/env python3
"""
scene_detect.py — PySceneDetect sidecar for ATLAS Video Studio.
Usage: python scene_detect.py <videoPath> <outputJsonPath>
Writes: {"scenes": [{"start": float, "end": float, "duration": float}]}
"""

import sys
import json
import pathlib

def detect_scenes(video_path: str, output_path: str) -> None:
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector(threshold=27.0))
    scene_manager.detect_scenes(video, show_progress=False)
    scene_list = scene_manager.get_scene_list()

    scenes = []
    for start_tc, end_tc in scene_list:
        start = start_tc.get_seconds()
        end = end_tc.get_seconds()
        scenes.append({
            "start": round(start, 4),
            "end": round(end, 4),
            "duration": round(end - start, 4),
        })

    output = {"scenes": scenes}
    pathlib.Path(output_path).write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"[scene_detect] wrote {len(scenes)} scenes to {output_path}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: scene_detect.py <videoPath> <outputJsonPath>", file=sys.stderr)
        sys.exit(1)
    detect_scenes(sys.argv[1], sys.argv[2])
```

- [ ] **Step 3 — Write `src/video-studio/util/python-sidecar.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";

const execFileAsync = promisify(execFile);

function getVenvDir(): string {
    return path.join(getDataDir(), "video-studio", "venv");
}

function getPyprojectPath(): string {
    return path.resolve("src/video-studio/python/pyproject.toml");
}

function getPythonBin(): string {
    const venv = getVenvDir();
    if (process.platform === "win32") {
        return path.join(venv, "Scripts", "python.exe");
    }
    return path.join(venv, "bin", "python");
}

async function resolveUv(): Promise<string | null> {
    const candidates = [
        "uv",
        path.join(process.env.HOME ?? "", ".cargo", "bin", "uv"),
        path.join(process.env.HOME ?? "", ".local", "bin", "uv"),
        path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "uv.exe"),
    ];
    for (const candidate of candidates) {
        try {
            await execFileAsync(candidate, ["--version"], { timeout: 5000 });
            return candidate;
        } catch {
            // not found at this path
        }
    }
    return null;
}

let _envReady = false;
let _envPromise: Promise<void> | null = null;

export async function ensurePythonEnv(): Promise<void> {
    if (_envReady) return;
    if (_envPromise) return _envPromise;
    _envPromise = _doEnsure();
    await _envPromise;
}

async function _doEnsure(): Promise<void> {
    const venvDir = getVenvDir();
    const markerFile = path.join(venvDir, ".atlas-ready");

    if (fs.existsSync(markerFile)) {
        _envReady = true;
        return;
    }

    console.log("[python-sidecar] Setting up Python venv at", venvDir);
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });

    const uv = await resolveUv();
    if (!uv) {
        throw new Error(
            "[python-sidecar] `uv` not found. Install it: https://github.com/astral-sh/uv#installation"
        );
    }

    await execFileAsync(uv, ["venv", venvDir], { timeout: 60_000 });

    const pyproject = getPyprojectPath();
    if (!fs.existsSync(pyproject)) {
        throw new Error(`[python-sidecar] pyproject.toml not found at ${pyproject}`);
    }

    await execFileAsync(
        uv,
        ["pip", "install", "--python", getPythonBin(), "-r", pyproject],
        { timeout: 300_000 }
    );

    fs.writeFileSync(markerFile, new Date().toISOString(), "utf-8");
    _envReady = true;
    console.log("[python-sidecar] Python env ready.");
}

export function runPython(scriptPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const python = getPythonBin();
        const child = spawn(python, [scriptPath, ...args], {
            env: {
                ...process.env,
                VIRTUAL_ENV: getVenvDir(),
                PATH: `${path.join(getVenvDir(), process.platform === "win32" ? "Scripts" : "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
            },
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`[python-sidecar] ${path.basename(scriptPath)} exited ${code}.\n${stderr}`));
            }
        });

        child.on("error", (err) => {
            reject(new Error(`[python-sidecar] Failed to spawn ${python}: ${err.message}`));
        });
    });
}

/** @internal test-only reset */
export function _resetEnvState(): void {
    _envReady = false;
    _envPromise = null;
}
```

- [ ] **Step 4 — Write `src/video-studio/util/python-sidecar.test.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../../config/paths.js", () => ({
    getDataDir: () => "/fake/data",
}));

import { ensurePythonEnv, runPython, _resetEnvState } from "./python-sidecar.js";

const MARKER = "/fake/data/video-studio/venv/.atlas-ready";

describe("ensurePythonEnv", () => {
    beforeEach(() => {
        _resetEnvState();
        vi.clearAllMocks();
    });

    afterEach(() => {
        _resetEnvState();
    });

    it("skips install when venv marker file exists", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === MARKER);
        const cp = await import("node:child_process");
        const execFileSpy = vi.spyOn(cp, "execFile");
        await ensurePythonEnv();
        expect(execFileSpy).not.toHaveBeenCalled();
    });

    it("is idempotent — second call is a no-op", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const cp = await import("node:child_process");
        const execFileSpy = vi.spyOn(cp, "execFile");
        await ensurePythonEnv();
        await ensurePythonEnv();
        expect(execFileSpy).not.toHaveBeenCalled();
    });
});

describe("runPython", () => {
    it("resolves stdout on exit code 0", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as any;
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as any);

        const promise = runPython("/fake/script.py", ["arg1", "arg2"]);

        fakeChild.stdout.push("hello\n");
        fakeChild.stdout.push(null);
        fakeChild.stderr.push(null);
        fakeChild.emit("close", 0);

        const result = await promise;
        expect(result).toBe("hello\n");
    });

    it("rejects with stderr on non-zero exit", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as any;
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as any);

        const promise = runPython("/fake/script.py", []);

        fakeChild.stdout.push(null);
        fakeChild.stderr.push("ModuleNotFoundError\n");
        fakeChild.stderr.push(null);
        fakeChild.emit("close", 1);

        await expect(promise).rejects.toThrow("exited 1");
    });
});
```

- [ ] **Step 5 — Run tests and typecheck**

```bash
cd /Users/user/Desktop/ATLAS
npx vitest run src/video-studio/util/python-sidecar.test.ts
npm run typecheck
```

No commit yet.

---

### Task 6: `src/video-studio/analyze/scene-detect.ts`

**Files:**
- Create: `src/video-studio/analyze/scene-detect.ts`
- Create: `src/video-studio/analyze/scene-detect.test.ts`

---

- [ ] **Step 1 — Write failing test first**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/scene-detect.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffprobePath: () => "/usr/local/bin/ffprobe",
}));

import { detectScenes } from "./scene-detect.js";
import { runPython } from "../util/python-sidecar.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

function mockStat(): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as any);
}

describe("detectScenes — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
    });

    it("returns cached scenes without calling python when cache file exists", async () => {
        const cachedScenes = [
            { index: 0, start: 0, end: 5, duration: 5 },
            { index: 1, start: 5, end: 10, duration: 5 },
        ];
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cachedScenes));

        const result = await detectScenes(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toEqual(cachedScenes);
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("detectScenes — fallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    });

    it("falls back to fixed intervals when python throws", async () => {
        vi.mocked(runPython).mockRejectedValue(new Error("scenedetect not found"));
        const cp = await import("node:child_process");
        vi.mocked(cp.execFile).mockImplementation((_bin: any, _args: any, _opts: any, cb: any) => {
            if (typeof _opts === "function") (_opts as Function)(null, "30.0\n", "");
            else if (typeof cb === "function") cb(null, "30.0\n", "");
            return {} as any;
        });

        const result = await detectScenes(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toHaveLength(6);
        expect(result[0]).toMatchObject({ index: 0, start: 0, end: 5, duration: 5 });
        expect(result[5]).toMatchObject({ index: 5, start: 25, end: 30, duration: 5 });
    });
});
```

- [ ] **Step 2 — Run, see it fail**

```bash
npx vitest run src/video-studio/analyze/scene-detect.test.ts
```

Expected: module-not-found for `./scene-detect.js`.

- [ ] **Step 3 — Implement `src/video-studio/analyze/scene-detect.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";
import { ffprobePath } from "../util/ffmpeg-bin.js";

const execFileAsync = promisify(execFile);

export interface Scene {
    index: number;
    start: number;
    end: number;
    duration: number;
}

interface SceneDetectOutput {
    scenes: Array<{ start: number; end: number; duration: number }>;
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function cachePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `scenes-${hash}.json`);
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

async function fallbackFixedIntervals(videoPath: string): Promise<Scene[]> {
    const { stdout } = await execFileAsync(
        ffprobePath(),
        [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            videoPath,
        ],
        { timeout: 30_000 }
    );

    const duration = parseFloat(stdout.trim());
    if (!isFinite(duration) || duration <= 0) {
        throw new Error(`[scene-detect] ffprobe returned invalid duration for ${videoPath}`);
    }

    const interval = 5;
    const scenes: Scene[] = [];
    let start = 0;
    let index = 0;
    while (start < duration) {
        const end = Math.min(start + interval, duration);
        scenes.push({ index, start: round4(start), end: round4(end), duration: round4(end - start) });
        start = end;
        index++;
    }
    return scenes;
}

export async function detectScenes(videoPath: string, projectRoot: string): Promise<Scene[]> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cachePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Scene[];
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    let scenes: Scene[];

    try {
        await ensurePythonEnv();
        const scriptPath = path.resolve("src/video-studio/python/scene_detect.py");
        const tmpOut = cacheFile + ".tmp.json";
        await runPython(scriptPath, [videoPath, tmpOut]);
        const raw = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as SceneDetectOutput;
        fs.unlinkSync(tmpOut);
        scenes = raw.scenes.map((s, i) => ({
            index: i,
            start: s.start,
            end: s.end,
            duration: s.duration,
        }));
    } catch (err) {
        console.warn(
            "[scene-detect] PySceneDetect failed, falling back to fixed intervals:",
            (err as Error).message
        );
        scenes = await fallbackFixedIntervals(videoPath);
    }

    fs.writeFileSync(cacheFile, JSON.stringify(scenes, null, 2), "utf-8");
    return scenes;
}
```

- [ ] **Step 4 — Run tests, confirm pass**

```bash
npx vitest run src/video-studio/analyze/scene-detect.test.ts
npm run typecheck
```

- [ ] **Step 5 — Stage (no commit)**

```bash
git add src/video-studio/analyze/scene-detect.ts src/video-studio/analyze/scene-detect.test.ts
```

---

### Task 7: `src/video-studio/analyze/frame-describe.ts`

**Files:**
- Create: `src/video-studio/analyze/frame-describe.ts`
- Create: `src/video-studio/analyze/frame-describe.test.ts`

---

- [ ] **Step 1 — Write failing test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/frame-describe.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../../models/local-vision.js", () => ({
    analyzeImage: vi.fn().mockResolvedValue({
        description: "A person standing in a field.",
        objects: [],
        textContent: "",
        sceneType: "photo",
        confidence: 0.8,
        source: "smolvlm",
        processingMs: 100,
    }),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffmpegPath: () => "/usr/local/bin/ffmpeg",
}));

import { describeKeyframes } from "./frame-describe.js";
import { analyzeImage } from "../../models/local-vision.js";
import type { Scene } from "./scene-detect.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SCENES: Scene[] = [
    { index: 0, start: 0, end: 6, duration: 6 },
    { index: 1, start: 6, end: 12, duration: 6 },
    { index: 2, start: 12, end: 18, duration: 6 },
];

function setupCacheMiss(): void {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as any);
}

describe("describeKeyframes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupCacheMiss();
        const cp = require("node:child_process");
        vi.mocked(cp.execFile).mockImplementation((_b: any, _a: any, _o: any, cb: any) => {
            if (typeof _o === "function") _o(null, "", "");
            else if (typeof cb === "function") cb(null, "", "");
            return {} as any;
        });
    });

    it("cache hit skips ffmpeg and vision", async () => {
        vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as any);
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const cached = [{ sceneIndex: 0, timestamp: 3, imagePath: "/p/s0.jpg", caption: "c" }];
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cached));

        const result = await describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT);
        expect(result).toEqual(cached);
        expect(analyzeImage).not.toHaveBeenCalled();
    });

    it("calls analyzeImage once per scene", async () => {
        await describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT);
        expect(analyzeImage).toHaveBeenCalledTimes(3);
    });

    it("respects concurrency limit of 3", async () => {
        const many: Scene[] = Array.from({ length: 9 }, (_, i) => ({
            index: i, start: i * 5, end: (i + 1) * 5, duration: 5,
        }));
        let concurrent = 0;
        let maxConcurrent = 0;
        vi.mocked(analyzeImage).mockImplementation(async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
            return {
                description: "frame", objects: [], textContent: "",
                sceneType: "photo" as const, confidence: 0.9,
                source: "smolvlm" as const, processingMs: 10,
            };
        });
        await describeKeyframes(VIDEO_PATH, many, PROJECT_ROOT);
        expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
});
```

- [ ] **Step 2 — Run, fails**

```bash
npx vitest run src/video-studio/analyze/frame-describe.test.ts
```

- [ ] **Step 3 — Implement**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/frame-describe.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { analyzeImage } from "../../models/local-vision.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import type { Scene } from "./scene-detect.js";

const execFileAsync = promisify(execFile);

export interface KeyframeCaption {
    sceneIndex: number;
    timestamp: number;
    imagePath: string;
    caption: string;
}

const CONCURRENCY = 3;

function buildCaptionCacheKey(videoPath: string, scenes: Scene[]): string {
    const stat = fs.statSync(videoPath);
    const scenesHash = createHash("sha256").update(JSON.stringify(scenes)).digest("hex").slice(0, 8);
    const videoHash = createHash("sha256")
        .update(`${videoPath}::${stat.mtimeMs}::${stat.size}`)
        .digest("hex").slice(0, 8);
    return `${videoHash}-${scenesHash}`;
}

function captionCacheFile(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", "keyframes", `captions-${hash}.json`);
}

function keyframeJpgPath(projectRoot: string, sceneIndex: number): string {
    return path.join(projectRoot, "cache", "keyframes", `scene-${sceneIndex}.jpg`);
}

async function extractFrame(videoPath: string, timestamp: number, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await execFileAsync(
        ffmpegPath(),
        [
            "-ss", String(timestamp),
            "-i", videoPath,
            "-frames:v", "1",
            "-q:v", "2",
            "-y",
            outPath,
        ],
        { timeout: 30_000 }
    );
}

async function pLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = [];
    let index = 0;
    async function worker(): Promise<void> {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

export async function describeKeyframes(
    videoPath: string,
    scenes: Scene[],
    projectRoot: string
): Promise<KeyframeCaption[]> {
    const hash = buildCaptionCacheKey(videoPath, scenes);
    const cacheFile = captionCacheFile(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as KeyframeCaption[];
    }

    const partialMap = new Map<number, KeyframeCaption>();
    if (fs.existsSync(cacheFile + ".partial")) {
        const partial = JSON.parse(fs.readFileSync(cacheFile + ".partial", "utf-8")) as KeyframeCaption[];
        for (const kf of partial) partialMap.set(kf.sceneIndex, kf);
    }

    const tasks = scenes.map((scene) => async (): Promise<KeyframeCaption> => {
        if (partialMap.has(scene.index)) return partialMap.get(scene.index)!;

        const mid = round4((scene.start + scene.end) / 2);
        const imgPath = keyframeJpgPath(projectRoot, scene.index);

        if (!fs.existsSync(imgPath)) {
            await extractFrame(videoPath, mid, imgPath);
        }

        const visionResult = await analyzeImage(
            imgPath,
            "Describe this video frame in one sentence. Focus on subject, action, and setting."
        );

        const kf: KeyframeCaption = {
            sceneIndex: scene.index,
            timestamp: mid,
            imagePath: imgPath,
            caption: visionResult.description,
        };

        partialMap.set(scene.index, kf);
        fs.writeFileSync(
            cacheFile + ".partial",
            JSON.stringify(Array.from(partialMap.values()), null, 2),
            "utf-8"
        );

        return kf;
    });

    const keyframes = await pLimit(tasks, CONCURRENCY);

    fs.writeFileSync(cacheFile, JSON.stringify(keyframes, null, 2), "utf-8");
    try { fs.unlinkSync(cacheFile + ".partial"); } catch { /* already gone */ }

    return keyframes;
}
```

- [ ] **Step 4 — Run tests, pass**

```bash
npx vitest run src/video-studio/analyze/frame-describe.test.ts
npm run typecheck
```

- [ ] **Step 5 — Stage**

```bash
git add src/video-studio/analyze/frame-describe.ts src/video-studio/analyze/frame-describe.test.ts
```

---

### Task 8: `src/video-studio/analyze/transcribe.ts`

**Files:**
- Create: `src/video-studio/python/faster_whisper_transcribe.py`
- Create: `src/video-studio/analyze/transcribe.ts`
- Create: `src/video-studio/analyze/transcribe.test.ts`

---

- [ ] **Step 1 — Create the Python sidecar script first**

Create `/Users/user/Desktop/ATLAS/src/video-studio/python/faster_whisper_transcribe.py`:

```python
#!/usr/bin/env python3
"""
faster_whisper_transcribe.py — Word-level transcript via faster-whisper.
Usage: python faster_whisper_transcribe.py <audioPath> <outputJsonPath> [modelSize]
"""

import sys
import json
import pathlib


def transcribe(audio_path: str, output_path: str, model_size: str = "base") -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
    )

    language = info.language
    segments = []

    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "start": round(w.start, 4),
                    "end": round(w.end, 4),
                    "word": w.word,
                    "confidence": round(w.probability, 4),
                })
        segments.append({
            "start": round(seg.start, 4),
            "end": round(seg.end, 4),
            "text": seg.text.strip(),
            "words": words,
        })

    result = {"language": language, "segments": segments}
    pathlib.Path(output_path).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[faster-whisper] {len(segments)} segments, language={language}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: faster_whisper_transcribe.py <audioPath> <outputJsonPath> [modelSize]", file=sys.stderr)
        sys.exit(1)
    model_size = sys.argv[3] if len(sys.argv) >= 4 else "base"
    transcribe(sys.argv[1], sys.argv[2], model_size)
```

- [ ] **Step 2 — Write failing TS test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/transcribe.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("node:os", () => ({ default: { tmpdir: () => "/tmp" } }));
vi.mock("../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffmpegPath: () => "/usr/local/bin/ffmpeg",
}));
vi.mock("../../voice/transcribe.js", () => ({
    transcribeAudio: vi.fn().mockResolvedValue("Hello from cloud Whisper"),
}));

import { transcribeVideo } from "./transcribe.js";
import { runPython } from "../util/python-sidecar.js";
import { transcribeAudio } from "../../voice/transcribe.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SAMPLE = {
    language: "en",
    segments: [{
        start: 0.0, end: 3.2, text: "Hello world",
        words: [
            { start: 0.0, end: 0.5, word: "Hello", confidence: 0.98 },
            { start: 0.6, end: 1.0, word: "world", confidence: 0.97 },
        ],
    }],
};

function setupCacheMiss(): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 8000 } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    const cp = require("node:child_process");
    vi.mocked(cp.execFile).mockImplementation((_b: any, _a: any, _o: any, cb: any) => {
        if (typeof _o === "function") _o(null, "", "");
        else if (typeof cb === "function") cb(null, "", "");
        return {} as any;
    });
}

describe("transcribeVideo", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupCacheMiss();
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE));
    });

    it("extracts 16kHz mono audio via ffmpeg", async () => {
        const cp = await import("node:child_process");
        const spy = vi.mocked(cp.execFile);
        await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        const ffmpegCall = spy.mock.calls.find((c) => String(c[0]).includes("ffmpeg"));
        expect(ffmpegCall).toBeDefined();
        const args = ffmpegCall![1] as string[];
        expect(args[args.indexOf("-ar") + 1]).toBe("16000");
        expect(args[args.indexOf("-ac") + 1]).toBe("1");
    });

    it("returns word-level timestamps from faster-whisper", async () => {
        const result = await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        expect(result.segments[0].words).toHaveLength(2);
        expect(result.segments[0].words[0]).toMatchObject({ word: "Hello" });
    });

    it("falls back to cloud Whisper when python sidecar fails", async () => {
        vi.mocked(runPython).mockRejectedValue(new Error("faster-whisper not installed"));
        const result = await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        expect(transcribeAudio).toHaveBeenCalled();
        expect(result.segments[0].text).toBe("Hello from cloud Whisper");
        expect(result.segments[0].words).toEqual([]);
    });
});
```

- [ ] **Step 3 — Implement `src/video-studio/analyze/transcribe.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import { transcribeAudio } from "../../voice/transcribe.js";

const execFileAsync = promisify(execFile);

export interface TranscriptWord {
    start: number;
    end: number;
    word: string;
    confidence: number;
}

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
    words: TranscriptWord[];
}

export interface Transcript {
    language: string;
    segments: TranscriptSegment[];
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    return createHash("sha256")
        .update(`${videoPath}::${stat.mtimeMs}::${stat.size}`)
        .digest("hex").slice(0, 16);
}

function cacheFilePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `transcript-${hash}.json`);
}

async function extractAudio(videoPath: string): Promise<string> {
    const tmpWav = path.join(os.tmpdir(), `atlas-vs-audio-${Date.now()}.wav`);
    await execFileAsync(
        ffmpegPath(),
        [
            "-i", videoPath,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            "-y",
            tmpWav,
        ],
        { timeout: 120_000 }
    );
    return tmpWav;
}

export async function transcribeVideo(
    videoPath: string,
    projectRoot: string,
    modelSize = "base"
): Promise<Transcript> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cacheFilePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Transcript;
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    const tmpWav = await extractAudio(videoPath);
    let transcript: Transcript;

    try {
        await ensurePythonEnv();
        const scriptPath = path.resolve("src/video-studio/python/faster_whisper_transcribe.py");
        const tmpOut = cacheFile + ".tmp.json";
        await runPython(scriptPath, [tmpWav, tmpOut, modelSize]);
        transcript = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as Transcript;
        try { fs.unlinkSync(tmpOut); } catch { /* non-fatal */ }
    } catch (pyErr) {
        console.warn(
            "[transcribe] faster-whisper failed, falling back to cloud Whisper:",
            (pyErr as Error).message
        );
        const plainText = await transcribeAudio(tmpWav);
        transcript = {
            language: "unknown",
            segments: [{ start: 0, end: 0, text: plainText, words: [] }],
        };
    } finally {
        try { fs.unlinkSync(tmpWav); } catch { /* non-fatal */ }
    }

    fs.writeFileSync(cacheFile, JSON.stringify(transcript, null, 2), "utf-8");
    return transcript;
}
```

- [ ] **Step 4 — Run tests**

```bash
npx vitest run src/video-studio/analyze/transcribe.test.ts
npm run typecheck
```

- [ ] **Step 5 — Stage**

```bash
git add \
  src/video-studio/python/faster_whisper_transcribe.py \
  src/video-studio/analyze/transcribe.ts \
  src/video-studio/analyze/transcribe.test.ts
```

---

### Task 9: `src/video-studio/analyze/timeline-builder.ts`

**Files:**
- Create: `src/video-studio/analyze/timeline-builder.ts`
- Create: `src/video-studio/analyze/timeline-builder.test.ts`

---

- [ ] **Step 1 — Write failing test**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/timeline-builder.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffprobePath: () => "/usr/local/bin/ffprobe",
}));
vi.mock("./scene-detect.js", () => ({ detectScenes: vi.fn() }));
vi.mock("./frame-describe.js", () => ({ describeKeyframes: vi.fn() }));
vi.mock("./transcribe.js", () => ({ transcribeVideo: vi.fn() }));

import { buildTimeline, probeVideoMetadata } from "./timeline-builder.js";
import { detectScenes } from "./scene-detect.js";
import { describeKeyframes } from "./frame-describe.js";
import { transcribeVideo } from "./transcribe.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_A = "/fake/videoA.mp4";
const VIDEO_B = "/fake/videoB.mp4";

const MOCK_SCENES = [{ index: 0, start: 0, end: 5, duration: 5 }];
const MOCK_KEYFRAMES = [{ sceneIndex: 0, timestamp: 2.5, imagePath: "/p/s0.jpg", caption: "t" }];
const MOCK_TRANSCRIPT = { language: "en", segments: [{ start: 0, end: 3, text: "Hi", words: [] }] };
const FFPROBE_JSON = JSON.stringify({
    streams: [{ width: 1920, height: 1080, r_frame_rate: "30/1" }],
    format: { duration: "10.0" },
});

function setupMocks(): void {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(detectScenes).mockResolvedValue(MOCK_SCENES);
    vi.mocked(describeKeyframes).mockResolvedValue(MOCK_KEYFRAMES);
    vi.mocked(transcribeVideo).mockResolvedValue(MOCK_TRANSCRIPT);
    const cp = require("node:child_process");
    vi.mocked(cp.execFile).mockImplementation((_b: any, _a: any, _o: any, cb: any) => {
        if (typeof _o === "function") _o(null, FFPROBE_JSON, "");
        else if (typeof cb === "function") cb(null, FFPROBE_JSON, "");
        return {} as any;
    });
}

describe("probeVideoMetadata", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const cp = require("node:child_process");
        vi.mocked(cp.execFile).mockImplementation((_b: any, _a: any, _o: any, cb: any) => {
            if (typeof _o === "function") _o(null, FFPROBE_JSON, "");
            else if (typeof cb === "function") cb(null, FFPROBE_JSON, "");
            return {} as any;
        });
    });

    it("parses width, height, fps, duration from ffprobe", async () => {
        const meta = await probeVideoMetadata(VIDEO_A);
        expect(meta.width).toBe(1920);
        expect(meta.height).toBe(1080);
        expect(meta.fps).toBe(30);
        expect(meta.duration).toBe(10);
        expect(meta.resolution).toBe("1920x1080");
    });
});

describe("buildTimeline", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMocks();
    });

    it("returns a Timeline for a single video", async () => {
        const result = await buildTimeline([VIDEO_A], PROJECT_ROOT);
        expect(result).toHaveProperty("videoPath", VIDEO_A);
        expect(result).toHaveProperty("scenes");
        expect(result).toHaveProperty("keyframes");
        expect(result).toHaveProperty("transcript");
    });

    it("returns a TimelineMap for multiple videos", async () => {
        const result = await buildTimeline([VIDEO_A, VIDEO_B], PROJECT_ROOT) as Record<string, unknown>;
        expect(result[VIDEO_A]).toBeDefined();
        expect(result[VIDEO_B]).toBeDefined();
    });

    it("writes timeline.json to projectRoot", async () => {
        await buildTimeline([VIDEO_A], PROJECT_ROOT);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            `${PROJECT_ROOT}/timeline.json`,
            expect.any(String),
            "utf-8"
        );
    });

    it("throws when videoPaths is empty", async () => {
        await expect(buildTimeline([], PROJECT_ROOT)).rejects.toThrow();
    });
});
```

- [ ] **Step 2 — Run, fails**

```bash
npx vitest run src/video-studio/analyze/timeline-builder.test.ts
```

- [ ] **Step 3 — Implement `src/video-studio/analyze/timeline-builder.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { ffprobePath } from "../util/ffmpeg-bin.js";
import { detectScenes } from "./scene-detect.js";
import { describeKeyframes } from "./frame-describe.js";
import { transcribeVideo } from "./transcribe.js";
import type { Scene } from "./scene-detect.js";
import type { KeyframeCaption } from "./frame-describe.js";
import type { Transcript } from "./transcribe.js";

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
    duration: number;
    fps: number;
    resolution: string;
    width: number;
    height: number;
}

export interface Timeline {
    videoPath: string;
    duration: number;
    fps: number;
    resolution: string;
    width: number;
    height: number;
    scenes: Scene[];
    keyframes: KeyframeCaption[];
    transcript: Transcript;
}

export type TimelineMap = Record<string, Timeline>;

export async function probeVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync(
        ffprobePath(),
        [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate:format=duration",
            "-of", "json",
            videoPath,
        ],
        { timeout: 30_000 }
    );

    const data = JSON.parse(stdout) as {
        streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
        format?: { duration?: string };
    };

    const stream = data.streams?.[0] ?? {};
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;
    const resolution = width && height ? `${width}x${height}` : "unknown";

    const [numStr, denStr] = (stream.r_frame_rate ?? "0/1").split("/");
    const fps = denStr && Number(denStr) !== 0
        ? Math.round((Number(numStr) / Number(denStr)) * 100) / 100
        : 0;

    const duration = parseFloat(data.format?.duration ?? "0");

    return { duration, fps, resolution, width, height };
}

export async function buildSingleTimeline(
    videoPath: string,
    projectRoot: string
): Promise<Timeline> {
    const [metadata, scenes] = await Promise.all([
        probeVideoMetadata(videoPath),
        detectScenes(videoPath, projectRoot),
    ]);

    const [keyframes, transcript] = await Promise.all([
        describeKeyframes(videoPath, scenes, projectRoot),
        transcribeVideo(videoPath, projectRoot),
    ]);

    return {
        videoPath,
        duration: metadata.duration,
        fps: metadata.fps,
        resolution: metadata.resolution,
        width: metadata.width,
        height: metadata.height,
        scenes,
        keyframes,
        transcript,
    };
}

export async function buildTimeline(
    videoPaths: string[],
    projectRoot: string
): Promise<Timeline | TimelineMap> {
    if (videoPaths.length === 0) {
        throw new Error("[timeline-builder] videoPaths must not be empty");
    }

    const timelineJsonPath = path.join(projectRoot, "timeline.json");

    if (videoPaths.length === 1) {
        const timeline = await buildSingleTimeline(videoPaths[0], projectRoot);
        fs.writeFileSync(timelineJsonPath, JSON.stringify(timeline, null, 2), "utf-8");
        return timeline;
    }

    const entries = await Promise.all(
        videoPaths.map((vp) => buildSingleTimeline(vp, projectRoot))
    );

    const map: TimelineMap = {};
    for (const entry of entries) {
        map[entry.videoPath] = entry;
    }

    fs.writeFileSync(timelineJsonPath, JSON.stringify(map, null, 2), "utf-8");
    return map;
}
```

- [ ] **Step 4 — Run ALL Layer B tests**

```bash
npx vitest run src/video-studio/
npm run typecheck
npm run lint
```

- [ ] **Step 5 — Milestone commit**

```bash
git add \
  src/video-studio/python/pyproject.toml \
  src/video-studio/python/scene_detect.py \
  src/video-studio/python/faster_whisper_transcribe.py \
  src/video-studio/util/python-sidecar.ts \
  src/video-studio/util/python-sidecar.test.ts \
  src/video-studio/analyze/scene-detect.ts \
  src/video-studio/analyze/scene-detect.test.ts \
  src/video-studio/analyze/frame-describe.ts \
  src/video-studio/analyze/frame-describe.test.ts \
  src/video-studio/analyze/transcribe.ts \
  src/video-studio/analyze/transcribe.test.ts \
  src/video-studio/analyze/timeline-builder.ts \
  src/video-studio/analyze/timeline-builder.test.ts

git commit -m "feat(video-studio): analyze pipeline — scenes, keyframes, transcript, timeline"
```

---

## Layer C — Plan + Render (Tasks 10-14)

*Goal: the editing brain. Zod schema for `edit_plan.json`, an LLM planner (MODELS.SONNET via injected `LLMClient`) with one auto-repair pass, pre-render validators (source existence, duration bounds, transition references), a type-safe FFmpeg `filter_complex` builder, and a renderer that compiles any valid plan to an mp4 with graceful-degrade retry on InvalidFilterGraph errors.*

*Milestone commit at end of Task 14: `feat(video-studio): plan schema + validator + ffmpeg renderer`*

---

### Task 10: `src/video-studio/plan/schema.ts` — Zod schema for edit_plan.json

**Responsibility:** Single source of truth for the shape of every `edit_plan.json` produced by the LLM planner. All downstream code — planner, validator, renderer — imports from here and never re-declares types.

**Files**

| Action | Path |
|--------|------|
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/schema.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/schema.test.ts` |

**Step-by-step TDD**

- [ ] Step 1: Write the failing tests first — `src/video-studio/plan/__tests__/schema.test.ts`
- [ ] Step 2: Run `npx vitest run src/video-studio/plan/__tests__/schema.test.ts` — confirm all fail
- [ ] Step 3: Implement `src/video-studio/plan/schema.ts`
- [ ] Step 4: Run tests — confirm all pass
- [ ] Step 5: `npx biome check src/video-studio/plan/schema.ts src/video-studio/plan/__tests__/schema.test.ts`

**`src/video-studio/plan/__tests__/schema.test.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { EditPlanSchema, validateEditPlan } from "../schema.js";

const VALID_PLAN = {
  projectId: "vid_2026_04_18_01",
  output: { path: "renders/final.mp4", aspect: "9:16", fps: 30, resolution: "1080x1920" },
  sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
  tracks: {
    video: [{ id: "v1", source: "s1", in: 3.2, out: 8.4 }],
    audio: [{ id: "a1", source: "music/upbeat.mp3", volume: -12, duck_on_speech: true }],
    overlays: [{ type: "captions", style: "reel_karaoke", from: 0, to: 12.9, highlight_color: "#FFD700" }],
  },
  transitions: [{ between: ["v1", "v2"], type: "xfade", kind: "fade", duration: 0.5 }],
  export_targets: ["mp4"],
};

describe("EditPlanSchema", () => {
  it("accepts a fully valid plan", () => {
    expect(EditPlanSchema.safeParse(VALID_PLAN).success).toBe(true);
  });

  it("accepts optional video fields speed, crop, effects", () => {
    const plan = structuredClone(VALID_PLAN);
    Object.assign(plan.tracks.video[0], { speed: 1.5, crop: "auto_face", effects: ["bg_replace:beach.jpg"] });
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a plan missing projectId", () => {
    const bad = { ...VALID_PLAN, projectId: undefined };
    const result = EditPlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("projectId"))).toBe(true);
    }
  });

  it("rejects an invalid aspect ratio", () => {
    const bad = structuredClone(VALID_PLAN);
    bad.output.aspect = "3:2" as never;
    expect(EditPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown export_target value", () => {
    const bad = structuredClone(VALID_PLAN);
    (bad as { export_targets: string[] }).export_targets = ["avi"];
    expect(EditPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects resolution that does not match WxH pattern", () => {
    const bad = structuredClone(VALID_PLAN);
    bad.output.resolution = "fullhd";
    expect(EditPlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe("EditPlanSchema overlay discriminated union", () => {
  it("accepts a captions overlay with required fields", () => {
    const plan = structuredClone(VALID_PLAN);
    plan.tracks.overlays = [{ type: "captions", style: "reel_karaoke", from: 0, to: 10, highlight_color: "#fff" }] as never;
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts a text overlay with required fields", () => {
    const plan = structuredClone(VALID_PLAN);
    plan.tracks.overlays = [{ type: "text", content: "Hello", from: 0, to: 5, x: 100, y: 200 }] as never;
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts a sticker overlay with required fields", () => {
    const plan = structuredClone(VALID_PLAN);
    plan.tracks.overlays = [{ type: "sticker", asset: "fire.gif", from: 1, to: 3, x: 50, y: 50 }] as never;
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a captions overlay missing highlight_color", () => {
    const plan = structuredClone(VALID_PLAN);
    plan.tracks.overlays = [{ type: "captions", style: "reel_karaoke", from: 0, to: 10 }] as never;
    expect(EditPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a text overlay missing content", () => {
    const plan = structuredClone(VALID_PLAN);
    plan.tracks.overlays = [{ type: "text", from: 0, to: 5, x: 0, y: 0 }] as never;
    expect(EditPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe("validateEditPlan", () => {
  it("returns ok:true with typed plan on valid input", () => {
    const r = validateEditPlan(VALID_PLAN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.projectId).toBe("vid_2026_04_18_01");
  });

  it("returns ok:false with human-readable errors on invalid input", () => {
    const r = validateEditPlan({ projectId: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(typeof r.errors[0]).toBe("string");
    }
  });
});
```

**`src/video-studio/plan/schema.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { z } from "zod";

const OutputSchema = z.object({
  path: z.string().min(1),
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
  fps: z.number().int().positive(),
  resolution: z.string().regex(/^\d+x\d+$/, "resolution must be WxH e.g. 1920x1080"),
});

const SourceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  duration: z.number().positive(),
});

const VideoTrackSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  speed: z.number().positive().optional(),
  crop: z.string().optional(),
  effects: z.array(z.string()).optional(),
});

const AudioTrackSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  volume: z.number().optional(),
  duck_on_speech: z.boolean().optional(),
  sync_to_beats: z.boolean().optional(),
  fade_in: z.number().nonnegative().optional(),
  fade_out: z.number().nonnegative().optional(),
});

const CaptionsOverlaySchema = z.object({
  type: z.literal("captions"),
  style: z.string().min(1),
  from: z.number().nonnegative(),
  to: z.number().positive(),
  highlight_color: z.string().min(1),
  font_size: z.number().positive().optional(),
  font_family: z.string().optional(),
  position: z.enum(["top", "center", "bottom"]).optional(),
});

const TextOverlaySchema = z.object({
  type: z.literal("text"),
  content: z.string().min(1),
  from: z.number().nonnegative(),
  to: z.number().positive(),
  x: z.number(),
  y: z.number(),
  font_size: z.number().positive().optional(),
  font_color: z.string().optional(),
  font_family: z.string().optional(),
  box_color: z.string().optional(),
});

const StickerOverlaySchema = z.object({
  type: z.literal("sticker"),
  asset: z.string().min(1),
  from: z.number().nonnegative(),
  to: z.number().positive(),
  x: z.number(),
  y: z.number(),
  scale: z.number().positive().optional(),
});

const OverlaySchema = z.discriminatedUnion("type", [
  CaptionsOverlaySchema,
  TextOverlaySchema,
  StickerOverlaySchema,
]);

const TracksSchema = z.object({
  video: z.array(VideoTrackSchema).min(1),
  audio: z.array(AudioTrackSchema).optional().default([]),
  overlays: z.array(OverlaySchema).optional().default([]),
});

const TransitionSchema = z.object({
  between: z.tuple([z.string(), z.string()]),
  type: z.enum(["xfade", "cut"]),
  kind: z.string().optional(),
  duration: z.number().positive().optional(),
});

export const EditPlanSchema = z.object({
  projectId: z.string().min(1),
  output: OutputSchema,
  sources: z.array(SourceSchema).min(1),
  tracks: TracksSchema,
  transitions: z.array(TransitionSchema).optional().default([]),
  export_targets: z.array(z.enum(["mp4", "fcpxml"])).min(1),
});

export type EditPlan = z.infer<typeof EditPlanSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type OverlayTrack = z.infer<typeof OverlaySchema>;
export type CaptionsOverlay = z.infer<typeof CaptionsOverlaySchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type StickerOverlay = z.infer<typeof StickerOverlaySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Source = z.infer<typeof SourceSchema>;

export type ValidateResult =
  | { ok: true; plan: EditPlan }
  | { ok: false; errors: string[] };

export function validateEditPlan(raw: unknown): ValidateResult {
  const result = EditPlanSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}
```

---

### Task 11: `src/video-studio/plan/planner.ts` — LLM writes edit_plan.json

**Responsibility:** Convert a `Timeline` and user intent into a validated `EditPlan` by calling the LLM with a constrained system prompt. One auto-repair pass on validation failure. Throws `PlanValidationError` after two total attempts.

**Files**

| Action | Path |
|--------|------|
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/planner.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/planner.test.ts` |

**Step-by-step TDD**

- [ ] Step 1: Write failing tests — `src/video-studio/plan/__tests__/planner.test.ts`
- [ ] Step 2: Run tests, confirm fail
- [ ] Step 3: Implement `src/video-studio/plan/planner.ts`
- [ ] Step 4: Run tests, confirm pass
- [ ] Step 5: Lint

**`src/video-studio/plan/__tests__/planner.test.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { planEdit, PlanValidationError } from "../planner.js";
import type { LLMClient } from "../../../llm.js";
import type { Timeline } from "../../analyze/timeline-builder.js";

const MOCK_TIMELINE = {
  videoPath: "inputs/clip1.mp4",
  duration: 42.1,
  fps: 30,
  resolution: "1920x1080",
  width: 1920,
  height: 1080,
  scenes: [
    { index: 0, start: 0, end: 20, duration: 20 },
    { index: 1, start: 20, end: 42.1, duration: 22.1 },
  ],
  keyframes: [
    { sceneIndex: 0, timestamp: 10, imagePath: "/p/s0.jpg", caption: "Person talking" },
    { sceneIndex: 1, timestamp: 31, imagePath: "/p/s1.jpg", caption: "Person walks away" },
  ],
  transcript: {
    language: "en",
    segments: [{ start: 0, end: 2, text: "Hello world", words: [
      { start: 0.5, end: 0.9, word: "Hello", confidence: 0.95 },
      { start: 1.0, end: 1.3, word: "world", confidence: 0.95 },
    ] }],
  },
} as unknown as Timeline;

const VALID_PLAN_JSON = JSON.stringify({
  projectId: "vid_test_01",
  output: { path: "renders/final.mp4", aspect: "9:16", fps: 30, resolution: "1080x1920" },
  sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
  tracks: { video: [{ id: "v1", source: "s1", in: 0, out: 20 }], audio: [], overlays: [] },
  transitions: [],
  export_targets: ["mp4"],
});

const INVALID_PLAN_JSON = JSON.stringify({
  projectId: "vid_test_01",
  output: { path: "renders/final.mp4", fps: 30, resolution: "1080x1920" },
  sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
  tracks: { video: [{ id: "v1", source: "s1", in: 0, out: 20 }] },
  transitions: [],
  export_targets: ["mp4"],
});

function makeMockLLM(responses: string[]): LLMClient {
  let call = 0;
  return {
    config: {} as never,
    chat: vi.fn().mockImplementation(async () => {
      const text = responses[call] ?? responses[responses.length - 1];
      call++;
      return {
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      };
    }),
  } as unknown as LLMClient;
}

describe("planEdit", () => {
  it("returns a valid EditPlan when LLM responds with correct JSON on first call", async () => {
    const llm = makeMockLLM([VALID_PLAN_JSON]);
    const plan = await planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "20s highlight", projectId: "vid_test_01" });
    expect(plan.projectId).toBe("vid_test_01");
    expect(plan.tracks.video).toHaveLength(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("triggers auto-repair when first response fails validation and succeeds on repair", async () => {
    const llm = makeMockLLM([INVALID_PLAN_JSON, VALID_PLAN_JSON]);
    const plan = await planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" });
    expect(plan.projectId).toBe("vid_test_01");
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("throws PlanValidationError after two consecutive validation failures", async () => {
    const llm = makeMockLLM([INVALID_PLAN_JSON, INVALID_PLAN_JSON]);
    await expect(
      planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" })
    ).rejects.toThrow(PlanValidationError);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("PlanValidationError carries lastAttempt and validationErrors", async () => {
    const llm = makeMockLLM([INVALID_PLAN_JSON, INVALID_PLAN_JSON]);
    let caught: PlanValidationError | undefined;
    try {
      await planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" });
    } catch (e) {
      if (e instanceof PlanValidationError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.lastAttempt).toBeDefined();
    expect(Array.isArray(caught?.validationErrors)).toBe(true);
    expect(caught?.validationErrors.length).toBeGreaterThan(0);
  });

  it("throws PlanValidationError when LLM returns prose (no JSON) both times", async () => {
    const llm = makeMockLLM(["I cannot help with that.", "Still no JSON here."]);
    await expect(
      planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" })
    ).rejects.toThrow(PlanValidationError);
  });
});
```

**`src/video-studio/plan/planner.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { validateEditPlan, type EditPlan } from "./schema.js";
import type { Timeline } from "../analyze/timeline-builder.js";

export class PlanValidationError extends Error {
  readonly lastAttempt: unknown;
  readonly validationErrors: string[];

  constructor(message: string, lastAttempt: unknown, validationErrors: string[]) {
    super(message);
    this.name = "PlanValidationError";
    this.lastAttempt = lastAttempt;
    this.validationErrors = validationErrors;
  }
}

export interface PlanEditOpts {
  llm: LLMClient;
  timeline: Timeline;
  userIntent: string;
  projectId: string;
}

const SCHEMA_DESCRIPTION = `Required JSON shape (strict — output ONLY this JSON, no prose):
{
  "projectId": "<string>",
  "output": { "path": "<string>", "aspect": "16:9"|"9:16"|"1:1"|"4:5", "fps": <int>, "resolution": "<WxH>" },
  "sources": [{ "id": "<string>", "path": "<string>", "duration": <number> }],
  "tracks": {
    "video": [{ "id": "<string>", "source": "<sources[].id>", "in": <number>, "out": <number>,
                "speed": <opt number>, "crop": <opt string>, "effects": <opt string[]> }],
    "audio": [{ "id": "<string>", "source": "<path>", "volume": <opt dB>, "duck_on_speech": <opt bool>,
                "sync_to_beats": <opt bool>, "fade_in": <opt s>, "fade_out": <opt s> }],
    "overlays": [
      { "type": "captions", "style": "<string>", "from": <s>, "to": <s>, "highlight_color": "<#hex>" } |
      { "type": "text", "content": "<string>", "from": <s>, "to": <s>, "x": <px>, "y": <px> } |
      { "type": "sticker", "asset": "<filename>", "from": <s>, "to": <s>, "x": <px>, "y": <px> }
    ]
  },
  "transitions": [{ "between": ["<videoId>", "<videoId>"], "type": "xfade"|"cut",
                    "kind": <opt string>, "duration": <opt s> }],
  "export_targets": ["mp4"] (required) | ["mp4","fcpxml"]
}
Constraints: video[].out <= source duration; video[].in < video[].out;
             transition between[] IDs must exist in tracks.video[].id.`;

function buildSystemPrompt(): string {
  return `You are a video editing planner. Given a timeline and a user intent, you output a single valid JSON edit plan conforming exactly to the schema below. Output ONLY the JSON object — no markdown fences, no prose, no comments.

${SCHEMA_DESCRIPTION}`;
}

function buildTimelineSummary(timeline: Timeline): string {
  const sceneSummary = timeline.scenes
    .map((s, i) => `  Scene ${i + 1}: ${s.start.toFixed(2)}s-${s.end.toFixed(2)}s (${s.duration.toFixed(1)}s)`)
    .join("\n");

  const captionSummary = (timeline.keyframes ?? [])
    .map((kf) => `    scene ${kf.sceneIndex}: "${kf.caption}"`)
    .join("\n");

  const allWords = (timeline.transcript?.segments ?? []).flatMap((s) => s.words ?? []);
  const excerpt = allWords.slice(0, 30).map((w) => w.word).join(" ");

  return `TIMELINE:
- videoPath: ${timeline.videoPath}
- duration: ${timeline.duration.toFixed(2)}s
- resolution: ${timeline.resolution}  fps: ${timeline.fps}
- scenes (${timeline.scenes.length}):
${sceneSummary}
- keyframe captions:
${captionSummary}
- transcript excerpt: "${excerpt}${allWords.length > 30 ? "..." : ""}"`;
}

function tryExtractAndValidate(content: string):
  | { ok: true; plan: EditPlan }
  | { ok: false; raw: unknown; errors: string[] } {
  const json = extractJSON(content);
  if (json === null) {
    return { ok: false, raw: null, errors: ["No JSON found in LLM response"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, raw: null, errors: ["JSON.parse failed on extracted string"] };
  }
  const v = validateEditPlan(parsed);
  if (v.ok) return { ok: true, plan: v.plan };
  return { ok: false, raw: parsed, errors: v.errors };
}

export async function planEdit(opts: PlanEditOpts): Promise<EditPlan> {
  const { llm, timeline, userIntent, projectId } = opts;

  const systemPrompt = buildSystemPrompt();
  const userContent = `${buildTimelineSummary(timeline)}\n\nUSER INTENT: ${userIntent}\n\nOutput the edit_plan JSON:`;

  const r1 = await llm.chat({
    messages: [{ role: "user", content: userContent }],
    systemPrompt,
    modelOverride: MODELS.SONNET,
  });
  const c1 = r1.choices[0]?.message?.content ?? "";
  const v1 = tryExtractAndValidate(c1);
  if (v1.ok) return v1.plan;

  const errorList = v1.errors.join("\n");
  const r2 = await llm.chat({
    messages: [
      { role: "user", content: userContent },
      { role: "assistant", content: c1 },
      {
        role: "user",
        content: `Your response failed validation with these errors:\n${errorList}\n\nFix every error. Output ONLY the corrected JSON:`,
      },
    ],
    systemPrompt,
    modelOverride: MODELS.SONNET,
  });
  const c2 = r2.choices[0]?.message?.content ?? "";
  const v2 = tryExtractAndValidate(c2);
  if (v2.ok) return v2.plan;

  throw new PlanValidationError(
    `Edit plan failed validation after 2 attempts for project ${projectId}`,
    v2.raw ?? v1.raw,
    v2.errors,
  );
}
```

---

### Task 12: `src/video-studio/plan/validator.ts` — pre-render checks + auto-repair

**Files**

| Action | Path |
|--------|------|
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/validator.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/validator.test.ts` |

**Step-by-step TDD**

- [ ] Step 1: Write failing tests
- [ ] Step 2: Confirm fail
- [ ] Step 3: Implement
- [ ] Step 4: Confirm pass
- [ ] Step 5: Lint

**`src/video-studio/plan/validator.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { validateEditPlan, type EditPlan } from "./schema.js";
import { PlanValidationError } from "./planner.js";

export type CheckResult = { ok: true } | { ok: false; errors: string[] };

export async function checkSourcesExist(
  plan: EditPlan,
  projectRoot?: string
): Promise<CheckResult> {
  const root = projectRoot ?? process.cwd();
  const errors: string[] = [];

  await Promise.all(
    plan.sources.map(async (source) => {
      const absPath = isAbsolute(source.path) ? source.path : resolve(root, source.path);
      try {
        await fs.access(absPath);
      } catch {
        errors.push(
          `Source id="${source.id}" path="${source.path}" not found (resolved: ${absPath})`
        );
      }
    })
  );

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function checkDurations(plan: EditPlan): CheckResult {
  const sourceMap = new Map(plan.sources.map((s) => [s.id, s]));
  const errors: string[] = [];

  for (const clip of plan.tracks.video) {
    const source = sourceMap.get(clip.source);
    if (!source) {
      errors.push(`Video clip id="${clip.id}" references unknown source id="${clip.source}"`);
      continue;
    }
    if (clip.in >= clip.out) {
      errors.push(`Video clip id="${clip.id}" has in=${clip.in} >= out=${clip.out}`);
    }
    if (clip.out > source.duration) {
      errors.push(`Video clip id="${clip.id}" out=${clip.out} exceeds source "${clip.source}" duration=${source.duration}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function checkTransitionBetweenExists(plan: EditPlan): CheckResult {
  const videoIds = new Set(plan.tracks.video.map((v) => v.id));
  const errors: string[] = [];

  for (const tx of plan.transitions ?? []) {
    const [a, b] = tx.between;
    if (!videoIds.has(a)) {
      errors.push(`Transition references video id="${a}" which does not exist in tracks.video`);
    }
    if (!videoIds.has(b)) {
      errors.push(`Transition references video id="${b}" which does not exist in tracks.video`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function repairPlan(
  llm: LLMClient,
  badPlan: unknown,
  errors: string[]
): Promise<EditPlan> {
  const badPlanJson = JSON.stringify(badPlan, null, 2);
  const errorList = errors.join("\n");

  const response = await llm.chat({
    messages: [
      {
        role: "user",
        content: `The following edit plan failed validation:\n\`\`\`json\n${badPlanJson}\n\`\`\`\n\nValidation errors:\n${errorList}\n\nFix every error. Output ONLY the corrected JSON:`,
      },
    ],
    modelOverride: MODELS.SONNET,
  });

  const content = response.choices[0]?.message?.content ?? "";
  const extracted = extractJSON(content);

  if (extracted === null) {
    throw new PlanValidationError(
      "repairPlan: LLM repair response contained no valid JSON",
      badPlan,
      errors
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    throw new PlanValidationError(
      "repairPlan: JSON.parse failed on extracted repair response",
      badPlan,
      errors
    );
  }

  const result = validateEditPlan(parsed);
  if (result.ok) return result.plan;

  throw new PlanValidationError(
    "repairPlan: LLM-repaired plan still failed Zod validation",
    parsed,
    result.errors
  );
}
```

Tests exercise: parallel collection of missing paths, duration failures, transition failures, successful LLM repair, repair-still-invalid failure.

---

### Task 13: `src/video-studio/render/ffmpeg-builder.ts` — filter_complex generator

**Files**

| Action | Path |
|--------|------|
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-builder.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-builder.test.ts` |

**`src/video-studio/render/ffmpeg-builder.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export interface DrawtextStyle {
  fontsize?: number;
  fontcolor?: string;
  fontfile?: string;
  x?: number;
  y?: number;
  box?: boolean;
  boxcolor?: string;
  enable?: string;
}

export interface AudioMixOpts {
  normalize?: boolean;
  duration?: "first" | "longest" | "shortest";
}

export interface BuildResult {
  filterGraph: string;
  outputLabels: { video: string; audio: string };
}

export class FilterComplexBuilder {
  private counter = 0;
  private fragments: string[] = [];
  private _outputVideoLabel = "";
  private _outputAudioLabel = "";

  private nextLabel(): string {
    const label = `[l${this.counter}]`;
    this.counter++;
    return label;
  }

  setOutputVideoLabel(label: string): void { this._outputVideoLabel = label; }
  setOutputAudioLabel(label: string): void { this._outputAudioLabel = label; }

  addTrim(sourceIdx: number, inSec: number, outSec: number): string {
    const out = this.nextLabel();
    this.fragments.push(
      `[${sourceIdx}:v]trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS${out}`
    );
    return out;
  }

  addConcat(labels: string[]): string {
    const out = this.nextLabel();
    this.fragments.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0${out}`);
    return out;
  }

  addXfade(
    labelA: string,
    labelB: string,
    kind: string,
    duration: number,
    offset?: number
  ): string {
    const out = this.nextLabel();
    const offsetPart = offset !== undefined ? `:offset=${offset}` : "";
    this.fragments.push(
      `${labelA}${labelB}xfade=transition=${kind}:duration=${duration}${offsetPart}${out}`
    );
    return out;
  }

  addOverlay(
    baseLabel: string,
    overlayLabel: string,
    opts: { x?: number; y?: number; enable?: string }
  ): string {
    const out = this.nextLabel();
    const parts: string[] = [];
    if (opts.x !== undefined) parts.push(`x=${opts.x}`);
    if (opts.y !== undefined) parts.push(`y=${opts.y}`);
    if (opts.enable) parts.push(`enable='${opts.enable}'`);
    const params = parts.length > 0 ? `=${parts.join(":")}` : "";
    this.fragments.push(`${baseLabel}${overlayLabel}overlay${params}${out}`);
    return out;
  }

  addDrawtext(baseLabel: string, text: string, style: DrawtextStyle): string {
    const out = this.nextLabel();
    const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
    const parts: string[] = [`text='${escaped}'`];
    if (style.fontsize !== undefined) parts.push(`fontsize=${style.fontsize}`);
    if (style.fontcolor) parts.push(`fontcolor=${style.fontcolor}`);
    if (style.fontfile) parts.push(`fontfile='${style.fontfile.replace(/:/g, "\\:")}'`);
    if (style.x !== undefined) parts.push(`x=${style.x}`);
    if (style.y !== undefined) parts.push(`y=${style.y}`);
    if (style.box) parts.push("box=1");
    if (style.boxcolor) parts.push(`boxcolor=${style.boxcolor}`);
    if (style.enable) parts.push(`enable='${style.enable}'`);
    this.fragments.push(`${baseLabel}drawtext=${parts.join(":")}${out}`);
    return out;
  }

  addSubtitles(baseLabel: string, assPath: string): string {
    const out = this.nextLabel();
    const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    this.fragments.push(`${baseLabel}subtitles='${escaped}'${out}`);
    return out;
  }

  addAudioMix(audioLabels: string[], opts: AudioMixOpts): string {
    const out = this.nextLabel();
    const n = audioLabels.length;
    const normPart = opts.normalize === false ? ":normalize=0" : "";
    const durPart = opts.duration ? `:duration=${opts.duration}` : "";
    this.fragments.push(`${audioLabels.join("")}amix=inputs=${n}${normPart}${durPart}${out}`);
    return out;
  }

  build(): BuildResult {
    return {
      filterGraph: this.fragments.join(";"),
      outputLabels: { video: this._outputVideoLabel, audio: this._outputAudioLabel },
    };
  }
}
```

Tests assert each method produces the expected filter_complex fragment, labels are unique across 20+ operations, and build() joins with ";".

---

### Task 14: `src/video-studio/render/ffmpeg-renderer.ts` — plan → mp4

**Files**

| Action | Path |
|--------|------|
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-renderer.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-renderer.test.ts` |
| Create | `/Users/user/Desktop/ATLAS/src/video-studio/__fixtures__/1s.mp4` (generated binary) |

**Generate fixture once (commit the binary):**

```bash
node --input-type=module <<'EOF'
import ffmpegStatic from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('src/video-studio/__fixtures__', { recursive: true });
execFileSync(ffmpegStatic, [
  '-f', 'lavfi', '-i', 'color=black:s=640x360:d=1',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-t', '1', '-y',
  'src/video-studio/__fixtures__/1s.mp4'
]);
EOF
```

**`src/video-studio/render/ffmpeg-renderer.ts` (complete)**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import type { EditPlan, Transition } from "../plan/schema.js";
import {
  checkSourcesExist,
  checkDurations,
  checkTransitionBetweenExists,
} from "../plan/validator.js";
import { FilterComplexBuilder } from "./ffmpeg-builder.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";

export enum RenderErrorCategory {
  CodecMissing = "CodecMissing",
  InvalidFilterGraph = "InvalidFilterGraph",
  SourceUnreadable = "SourceUnreadable",
  Unknown = "Unknown",
}

export class RenderError extends Error {
  readonly category: RenderErrorCategory;
  readonly stderrExcerpt: string;
  readonly ffmpegArgs: string[];

  constructor(message: string, category: RenderErrorCategory, stderrExcerpt: string, ffmpegArgs: string[]) {
    super(message);
    this.name = "RenderError";
    this.category = category;
    this.stderrExcerpt = stderrExcerpt;
    this.ffmpegArgs = ffmpegArgs;
  }
}

export interface RenderOpts {
  onProgress?: (percent: number) => void;
}

export interface RenderResult {
  outputPath: string;
  logPath: string;
}

const CODEC_MISSING = [/Decoder.*not found/i, /Encoder.*not found/i, /Unknown encoder/i, /codec.*not found/i];
const INVALID_GRAPH = [/No such filter/i, /Invalid option/i, /Error initializing.*filter/i, /filter chain/i];
const SOURCE_UNREADABLE = [/No such file or directory/i, /moov atom not found/i, /Invalid data found/i, /ENOENT/];

export function classifyRenderError(stderr: string): RenderErrorCategory {
  if (CODEC_MISSING.some((p) => p.test(stderr))) return RenderErrorCategory.CodecMissing;
  if (INVALID_GRAPH.some((p) => p.test(stderr))) return RenderErrorCategory.InvalidFilterGraph;
  if (SOURCE_UNREADABLE.some((p) => p.test(stderr))) return RenderErrorCategory.SourceUnreadable;
  return RenderErrorCategory.Unknown;
}

function absPath(p: string, root: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}

interface Compiled {
  inputs: string[];
  filterGraph: string;
  outputVideoLabel: string;
  outputAudioLabel: string;
  outputPath: string;
}

function compilePlan(plan: EditPlan, projectRoot: string): Compiled {
  const builder = new FilterComplexBuilder();
  const sourceInfo = new Map(
    plan.sources.map((s, i) => [s.id, { idx: i, path: absPath(s.path, projectRoot) }])
  );
  const inputs = plan.sources.map((s) => absPath(s.path, projectRoot));

  const videoLabels = new Map<string, string>();
  for (const clip of plan.tracks.video) {
    const info = sourceInfo.get(clip.source);
    if (!info) continue;
    const label = builder.addTrim(info.idx, clip.in, clip.out);
    videoLabels.set(clip.id, label);
  }

  const transitionMap = new Map(
    (plan.transitions ?? []).map((tx) => [`${tx.between[0]}_${tx.between[1]}`, tx])
  );

  const clipIds = plan.tracks.video.map((v) => v.id);
  let finalVideoLabel = videoLabels.get(clipIds[0])!;

  for (let i = 1; i < clipIds.length; i++) {
    const prevId = clipIds[i - 1];
    const currId = clipIds[i];
    const tx: Transition | undefined = transitionMap.get(`${prevId}_${currId}`);
    const currLabel = videoLabels.get(currId)!;

    if (tx?.type === "xfade" && tx.duration !== undefined) {
      const prevClip = plan.tracks.video.find((v) => v.id === prevId)!;
      const prevLen = prevClip.out - prevClip.in;
      const offset = Math.max(0, prevLen - tx.duration);
      finalVideoLabel = builder.addXfade(finalVideoLabel, currLabel, tx.kind ?? "fade", tx.duration, offset);
    } else {
      finalVideoLabel = builder.addConcat([finalVideoLabel, currLabel]);
    }
  }

  for (const overlay of plan.tracks.overlays ?? []) {
    if (overlay.type === "text") {
      finalVideoLabel = builder.addDrawtext(finalVideoLabel, overlay.content, {
        fontsize: overlay.font_size,
        fontcolor: overlay.font_color ?? "white",
        x: overlay.x,
        y: overlay.y,
        enable: `between(t,${overlay.from},${overlay.to})`,
      });
    }
  }

  builder.setOutputVideoLabel(finalVideoLabel);

  let finalAudioLabel = "";
  const audioTracks = plan.tracks.audio ?? [];
  if (audioTracks.length > 0) {
    for (const at of audioTracks) inputs.push(absPath(at.source, projectRoot));
    const audioLabels = audioTracks.map((_, i) => `[${plan.sources.length + i}:a]`);
    finalAudioLabel = builder.addAudioMix(audioLabels, { normalize: false });
    builder.setOutputAudioLabel(finalAudioLabel);
  }

  const { filterGraph, outputLabels } = builder.build();

  return {
    inputs,
    filterGraph,
    outputVideoLabel: outputLabels.video,
    outputAudioLabel: outputLabels.audio,
    outputPath: absPath(plan.output.path, projectRoot),
  };
}

function buildArgs(compiled: Compiled, plan: EditPlan, progressPath: string): string[] {
  const args: string[] = [];
  const [w, h] = plan.output.resolution.split("x").map(Number);

  for (const inp of compiled.inputs) args.push("-i", inp);

  if (compiled.filterGraph) {
    args.push("-filter_complex", compiled.filterGraph);
  }

  args.push("-map", compiled.outputVideoLabel || "0:v");

  if (compiled.outputAudioLabel) {
    args.push("-map", compiled.outputAudioLabel);
  } else {
    args.push(
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-map", `${compiled.inputs.length}:a`
    );
  }

  args.push(
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-vf", `scale=${w}:${h}`, "-r", String(plan.output.fps),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", progressPath, "-y",
    compiled.outputPath
  );

  return args;
}

function simplifyPlan(plan: EditPlan): EditPlan {
  return {
    ...plan,
    transitions: (plan.transitions ?? []).map((tx) => ({ ...tx, type: "cut" as const })),
    tracks: {
      ...plan.tracks,
      video: plan.tracks.video.map((v) => ({ ...v, effects: undefined })),
    },
  };
}

async function runFFmpeg(
  binPath: string,
  args: string[],
  logPath: string,
  totalDuration: number,
  onProgress?: (pct: number) => void
): Promise<void> {
  await fs.mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  let stderr = "";

  return new Promise<void>((res, rej) => {
    const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      log.write(text);
      stderr = (stderr + text).slice(-8192);

      if (onProgress && totalDuration > 0) {
        const m = text.match(/out_time_ms=(\d+)/);
        if (m) {
          const secs = parseInt(m[1], 10) / 1_000_000;
          onProgress(Math.min(100, Math.round((secs / totalDuration) * 100)));
        }
      }
    });

    proc.stdout?.on("data", (chunk: Buffer) => log.write(chunk));

    proc.on("close", (code) => {
      log.end();
      if (code === 0) {
        res();
      } else {
        rej(
          new RenderError(
            `ffmpeg exited with code ${code}`,
            classifyRenderError(stderr),
            stderr.slice(-2000),
            args
          )
        );
      }
    });

    proc.on("error", (err) => {
      log.end();
      rej(new RenderError(`ffmpeg spawn error: ${err.message}`, RenderErrorCategory.Unknown, err.message, args));
    });
  });
}

export async function renderPlan(
  plan: EditPlan,
  projectRoot: string,
  opts: RenderOpts = {}
): Promise<RenderResult> {
  const sc = await checkSourcesExist(plan, projectRoot);
  if (!sc.ok) {
    throw new RenderError(
      `Pre-render: ${sc.errors.join("; ")}`,
      RenderErrorCategory.SourceUnreadable,
      sc.errors.join("\n"),
      []
    );
  }

  const dc = checkDurations(plan);
  if (!dc.ok) {
    throw new RenderError(
      `Pre-render: ${dc.errors.join("; ")}`,
      RenderErrorCategory.InvalidFilterGraph,
      dc.errors.join("\n"),
      []
    );
  }

  const tc = checkTransitionBetweenExists(plan);
  if (!tc.ok) {
    throw new RenderError(
      `Pre-render: ${tc.errors.join("; ")}`,
      RenderErrorCategory.InvalidFilterGraph,
      tc.errors.join("\n"),
      []
    );
  }

  const binPath = ffmpegPath();

  const ts = Date.now();
  const rendersDir = resolve(projectRoot, "renders");
  await fs.mkdir(rendersDir, { recursive: true });

  const logPath = join(rendersDir, `render-${ts}.log`);
  const progressPath = join(rendersDir, `progress-${ts}.txt`);

  const totalDuration = plan.tracks.video.reduce((s, clip) => s + (clip.out - clip.in), 0);

  const compiled = compilePlan(plan, projectRoot);
  await fs.mkdir(dirname(compiled.outputPath), { recursive: true });
  const args = buildArgs(compiled, plan, progressPath);

  try {
    await runFFmpeg(binPath, args, logPath, totalDuration, opts.onProgress);
    return { outputPath: compiled.outputPath, logPath };
  } catch (err) {
    if (err instanceof RenderError && err.category === RenderErrorCategory.InvalidFilterGraph) {
      const simple = simplifyPlan(plan);
      const sc2 = compilePlan(simple, projectRoot);
      const retryLog = join(rendersDir, `render-${ts}-retry.log`);
      const retryProgress = join(rendersDir, `progress-${ts}-retry.txt`);
      await fs.mkdir(dirname(sc2.outputPath), { recursive: true });
      const retryArgs = buildArgs(sc2, simple, retryProgress);
      await runFFmpeg(binPath, retryArgs, retryLog, totalDuration, opts.onProgress);
      return { outputPath: sc2.outputPath, logPath: retryLog };
    }
    throw err;
  }
}
```

Tests: unit-level `classifyRenderError`, pre-render check failure paths (SourceUnreadable, InvalidFilterGraph), integration success path against `__fixtures__/1s.mp4` — asserts ffprobe-readable output and `onProgress` values in [0,100].

---

### Milestone commit — end of Layer C (after Task 14)

```bash
git add \
  src/video-studio/plan/schema.ts \
  src/video-studio/plan/planner.ts \
  src/video-studio/plan/validator.ts \
  src/video-studio/plan/__tests__/schema.test.ts \
  src/video-studio/plan/__tests__/planner.test.ts \
  src/video-studio/plan/__tests__/validator.test.ts \
  src/video-studio/render/ffmpeg-builder.ts \
  src/video-studio/render/ffmpeg-renderer.ts \
  src/video-studio/render/__tests__/ffmpeg-builder.test.ts \
  src/video-studio/render/__tests__/ffmpeg-renderer.test.ts \
  src/video-studio/__fixtures__/1s.mp4

git commit -m "feat(video-studio): plan schema + validator + ffmpeg renderer"
```

---

## Layer D — Effects, Tools, Wiring, Smoke test (Tasks 15-22)

*Goal: complete the user-facing surface. Word-level karaoke ASS captions, librosa beat-sync cut snapping, bundled CC0 SFX pack, free/CC music library with cached downloads, seven `video_*` tools (including a safety-gated `video_ffmpeg` escape hatch), registry/router wiring (new `video_editing` category), pipeline-first skill rewrite, and an end-to-end smoke test that verifies the whole pipeline on a generated 2-second fixture.*

*Milestone commit at end of Task 22: `feat(video-studio): effects, tools, skill, smoke test`*

---

### Task 15: `src/video-studio/effects/captions.ts` — word-level ASS subtitle generator

**Files:**
- Create: `src/video-studio/effects/captions.ts`
- Create: `src/video-studio/effects/__tests__/captions.test.ts`

**Interfaces:**
```typescript
export type CaptionStyle = "reel_karaoke" | "minimal" | "bold";
export interface CaptionOpts {
  style: CaptionStyle;
  highlightColor?: string;
}
export function generateCaptionsASS(
  transcript: Transcript,
  opts: CaptionOpts,
  outputPath: string
): Promise<string>;
```

- [ ] **Step 1 — Write failing tests in `src/video-studio/effects/__tests__/captions.test.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateCaptionsASS } from "../captions.js";
import type { Transcript } from "../../analyze/transcribe.js";

const SAMPLE_TRANSCRIPT: Transcript = {
  language: "en",
  segments: [{
    start: 0, end: 2,
    text: "Hello world this is Atlas",
    words: [
      { word: "Hello", start: 0.00, end: 0.40, confidence: 0.95 },
      { word: "world", start: 0.45, end: 0.90, confidence: 0.95 },
      { word: "this",  start: 1.10, end: 1.35, confidence: 0.95 },
      { word: "is",    start: 1.40, end: 1.55, confidence: 0.95 },
      { word: "Atlas", start: 1.60, end: 2.00, confidence: 0.95 },
    ],
  }],
};

describe("generateCaptionsASS", () => {
  let outDir: string;
  beforeEach(async () => { outDir = await fs.mkdtemp(join(tmpdir(), "captions-test-")); });
  afterEach(async () => { await fs.rm(outDir, { recursive: true, force: true }); });

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
    expect(Number.parseInt(styleMatch![1], 10)).toBeGreaterThanOrEqual(60);
  });

  it("minimal uses small bottom-aligned font (size <= 36)", async () => {
    const outPath = join(outDir, "minimal.ass");
    await generateCaptionsASS(SAMPLE_TRANSCRIPT, { style: "minimal" }, outPath);
    const content = await fs.readFile(outPath, "utf-8");
    const styleMatch = content.match(/Style: Atlas,.+?,(\d+),/);
    expect(Number.parseInt(styleMatch![1], 10)).toBeLessThanOrEqual(36);
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
```

- [ ] **Step 2 — Confirm fail**

- [ ] **Step 3 — Implement `src/video-studio/effects/captions.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Transcript, TranscriptWord } from "../analyze/transcribe.js";

export type CaptionStyle = "reel_karaoke" | "minimal" | "bold";

export interface CaptionOpts {
  style: CaptionStyle;
  highlightColor?: string;
}

function toASSTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToASSColor(hex: string): string {
  const h = hex.replace("#", "");
  const r = h.substring(0, 2);
  const g = h.substring(2, 4);
  const b = h.substring(4, 6);
  return `&H00${b}${g}${r}&`.toUpperCase();
}

interface StylePreset {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;
  outlineColor: string;
  bold: boolean;
  alignment: number;
  marginV: number;
  outline: number;
  shadow: number;
}

const PRESETS: Record<CaptionStyle, StylePreset> = {
  reel_karaoke: {
    fontName: "Arial Black", fontSize: 72,
    primaryColor: "&H00FFFFFF&", secondaryColor: "&H00AAAAAA&",
    outlineColor: "&H00000000&", bold: true,
    alignment: 5, marginV: 40, outline: 3, shadow: 1,
  },
  minimal: {
    fontName: "Arial", fontSize: 32,
    primaryColor: "&H00FFFFFF&", secondaryColor: "&H00FFFFFF&",
    outlineColor: "&H00000000&", bold: false,
    alignment: 2, marginV: 30, outline: 1, shadow: 0,
  },
  bold: {
    fontName: "Impact", fontSize: 56,
    primaryColor: "&H00FFFFFF&", secondaryColor: "&H00CCCCCC&",
    outlineColor: "&H00000000&", bold: true,
    alignment: 5, marginV: 40, outline: 2, shadow: 1,
  },
};

function groupWordsIntoLines(words: TranscriptWord[], maxWordsPerLine = 5): TranscriptWord[][] {
  const lines: TranscriptWord[][] = [];
  for (let i = 0; i < words.length; i += maxWordsPerLine) {
    lines.push(words.slice(i, i + maxWordsPerLine));
  }
  return lines;
}

function buildStyleLine(preset: StylePreset): string {
  const bold = preset.bold ? -1 : 0;
  return (
    `Style: Atlas,${preset.fontName},${preset.fontSize},` +
    `${preset.primaryColor},${preset.secondaryColor},${preset.outlineColor},&H80000000&,` +
    `${bold},0,0,0,100,100,0,0,1,${preset.outline},${preset.shadow},` +
    `${preset.alignment},10,10,${preset.marginV},1`
  );
}

function buildKaraokeDialogue(words: TranscriptWord[]): string {
  const lineStart = words[0].start;
  const lineEnd = words[words.length - 1].end;
  const parts = words.map((w) => {
    const durationCs = Math.max(1, Math.round((w.end - w.start) * 100));
    return `{\\k${durationCs}}${w.word}`;
  });
  return `Dialogue: 0,${toASSTime(lineStart)},${toASSTime(lineEnd)},Atlas,,0,0,0,,${parts.join(" ")}`;
}

function buildPlainDialogue(words: TranscriptWord[]): string {
  const lineStart = words[0].start;
  const lineEnd = words[words.length - 1].end;
  const text = words.map((w) => w.word).join(" ");
  return `Dialogue: 0,${toASSTime(lineStart)},${toASSTime(lineEnd)},Atlas,,0,0,0,,${text}`;
}

export async function generateCaptionsASS(
  transcript: Transcript,
  opts: CaptionOpts,
  outputPath: string
): Promise<string> {
  const preset = { ...PRESETS[opts.style] };

  if (opts.style === "reel_karaoke" && opts.highlightColor) {
    preset.secondaryColor = hexToASSColor(opts.highlightColor);
  } else if (opts.style === "reel_karaoke") {
    preset.secondaryColor = hexToASSColor("#FFD700");
  }

  const allWords = transcript.segments.flatMap((s) => s.words ?? []);
  const lines = groupWordsIntoLines(allWords, 5);

  const dialogueLines =
    opts.style === "reel_karaoke"
      ? lines.map(buildKaraokeDialogue)
      : lines.map(buildPlainDialogue);

  const ass = [
    "[Script Info]",
    `; Generated by ATLAS Video Studio — ${new Date().toISOString()}`,
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    buildStyleLine(preset),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogueLines,
    "",
  ].join("\n");

  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, ass, "utf-8");
  return outputPath;
}
```

- [ ] **Step 4 — Run tests, confirm pass**
- [ ] **Step 5 — Lint**

---

### Task 16: `src/video-studio/effects/beat-sync.ts` — beat detection + cut snapping

**Files:**
- Create: `src/video-studio/effects/beat-sync.ts`
- Create: `src/video-studio/python/beat_detect.py`
- Create: `src/video-studio/effects/__tests__/beat-sync.test.ts`

**Interfaces:**
```typescript
export function detectBeats(audioPath: string): Promise<number[]>;
export function snapCutsToBeats(plan: EditPlan, beats: number[], tolerance?: number): EditPlan;
```

- [ ] **Step 1 — Create `src/video-studio/python/beat_detect.py`**

```python
#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import sys
import json

def main():
    if len(sys.argv) < 2:
        print("[]")
        sys.exit(0)
    audio_path = sys.argv[1]
    try:
        import librosa
        y, sr = librosa.load(audio_path, mono=True)
        _, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
        print(json.dumps(beat_times))
    except Exception as e:
        sys.stderr.write(f"beat_detect error: {e}\n")
        print("[]")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2 — Write failing tests**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { snapCutsToBeats } from "../beat-sync.js";
import type { EditPlan } from "../../plan/schema.js";

function makePlan(clips: Array<{ id: string; in: number; out: number }>): EditPlan {
  return {
    projectId: "test",
    output: { path: "renders/out.mp4", aspect: "16:9", fps: 30, resolution: "1920x1080" },
    sources: clips.map((c) => ({ id: c.id, path: `inputs/${c.id}.mp4`, duration: c.out + 5 })),
    tracks: {
      video: clips.map((c) => ({ id: `v_${c.id}`, source: c.id, in: c.in, out: c.out })),
      audio: [],
      overlays: [],
    },
    transitions: [],
    export_targets: ["mp4"],
  } as EditPlan;
}

describe("snapCutsToBeats", () => {
  const BEATS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

  it("snaps cuts to nearest beat within default 0.15s tolerance", () => {
    const plan = makePlan([{ id: "s1", in: 0.08, out: 0.98 }]);
    const result = snapCutsToBeats(plan, BEATS);
    expect(result.tracks.video[0].in).toBe(0.0);
    expect(result.tracks.video[0].out).toBe(1.0);
  });

  it("leaves cuts outside tolerance unchanged", () => {
    const plan = makePlan([{ id: "s1", in: 0.30, out: 1.80 }]);
    const result = snapCutsToBeats(plan, BEATS, 0.15);
    expect(result.tracks.video[0].in).toBeCloseTo(0.30);
    expect(result.tracks.video[0].out).toBeCloseTo(1.80);
  });

  it("respects custom tolerance", () => {
    const plan = makePlan([{ id: "s1", in: 0.30, out: 0.90 }]);
    const result = snapCutsToBeats(plan, BEATS, 0.25);
    expect(result.tracks.video[0].in).toBe(0.5);
  });

  it("returns a new object (does not mutate)", () => {
    const plan = makePlan([{ id: "s1", in: 0.08, out: 0.98 }]);
    const result = snapCutsToBeats(plan, BEATS);
    expect(result).not.toBe(plan);
    expect(plan.tracks.video[0].in).toBeCloseTo(0.08);
  });

  it("returns plan unchanged with empty beats", () => {
    const plan = makePlan([{ id: "s1", in: 0.5, out: 1.5 }]);
    const result = snapCutsToBeats(plan, []);
    expect(result.tracks.video[0].in).toBeCloseTo(0.5);
  });
});

describe("detectBeats", () => {
  beforeEach(() => { vi.resetModules(); });

  it("parses librosa JSON output", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (_b: string, _a: string[], _o: unknown, cb: Function) => {
        cb(null, JSON.stringify([0.5, 1.0, 1.5]), "");
      },
    }));
    const { detectBeats } = await import("../beat-sync.js");
    const beats = await detectBeats("/tmp/fake.mp3");
    expect(beats).toEqual([0.5, 1.0, 1.5]);
  });

  it("throws on python failure", async () => {
    vi.doMock("node:child_process", () => ({
      execFile: (_b: string, _a: string[], _o: unknown, cb: Function) => {
        cb(new Error("python not found"), "", "python not found");
      },
    }));
    const { detectBeats } = await import("../beat-sync.js");
    await expect(detectBeats("/tmp/fake.mp3")).rejects.toThrow(/beat detection failed/i);
  });
});
```

- [ ] **Step 3 — Implement `src/video-studio/effects/beat-sync.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditPlan, VideoTrack } from "../plan/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_SCRIPT = join(__dirname, "../python/beat_detect.py");

function nearestBeat(t: number, beats: number[]): { beat: number; distance: number } {
  let best = beats[0];
  let bestDist = Math.abs(t - beats[0]);
  for (const b of beats) {
    const d = Math.abs(t - b);
    if (d < bestDist) { best = b; bestDist = d; }
  }
  return { beat: best, distance: bestDist };
}

export function detectBeats(audioPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [PYTHON_SCRIPT, audioPath],
      { maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Beat detection failed for "${audioPath}": ${err.message}${stderr ? ` — ${stderr.trim()}` : ""}`
            )
          );
          return;
        }
        try {
          const beats = JSON.parse(stdout.trim()) as number[];
          resolve(Array.isArray(beats) ? beats : []);
        } catch (parseErr) {
          reject(new Error(`Beat detection: failed to parse librosa output — ${String(parseErr)}`));
        }
      }
    );
  });
}

export function snapCutsToBeats(
  plan: EditPlan,
  beats: number[],
  tolerance = 0.15
): EditPlan {
  if (beats.length === 0) return plan;

  const snappedClips: VideoTrack[] = plan.tracks.video.map((clip) => {
    const nearIn = nearestBeat(clip.in, beats);
    const nearOut = nearestBeat(clip.out, beats);
    return {
      ...clip,
      in: nearIn.distance <= tolerance ? nearIn.beat : clip.in,
      out: nearOut.distance <= tolerance ? nearOut.beat : clip.out,
    };
  });

  return {
    ...plan,
    tracks: { ...plan.tracks, video: snappedClips },
  };
}
```

- [ ] **Step 4 — Run tests, confirm pass**
- [ ] **Step 5 — Lint**

---

### Task 17: `src/video-studio/assets/sfx-pack.ts` — bundled SFX index

**Files:**
- Create: `src/video-studio/assets/sfx/index.json` (manifest of 20 CC0-licensed SFX)
- Create: `src/video-studio/assets/sfx-pack.ts`
- Create: `src/video-studio/assets/__tests__/sfx-pack.test.ts`

Note: Binary .mp3 files are fetched at install time by `scripts/postinstall-video.ts` (extended in a later patch) or manually; the plan/design layer only requires the manifest.

**`src/video-studio/assets/sfx/index.json`:**

```json
[
  { "name": "whoosh_fast",        "category": "whoosh",       "duration": 0.4, "license": "CC0" },
  { "name": "whoosh_soft",        "category": "whoosh",       "duration": 0.5, "license": "CC0" },
  { "name": "pop_bubble",         "category": "pop",          "duration": 0.3, "license": "CC0" },
  { "name": "pop_deep",           "category": "pop",          "duration": 0.4, "license": "CC0" },
  { "name": "ding_bright",        "category": "ding",         "duration": 1.2, "license": "CC0" },
  { "name": "ding_soft",          "category": "ding",         "duration": 0.9, "license": "CC0" },
  { "name": "swoosh_down",        "category": "whoosh",       "duration": 0.6, "license": "CC0" },
  { "name": "swoosh_up",          "category": "whoosh",       "duration": 0.6, "license": "CC0" },
  { "name": "impact_thud",        "category": "impact",       "duration": 0.5, "license": "CC0" },
  { "name": "impact_hit",         "category": "impact",       "duration": 0.3, "license": "CC0" },
  { "name": "transition_snap",    "category": "transition",   "duration": 0.2, "license": "CC0" },
  { "name": "transition_shutter", "category": "transition",   "duration": 0.4, "license": "CC0" },
  { "name": "notification_chime", "category": "notification", "duration": 1.5, "license": "CC0" },
  { "name": "error_buzz",         "category": "notification", "duration": 0.6, "license": "CC0" },
  { "name": "success_sparkle",    "category": "notification", "duration": 0.8, "license": "CC0" },
  { "name": "typing_single",      "category": "typing",       "duration": 0.1, "license": "CC0" },
  { "name": "laser_zap",          "category": "impact",       "duration": 0.5, "license": "CC0" },
  { "name": "electric_crackle",   "category": "ambient",      "duration": 0.7, "license": "CC0" },
  { "name": "crowd_cheer_short",  "category": "ambient",      "duration": 2.0, "license": "CC0" },
  { "name": "camera_shutter",     "category": "transition",   "duration": 0.3, "license": "CC0" }
]
```

**`src/video-studio/assets/sfx-pack.ts`:**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SFX_DIR = join(__dirname, "sfx");
const _require = createRequire(import.meta.url);

export type SFXCategory =
  | "whoosh" | "pop" | "ding" | "impact"
  | "transition" | "notification" | "typing" | "ambient";

export interface SFXEntry {
  name: string;
  category: SFXCategory;
  path: string;
  duration: number;
  license: string;
}

interface ManifestEntry {
  name: string;
  category: SFXCategory;
  duration: number;
  license: string;
}

const _rawManifest: ManifestEntry[] = _require("./sfx/index.json") as ManifestEntry[];

const _index: Map<string, SFXEntry> = new Map(
  _rawManifest.map((m) => [
    m.name,
    { ...m, path: join(SFX_DIR, `${m.name}.mp3`) },
  ])
);

export function listSFX(): SFXEntry[] {
  return [..._index.values()];
}

export function getSFX(name: string): string {
  if (!name) throw new Error("getSFX: name must be a non-empty string");
  const entry = _index.get(name);
  if (!entry) {
    throw new Error(`Unknown SFX: "${name}". Available: ${[..._index.keys()].join(", ")}`);
  }
  return entry.path;
}
```

Tests assert listSFX >= 20 entries, all have required fields, getSFX throws on unknown name.

---

### Task 18: `src/video-studio/assets/music-library.ts` — free/CC music index

**Files:**
- Create: `src/video-studio/assets/music/index.json` (10+ free/CC tracks manifest)
- Create: `src/video-studio/assets/music-library.ts`
- Create: `src/video-studio/assets/__tests__/music-library.test.ts`

**`src/video-studio/assets/music-library.ts`:**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const _require = createRequire(import.meta.url);
const MUSIC_CACHE_DIR = path.resolve(
  process.env.ATLAS_DATA_DIR ?? "data",
  "video-studio",
  "music-cache"
);

export interface MusicEntry {
  title: string;
  artist: string;
  url: string;
  license: string;
  mood: string[];
  bpm: number;
  durationSec: number;
}

export interface MusicSearchQuery {
  mood?: string;
  bpm?: number;
  duration?: number;
}

const _manifest: MusicEntry[] = _require("./music/index.json") as MusicEntry[];

function urlCacheKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

function cachedPath(entry: MusicEntry, dir: string): string {
  const key = urlCacheKey(entry.url);
  return join(dir, `${key}.mp3`);
}

export async function searchMusic(query: MusicSearchQuery): Promise<MusicEntry[]> {
  return _manifest.filter((entry) => {
    if (query.mood) {
      const keyword = query.mood.toLowerCase();
      if (!entry.mood.some((m) => m.toLowerCase().includes(keyword))) return false;
    }
    if (query.bpm !== undefined && Math.abs(entry.bpm - query.bpm) > 10) return false;
    if (query.duration !== undefined && entry.durationSec < query.duration) return false;
    return true;
  });
}

export async function downloadMusic(entry: MusicEntry, destDir: string): Promise<string> {
  await fs.mkdir(MUSIC_CACHE_DIR, { recursive: true });
  await fs.mkdir(destDir, { recursive: true });

  const cached = cachedPath(entry, MUSIC_CACHE_DIR);
  const dest = cachedPath(entry, destDir);

  try {
    await fs.access(cached);
    if (cached !== dest) await fs.copyFile(cached, dest);
    return dest;
  } catch { /* not cached */ }

  let response: Response;
  try {
    response = await fetch(entry.url);
  } catch (err) {
    throw new Error(
      `Music download failed (offline or network error): ${entry.url} — ${String(err)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Music download HTTP error ${response.status} ${response.statusText}: ${entry.url}`
    );
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(cached, new Uint8Array(buffer));
  if (cached !== dest) await fs.copyFile(cached, dest);
  return dest;
}
```

Tests: search by mood/bpm/duration (AND logic), cache hit on 2nd download call, offline error message, 4xx rejection.

---

### Task 19: `src/tools/video-studio.ts` — 7 tool surface

Exports 7 `ToolDefinition` objects, each a handler that wraps the corresponding `src/video-studio/index.ts` function and returns `JSON.stringify({success, ...}|{error})`:

- `videoCreateProject` → `createProject(inputs)`
- `videoAnalyze` → `buildTimeline(videoPaths, projectRoot)`
- `videoPlanEdit` → `planEdit({llm, timeline, userIntent, projectId})` + writes `edit_plan.json`
- `videoRender` → reads `edit_plan.json`, applies captions/beat-sync if referenced, calls `renderPlan(plan, projectRoot)`
- `videoPatchPlan` → RFC 6902 JSON Patch on `edit_plan.json`, re-validates
- `videoFfmpeg` (escape hatch) → raw `ffmpeg-static` with SAFETY CHECK:
  - reject URLs (`http://`, `https://`) after `-i`
  - reject path traversal (`..`)
  - require input paths inside `data/video-projects/` or `/tmp/`
- `videoListProjects` → `listProjects()`

**Full file** follows the `ToolDefinition` pattern from `src/tools/get-current-time.ts`. Handler returns `JSON.stringify(...)`.

The full code is long but each handler follows the pattern:

```typescript
export const videoCreateProject: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "video_create_project",
      description: "Create a new video editing project and copy input files into it. Returns a projectId.",
      parameters: {
        type: "object",
        properties: {
          inputs: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths to input video files."
          }
        },
        required: ["inputs"],
      },
    },
  },
  async handler(input) {
    const inputs = input.inputs as string[] | undefined;
    if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
      return JSON.stringify({ error: "inputs must be a non-empty array of file paths" });
    }
    try {
      const project = await createProject(inputs);
      return JSON.stringify({ success: true, projectId: project.id, rootDir: project.rootDir });
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }
  },
};
```

**Safety gate for `videoFfmpeg`:**

```typescript
import { normalize, resolve as pathResolve } from "node:path";

const ALLOWED_INPUT_PREFIXES = [
  normalize(pathResolve("data/video-projects")),
  "/tmp/",
  normalize(pathResolve("data/video-studio")),
];

function isAllowedInputPath(p: string): boolean {
  if (/^https?:\/\//i.test(p)) return false;
  if (p.includes("..")) return false;
  const normalized = normalize(pathResolve(p));
  return ALLOWED_INPUT_PREFIXES.some((allowed) => normalized.startsWith(allowed));
}

function validateFfmpegArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i" && i + 1 < args.length) {
      const inputPath = args[i + 1];
      if (!isAllowedInputPath(inputPath)) {
        return `Blocked: -i "${inputPath}" is outside allowed directories.`;
      }
    }
  }
  return null;
}
```

**Tests** (`src/tools/__tests__/video-studio.test.ts`):
- All 7 tools have `schema.type === "function"`
- All 7 names begin with `video_` and are unique
- Each handler returns a JSON string with `success` or `error`
- `videoFfmpeg` rejects URLs, path traversal, and paths outside allowed dirs
- `videoFfmpeg` accepts paths inside `data/video-projects/`

TDD flow: write tests → fail → implement → pass → lint.

---

### Task 20: Wire tools into registry + router

**Files to modify:**
- `src/tools/index.ts` — import the 7 tools, add `registry.set(...)` lines
- `src/tool-router.ts` — add new `video_editing` category, remove `davinci_script`/`blender_script` from `media`
- Create `src/tools/__tests__/video-studio-registry.test.ts`

**Exact diffs:**

**`src/tools/index.ts`** — after line 27 (`import { davinciScript } from "./video.js";`) add:

```typescript
import {
    videoCreateProject,
    videoAnalyze,
    videoPlanEdit,
    videoRender,
    videoPatchPlan,
    videoFfmpeg,
    videoListProjects,
} from "./video-studio.js";
```

After line 249 (`registry.set(davinciScript.schema.function.name, davinciScript);`) add:

```typescript
// Video Studio tools
registry.set(videoCreateProject.schema.function.name, videoCreateProject);
registry.set(videoAnalyze.schema.function.name, videoAnalyze);
registry.set(videoPlanEdit.schema.function.name, videoPlanEdit);
registry.set(videoRender.schema.function.name, videoRender);
registry.set(videoPatchPlan.schema.function.name, videoPatchPlan);
registry.set(videoFfmpeg.schema.function.name, videoFfmpeg);
registry.set(videoListProjects.schema.function.name, videoListProjects);
```

**`src/tool-router.ts`** — modify the `media` category (around line 162) by removing `"blender_script"` and `"davinci_script"` from its tools list.

Then add this new block immediately after the `media` block:

```typescript
video_editing: {
    description: "Full video editing pipeline: cut, trim, join, render videos; make reels, shorts, TikToks; add captions, subtitles, transitions (fade, xfade, dissolve), music with beat-sync, sound effects; background removal; auto-crop to vertical; export to DaVinci Resolve or Premiere. Use for any task that involves editing, combining, or producing video content from one or more video files.",
    tools: [
        "video_create_project", "video_analyze", "video_plan_edit",
        "video_render", "video_patch_plan", "video_ffmpeg",
        "video_list_projects", "davinci_script", "blender_script",
    ],
},
```

**Test** (`src/tools/__tests__/video-studio-registry.test.ts`):

```typescript
import { describe, it, expect } from "vitest";

describe("video studio registry", () => {
  it("all 7 video_ tools are registered", async () => {
    const { getToolSchemasByNames } = await import("../index.js");
    const names = [
      "video_create_project", "video_analyze", "video_plan_edit",
      "video_render", "video_patch_plan", "video_ffmpeg", "video_list_projects",
    ];
    const schemas = getToolSchemasByNames(names);
    expect(schemas).toHaveLength(7);
  });
});
```

TDD flow: write tests → fail → apply diffs → pass.

---

### Task 21: Rewrite `skills/video_editing.md`

**File:** `/Users/user/Desktop/ATLAS/skills/video_editing.md` — complete replacement.

**New content (full file):**

```markdown
---
name: Video Editor
role: video_editor
description: Full video editing pipeline — create projects, analyze footage, plan edits, render output, and deliver reels, shorts, TikToks, and long-form videos.
triggers:
  - video
  - edit
  - cut
  - trim
  - join
  - reel
  - tiktok
  - short
  - caption
  - subtitle
  - transition
  - background removal
  - render
  - highlight reel
  - montage
  - overlay
  - music sync
  - beat sync
  - green screen
  - aspect ratio
  - vertical video
  - horizontal video
  - compress video
  - ffmpeg
---

## The Four-Step Pipeline

Every video editing task follows this exact sequence. Never skip steps.

### 1. Create project (`video_create_project`)
Pass input file paths. Copies into a durable project directory. Returns `projectId`.

### 2. Analyze footage (`video_analyze`)
Scene detection + frame captioning + word-level transcription. Results hash-cached.

### 3. Plan the edit (`video_plan_edit`)
Natural-language intent → validated `edit_plan.json`. Review before rendering.

### 4. Render (`video_render`)
Executes plan via FFmpeg. Captions and beat-sync auto-apply.

---

## When to patch vs re-plan

- **`video_patch_plan`** (JSON Patch): one field changes — aspect ratio, a single in/out, volume.
- **Re-run `video_plan_edit`**: user intent has changed substantially, or 3+ values need changing.

---

## Aspect ratio from user signals

| User says | Aspect |
|---|---|
| reel, short, TikTok, vertical, 9:16 | 9:16 (1080x1920) |
| YouTube, landscape, 16:9 | 16:9 (1920x1080) |
| square, Instagram post, 1:1 | 1:1 (1080x1080) |
| (no mention) | 16:9 default |

Always surface the assumed aspect to the user before rendering.

---

## Caption styles

- `reel_karaoke` — large bold centered, per-word color flip. Best for reels/TikToks.
- `minimal` — small white bottom, thin outline. Best for tutorials/professional.
- `bold` — Impact font, classic viral caption. Best for memes/punchlines.

---

## When `video_ffmpeg` is appropriate

Never first choice. Only for:
- Specific codec conversion the pipeline doesn't support.
- Extracting a single stream.
- Debugging a render failure.

Input paths must be inside `data/video-projects/` or `/tmp/`.

---

## Multi-video workflow

`video_create_project([a.mp4, b.mp4])` → `video_analyze` → `video_plan_edit("join with fade, add music")` → `video_render`.

---

## Music and beat sync

- Planner adds `audio` track in plan.
- `duck_on_speech: true` auto-lowers music during speech.
- `sync_to_beats: true` snaps cuts to beat grid via librosa.
- Source music via `searchMusic({mood, bpm})` or user file.

---

## Error recovery

- FFmpeg codec error → add `-c:v libx264 -c:a aac` intermediate, retry.
- Scene detection fails → auto fallback to 5s keyframe sampling.
- Beat-sync (librosa) unavailable → omit from plan, render without.
- Plan validation error → patch the specific invalid field, don't re-plan everything.
```

Single commit after writing: `chore(skills): rewrite video_editing skill for pipeline-first workflow` (bundled into final milestone commit).

---

### Task 22: `scripts/video-studio-smoke.ts` — end-to-end smoke test

**Files:**
- Modify: `package.json` — add `"smoke:video": "tsx scripts/video-studio-smoke.ts"`
- Create: `src/video-studio/__fixtures__/generate-2s.ts`
- Create: `scripts/video-studio-smoke.ts`

**`src/video-studio/__fixtures__/generate-2s.ts`:**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ffmpegPath } from "../util/ffmpeg-bin.js";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const FIXTURE_PATH = join(__dirname, "2s.mp4");

export async function ensureFixture(): Promise<string> {
  try {
    await fs.access(FIXTURE_PATH);
    return FIXTURE_PATH;
  } catch { /* generate */ }

  await execFileAsync(ffmpegPath(), [
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "2",
    "-c:v", "libx264", "-c:a", "aac",
    "-shortest", "-y",
    FIXTURE_PATH,
  ]);

  return FIXTURE_PATH;
}
```

**`scripts/video-studio-smoke.ts`:**

```typescript
#!/usr/bin/env tsx
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "../src/video-studio/project.js";
import { buildTimeline } from "../src/video-studio/analyze/timeline-builder.js";
import { renderPlan } from "../src/video-studio/render/ffmpeg-renderer.js";
import { ffprobePath } from "../src/video-studio/util/ffmpeg-bin.js";
import { ensureFixture } from "../src/video-studio/__fixtures__/generate-2s.js";

const execFileAsync = promisify(execFile);

function log(msg: string): void { process.stdout.write(`[smoke:video] ${msg}\n`); }
function fail(msg: string): never {
  process.stderr.write(`[smoke:video] FAIL: ${msg}\n`);
  process.exit(1);
}

async function assertFileExists(path: string, label: string): Promise<void> {
  try {
    const stat = await fs.stat(path);
    if (stat.size === 0) fail(`${label} exists but is empty: ${path}`);
    log(`  OK  ${label}: ${path} (${stat.size} bytes)`);
  } catch {
    fail(`${label} not found: ${path}`);
  }
}

async function ffprobeReadable(path: string): Promise<void> {
  const { stdout } = await execFileAsync(
    ffprobePath(),
    ["-v", "quiet", "-print_format", "json", "-show_format", path],
    { timeout: 30_000 }
  );
  const probe = JSON.parse(stdout) as { format?: { duration?: string } };
  const dur = Number.parseFloat(probe.format?.duration ?? "0");
  if (dur <= 0) fail(`ffprobe reports zero duration for ${path}`);
  log(`  OK  ffprobe: duration=${dur.toFixed(2)}s`);
}

async function main(): Promise<void> {
  log("Starting video-studio smoke test...");

  log("Step 1: Ensuring 2s fixture...");
  const fixturePath = await ensureFixture();
  await assertFileExists(fixturePath, "fixture");

  log("Step 2: Creating project...");
  const project = await createProject([fixturePath]);
  log(`  projectId: ${project.id}`);

  log("Step 3: Analyzing footage...");
  await buildTimeline([project.inputs[0]], project.rootDir);
  log(`  timeline.json written`);

  log("Step 4: Writing test edit_plan.json...");
  const renderOutput = "renders/smoke_out.mp4";
  const plan = {
    projectId: project.id,
    output: { path: renderOutput, aspect: "16:9" as const, fps: 30, resolution: "640x360" },
    sources: [{ id: "s1", path: project.inputs[0], duration: 2.0 }],
    tracks: {
      video: [{ id: "v1", source: "s1", in: 0, out: 2.0 }],
      audio: [],
      overlays: [],
    },
    transitions: [],
    export_targets: ["mp4" as const],
  };
  await fs.writeFile(project.planPath, JSON.stringify(plan, null, 2), "utf-8");
  log(`  plan written to: ${project.planPath}`);

  log("Step 5: Rendering...");
  const { outputPath } = await renderPlan(plan, project.rootDir);
  log(`  rendered to: ${outputPath}`);

  log("Step 6: Asserting output...");
  await assertFileExists(outputPath, "rendered mp4");
  await ffprobeReadable(outputPath);

  log("Step 7: Cleaning up...");
  await fs.rm(project.rootDir, { recursive: true, force: true });

  log("\nSMOKE TEST PASSED.");
  process.exit(0);
}

main().catch((err) => fail(String(err)));
```

Add to `package.json` scripts:
```json
"smoke:video": "tsx scripts/video-studio-smoke.ts"
```

Run to verify: `npm run smoke:video` → exit code 0.

---

### Final Milestone Commit (end of Layer D / Phase 1)

```bash
git add \
  src/video-studio/effects/captions.ts \
  src/video-studio/effects/beat-sync.ts \
  src/video-studio/effects/__tests__/captions.test.ts \
  src/video-studio/effects/__tests__/beat-sync.test.ts \
  src/video-studio/python/beat_detect.py \
  src/video-studio/assets/sfx-pack.ts \
  src/video-studio/assets/sfx/index.json \
  src/video-studio/assets/music-library.ts \
  src/video-studio/assets/music/index.json \
  src/video-studio/assets/__tests__/sfx-pack.test.ts \
  src/video-studio/assets/__tests__/music-library.test.ts \
  src/video-studio/__fixtures__/generate-2s.ts \
  src/tools/video-studio.ts \
  src/tools/__tests__/video-studio.test.ts \
  src/tools/__tests__/video-studio-registry.test.ts \
  src/tools/index.ts \
  src/tool-router.ts \
  skills/video_editing.md \
  scripts/video-studio-smoke.ts \
  package.json

git commit -m "feat(video-studio): effects, tools, skill, smoke test"
```

---

## Final Verification Checklist

(From the approved spec at `/Users/user/.claude/plans/find-ways-to-improve-tidy-russell.md`)

1. `npm install` succeeds; `ffmpeg-static` binary is executable on current OS.
2. Send a video on Telegram — reaches `data/video-projects/<id>/inputs/`.
3. Run `video_analyze` → `timeline.json` has scenes, captions, transcript aligned.
4. Run `video_plan_edit` with prompt "make a 20s highlight reel with captions" → valid `edit_plan.json`.
5. Run `video_render` → `renders/final.mp4` opens and plays; captions are word-synced; cuts land on beats (if music present).
6. Send two videos, ask for "join them with a fade between, add this music" → single output with xfade + ducked music.
7. (Phase 2) "Change my background to a beach" → BiRefNet lazy-downloads once.
8. (Phase 2) "Turn this into a vertical reel" → auto-crop tracks face smoothly without jitter.
9. (Phase 3) "Export to DaVinci" → `.fcpxml` opens in DaVinci with tracks intact.
10. (Phase 3) "Edit this like my last reel" → template recalled, renders in seconds.
11. `npm run build`, `npm run typecheck`, `npm run lint` all pass.
12. `ATLAS_VIDEO_NO_HEAVY=1 npm start` — heavy effects gracefully unavailable.
13. Smoke test `scripts/video-studio-smoke.ts` passes on macOS, Windows, Linux.
