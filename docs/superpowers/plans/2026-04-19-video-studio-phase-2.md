# ATLAS Video Studio — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the AI-backed "magic effects" layer — face-tracked auto-crop, BiRefNet background removal, schema extensions, optional stock B-roll — on top of Phase 1's FFmpeg pipeline, without loading heavy models at boot.

**Architecture:** Three layers (E, F, G). Each new effect extends `edit_plan.json` schema v2 and hooks into `compilePlan()` in the FFmpeg renderer. Heavy models (BiRefNet ~400MB, MediaPipe ~50MB) download lazily via an `ensureModel()` helper that respects a disk-space guard, an `ATLAS_VIDEO_NO_HEAVY=1` kill switch, and an optional user-confirmation callback. Python sidecar from Phase 1 is extended with new scripts (`face_track.py`, `bg_matte.py`, `model_loader.py`).

**Tech Stack:** TypeScript + NodeNext, Zod, FFmpeg filter_complex + sendcmd, Python sidecar (uv venv), MediaPipe, BiRefNet (PyTorch), Pexels API (opt-in), vitest.

**Approved spec:** `/Users/user/.claude/plans/find-ways-to-improve-tidy-russell.md` (Phase 2 section).

**Phase 1 commits already landed:** `bb13be2` (Layer A), `b4aefd0` (Layer B), `88ea891` (Layer C), `b7c38ca` (Layer D). 166 tests passing.

**Conventions inherited from Phase 1** — every task follows these:
- ES modules, NodeNext, `.js` import extensions on every relative import
- Copyright header on every new .ts file:
  ```
  // Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
  // This software is proprietary. Copying or reuse is prohibited.
  // See LICENSE.md for details.
  ```
