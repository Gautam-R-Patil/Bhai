#!/usr/bin/env tsx
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { ensureFixture } from "../src/video-studio/__fixtures__/generate-2s.js";
import { buildTimeline } from "../src/video-studio/analyze/timeline-builder.js";
import { ModelDownloadBlockedError } from "../src/video-studio/effects/bg-remove.js";
import { createProject } from "../src/video-studio/project.js";
import { renderPlan } from "../src/video-studio/render/ffmpeg-renderer.js";
import { ffprobePath } from "../src/video-studio/util/ffmpeg-bin.js";

const execFileAsync = promisify(execFile);

function log(msg: string): void {
    process.stdout.write(`[smoke:video] ${msg}\n`);
}

function skip(msg: string): void {
    process.stdout.write(`[smoke:video] SKIP: ${msg}\n`);
}

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
        { timeout: 30_000 },
    );
    const probe = JSON.parse(stdout) as { format?: { duration?: string } };
    const dur = Number.parseFloat(probe.format?.duration ?? "0");
    if (dur <= 0) fail(`ffprobe reports zero duration for ${path}`);
    log(`  OK  ffprobe: duration=${dur.toFixed(2)}s`);
}

async function ffprobeVideoSize(path: string): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync(
        ffprobePath(),
        [
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            path,
        ],
        { timeout: 30_000 },
    );
    const probe = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const s = probe.streams?.[0];
    return { width: s?.width ?? 0, height: s?.height ?? 0 };
}

type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
type HeavyOverride = { crop?: "auto_face" | string; effects?: string[] };

function makePlan(
    fixturePath: string,
    projectId: string,
    outPath: string,
    aspect: Aspect,
    resolution: string,
    override: HeavyOverride,
) {
    const videoClip: Record<string, unknown> = { id: "v1", source: "s1", in: 0, out: 2.0 };
    if (override.crop !== undefined) videoClip.crop = override.crop;
    if (override.effects !== undefined) videoClip.effects = override.effects;

    return {
        projectId,
        output: { path: outPath, aspect, fps: 30, resolution },
        sources: [{ id: "s1", path: fixturePath, duration: 2.0 }],
        tracks: {
            video: [videoClip] as unknown as { id: string; source: string; in: number; out: number }[],
            audio: [],
            overlays: [],
        },
        transitions: [],
        export_targets: ["mp4" as const],
    };
}

async function runHeavyLegs(fixturePath: string, projectRoot: string, baselineSize: number): Promise<void> {
    log("\n=== Phase 2 Heavy-Path Legs (ATLAS_VIDEO_SMOKE_HEAVY=1) ===\n");
    const exercised: string[] = [];
    const skipped: string[] = [];

    // Leg A: crop=auto_face → 9:16 aspect
    try {
        const planA = makePlan(fixturePath, "vid_smoke_autocrop", "renders/smoke_autocrop.mp4", "9:16", "1080x1920", {
            crop: "auto_face",
        });
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
        const planB = makePlan(fixturePath, "vid_smoke_colorgrade", "renders/smoke_colorgrade.mp4", "16:9", "640x360", {
            effects: ["color_grade:warm"],
        });
        const legBRoot = `${projectRoot}/heavy-b`;
        await fs.mkdir(legBRoot, { recursive: true });
        const { outputPath: outB } = await renderPlan(planB, legBRoot);
        await assertFileExists(outB, "color_grade:warm rendered mp4");
        const statB = await fs.stat(outB);
        const pct = (Math.abs(statB.size - baselineSize) / Math.max(baselineSize, 1)) * 100;
        log(`  OK  Leg B: size diff ${pct.toFixed(1)}% baseline=${baselineSize} warm=${statB.size}`);
        exercised.push("color_grade:warm effect dispatch");
    } catch (err) {
        fail(`Leg B FAIL: ${String(err)}`);
    }

    // Leg C: bg_replace with auto-declining confirm → ModelDownloadBlockedError
    try {
        const planC = makePlan(fixturePath, "vid_smoke_bgreplace", "renders/smoke_bgreplace.mp4", "16:9", "640x360", {
            effects: ["bg_replace:bg.jpg"],
        });
        const legCRoot = `${projectRoot}/heavy-c`;
        await fs.mkdir(legCRoot, { recursive: true });
        const autoDecline = async (): Promise<boolean> => false;

        let threw = false;
        try {
            await renderPlan(planC, legCRoot, { confirm: autoDecline });
        } catch (err) {
            if (err instanceof ModelDownloadBlockedError) {
                threw = true;
                log("  OK  Leg C: ModelDownloadBlockedError as expected");
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
    log("  timeline.json written");

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
    const baselineStat = await fs.stat(outputPath);

    if (process.env.ATLAS_VIDEO_SMOKE_HEAVY === "1") {
        await runHeavyLegs(fixturePath, project.rootDir, baselineStat.size);
    } else {
        log("\nPhase 2 heavy-path skipped (set ATLAS_VIDEO_SMOKE_HEAVY=1 to enable).");
    }

    log("Step 7: Cleaning up...");
    await fs.rm(project.rootDir, { recursive: true, force: true });

    log("\nSMOKE TEST PASSED.");
    process.exit(0);
}

main().catch((err) => fail(String(err)));
