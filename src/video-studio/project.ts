// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import crypto from "node:crypto";
import fs, { promises as fsp } from "node:fs";
import path from "node:path";

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
    const dataDir = process.env.BHAI_DATA_DIR ?? path.resolve("data");
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
            if (entry.startsWith(`${prefix}_`)) {
                const suffix = entry.slice(prefix.length + 1);
                const n = parseInt(suffix, 10);
                if (!Number.isNaN(n) && n > existingMax) existingMax = n;
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
    await fsp.writeFile(path.join(root, "project.json"), JSON.stringify(meta, null, 2), "utf8");

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