- Alphabetized imports (Biome `organizeImports`)
- `as unknown as X` for CJS/interop casts
- Call-time `execFileP` wrapper when `vi.mock("node:child_process")` is used in tests (module-level `promisify(execFile)` isn't intercepted)
- Template literals; `Number.parseInt(x, 10)` / `Number.parseFloat(x)` — never globals
- `createRequire(import.meta.url)` for loading JSON manifests
- Tsc / Biome — scope to new files only; repo has ~1,084 pre-existing Biome errors elsewhere
- Tests live in `__tests__/` subdirectories next to the module under test
- Milestone commits happen ONLY at layer boundaries (3 total for Phase 2), never per-task. Commit via:
  ```bash
  git -c user.email="local@atlas.dev" -c user.name="ATLAS Local" commit -m "..."
  ```

**13 tasks grouped into 3 layers, each ending with one milestone commit.**

- **Layer E — Foundation + schema extension** (Tasks 23-26): `model-cache.ts` (ensureModel, kill switch, disk guard, confirm), extend `schema.ts` with v2 (crop union + export VideoTrackSchema), `plan/effects.ts` (parseEffect), `pyproject.toml` deps, `model_loader.py` (BiRefNet downloader). Ends with commit `feat(video-studio): Layer E foundation — model-cache + schema v2 + deps`.

- **Layer F — Face tracking + auto-crop** (Tasks 27-30): `face_track.py` (MediaPipe CLI), `face-track.ts` (cached wrapper), `auto-crop.ts` (EMA-smoothed 9:16/1:1/4:5 crop), extend `FilterComplexBuilder` with `addAutoCrop` and `ffmpeg-renderer` with `compilePlanAsync` + `buildSendcmdScript`. Ends with commit `feat(video-studio): Layer F — MediaPipe face tracking + auto-crop`.

- **Layer G — Background removal + stock B-roll + integration** (Tasks 31-35): `bg_matte.py` (BiRefNet inference), `bg-remove.ts` (lazy-loaded wrapper), extend `FilterComplexBuilder` with `addAlphaMerge` + `addColorGrade`, wire effect dispatch into `compilePlanAsync`, optional `stock-broll.ts` (Pexels), extend smoke test with heavy-path legs. Ends with commit `feat(video-studio): Layer G — bg removal, stock b-roll, integration`.

**After Phase 2 completes:** 7 total `feat(video-studio):` commits, ~226 tests passing.

---

## Layer E — Foundation + schema extension (Tasks 23-26)

---

### Task 23: `src/video-studio/util/model-cache.ts` + tests

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/util/model-cache.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/util/__tests__/model-cache.test.ts`

---

- [ ] **Step 1 — Write failing test(s)**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/__tests__/model-cache.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:fs/promises");
vi.mock("node:os");
vi.mock("../python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import { runPython } from "../python-sidecar.js";
import {
    ModelDownloadBlockedError,
    ensureModel,
    modelCacheDir,
} from "../model-cache.js";

const FAKE_HOME = "/fake/home";
const FAKE_CACHE_DIR = `${FAKE_HOME}/.atlas/models`;

function setupBaseMocks(): void {
    vi.mocked(os.homedir).mockReturnValue(FAKE_HOME);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fsPromises.statfs).mockResolvedValue({
        bsize: 4096,
        bavail: 5 * 1024 * 1024,
        blocks: 0,
        bfree: 0,
        files: 0,
        ffree: 0,
    } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
}

describe("modelCacheDir", () => {
    beforeEach(() => {
        vi.mocked(os.homedir).mockReturnValue(FAKE_HOME);
    });

    it("returns ~/.atlas/models", () => {
        expect(modelCacheDir()).toBe(FAKE_CACHE_DIR);
    });
});

describe("ensureModel — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
    });

    it("returns model dir immediately when .ready marker exists — no downloader call", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) =>
            String(p) === `${FAKE_CACHE_DIR}/mediapipe_face/.ready`,
        );

        const result = await ensureModel("mediapipe_face");

        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
        expect(runPython).not.toHaveBeenCalled();
    });

    it("also returns immediately for birefnet on cache hit without kill-switch concern", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) =>
            String(p) === `${FAKE_CACHE_DIR}/birefnet/.ready`,
        );

        const result = await ensureModel("birefnet");

        expect(result).toBe(`${FAKE_CACHE_DIR}/birefnet`);
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("ensureModel — kill switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        process.env.ATLAS_VIDEO_NO_HEAVY = "1";
    });

    afterEach(() => {
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(kill_switch) for birefnet (tier 3)", async () => {
        await expect(ensureModel("birefnet")).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "kill_switch",
        });
    });

    it("does NOT throw for mediapipe_face (tier 2) even when kill switch is on", async () => {
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
        const result = await ensureModel("mediapipe_face");
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });
});

describe("ensureModel — disk space check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(disk_space) when free bytes < requireFreeBytes", async () => {
        vi.mocked(fsPromises.statfs).mockResolvedValue({
            bsize: 4096,
            bavail: 100,
            blocks: 0,
            bfree: 0,
            files: 0,
            ffree: 0,
        } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);

        await expect(ensureModel("mediapipe_face")).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "disk_space",
        });
    });

    it("skips disk check when statfs throws ENOSYS", async () => {
        const err = Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
        vi.mocked(fsPromises.statfs).mockRejectedValue(err);
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

        const result = await ensureModel("mediapipe_face");
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });

    it("honours custom requireFreeBytes threshold", async () => {
        vi.mocked(fsPromises.statfs).mockResolvedValue({
            bsize: 1024,
            bavail: 300 * 1024,
            blocks: 0,
            bfree: 0,
            files: 0,
            ffree: 0,
        } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);

        await expect(
            ensureModel("mediapipe_face", { requireFreeBytes: 400 * 1024 * 1024 }),
        ).rejects.toMatchObject({
            reason: "disk_space",
        });
    });
});

describe("ensureModel — confirm callback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(user_declined) when confirm returns false", async () => {
        const confirm = vi.fn().mockResolvedValue(false);

        await expect(
            ensureModel("mediapipe_face", { confirm }),
        ).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "user_declined",
        });
        expect(confirm).toHaveBeenCalledWith({
            name: "mediapipe_face",
            sizeBytes: 50 * 1024 * 1024,
        });
    });

    it("proceeds with download when confirm returns true", async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

        const result = await ensureModel("mediapipe_face", { confirm });

        expect(confirm).toHaveBeenCalledOnce();
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });
});

describe("ensureModel — unknown model", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(no_downloader) for unrecognised model name", async () => {
        await expect(
            ensureModel("totally_unknown" as never),
        ).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "no_downloader",
        });
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
cd /Users/user/Desktop/ATLAS && npm run test -- --reporter=verbose 2>&1 | tail -15
```

Expected: `Cannot find module '../model-cache.js'` — all 10 model-cache tests fail.

- [ ] **Step 3 — Implement**

Create `/Users/user/Desktop/ATLAS/src/video-studio/util/model-cache.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { mkdir, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPython } from "./python-sidecar.js";

export type ModelName = "birefnet" | "mediapipe_face";

export interface EnsureModelOpts {
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
    requireFreeBytes?: number;
}

export class ModelDownloadBlockedError extends Error {
    readonly reason: "kill_switch" | "disk_space" | "user_declined" | "no_downloader";

    constructor(reason: ModelDownloadBlockedError["reason"], message: string) {
        super(message);
        this.name = "ModelDownloadBlockedError";
        this.reason = reason;
    }
}

export function modelCacheDir(): string {
    return path.join(os.homedir(), ".atlas", "models");
}

export async function ensureModel(name: ModelName, opts: EnsureModelOpts = {}): Promise<string> {
    const entry = DOWNLOADERS[name];
    if (!entry) {
        throw new ModelDownloadBlockedError(
            "no_downloader",
            `[model-cache] No downloader registered for model: "${name}"`,
        );
    }

    const dest = path.join(modelCacheDir(), name);
    const readyMarker = path.join(dest, ".ready");

    if (fs.existsSync(readyMarker)) {
        return dest;
    }

    if (entry.tier >= 3 && process.env.ATLAS_VIDEO_NO_HEAVY === "1") {
        throw new ModelDownloadBlockedError(
            "kill_switch",
            `[model-cache] Model "${name}" is a Tier-${entry.tier} (heavy) download and ` +
                `ATLAS_VIDEO_NO_HEAVY=1 is set. Unset the variable to allow downloads.`,
        );
    }

    const requiredBytes = opts.requireFreeBytes ?? 5 * 1024 ** 3;
    try {
        const stats = await statfs(os.homedir());
        const freeBytes = (stats as unknown as { bsize: number; bavail: number }).bsize *
            (stats as unknown as { bsize: number; bavail: number }).bavail;
        if (freeBytes < requiredBytes) {
            throw new ModelDownloadBlockedError(
                "disk_space",
                `[model-cache] Insufficient free disk space for "${name}". ` +
                    `Need ${(requiredBytes / 1024 ** 3).toFixed(1)} GB, ` +
                    `have ${(freeBytes / 1024 ** 3).toFixed(1)} GB.`,
            );
        }
    } catch (err) {
        if (err instanceof ModelDownloadBlockedError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOSYS") throw err;
    }

    if (opts.confirm) {
        const approved = await opts.confirm({ name, sizeBytes: entry.sizeBytes });
        if (!approved) {
            throw new ModelDownloadBlockedError(
                "user_declined",
                `[model-cache] Download of "${name}" was declined by user.`,
            );
        }
    }

    await mkdir(dest, { recursive: true });
    await entry.download(dest);

    return dest;
}

async function downloadBirefnet(dest: string): Promise<void> {
    const scriptPath = path.resolve("src/video-studio/python/model_loader.py");
    await runPython(scriptPath, ["birefnet", dest], { timeoutMs: 30 * 60 * 1000 });
    await writeFile(path.join(dest, ".ready"), new Date().toISOString(), "utf-8");
}

const DOWNLOADERS: Record<
    ModelName,
    { sizeBytes: number; tier: 2 | 3; download: (dest: string) => Promise<void> }
> = {
    birefnet: {
        sizeBytes: 400 * 1024 * 1024,
        tier: 3,
        download: downloadBirefnet,
    },
    mediapipe_face: {
        sizeBytes: 50 * 1024 * 1024,
        tier: 2,
        download: async (dest: string) => {
            await writeFile(path.join(dest, ".ready"), new Date().toISOString(), "utf-8");
        },
    },
};
```

- [ ] **Step 4 — Confirm pass**

```bash
cd /Users/user/Desktop/ATLAS && npm run test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all model-cache tests green, prior 166 tests still passing.

- [ ] **Step 5 — Gates**

```bash
cd /Users/user/Desktop/ATLAS && npx tsc --noEmit 2>&1 | grep -E "model-cache" || echo "CLEAN_NEW_FILES"
cd /Users/user/Desktop/ATLAS && npx biome check src/video-studio/util/model-cache.ts src/video-studio/util/__tests__/model-cache.test.ts 2>&1 | tail -5
```

Clean.

---

### Task 24: Extend `src/video-studio/plan/schema.ts`

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/plan/schema.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/schema.test.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/plan/effects.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/effects.test.ts`

---

- [ ] **Step 1 — Write failing test(s)**

Modify `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/schema.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { EditPlanSchema, VideoTrackSchema, validateEditPlan } from "../schema.js";

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

    it("accepts crop: auto_face", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "auto_face" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("accepts crop: coordinate string matching N:N:N:N", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "0:0:1920:1080" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("rejects crop: arbitrary string that is not auto_face or N:N:N:N", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "garbage_value" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(false);
    });
});

describe("VideoTrackSchema export", () => {
    it("VideoTrackSchema is exported and parses a valid track", () => {
        const result = VideoTrackSchema.safeParse({ id: "v1", source: "s1", in: 0, out: 5 });
        expect(result.success).toBe(true);
    });
});

describe("EditPlanSchema overlay discriminated union", () => {
    it("accepts a captions overlay with required fields", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [
            { type: "captions", style: "reel_karaoke", from: 0, to: 10, highlight_color: "#fff" },
        ] as never;
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

Create `/Users/user/Desktop/ATLAS/src/video-studio/plan/__tests__/effects.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { parseEffect } from "../effects.js";

describe("parseEffect — valid directives", () => {
    it("parses bg_replace with asset path", () => {
        const result = parseEffect("bg_replace:path/to/bg.jpg");
        expect(result).toEqual({ kind: "bg_replace", asset: "path/to/bg.jpg" });
    });

    it("parses stabilize (no colon)", () => {
        const result = parseEffect("stabilize");
        expect(result).toEqual({ kind: "stabilize" });
    });

    it("parses color_grade with preset", () => {
        const result = parseEffect("color_grade:warm");
        expect(result).toEqual({ kind: "color_grade", preset: "warm" });
    });

    it("parses stylize with preset", () => {
        const result = parseEffect("stylize:anime");
        expect(result).toEqual({ kind: "stylize", preset: "anime" });
    });

    it("parses bg_replace with a nested path containing slashes", () => {
        const result = parseEffect("bg_replace:assets/backgrounds/beach/sunset.jpg");
        expect(result).toEqual({ kind: "bg_replace", asset: "assets/backgrounds/beach/sunset.jpg" });
    });
});

describe("parseEffect — invalid / rejected inputs", () => {
    it("returns null for unknown kind", () => {
        expect(parseEffect("sharpen")).toBeNull();
        expect(parseEffect("zoom:2x")).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(parseEffect("")).toBeNull();
    });

    it("returns null for color_grade with missing preset (empty after colon)", () => {
        expect(parseEffect("color_grade:")).toBeNull();
    });

    it("returns null for bg_replace with missing asset (empty after colon)", () => {
        expect(parseEffect("bg_replace:")).toBeNull();
    });

    it("returns null for stylize with missing preset (empty after colon)", () => {
        expect(parseEffect("stylize:")).toBeNull();
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
cd /Users/user/Desktop/ATLAS && npm run test -- --reporter=verbose 2>&1 | tail -15
```

Expected: `VideoTrackSchema` import fails (not exported), crop rejection test fails, effects module-not-found.

- [ ] **Step 3 — Implement**

Replace `/Users/user/Desktop/ATLAS/src/video-studio/plan/schema.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { z } from "zod";

const OutputSchema = z.object({
    aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
    fps: z.number().int().positive(),
    path: z.string().min(1),
    resolution: z.string().regex(/^\d+x\d+$/, "resolution must be WxH e.g. 1920x1080"),
});

const SourceSchema = z.object({
    duration: z.number().positive(),
    id: z.string().min(1),
    path: z.string().min(1),
});

export const VideoTrackSchema = z.object({
    crop: z
        .union([z.literal("auto_face"), z.string().regex(/^\d+:\d+:\d+:\d+$/)])
        .optional(),
    effects: z.array(z.string()).optional(),
    id: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().positive(),
    source: z.string().min(1),
    speed: z.number().positive().optional(),
});

const AudioTrackSchema = z.object({
    duck_on_speech: z.boolean().optional(),
    fade_in: z.number().nonnegative().optional(),
    fade_out: z.number().nonnegative().optional(),
    id: z.string().min(1),
    source: z.string().min(1),
    sync_to_beats: z.boolean().optional(),
    volume: z.number().optional(),
});

const CaptionsOverlaySchema = z.object({
    font_family: z.string().optional(),
    font_size: z.number().positive().optional(),
    from: z.number().nonnegative(),
    highlight_color: z.string().min(1),
    position: z.enum(["top", "center", "bottom"]).optional(),
    style: z.string().min(1),
    to: z.number().positive(),
    type: z.literal("captions"),
});

const TextOverlaySchema = z.object({
    box_color: z.string().optional(),
    content: z.string().min(1),
    font_color: z.string().optional(),
    font_family: z.string().optional(),
    font_size: z.number().positive().optional(),
    from: z.number().nonnegative(),
    to: z.number().positive(),
    type: z.literal("text"),
    x: z.number(),
    y: z.number(),
});

const StickerOverlaySchema = z.object({
    asset: z.string().min(1),
    from: z.number().nonnegative(),
    scale: z.number().positive().optional(),
    to: z.number().positive(),
    type: z.literal("sticker"),
    x: z.number(),
    y: z.number(),
});

const OverlaySchema = z.discriminatedUnion("type", [
    CaptionsOverlaySchema,
    TextOverlaySchema,
    StickerOverlaySchema,
]);

const TracksSchema = z.object({
    audio: z.array(AudioTrackSchema).optional().default([]),
    overlays: z.array(OverlaySchema).optional().default([]),
    video: z.array(VideoTrackSchema).min(1),
});

const TransitionSchema = z.object({
    between: z.tuple([z.string(), z.string()]),
    duration: z.number().positive().optional(),
    kind: z.string().optional(),
    type: z.enum(["xfade", "cut"]),
});

export const EditPlanSchema = z.object({
    export_targets: z.array(z.enum(["mp4", "fcpxml"])).min(1),
    output: OutputSchema,
    projectId: z.string().min(1),
    sources: z.array(SourceSchema).min(1),
    tracks: TracksSchema,
    transitions: z.array(TransitionSchema).optional().default([]),
});

export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type CaptionsOverlay = z.infer<typeof CaptionsOverlaySchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type OverlayTrack = z.infer<typeof OverlaySchema>;
export type Source = z.infer<typeof SourceSchema>;
export type StickerOverlay = z.infer<typeof StickerOverlaySchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export type ValidateResult = { ok: true; plan: EditPlan } | { ok: false; errors: string[] };

export function validateEditPlan(raw: unknown): ValidateResult {
    const result = EditPlanSchema.safeParse(raw);
    if (result.success) {
        return { ok: true, plan: result.data };
    }
    const errors = result.error.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${issuePath}: ${issue.message}`;
    });
    return { ok: false, errors };
}
```

Create `/Users/user/Desktop/ATLAS/src/video-studio/plan/effects.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export type EffectDirective =
    | { kind: "bg_replace"; asset: string }
    | { kind: "color_grade"; preset: string }
    | { kind: "stabilize" }
    | { kind: "stylize"; preset: string };

const PAYLOAD_KINDS = new Set(["bg_replace", "color_grade", "stylize"] as const);
type PayloadKind = "bg_replace" | "color_grade" | "stylize";

const NO_PAYLOAD_KINDS = new Set(["stabilize"] as const);

export function parseEffect(raw: string): EffectDirective | null {
    if (!raw) return null;

    const colonIdx = raw.indexOf(":");
    const kind = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
    const payload = colonIdx === -1 ? "" : raw.slice(colonIdx + 1);

    if (NO_PAYLOAD_KINDS.has(kind as "stabilize")) {
        if (payload !== "") return null;
        return { kind: "stabilize" };
    }

    if (PAYLOAD_KINDS.has(kind as PayloadKind)) {
        if (!payload) return null;

        if (kind === "bg_replace") {
            return { kind: "bg_replace", asset: payload };
        }
        if (kind === "color_grade") {
            return { kind: "color_grade", preset: payload };
        }
        if (kind === "stylize") {
            return { kind: "stylize", preset: payload };
        }
    }

    return null;
}
```

- [ ] **Step 4 — Confirm pass**

```bash
cd /Users/user/Desktop/ATLAS && npm run test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all schema + effects tests green.

- [ ] **Step 5 — Gates**

```bash
cd /Users/user/Desktop/ATLAS && npx tsc --noEmit 2>&1 | grep -E "schema|effects" || echo "CLEAN_NEW_FILES"
cd /Users/user/Desktop/ATLAS && npx biome check src/video-studio/plan/schema.ts src/video-studio/plan/effects.ts src/video-studio/plan/__tests__/schema.test.ts src/video-studio/plan/__tests__/effects.test.ts 2>&1 | tail -5
```

Clean.

---

### Task 25: Extend `src/video-studio/python/pyproject.toml`

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/python/pyproject.toml`

---

- [ ] **Step 1 — Write failing test(s)**

No automated test — verification is via `ensurePythonEnv()` at runtime and a gate check on the dep list.

- [ ] **Step 2 — Confirm fail**

```bash
cd /Users/user/Desktop/ATLAS && python3 -c "import mediapipe" 2>&1 | head -3
```

Expected: `ModuleNotFoundError: No module named 'mediapipe'`.

- [ ] **Step 3 — Implement**

Replace `/Users/user/Desktop/ATLAS/src/video-studio/python/pyproject.toml`:

```toml
[project]
name = "atlas-video-studio"
version = "0.2.0"
requires-python = ">=3.10,<3.13"
dependencies = [
    "faster-whisper>=1.0",
    "huggingface-hub>=0.20",
    "librosa>=0.10",
    "mediapipe>=0.10",
    "numpy>=1.24",
    "Pillow>=10.0",
    "scenedetect[opencv]>=0.6",
    "torch>=2.1",
    "torchvision>=0.16",
    "transformers>=4.37",
]
```

- [ ] **Step 4 — Confirm pass**

```bash
rm -f data/video-studio/venv/.atlas-ready
cd /Users/user/Desktop/ATLAS && npm run test -- --reporter=verbose 2>&1 | tail -10
```

Expected: no test regressions.

- [ ] **Step 5 — Gates**

```bash
cd /Users/user/Desktop/ATLAS && python3 -c "
import tomllib, pathlib, sys
data = tomllib.loads(pathlib.Path('src/video-studio/python/pyproject.toml').read_text())
deps = data['project']['dependencies']
required = ['mediapipe', 'torch', 'torchvision', 'Pillow', 'numpy', 'huggingface-hub', 'transformers']
missing = [r for r in required if not any(d.startswith(r) for d in deps)]
if missing:
    print('MISSING:', missing); sys.exit(1)
else:
    print('ALL_DEPS_PRESENT')
" 2>&1
```

Expected: `ALL_DEPS_PRESENT`.

---

### Task 26: `src/video-studio/python/model_loader.py`

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py`

---

- [ ] **Step 1 — Write failing test(s)**

No vitest test. Exercised indirectly by Task 23's birefnet download mock path.

- [ ] **Step 2 — Confirm fail**

```bash
python3 -m py_compile /Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py 2>&1 | head -5
```

Expected: `No such file or directory`.

- [ ] **Step 3 — Implement**

Create `/Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py`:

```python
#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
"""
model_loader.py — On-demand model downloader sidecar for ATLAS Video Studio.

Usage:
    python model_loader.py <model_name> <dest_dir>

Supported models:
    birefnet   — ZhengPeng7/BiRefNet via Hugging Face Hub snapshot_download

On success: writes <dest_dir>/.ready with an ISO 8601 timestamp and exits 0.
On failure: writes error message to stderr and exits 1.
"""

import datetime
import pathlib
import sys


SUPPORTED_MODELS: dict[str, str] = {
    "birefnet": "ZhengPeng7/BiRefNet",
}


def download_birefnet(dest_dir: pathlib.Path) -> None:
    """Download BiRefNet weights via huggingface_hub.snapshot_download."""
    from huggingface_hub import snapshot_download

    repo_id = SUPPORTED_MODELS["birefnet"]
    print(f"[model_loader] Downloading {repo_id} → {dest_dir}", flush=True)
    snapshot_download(repo_id=repo_id, local_dir=str(dest_dir))
    print(f"[model_loader] Download complete: {repo_id}", flush=True)


DOWNLOADERS = {
    "birefnet": download_birefnet,
}


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "Usage: model_loader.py <model_name> <dest_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    model_name = sys.argv[1]
    dest_dir = pathlib.Path(sys.argv[2])

    if model_name not in DOWNLOADERS:
        print(f"Unknown model: {model_name}", file=sys.stderr)
        sys.exit(1)

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        DOWNLOADERS[model_name](dest_dir)
        ready_marker = dest_dir / ".ready"
        ready_marker.write_text(
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
            encoding="utf-8",
        )
        print(f"[model_loader] Wrote ready marker: {ready_marker}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[model_loader] ERROR downloading {model_name}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4 — Confirm pass**

```bash
python3 -m py_compile /Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py && echo "SYNTAX_OK"
python3 /Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py 2>&1 | head -3
python3 /Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py unknown_model /tmp/dest 2>&1
```

Expected:
- Line 1: `SYNTAX_OK`
- Line 2: Usage line (exit 1 on missing args)
- Line 3: `Unknown model: unknown_model` (exit 1)

- [ ] **Step 5 — Gates**

```bash
python3 -m py_compile /Users/user/Desktop/ATLAS/src/video-studio/python/model_loader.py && echo "SYNTAX_OK"
```

Expected: `SYNTAX_OK`.

---

### Layer E milestone commit

```bash
cd /Users/user/Desktop/ATLAS
git add \
    src/video-studio/util/model-cache.ts \
    src/video-studio/util/__tests__/model-cache.test.ts \
    src/video-studio/plan/schema.ts \
    src/video-studio/plan/effects.ts \
    src/video-studio/plan/__tests__/schema.test.ts \
    src/video-studio/plan/__tests__/effects.test.ts \
    src/video-studio/python/pyproject.toml \
    src/video-studio/python/model_loader.py
git -c user.email="local@atlas.dev" -c user.name="ATLAS Local" commit -m "feat(video-studio): Layer E foundation — model-cache + schema v2 + deps"
```
## Layer F — Face tracking + auto-crop (Tasks 27-30)

*Goal: add MediaPipe face detection, EMA-smoothed 9:16 auto-crop, and FFmpeg `sendcmd`-driven dynamic crop injection. Four tasks, each TDD-first. Milestone commit at end of Task 30.*

---

### Task 27: `src/video-studio/python/face_track.py`

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/python/face_track.py`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/python/pyproject.toml` — add `opencv-python>=4.8` (mediapipe already added by Layer E Task 25)

---

- [ ] **Step 1 — Document the JSON contract (pre-implementation)**

```
CLI:    python face_track.py <video_path> <output_json_path>
Exit 0: writes valid JSON to <output_json_path>
Exit 1: prints error to stderr, writes nothing
Output shape:
  {
    "videoPath": "<str>",
    "fps":        <float>,
    "width":      <int>,
    "height":     <int>,
    "frames": [
      { "t": <float>, "faces": [ {"x":<int>,"y":<int>,"w":<int>,"h":<int>,"score":<float>} ] }
    ]
  }
Sampling cadence: every max(1, int(fps/10))-th frame (~10 Hz cap)
```

- [ ] **Step 2 — Implement `face_track.py`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/python/face_track.py`:

```python
#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
"""
face_track.py — MediaPipe face detection sidecar for ATLAS Video Studio.
Usage: python face_track.py <videoPath> <outputJsonPath>
Writes JSON: { videoPath, fps, width, height,
               frames: [{t, faces:[{x,y,w,h,score}]}] }
Samples every max(1, int(fps/10))-th frame to stay at ~10 Hz.
"""

import json
import pathlib
import sys


def detect_faces(video_path: str, output_path: str) -> None:
    import cv2
    import mediapipe as mp

    face_detection = mp.solutions.face_detection.FaceDetection(
        model_selection=1,
        min_detection_confidence=0.5,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[face_track] Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps: float = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width: int = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height: int = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    sample_every: int = max(1, int(fps / 10))

    frames = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_every == 0:
            t = round(frame_idx / fps, 4)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_detection.process(rgb)

            face_list = []
            if results.detections:
                for det in results.detections:
                    bb = det.location_data.relative_bounding_box
                    x = max(0, int(bb.xmin * width))
                    y = max(0, int(bb.ymin * height))
                    w = int(bb.width * width)
                    h = int(bb.height * height)
                    score = round(float(det.score[0]), 4) if det.score else 0.0
                    face_list.append({"x": x, "y": y, "w": w, "h": h, "score": score})

            frames.append({"t": t, "faces": face_list})

        frame_idx += 1

    cap.release()
    face_detection.close()

    output = {
        "videoPath": video_path,
        "fps": round(fps, 4),
        "width": width,
        "height": height,
        "frames": frames,
    }

    out_path = pathlib.Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[face_track] wrote {len(frames)} sampled frames to {output_path}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: face_track.py <videoPath> <outputJsonPath>", file=sys.stderr)
        sys.exit(1)
    try:
        detect_faces(sys.argv[1], sys.argv[2])
    except Exception as exc:
        print(f"[face_track] error: {exc}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 3 — Add `opencv-python` to `pyproject.toml`** (mediapipe was added in Layer E Task 25)

Edit the `[project].dependencies` array to include `"opencv-python>=4.8"` alphabetically.

- [ ] **Step 4 — Gates**

```bash
python3 -m py_compile /Users/user/Desktop/ATLAS/src/video-studio/python/face_track.py && echo "SYNTAX_OK"
python3 /Users/user/Desktop/ATLAS/src/video-studio/python/face_track.py 2>&1 | head -3
```

Expected: `SYNTAX_OK`; missing-args invocation prints usage and exits 1.

---

### Task 28: `src/video-studio/analyze/face-track.ts` + tests

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/analyze/face-track.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/analyze/__tests__/face-track.test.ts`

---

- [ ] **Step 1 — Write the failing tests**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/__tests__/face-track.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";
import type { FaceTrack } from "../face-track.js";
import { detectFaces } from "../face-track.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SAMPLE_TRACK: FaceTrack = {
    videoPath: VIDEO_PATH,
    fps: 30.0,
    width: 1920,
    height: 1080,
    frames: [
        { t: 0.0, faces: [{ x: 450, y: 320, w: 180, h: 220, score: 0.98 }] },
        { t: 0.1, faces: [] },
    ],
};

function setupStat(): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as unknown as fs.Stats);
}

describe("detectFaces — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupStat();
    });

    it("returns cached FaceTrack without calling python when cache file exists", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));

        const result = await detectFaces(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toEqual(SAMPLE_TRACK);
        expect(runPython).not.toHaveBeenCalled();
        expect(ensurePythonEnv).not.toHaveBeenCalled();
    });
});

describe("detectFaces — cache miss", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));
    });

    it("calls ensurePythonEnv and runPython on cache miss", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(ensurePythonEnv).toHaveBeenCalledOnce();
        expect(runPython).toHaveBeenCalledOnce();
    });

    it("runPython receives script path ending in face_track.py, videoPath, and tmp output path", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        const [scriptArg, posArgs] = vi.mocked(runPython).mock.calls[0] as [string, string[]];
        expect(scriptArg).toContain("face_track.py");
        expect(posArgs[0]).toBe(VIDEO_PATH);
        expect(posArgs[1]).toContain(".tmp.json");
    });

    it("writes parsed result to cache file after successful python call", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
        const cacheWrite = writeCalls.find(([p]) => String(p).includes("faces-") && !String(p).includes(".tmp"));
        expect(cacheWrite).toBeDefined();
        const written = JSON.parse(String(cacheWrite![1])) as FaceTrack;
        expect(written.fps).toBe(30.0);
        expect(written.frames).toHaveLength(2);
    });

    it("unlinkSync is called on the tmp file after reading", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
    });

    it("rejects with a descriptive error when python output is not valid JSON", async () => {
        vi.mocked(fs.readFileSync).mockReturnValue("NOT_VALID_JSON{{{");
        await expect(detectFaces(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(/face-track/i);
    });
});

describe("detectFaces — empty frames", () => {
    it("resolves with empty-frames track when python reports no detections", async () => {
        vi.clearAllMocks();
        setupStat();
        const emptyTrack: FaceTrack = { ...SAMPLE_TRACK, frames: [] };
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(emptyTrack));
        const result = await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(result.frames).toHaveLength(0);
        expect(result.fps).toBe(30.0);
    });
});

describe("detectFaces — cache dir creation", () => {
    it("creates the cache directory (recursive) when it does not exist", async () => {
        vi.clearAllMocks();
        setupStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
        vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));

        await detectFaces(VIDEO_PATH, PROJECT_ROOT);

        expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
            expect.stringContaining("cache"),
            expect.objectContaining({ recursive: true }),
        );
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
npx vitest run src/video-studio/analyze/__tests__/face-track.test.ts
```

Expected: module-not-found for `../face-track.js`.

- [ ] **Step 3 — Implement `face-track.ts`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/analyze/face-track.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";

export interface FaceBBox {
    h: number;
    score: number;
    w: number;
    x: number;
    y: number;
}

export interface FaceFrame {
    faces: FaceBBox[];
    t: number;
}

export interface FaceTrack {
    fps: number;
    frames: FaceFrame[];
    height: number;
    videoPath: string;
    width: number;
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function cacheFilePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `faces-${hash}.json`);
}

export async function detectFaces(videoPath: string, projectRoot: string): Promise<FaceTrack> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cacheFilePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as FaceTrack;
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    await ensurePythonEnv();
    const scriptPath = path.resolve("src/video-studio/python/face_track.py");
    const tmpOut = `${cacheFile}.tmp.json`;

    await runPython(scriptPath, [videoPath, tmpOut]);

    let track: FaceTrack;
    try {
        track = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as FaceTrack;
    } catch (err) {
        throw new Error(`[face-track] failed to parse python output: ${(err as Error).message}`);
    }

    try {
        fs.unlinkSync(tmpOut);
    } catch {
        // non-fatal — tmp cleanup failure does not affect result correctness
    }

    fs.writeFileSync(cacheFile, JSON.stringify(track, null, 2), "utf-8");
    return track;
}
```

- [ ] **Step 4 — Confirm pass**

```bash
npx vitest run src/video-studio/analyze/__tests__/face-track.test.ts
```

- [ ] **Step 5 — Gate**

```bash
npx tsc --noEmit 2>&1 | grep "face-track" || echo "CLEAN_NEW_FILES"
npx biome check src/video-studio/analyze/face-track.ts src/video-studio/analyze/__tests__/face-track.test.ts 2>&1 | tail -5
```

---

### Task 29: `src/video-studio/effects/auto-crop.ts` + tests

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/effects/auto-crop.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/effects/__tests__/auto-crop.test.ts`

Pure TypeScript — no I/O.

---

- [ ] **Step 1 — Write failing tests**

Create `/Users/user/Desktop/ATLAS/src/video-studio/effects/__tests__/auto-crop.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import type { FaceTrack } from "../../analyze/face-track.js";
import { computeAutoCrop } from "../auto-crop.js";

function makeTrack(overrides: Partial<FaceTrack> = {}): FaceTrack {
    return {
        videoPath: "/fake/clip.mp4",
        fps: 30,
        width: 1920,
        height: 1080,
        frames: [],
        ...overrides,
    };
}

describe("computeAutoCrop — dimensions", () => {
    it("9:16 cropW = floor(inputHeight * 9/16), cropH = inputHeight", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        expect(frames).toHaveLength(1);
        expect(frames[0].w).toBe(Math.floor(1080 * (9 / 16)));
        expect(frames[0].h).toBe(1080);
    });

    it("1:1 produces min(W,H) square", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "1:1", inputWidth: 1920, inputHeight: 1080 });
        expect(frames[0].w).toBe(1080);
        expect(frames[0].h).toBe(1080);
    });

    it("4:5 cropW = floor(inputHeight * 4/5) clamped to inputWidth", () => {
        const track = makeTrack({
            width: 1080,
            height: 1350,
            frames: [{ t: 0.0, faces: [{ x: 540, y: 675, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "4:5", inputWidth: 1080, inputHeight: 1350 });
        expect(frames[0].h).toBe(1350);
        expect(frames[0].w).toBe(Math.min(1080, Math.floor(1350 * (4 / 5))));
    });
});

describe("computeAutoCrop — defaults and inheritance", () => {
    it("no faces at t=0 defaults to centered crop", () => {
        const track = makeTrack({ frames: [{ t: 0.0, faces: [] }] });
        const frames = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        const cropW = Math.floor(1080 * (9 / 16));
        expect(frames[0].x).toBe(Math.round(1920 / 2 - cropW / 2));
        expect(frames[0].y).toBe(0);
    });

    it("empty-faces mid-track inherits previous smoothed center", () => {
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.1, faces: [] },
            ],
        });
        const frames = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        expect(frames[1].x).toBe(frames[0].x);
        expect(frames[1].y).toBe(frames[0].y);
    });
});

describe("computeAutoCrop — EMA smoothing", () => {
    it("alpha=0.12 dampens 500px face jump to ≤20px crop jump", () => {
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 200, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.033, faces: [{ x: 700, y: 540, w: 200, h: 250, score: 0.9 }] },
            ],
        });
        const result = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 0.12,
        });
        expect(Math.abs(result[1].x - result[0].x)).toBeLessThanOrEqual(20);
    });

    it("alpha=1.0 snaps to face center exactly on second frame", () => {
        const face2 = { x: 700, y: 540, w: 200, h: 250, score: 0.9 };
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 200, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.033, faces: [face2] },
            ],
        });
        const result = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        const cropW = Math.floor(1080 * (9 / 16));
        const faceCx = face2.x + face2.w / 2;
        const expectedX = Math.round(Math.max(0, Math.min(1920 - cropW, faceCx - cropW / 2)));
        expect(result[1].x).toBe(expectedX);
    });
});

describe("computeAutoCrop — bounds clamping", () => {
    it("face at right edge clamps crop x to inputWidth - cropW", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 1800, y: 540, w: 100, h: 120, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        const cropW = Math.floor(1080 * (9 / 16));
        expect(frames[0].x).toBeGreaterThanOrEqual(0);
        expect(frames[0].x + frames[0].w).toBeLessThanOrEqual(1920);
        expect(frames[0].x).toBe(1920 - cropW);
    });
});

describe("computeAutoCrop — output length", () => {
    it("returns CropFrame[] of same length as input frames", () => {
        const inputFrames = Array.from({ length: 10 }, (_, i) => ({
            t: i * 0.1,
            faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }],
        }));
        const track = makeTrack({ frames: inputFrames });
        const result = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        expect(result).toHaveLength(10);
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
npx vitest run src/video-studio/effects/__tests__/auto-crop.test.ts
```

- [ ] **Step 3 — Implement `auto-crop.ts`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/effects/auto-crop.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { FaceTrack } from "../analyze/face-track.js";

export interface AutoCropOpts {
    /** EMA smoothing factor — 0 = no movement, 1 = instant snap. Default 0.12. */
    alpha?: number;
    inputHeight: number;
    inputWidth: number;
    targetAspect: "1:1" | "4:5" | "9:16";
}

export interface CropFrame {
    h: number;
    t: number;
    w: number;
    x: number;
    y: number;
}

function aspectRatio(aspect: AutoCropOpts["targetAspect"]): number {
    switch (aspect) {
        case "9:16":
            return 9 / 16;
        case "1:1":
            return 1;
        case "4:5":
            return 4 / 5;
    }
}

function computeCropDimensions(
    targetAspect: AutoCropOpts["targetAspect"],
    inputWidth: number,
    inputHeight: number,
): { cropH: number; cropW: number } {
    const ratio = aspectRatio(targetAspect);
    const cropH = inputHeight;
    const cropW = Math.min(inputWidth, Math.floor(inputHeight * ratio));
    return { cropH, cropW };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function primaryFaceCenter(
    faces: FaceTrack["frames"][number]["faces"],
): { cx: number; cy: number } | null {
    if (faces.length === 0) return null;
    const primary = faces.reduce((best, f) => {
        return f.w * f.h * f.score > best.w * best.h * best.score ? f : best;
    });
    return { cx: primary.x + primary.w / 2, cy: primary.y + primary.h / 2 };
}

export function computeAutoCrop(faceTrack: FaceTrack, opts: AutoCropOpts): CropFrame[] {
    const { inputHeight, inputWidth, targetAspect } = opts;
    const alpha = opts.alpha ?? 0.12;
    const { cropH, cropW } = computeCropDimensions(targetAspect, inputWidth, inputHeight);

    const defaultCx = inputWidth / 2;
    const defaultCy = inputHeight / 2;

    let smoothedCx = defaultCx;
    let smoothedCy = defaultCy;
    let initialized = false;

    const result: CropFrame[] = [];

    for (const frame of faceTrack.frames) {
        const center = primaryFaceCenter(frame.faces);

        let desiredCx: number;
        let desiredCy: number;

        if (center !== null) {
            desiredCx = center.cx;
            desiredCy = center.cy;
        } else if (!initialized) {
            desiredCx = defaultCx;
            desiredCy = defaultCy;
        } else {
            desiredCx = smoothedCx;
            desiredCy = smoothedCy;
        }

        if (!initialized) {
            smoothedCx = desiredCx;
            smoothedCy = desiredCy;
            initialized = true;
        } else {
            smoothedCx = alpha * desiredCx + (1 - alpha) * smoothedCx;
            smoothedCy = alpha * desiredCy + (1 - alpha) * smoothedCy;
        }

        const rawX = smoothedCx - cropW / 2;
        const rawY = smoothedCy - cropH / 2;

        const x = Math.round(clamp(rawX, 0, inputWidth - cropW));
        const y = Math.round(clamp(rawY, 0, inputHeight - cropH));

        result.push({ h: cropH, t: frame.t, w: cropW, x, y });
    }

    return result;
}
```

- [ ] **Step 4 — Confirm pass**

```bash
npx vitest run src/video-studio/effects/__tests__/auto-crop.test.ts
```

- [ ] **Step 5 — Gate**

```bash
npx tsc --noEmit 2>&1 | grep "auto-crop" || echo "CLEAN_NEW_FILES"
npx biome check src/video-studio/effects/auto-crop.ts src/video-studio/effects/__tests__/auto-crop.test.ts 2>&1 | tail -5
```

---

### Task 30: `FilterComplexBuilder.addAutoCrop` + `compilePlanAsync` wiring

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-builder.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-renderer.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-builder.test.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-renderer.test.ts`

---

- [ ] **Step 1 — Write failing tests**

Append to `ffmpeg-builder.test.ts`:

```typescript
describe("FilterComplexBuilder — addAutoCrop", () => {
    it("produces sendcmd=f='<path>',crop=<initial> fragment", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "/tmp/sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).toContain("sendcmd=f=");
        expect(graph).toContain("crop=607:1080:656:0");
    });

    it("backslash path separators are converted to forward slashes", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "C:\\renders\\sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).not.toContain("C:\\");
        expect(graph).toContain("C/");
    });

    it("colons in path escaped for FFmpeg filter syntax", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "C:/renders/sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).toContain("C\\:");
    });

    it("returns a label that chains into next filter", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        const cropOut = b.addAutoCrop(base, "/tmp/cmd.txt", "607:1080:0:0");
        b.addDrawtext(cropOut, "Test", { fontsize: 24 });
        expect(b.build().filterGraph).toContain(cropOut);
    });

    it("initialCrop string included verbatim", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "/tmp/sc.txt", "999:888:11:22");
        expect(b.build().filterGraph).toContain("crop=999:888:11:22");
    });
});
```

Append to `ffmpeg-renderer.test.ts`:

```typescript
import type { CropFrame } from "../../effects/auto-crop.js";
import type { FaceTrack } from "../../analyze/face-track.js";
import { buildSendcmdScript } from "../ffmpeg-renderer.js";

describe("buildSendcmdScript", () => {
    it("produces one sendcmd line per CropFrame", () => {
        const frames: CropFrame[] = [
            { t: 0.0, x: 420, y: 0, w: 607, h: 1080 },
            { t: 0.033, x: 422, y: 0, w: 607, h: 1080 },
        ];
        const script = buildSendcmdScript(frames);
        const lines = script.trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^0 crop w 607/);
        expect(lines[0]).toContain("crop h 1080");
        expect(lines[0]).toContain("crop x 420");
        expect(lines[0]).toContain("crop y 0");
        expect(lines[1]).toMatch(/^0\.033/);
    });

    it("each line ends with a semicolon", () => {
        const frames: CropFrame[] = [{ t: 0.0, x: 0, y: 0, w: 607, h: 1080 }];
        expect(buildSendcmdScript(frames).trim()).toMatch(/;$/);
    });

    it("returns empty string for empty input", () => {
        expect(buildSendcmdScript([])).toBe("");
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
npx vitest run src/video-studio/render/__tests__/
```

- [ ] **Step 3 — Add `addAutoCrop` method to `FilterComplexBuilder`**

Insert into `ffmpeg-builder.ts` class (after `addSubtitles`, before `addAudioMix`):

```typescript
/**
 * Auto-crop filter: attaches FFmpeg's sendcmd to change crop rect over time.
 */
addAutoCrop(baseLabel: string, sendcmdPath: string, initialCrop: string): string {
    const out = this.nextLabel();
    const escapedPath = sendcmdPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    this.fragments.push(
        `${baseLabel}sendcmd=f='${escapedPath}',crop=${initialCrop}${out}`,
    );
    return out;
}
```

- [ ] **Step 4 — Add `buildSendcmdScript` + `compilePlanAsync` to `ffmpeg-renderer.ts`**

Update imports block:

```typescript
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CropFrame } from "../effects/auto-crop.js";
import type { EditPlan, Transition } from "../plan/schema.js";
import { checkDurations, checkSourcesExist, checkTransitionBetweenExists } from "../plan/validator.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import { FilterComplexBuilder } from "./ffmpeg-builder.js";
```

Add after `classifyRenderError`:

```typescript
/**
 * Converts CropFrame[] into FFmpeg sendcmd script content.
 * Format: "<t> crop w <w>, crop h <h>, crop x <x>, crop y <y>;"
 */
export function buildSendcmdScript(cropFrames: CropFrame[]): string {
    if (cropFrames.length === 0) return "";
    return cropFrames
        .map((f) => `${f.t} crop w ${f.w}, crop h ${f.h}, crop x ${f.x}, crop y ${f.y};`)
        .join("\n");
}
```

Add after the existing sync `compilePlan` function:

```typescript
/**
 * Async variant of compilePlan.
 * Handles clip.crop === "auto_face" by running face detection + EMA smoothing
 * + writing a sendcmd script. Other clips pass through unchanged.
 */
export async function compilePlanAsync(plan: EditPlan, projectRoot: string): Promise<Compiled> {
    const builder = new FilterComplexBuilder();
    const sourceInfo = new Map(
        plan.sources.map((s, i) => [s.id, { idx: i, path: absPath(s.path, projectRoot) }]),
    );
    const inputs = plan.sources.map((s) => absPath(s.path, projectRoot));
    const ts = Date.now();

    const rendersDir = resolve(projectRoot, "renders");
    await fs.mkdir(rendersDir, { recursive: true });

    const videoLabels = new Map<string, string>();

    for (const clip of plan.tracks.video) {
        const info = sourceInfo.get(clip.source);
        if (!info) continue;

        const trimmedLabel = builder.addTrim(info.idx, clip.in, clip.out);

        if (clip.crop === "auto_face") {
            const { detectFaces } = await import("../analyze/face-track.js");
            const { computeAutoCrop } = await import("../effects/auto-crop.js");
            const { probeVideoMetadata } = await import("../analyze/timeline-builder.js");

            const meta = await probeVideoMetadata(info.path);
            const faceTrack = await detectFaces(info.path, projectRoot);
            const cropFrames = computeAutoCrop(faceTrack, {
                targetAspect: plan.output.aspect as "1:1" | "4:5" | "9:16",
                inputWidth: meta.width,
                inputHeight: meta.height,
            });

            const sendcmdContent = buildSendcmdScript(cropFrames);
            const sendcmdPath = join(rendersDir, `sendcmd-${ts}-${clip.id}.txt`);
            await fs.writeFile(sendcmdPath, sendcmdContent, "utf-8");

            const first = cropFrames[0];
            const initialCrop = first
                ? `${first.w}:${first.h}:${first.x}:${first.y}`
                : `${meta.width}:${meta.height}:0:0`;

            const cropLabel = builder.addAutoCrop(trimmedLabel, sendcmdPath, initialCrop);
            videoLabels.set(clip.id, cropLabel);
        } else {
            videoLabels.set(clip.id, trimmedLabel);
        }
    }

    // ... rest mirrors compilePlan (transitions + overlays + audio + build)
    // See the Phase 1 compilePlan implementation for the remaining structure;
    // reuse it verbatim, substituting videoLabels lookups where appropriate.

    const transitionMap = new Map((plan.transitions ?? []).map((tx) => [`${tx.between[0]}_${tx.between[1]}`, tx]));
    const clipIds = plan.tracks.video.map((v) => v.id);
    const firstLabel = videoLabels.get(clipIds[0]);
    if (!firstLabel) {
        throw new RenderError(
            "compilePlanAsync: no video labels produced from plan",
            RenderErrorCategory.InvalidFilterGraph,
            "",
            [],
        );
    }
    let finalVideoLabel: string = firstLabel;

    for (let i = 1; i < clipIds.length; i++) {
        const prevId = clipIds[i - 1];
        const currId = clipIds[i];
        const tx: Transition | undefined = transitionMap.get(`${prevId}_${currId}`);
        const currLabel = videoLabels.get(currId);
        if (!currLabel) continue;
        if (tx?.type === "xfade" && tx.duration !== undefined) {
            const prevClip = plan.tracks.video.find((v) => v.id === prevId);
            const prevLen = prevClip ? prevClip.out - prevClip.in : 0;
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
        const audioLabels = audioTracks.map((_, idx) => `[${plan.sources.length + idx}:a]`);
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
```

Update `renderPlan` body — replace the single `compilePlan` call with:

```typescript
const hasAutoCrop = plan.tracks.video.some((v) => v.crop === "auto_face");
const compiled = hasAutoCrop
    ? await compilePlanAsync(plan, projectRoot)
    : compilePlan(plan, projectRoot);
```

- [ ] **Step 5 — Confirm pass**

```bash
npx vitest run src/video-studio/render/__tests__/
```

- [ ] **Step 6 — Gates**

```bash
npx tsc --noEmit 2>&1 | grep "video-studio" || echo "CLEAN_NEW_FILES"
npx biome check src/video-studio/render/ffmpeg-builder.ts src/video-studio/render/ffmpeg-renderer.ts 2>&1 | tail -5
```

---

### Layer F milestone commit

```bash
cd /Users/user/Desktop/ATLAS
git add \
    src/video-studio/python/face_track.py \
    src/video-studio/python/pyproject.toml \
    src/video-studio/analyze/face-track.ts \
    src/video-studio/analyze/__tests__/face-track.test.ts \
    src/video-studio/effects/auto-crop.ts \
    src/video-studio/effects/__tests__/auto-crop.test.ts \
    src/video-studio/render/ffmpeg-builder.ts \
    src/video-studio/render/ffmpeg-renderer.ts \
    src/video-studio/render/__tests__/ffmpeg-builder.test.ts \
    src/video-studio/render/__tests__/ffmpeg-renderer.test.ts
git -c user.email="local@atlas.dev" -c user.name="ATLAS Local" commit -m "feat(video-studio): Layer F — MediaPipe face tracking + auto-crop"
```
## Layer G — Background removal + stock B-roll + integration (Tasks 31-35)

*Goal: BiRefNet-powered background removal with alpha-matte compositing, optional Pexels stock B-roll, `color_grade` filter dispatch in the renderer, and smoke-test extension — ending Phase 2.*

*Milestone commit at end of Task 35: `feat(video-studio): Layer G — bg removal, stock b-roll, integration`*

---

### Task 31: `src/video-studio/python/bg_matte.py`

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/python/bg_matte.py`

---

- [ ] **Step 1 — Write the failing test (manual smoke)**

```bash
python src/video-studio/python/bg_matte.py 2>&1 | head -3
```

Expected: `No such file or directory` or Python error — file does not exist yet.

- [ ] **Step 2 — Confirm fail**

As above.

- [ ] **Step 3 — Implement `bg_matte.py`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/python/bg_matte.py`:

```python
#!/usr/bin/env python3
# Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
#
# bg_matte.py — BiRefNet alpha-matte generator for ATLAS Video Studio.
# Usage: python bg_matte.py <video_path> <model_dir> <output_matte_path>
#
# Writes a ProRes 4444 .mov (alpha channel preserved) to <output_matte_path>.
# Logs progress every 30 frames to stderr: [bg_matte] frame 30/300 (10%) gpu=cuda

import os
import subprocess
import sys
import shutil


def main() -> None:
    if len(sys.argv) != 4:
        print("Usage: bg_matte.py <video_path> <model_dir> <output_matte_path>", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    model_dir = sys.argv[2]
    output_matte_path = sys.argv[3]

    try:
        import cv2
        import numpy as np
        import torch
        from transformers import AutoModelForImageSegmentation
    except ImportError as e:
        print(f"[bg_matte] Import error — missing dependency: {e}", file=sys.stderr)
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[bg_matte] Loading BiRefNet from {model_dir} on {device}", file=sys.stderr)

    try:
        model = AutoModelForImageSegmentation.from_pretrained(
            model_dir,
            trust_remote_code=True,
        )
        model.to(device)
        model.eval()
    except Exception as e:
        print(f"[bg_matte] Failed to load model: {e}", file=sys.stderr)
        sys.exit(1)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[bg_matte] Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    frames_dir = output_matte_path + "_frames"
    os.makedirs(frames_dir, exist_ok=True)

    BIREFNET_SIZE = 1024
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    frame_idx = 0
    try:
        while True:
            ret, bgr = cap.read()
            if not ret:
                break

            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            resized = cv2.resize(rgb, (BIREFNET_SIZE, BIREFNET_SIZE))
            tensor = (resized.astype(np.float32) / 255.0 - mean) / std
            tensor = torch.from_numpy(tensor).permute(2, 0, 1).unsqueeze(0).to(device)

            with torch.no_grad():
                output = model(tensor)
                if isinstance(output, (list, tuple)):
                    pred = output[-1]
                else:
                    pred = output
                if hasattr(pred, "logits"):
                    pred = pred.logits
                alpha = torch.sigmoid(pred).squeeze().cpu().numpy()

            alpha_resized = cv2.resize(alpha.astype(np.float32), (orig_w, orig_h))
            alpha_uint8 = (alpha_resized * 255).clip(0, 255).astype(np.uint8)

            frame_path = os.path.join(frames_dir, f"frame_{frame_idx:06d}.png")
            cv2.imwrite(frame_path, alpha_uint8)

            frame_idx += 1
            if frame_idx % 30 == 0:
                pct = int(frame_idx / max(total_frames, 1) * 100)
                print(
                    f"[bg_matte] frame {frame_idx}/{total_frames} ({pct}%) gpu={device}",
                    file=sys.stderr,
                    flush=True,
                )
    except Exception as e:
        cap.release()
        print(f"[bg_matte] Inference error at frame {frame_idx}: {e}", file=sys.stderr)
        sys.exit(1)

    cap.release()
    print(f"[bg_matte] Inference complete — {frame_idx} frames. Stitching to ProRes 4444...", file=sys.stderr)

    frame_pattern = os.path.join(frames_dir, "frame_%06d.png")
    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg_bin,
        "-framerate", str(fps),
        "-i", frame_pattern,
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-y",
        output_matte_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[bg_matte] ffmpeg stitch failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    shutil.rmtree(frames_dir, ignore_errors=True)
    print(f"[bg_matte] Done — matte written to {output_matte_path}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[bg_matte] Fatal: {exc}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 4 — Confirm pass**

```bash
python src/video-studio/python/bg_matte.py 2>&1 | grep "Usage"
```

Expected: `Usage: bg_matte.py <video_path> <model_dir> <output_matte_path>`.

- [ ] **Step 5 — Gate**

```bash
git add src/video-studio/python/bg_matte.py
```

---

### Task 32: `src/video-studio/effects/bg-remove.ts` + tests

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/effects/bg-remove.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/effects/__tests__/bg-remove.test.ts`

---

- [ ] **Step 1 — Write failing tests**

Create `/Users/user/Desktop/ATLAS/src/video-studio/effects/__tests__/bg-remove.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("../../util/model-cache.js", () => ({
    ensureModel: vi.fn(),
    ModelDownloadBlockedError: class ModelDownloadBlockedError extends Error {
        readonly reason: string;
        constructor(reason: string) {
            super(`Model download blocked: ${reason}`);
            this.name = "ModelDownloadBlockedError";
            this.reason = reason;
        }
    },
}));
vi.mock("../../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import fs from "node:fs";
import { ensureModel } from "../../util/model-cache.js";
import { runPython } from "../../util/python-sidecar.js";
import { generateAlphaMatte } from "../bg-remove.js";

const VIDEO_PATH = "/fake/video.mp4";
const PROJECT_ROOT = "/fake/project";

function mockStat(mtime = 1000, size = 50000): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: mtime, size } as unknown as fs.Stats);
}

describe("generateAlphaMatte — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
    });

    it("returns cached matte path without calling ensureModel or runPython", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const result = await generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT);
        expect(result).toMatch(/matte-[0-9a-f]{16}\.mov$/);
        expect(ensureModel).not.toHaveBeenCalled();
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("generateAlphaMatte — cache miss", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it("calls ensureModel('birefnet') then runPython on cache miss", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockResolvedValue("");
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            return String(p).includes("matte-");
        });

        const result = await generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT);
        expect(ensureModel).toHaveBeenCalledWith("birefnet", expect.any(Object));
        expect(runPython).toHaveBeenCalledWith(
            expect.stringContaining("bg_matte.py"),
            expect.arrayContaining([VIDEO_PATH]),
            expect.objectContaining({ timeoutMs: 30 * 60 * 1000 }),
        );
        expect(result).toMatch(/matte-[0-9a-f]{16}\.mov$/);
    });

    it("surfaces ModelDownloadBlockedError('kill_switch') when kill-switch is on", async () => {
        const { ModelDownloadBlockedError: MDBE } = await import("../../util/model-cache.js");
        vi.mocked(ensureModel).mockRejectedValue(new MDBE("kill_switch"));
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "kill_switch",
        });
        expect(runPython).not.toHaveBeenCalled();
    });

    it("surfaces ModelDownloadBlockedError('user_declined') when user declines confirm", async () => {
        const { ModelDownloadBlockedError: MDBE } = await import("../../util/model-cache.js");
        vi.mocked(ensureModel).mockRejectedValue(new MDBE("user_declined"));
        const confirm = vi.fn().mockResolvedValue(false);
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT, { confirm })).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "user_declined",
        });
        expect(runPython).not.toHaveBeenCalled();
    });

    it("propagates timeout error from runPython", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockRejectedValue(new Error("bg_matte.py timed out after 1800000ms"));
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(/timed out/i);
    });

    it("rejects descriptively when runPython succeeds but no output file is created", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockResolvedValue("");
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(
            /bg_matte\.py did not produce output/i,
        );
    });
});
```

- [ ] **Step 2 — Confirm fail**

```bash
npx vitest run src/video-studio/effects/__tests__/bg-remove.test.ts
```

Expected: module-not-found for `../bg-remove.js`.

- [ ] **Step 3 — Implement `bg-remove.ts`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/effects/bg-remove.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModel, ModelDownloadBlockedError } from "../util/model-cache.js";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BG_MATTE_PY = join(__dirname, "../python/bg_matte.py");

export interface AlphaMatteOpts {
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
}

function buildCacheKey(videoPath: string): string {
    const stat = statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function generateAlphaMatte(
    videoPath: string,
    projectRoot: string,
    opts?: AlphaMatteOpts,
): Promise<string> {
    const hash = buildCacheKey(videoPath);
    const cacheDir = join(projectRoot, "cache");
    const cachePath = join(cacheDir, `matte-${hash}.mov`);

    if (existsSync(cachePath)) {
        return cachePath;
    }

    await mkdir(cacheDir, { recursive: true });

    const modelDir = await ensureModel("birefnet", { confirm: opts?.confirm });

    await ensurePythonEnv();

    await runPython(BG_MATTE_PY, [videoPath, modelDir, cachePath], {
        timeoutMs: 30 * 60 * 1000,
    });

    if (!existsSync(cachePath)) {
        throw new Error(
            `[bg-remove] bg_matte.py did not produce output at expected path: ${cachePath}`,
        );
    }

    return cachePath;
}

export { ModelDownloadBlockedError };
```

- [ ] **Step 4 — Confirm pass**

```bash
npx vitest run src/video-studio/effects/__tests__/bg-remove.test.ts
```

Expected: all 6 tests green.

- [ ] **Step 5 — Gate**

```bash
git add src/video-studio/effects/bg-remove.ts src/video-studio/effects/__tests__/bg-remove.test.ts
```

---

### Task 33: FilterComplexBuilder `addAlphaMerge` + `addColorGrade` + `compilePlanAsync` dispatch

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-builder.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/ffmpeg-renderer.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-builder.test.ts`
- Modify: `/Users/user/Desktop/ATLAS/src/video-studio/render/__tests__/ffmpeg-renderer.test.ts`

---

- [ ] **Step 1 — Write failing tests**

Append to `ffmpeg-builder.test.ts`:

```typescript
describe("FilterComplexBuilder — addAlphaMerge", () => {
    it("produces a 2-fragment chain: alphamerge then overlay", () => {
        const b = new FilterComplexBuilder();
        const fg = b.addTrim(0, 0, 5);
        b.addAlphaMerge(fg, "[1:v]", "[2:v]");
        const graph = b.build().filterGraph;
        const parts = graph.split(";");
        expect(parts).toHaveLength(3);
        expect(parts[1]).toContain("alphamerge");
        expect(parts[2]).toContain("overlay");
    });

    it("returns the final overlay output label", () => {
        const b = new FilterComplexBuilder();
        const fg = b.addTrim(0, 0, 5);
        const out = b.addAlphaMerge(fg, "[1:v]", "[2:v]");
        expect(out).toMatch(/^\[l\d+\]$/);
        expect(b.build().filterGraph).toContain(out);
    });
});

describe("FilterComplexBuilder — addColorGrade", () => {
    it("warm preset includes colortemperature=temperature=5500", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "warm");
        expect(b.build().filterGraph).toContain("colortemperature=temperature=5500");
    });

    it("cool preset includes colortemperature=temperature=7500", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "cool");
        expect(b.build().filterGraph).toContain("colortemperature=temperature=7500");
    });

    it("vintage preset includes curves=vintage", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "vintage");
        expect(b.build().filterGraph).toContain("curves=vintage");
    });

    it("mono preset includes hue=s=0", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "mono");
        expect(b.build().filterGraph).toContain("hue=s=0");
    });
});
```

Also add tests to `ffmpeg-renderer.test.ts` verifying `compilePlanAsync` dispatches effects: one for `color_grade:warm` (asserts `addColorGrade` is called), one for `bg_replace:bg.jpg` (asserts `generateAlphaMatte` is called and 2 extra inputs are added), one for unknown effect (asserts warning + skip, not throw).

- [ ] **Step 2 — Confirm fail**

Run tests — the new methods/behaviors aren't implemented yet.

- [ ] **Step 3 — Implement additions**

Add to `ffmpeg-builder.ts`:

```typescript
/**
 * Composite foreground over background using a separate alpha matte.
 */
addAlphaMerge(fgLabel: string, alphaLabel: string, bgLabel: string): string {
    const merged = this.nextLabel();
    const out = this.nextLabel();
    this.fragments.push(`${fgLabel}${alphaLabel}alphamerge${merged}`);
    this.fragments.push(`${bgLabel}${merged}overlay${out}`);
    return out;
}

/**
 * Apply a color grading preset: "cool" | "mono" | "vintage" | "warm".
 */
addColorGrade(baseLabel: string, preset: "cool" | "mono" | "vintage" | "warm"): string {
    const out = this.nextLabel();
    let filter: string;
    switch (preset) {
        case "cool":
            filter = "colortemperature=temperature=7500,eq=saturation=0.95";
            break;
        case "mono":
            filter = "hue=s=0";
            break;
        case "vintage":
            filter = "curves=vintage,eq=saturation=0.7";
            break;
        case "warm":
            filter = "colortemperature=temperature=5500,eq=saturation=1.1:gamma=1.05";
            break;
    }
    this.fragments.push(`${baseLabel}${filter}${out}`);
    return out;
}
```

Extend `compilePlanAsync` in `ffmpeg-renderer.ts` to:
1. Iterate each clip's `effects ?? []`
2. Parse each via `parseEffect(raw)` from `../plan/effects.js`
3. Dispatch:
   - `bg_replace` → `await generateAlphaMatte(sourceAbs, projectRoot, {confirm: opts.confirm})`, add matte + bg as new inputs, `builder.addAlphaMerge(currentLabel, matteLabel, bgLabel)`
   - `color_grade` → `builder.addColorGrade(currentLabel, preset)`
   - `stabilize` / `stylize` → warn + skip (Phase 3 stubs)
   - unknown → warn + skip

Also extend `RenderOpts`:

```typescript
export interface RenderOpts {
    onProgress?: (percent: number) => void;
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
}
```

- [ ] **Step 4 — Confirm pass**

```bash
npx vitest run src/video-studio/render/
```

- [ ] **Step 5 — Gate**

```bash
git add src/video-studio/render/ffmpeg-builder.ts src/video-studio/render/ffmpeg-renderer.ts src/video-studio/render/__tests__/
```

---

### Task 34: `src/video-studio/assets/stock-broll.ts` + tests

**Files:**
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/assets/stock-broll.ts`
- Create: `/Users/user/Desktop/ATLAS/src/video-studio/assets/__tests__/stock-broll.test.ts`

---

- [ ] **Step 1 — Write failing tests**

Create `/Users/user/Desktop/ATLAS/src/video-studio/assets/__tests__/stock-broll.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StockBrollDisabledError, downloadStockClip, searchStockVideo } from "../stock-broll.js";
import type { StockClip } from "../stock-broll.js";

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

describe("searchStockVideo — disabled", () => {
    it("throws StockBrollDisabledError when PEXELS_API_KEY is not set", async () => {
        await expect(searchStockVideo("nature")).rejects.toThrow(StockBrollDisabledError);
        await expect(searchStockVideo("nature")).rejects.toThrow(/PEXELS_API_KEY not set/);
    });
});

describe("searchStockVideo — enabled", () => {
    beforeEach(() => {
        process.env.PEXELS_API_KEY = "test-key-123";
    });

    it("parses Pexels API response into StockClip array", async () => {
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
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => mockResponse,
            }),
        );

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
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ videos: [] }),
            }),
        );
        const results = await searchStockVideo("zzz_nonexistent_query");
        expect(results).toEqual([]);
    });

    it("surfaces descriptive error on network failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
        await expect(searchStockVideo("ocean")).rejects.toThrow(/network error/i);
    });

    it("surfaces auth-failed error on 401 response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                json: async () => ({}),
            }),
        );
        await expect(searchStockVideo("ocean")).rejects.toThrow(/auth failed|401/i);
    });
});

