#!/usr/bin/env tsx
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { ensureFixture } from "../src/video-studio/__fixtures__/generate-2s.js";
import { buildTimeline } from "../src/video-studio/analyze/timeline-builder.js";
import { createProject } from "../src/video-studio/project.js";
import { renderPlan } from "../src/video-studio/render/ffmpeg-renderer.js";
import { ffprobePath } from "../src/video-studio/util/ffmpeg-bin.js";

const execFileAsync = promisify(execFile);

function log(msg: string): void {
    process.stdout.write(`[smoke:video] ${msg}\n`);
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

    log("Step 7: Cleaning up...");
    await fs.rm(project.rootDir, { recursive: true, force: true });

    log("\nSMOKE TEST PASSED.");
    process.exit(0);
}

main().catch((err) => fail(String(err)));