describe("downloadStockClip", () => {
    beforeEach(() => {
        process.env.PEXELS_API_KEY = "test-key-123";
    });

    function makeClip(id = "99"): StockClip {
        return {
            durationSec: 10,
            height: 1080,
            id,
            provider: "pexels",
            thumbnailUrl: undefined,
            url: `https://example.com/clip-${id}.mp4`,
            width: 1920,
        };
    }

    it("downloads the clip and returns the file path", async () => {
        const fakeBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                arrayBuffer: async () => fakeBytes.buffer,
            }),
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
});
```

- [ ] **Step 2 — Confirm fail**

```bash
npx vitest run src/video-studio/assets/__tests__/stock-broll.test.ts
```

Expected: module-not-found.

- [ ] **Step 3 — Implement `stock-broll.ts`**

Create `/Users/user/Desktop/ATLAS/src/video-studio/assets/stock-broll.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface StockClip {
    durationSec: number;
    height: number;
    id: string;
    provider: "pexels";
    thumbnailUrl?: string;
    url: string;
    width: number;
}

export class StockBrollDisabledError extends Error {
    constructor() {
        super("PEXELS_API_KEY not set — stock B-roll is opt-in.");
        this.name = "StockBrollDisabledError";
    }
}

interface PexelsVideoFile {
    height: number;
    link: string;
    quality: string;
    width: number;
}

interface PexelsVideo {
    duration: number;
    id: number;
    image?: string;
    video_files: PexelsVideoFile[];
}

interface PexelsSearchResponse {
    videos: PexelsVideo[];
}

function requireApiKey(): string {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new StockBrollDisabledError();
    return key;
}

function pickLargestFile(files: PexelsVideoFile[]): PexelsVideoFile | undefined {
    if (files.length === 0) return undefined;
    return files.reduce((best, f) => (f.width * f.height > best.width * best.height ? f : best), files[0]);
}

function clipCacheName(clip: StockClip): string {
    return `${clip.provider}-${clip.id}.mp4`;
}

export async function searchStockVideo(
    query: string,
    opts?: { count?: number },
): Promise<StockClip[]> {
    const key = requireApiKey();
    const count = opts?.count ?? 10;
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}`;

    let resp: Response;
    try {
        resp = await fetch(url, { headers: { Authorization: key } });
    } catch (err) {
        throw new Error(`[stock-broll] Pexels search network error: ${String(err)}`);
    }

    if (resp.status === 401) {
        throw new Error("[stock-broll] Pexels auth failed (401) — check PEXELS_API_KEY");
    }
    if (!resp.ok) {
        throw new Error(`[stock-broll] Pexels search HTTP error ${resp.status}`);
    }

    const data = (await resp.json()) as PexelsSearchResponse;
    const videos: PexelsVideo[] = data.videos ?? [];

    return videos.map((v): StockClip => {
        const best = pickLargestFile(v.video_files);
        return {
            durationSec: v.duration,
            height: best?.height ?? 0,
            id: String(v.id),
            provider: "pexels",
            thumbnailUrl: v.image,
            url: best?.link ?? "",
            width: best?.width ?? 0,
        };
    });
}

export async function downloadStockClip(clip: StockClip, destDir: string): Promise<string> {
    await fs.mkdir(destDir, { recursive: true });
    const cacheName = clipCacheName(clip);
    const destPath = join(destDir, cacheName);

    try {
        await fs.access(destPath);
        return destPath;
    } catch {
        // cache miss — fall through
    }

    let resp: Response;
    try {
        resp = await fetch(clip.url);
    } catch (err) {
        throw new Error(`[stock-broll] Download network error for clip ${clip.id}: ${String(err)}`);
    }

    if (!resp.ok) {
        throw new Error(
            `[stock-broll] Download HTTP error ${resp.status} ${resp.statusText} for clip ${clip.id}: ${clip.url}`,
        );
    }

    const buffer = await resp.arrayBuffer();
    await fs.writeFile(destPath, new Uint8Array(buffer));
    return destPath;
}
```

- [ ] **Step 4 — Confirm pass**

```bash
npx vitest run src/video-studio/assets/__tests__/stock-broll.test.ts
```

- [ ] **Step 5 — Gate**

```bash
git add src/video-studio/assets/stock-broll.ts src/video-studio/assets/__tests__/stock-broll.test.ts
```

---

### Task 35: Smoke test extension + Layer G milestone commit

**Files:**
- Modify: `/Users/user/Desktop/ATLAS/scripts/video-studio-smoke.ts`

---

- [ ] **Step 1 — Plan heavy-path additions**

Extend existing smoke test with Phase 2 heavy leg gated on `ATLAS_VIDEO_SMOKE_HEAVY=1`:
- Leg A: `crop: "auto_face"` → assert 9:16 aspect
- Leg B: `effects: ["color_grade:warm"]` → assert output size differs from baseline
- Leg C: `effects: ["bg_replace:bg.jpg"]` with auto-declining `confirm` → assert `ModelDownloadBlockedError`

- [ ] **Step 2 — Replace smoke script**

Update `/Users/user/Desktop/ATLAS/scripts/video-studio-smoke.ts` to add the heavy-path section. Keep the existing 7-step baseline flow. Add `runHeavyLegs(fixturePath, projectRoot, baselineSize)` function gated on `process.env.ATLAS_VIDEO_SMOKE_HEAVY === "1"`.

Heavy-leg implementation skeleton:

```typescript
import { ModelDownloadBlockedError } from "../src/video-studio/effects/bg-remove.js";

async function runHeavyLegs(fixturePath: string, projectRoot: string, baselineSize: number): Promise<void> {
    log("\n=== Phase 2 Heavy-Path Legs (ATLAS_VIDEO_SMOKE_HEAVY=1) ===\n");
    const exercised: string[] = [];
    const skipped: string[] = [];

    // Leg A: crop=auto_face → 9:16 aspect
    try {
        const planA = makePlan(fixturePath, "vid_smoke_autocrop", "renders/smoke_autocrop.mp4", "9:16", "1080x1920", { crop: "auto_face" });
        const legARoot = `${projectRoot}/heavy-a`;
        await fs.mkdir(legARoot, { recursive: true });
        const { outputPath: outA } = await renderPlan(planA, legARoot);
        await assertFileExists(outA, "auto_face rendered mp4");
        const { width, height } = await ffprobeVideoSize(outA);
        if (height / width < 1.5) fail(`Leg A: expected 9:16 (h/w>=1.5) got ${height}x${width}`);
        exercised.push("auto_face crop → 9:16 aspect");
    } catch (err) {
        skip(`Leg A: ${String(err)}`);
        skipped.push("auto_face crop");
    }

    // Leg B: color_grade:warm → output size differs from baseline
    try {
        const planB = makePlan(fixturePath, "vid_smoke_colorgrade", "renders/smoke_colorgrade.mp4", "16:9", "640x360", { effects: ["color_grade:warm"] });
        const legBRoot = `${projectRoot}/heavy-b`;
        await fs.mkdir(legBRoot, { recursive: true });
        const { outputPath: outB } = await renderPlan(planB, legBRoot);
        await assertFileExists(outB, "color_grade:warm rendered mp4");
        const statB = await fs.stat(outB);
        const pct = Math.abs(statB.size - baselineSize) / Math.max(baselineSize, 1) * 100;
        log(`  OK  Leg B: size diff ${pct.toFixed(1)}% baseline=${baselineSize} warm=${statB.size}`);
        exercised.push("color_grade:warm effect dispatch");
    } catch (err) {
        fail(`Leg B FAIL: ${String(err)}`);
    }

    // Leg C: bg_replace with auto-declining confirm → ModelDownloadBlockedError
    try {
        const planC = makePlan(fixturePath, "vid_smoke_bgreplace", "renders/smoke_bgreplace.mp4", "16:9", "640x360", { effects: ["bg_replace:bg.jpg"] });
        const legCRoot = `${projectRoot}/heavy-c`;
        await fs.mkdir(legCRoot, { recursive: true });
        const autoDecline = async () => false;

        let threw = false;
        try {
            await renderPlan(planC, legCRoot, { confirm: autoDecline });
        } catch (err) {
            if (err instanceof ModelDownloadBlockedError) {
                threw = true;
                log(`  OK  Leg C: ModelDownloadBlockedError as expected`);
            } else {
                throw err;
            }
        }
        if (!threw) fail("Leg C: expected ModelDownloadBlockedError");
        exercised.push("bg_replace auto-declined → ModelDownloadBlockedError");
    } catch (err) {
        if (!(err instanceof ModelDownloadBlockedError)) fail(`Leg C: ${String(err)}`);
    }

    log("\n--- Phase 2 Heavy-Path Summary ---");
    for (const item of exercised) log(`  EXERCISED: ${item}`);
    for (const item of skipped) skip(`  ${item}`);
}
```

Then in `main()`:
```typescript
if (process.env.ATLAS_VIDEO_SMOKE_HEAVY === "1") {
    await runHeavyLegs(fixturePath, project.rootDir, baselineStat.size);
} else {
    log("\nPhase 2 heavy-path skipped (set ATLAS_VIDEO_SMOKE_HEAVY=1 to enable).");
}
```

- [ ] **Step 3 — Run baseline smoke test**

```bash
npx tsx scripts/video-studio-smoke.ts
```

Expected: existing 7-step flow passes, "Phase 2 heavy-path skipped" printed at end.

- [ ] **Step 4 — Run full test suite**

```bash
npx vitest run
```

Expected: ≥226 tests pass.

- [ ] **Step 5 — Stage smoke script**

```bash
git add scripts/video-studio-smoke.ts
```

- [ ] **Step 6 — Layer G milestone commit**

```bash
cd /Users/user/Desktop/ATLAS
git add \
    src/video-studio/python/bg_matte.py \
    src/video-studio/effects/bg-remove.ts \
    src/video-studio/effects/__tests__/bg-remove.test.ts \
    src/video-studio/render/ffmpeg-builder.ts \
    src/video-studio/render/ffmpeg-renderer.ts \
    src/video-studio/render/__tests__/ffmpeg-builder.test.ts \
    src/video-studio/render/__tests__/ffmpeg-renderer.test.ts \
    src/video-studio/assets/stock-broll.ts \
    src/video-studio/assets/__tests__/stock-broll.test.ts \
    scripts/video-studio-smoke.ts
git -c user.email="local@atlas.dev" -c user.name="ATLAS Local" commit -m "feat(video-studio): Layer G — bg removal, stock b-roll, integration"
```

---


## Phase 2 Verification Checklist

Run these checks after all 13 tasks are implemented. They confirm the full surface is correct.

- [ ] **1. Kill-switch:** `ATLAS_VIDEO_NO_HEAVY=1` + `ensureModel("birefnet")` → `ModelDownloadBlockedError` with `reason: "kill_switch"`. No network activity.
- [ ] **2. User-declined:** confirm callback returning `false` → `ModelDownloadBlockedError` with `reason: "user_declined"`. No download.
- [ ] **3. Disk-space:** mocked `<5GB free` → `ModelDownloadBlockedError` with `reason: "disk_space"`. No network.
- [ ] **4. Schema v2:** `EditPlanSchema` accepts `crop: "auto_face"` and `crop: "0:0:1920:1080"`; rejects `crop: "garbage"`. `VideoTrackSchema` exported.
- [ ] **5. parseEffect:** valid directives parse to correct `EffectDirective`; malformed return `null`.
- [ ] **6. Face detection:** `detectFaces(videoPath, projectRoot)` returns `FaceTrack` with `frames[].faces[]` bounding boxes. Cache hash-keyed.
- [ ] **7. Auto-crop smoothness:** `computeAutoCrop` with `alpha=0.12` has no crop-center jump > 20px between adjacent frames (500px face movement test).
- [ ] **8. Auto-crop aspect:** `renderPlan` with `crop: "auto_face"` and `output.aspect: "9:16"` produces mp4 with `ffprobe` height/width ≥ 1.5.
- [ ] **9. generateAlphaMatte gate:** `ATLAS_VIDEO_NO_HEAVY=1` + `generateAlphaMatte(...)` → surfaces `ModelDownloadBlockedError("kill_switch")`.
- [ ] **10. color_grade alters output:** `effects: ["color_grade:warm"]` rendered mp4 size differs from baseline by > 5% (use color-bar fixture if black fixture is idempotent under color temperature).
- [ ] **11. StockBrollDisabledError:** `delete process.env.PEXELS_API_KEY` + `searchStockVideo("ocean")` throws `StockBrollDisabledError` without calling `fetch`.
- [ ] **12. searchStockVideo:** with `PEXELS_API_KEY` set + mocked `fetch` → returns `StockClip[]` with proper shape.
- [ ] **13. Total tests ≥ 226:** `npm run test` shows ≥226 tests passing (166 Phase 1 + ≥60 Phase 2).
- [ ] **14. Commit history:** `git log --oneline | grep "feat(video-studio):"` shows 7 commits (4 Phase 1 + 3 Phase 2 layer milestones).
- [ ] **15. TypeScript clean:** `npx tsc --noEmit` clean on all new files.
- [ ] **16. Heavy smoke:** `ATLAS_VIDEO_SMOKE_HEAVY=1 npm run smoke:video` passes the auto-crop + color-grade legs, and the bg_replace leg correctly surfaces `ModelDownloadBlockedError` when `confirm` returns false.

---

## Constraints Summary for Future Agents

| Constraint | Detail |
|---|---|
| BiRefNet size | ~400MB. `ensureModel` must fire `confirm` callback before first download. |
| MediaPipe Python | No wheels for Python 3.13. `pyproject.toml` pins `requires-python = ">=3.10,<3.13"`. |
| CUDA vs CPU | `bg_matte.py` detects at runtime (`torch.cuda.is_available()`), falls back to CPU. |
| `ATLAS_VIDEO_NO_HEAVY` | Blocks Tier 3/4 only. MediaPipe (Tier 2) always available. |
| Disk-space helper | `fs.statfs` (Node 18+). Require `bsize * bavail >= 5 * 1024**3`. Catch `ENOSYS` and skip on unsupported platforms. |
| `compilePlanAsync` | Used only when a clip has `crop === "auto_face"` OR `effects` includes `bg_replace:...`. Sync `compilePlan` still handles the common path. |
| `sendcmd` script | Written to `<projectRoot>/renders/sendcmd-<ts>-<clipId>.txt`. FFmpeg `sendcmd=f=...,crop=W:H:X:Y` references it. |
| Dynamic imports | `compilePlanAsync` uses `await import("../analyze/face-track.js")`, `import("../effects/bg-remove.js")` etc. to avoid circular imports at module load. |
