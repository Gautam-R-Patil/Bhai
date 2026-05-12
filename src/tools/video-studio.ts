// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../config/paths.js";
import type { LLMClient } from "../llm.js";
import { buildTimeline } from "../video-studio/analyze/timeline-builder.js";
import {
    downloadStockClip,
    type StockProvider,
    searchStockVideo,
    selectDefaultProvider,
} from "../video-studio/assets/stock-broll.js";
import { PlanValidationError, planEdit } from "../video-studio/plan/planner.js";
import { type EditPlan, validateEditPlan } from "../video-studio/plan/schema.js";
import { createProject, listProjects, loadProject } from "../video-studio/project.js";
import { renderPlan } from "../video-studio/render/ffmpeg-renderer.js";
import { ffmpegPath } from "../video-studio/util/ffmpeg-bin.js";
import type { ToolDefinition } from "./get-current-time.js";

const execFileP = promisify(execFile);

// ── LLM client injection ──────────────────────────
// Module-scoped LLM client. Callers (index.ts boot sequence) must call
// setVideoStudioLLMClient() at startup to enable `video_plan_edit`.

let _llmClient: LLMClient | null = null;

export function setVideoStudioLLMClient(client: LLMClient): void {
    _llmClient = client;
}

function getLLMClient(): LLMClient | null {
    return _llmClient;
}

// ── Helpers ───────────────────────────────────────

function errResult(message: string): string {
    return JSON.stringify({ error: message });
}

function errFromUnknown(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return errResult(msg);
}

// ── Minimal RFC 6902 JSON Patch applier ──────────
// Supports: "replace", "add", "remove". No external dependency.

interface JsonPatchOp {
    op: "replace" | "add" | "remove";
    path: string;
    value?: unknown;
}

function applyJsonPatch(doc: unknown, ops: JsonPatchOp[]): unknown {
    const clone = JSON.parse(JSON.stringify(doc));
    for (const op of ops) {
        const parts = op.path
            .split("/")
            .slice(1)
            .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
        let target: unknown = clone;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (Array.isArray(target)) {
                target = (target as unknown[])[Number(key)];
            } else if (target && typeof target === "object") {
                target = (target as Record<string, unknown>)[key];
            } else {
                throw new Error(`JSON Patch path ${op.path} unreachable`);
            }
        }
        const last = parts[parts.length - 1];
        if (op.op === "remove") {
            if (Array.isArray(target)) (target as unknown[]).splice(Number(last), 1);
            else delete (target as Record<string, unknown>)[last];
        } else if (op.op === "add" || op.op === "replace") {
            if (Array.isArray(target) && last === "-") (target as unknown[]).push(op.value);
            else if (Array.isArray(target)) (target as unknown[])[Number(last)] = op.value;
            else (target as Record<string, unknown>)[last] = op.value;
        }
    }
    return clone;
}

// ── Safety gate for video_ffmpeg ─────────────────

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function validateFfmpegArgs(args: string[]): { ok: boolean; reason?: string } {
    const dataVideoProjects = `${path.resolve(getDataDir(), "video-projects")}${path.sep}`;
    // Build the set of accepted tmp-dir prefixes. macOS makes this tricky:
    // /tmp → /private/tmp and /var → /private/var are both symlinks, and
    // os.tmpdir() can return either side depending on env. Accept the raw
    // resolved form and the realpath-resolved form so a match on either
    // side of the symlink is enough.
    const resolvedTmp = path.resolve(tmpdir());
    const realTmp = (() => {
        try {
            return realpathSync(resolvedTmp);
        } catch {
            return resolvedTmp;
        }
    })();
    const tmpPrefix = `${resolvedTmp}${path.sep}`;
    const tmpPrefixes = new Set<string>([tmpPrefix]);
    if (realTmp !== resolvedTmp) tmpPrefixes.add(`${realTmp}${path.sep}`);
    // macOS: /tmp itself is a universal alias many tools use.
    if (process.platform === "darwin") {
        tmpPrefixes.add(`/tmp${path.sep}`);
        tmpPrefixes.add(`/private/tmp${path.sep}`);
    }

    // Generic URL-scheme regex (RFC 3986 style), case-insensitive.
    // Any arg that looks like "<scheme>://..." OR ffmpeg's "concat:..." pseudo-scheme is rejected
    // unless the scheme matches our tiny allowlist (empty for Phase 1 — no remote sources allowed).
    const SCHEME_RE = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/i;

    function checkPath(p: string, role: "input" | "output"): { ok: boolean; reason?: string } {
        const lower = p.toLowerCase();

        // 1. Reject any URL-like scheme
        if (SCHEME_RE.test(p)) {
            // Allow bare drive-letter Windows paths like "C:\foo" — but we're blocking Windows for now
            // since we normalize to posix-style. Any scheme:// is rejected.
            return { ok: false, reason: `unsafe: URL-like scheme rejected in ${role} "${p}"` };
        }

        // 2. Reject path traversal
        if (p.includes("..")) {
            return { ok: false, reason: `unsafe: path traversal ".." rejected in ${role} "${p}"` };
        }

        // 3. Must be an absolute path
        if (!path.isAbsolute(p)) {
            return {
                ok: false,
                reason: `unsafe: relative ${role} path "${p}" — use an absolute path inside ${tmpPrefix} or ${dataVideoProjects}`,
            };
        }

        // 4. Must be inside the OS temp dir or <dataDir>/video-projects/.
        // Try both the raw absolute form and the realpath-resolved form so
        // a symlinked output dir like /tmp → /private/tmp matches on either
        // side of the link. realpathSync throws for non-existent paths
        // (common for output files) — fall back to resolve in that case.
        const candidates = new Set<string>([path.resolve(p)]);
        try {
            candidates.add(realpathSync(path.resolve(p)));
        } catch {
            /* path may not exist yet — resolved form is enough */
        }
        const isWin = process.platform === "win32";
        const norm = (s: string) => (isWin ? s.toLowerCase() : s);
        const allowed = [...tmpPrefixes, dataVideoProjects].map(norm);
        const matched = [...candidates].some((c) => allowed.some((prefix) => norm(c).startsWith(prefix)));
        if (!matched) {
            return {
                ok: false,
                reason: `unsafe: ${role} "${p}" is outside ${tmpPrefix} and ${dataVideoProjects}`,
            };
        }

        return { ok: true };
    }

    // Walk args to find -i <path> inputs and the output (last positional).
    const argCount = args.length;
    const outputIdx = findOutputArgIndex(args);

    for (let i = 0; i < argCount; i++) {
        if (args[i] === "-i" && i + 1 < argCount) {
            const result = checkPath(args[i + 1], "input");
            if (!result.ok) return result;
            i++; // skip the path we just checked
        }
    }

    if (outputIdx !== -1) {
        const result = checkPath(args[outputIdx], "output");
        if (!result.ok) return result;
    }

    return { ok: true };
}

/**
 * Find the index of the output positional argument in an ffmpeg arg list.
 * FFmpeg's convention: the output is the LAST positional (non-flag, not a value
 * immediately following a `-flag`). Returns -1 if no output positional found
 * (e.g. arg-less commands like `["-version"]`).
 *
 * Heuristic: scan backwards; the first arg that isn't preceded by a flag-taking
 * option is the output. Conservative — if ambiguous, returns the last arg.
 */
function findOutputArgIndex(args: string[]): number {
    if (args.length === 0) return -1;
    // The last arg is a candidate. If the second-to-last is a flag that takes a value
    // (starts with "-" and is NOT one of the known booleans like -y, -n, -nostats, -version),
    // then the last arg is a value, not an output. Simpler heuristic: if the last arg
    // starts with "-", it's a flag (no positional output); otherwise it's the output.
    const last = args[args.length - 1];
    if (last.startsWith("-")) return -1;
    // Make sure it isn't the value for a -option immediately before it
    if (args.length >= 2) {
        const prev = args[args.length - 2];
        // If prev is `-i`, the last arg is an input (already covered by the input scan), not output.
        if (prev === "-i") return -1;
    }
    return args.length - 1;
}

// ── Tool definitions ─────────────────────────────

export const videoCreateProject: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_create_project",
            description:
                "Create a new video editing project and copy input files into it. Returns a projectId used by all subsequent video tools. ALWAYS call this first.",
            parameters: {
                type: "object",
                properties: {
                    inputs: {
                        type: "array",
                        items: { type: "string" },
                        description: "Absolute paths to video input files.",
                    },
                },
                required: ["inputs"],
            },
        },
    },

    async handler(input) {
        try {
            const inputs = input.inputs;
            if (!Array.isArray(inputs) || inputs.some((x) => typeof x !== "string")) {
                return errResult("`inputs` must be an array of string paths");
            }
            if (inputs.length === 0) {
                return errResult("`inputs` must not be empty");
            }
            const project = await createProject(inputs as string[]);
            return JSON.stringify({
                success: true,
                projectId: project.id,
                rootDir: project.rootDir,
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoAnalyze: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_analyze",
            description:
                "Analyze a video project: detect scenes, caption keyframes, produce a word-level transcript. Writes timeline.json. Results are cached per input file.",
            parameters: {
                type: "object",
                properties: {
                    projectId: { type: "string", description: "Project ID from video_create_project." },
                },
                required: ["projectId"],
            },
        },
    },

    async handler(input) {
        try {
            const projectId = input.projectId;
            if (typeof projectId !== "string" || projectId.length === 0) {
                return errResult("`projectId` is required");
            }
            const project = await loadProject(projectId);
            const timeline = await buildTimeline(project.inputs, project.rootDir);

            // Terse summary — keep agent context lean. Handle both single-video
            // Timeline and TimelineMap shapes.
            let videoCount = 0;
            let totalScenes = 0;
            if (timeline && typeof timeline === "object" && "scenes" in timeline) {
                videoCount = 1;
                totalScenes = (timeline as { scenes: unknown[] }).scenes.length;
            } else {
                const entries = Object.values(timeline as Record<string, { scenes: unknown[] }>);
                videoCount = entries.length;
                totalScenes = entries.reduce((acc, t) => acc + (t.scenes?.length ?? 0), 0);
            }

            return JSON.stringify({
                success: true,
                projectId,
                videoCount,
                totalScenes,
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoPlanEdit: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_plan_edit",
            description:
                "Ask the LLM to compose edit_plan.json from timeline.json + a natural-language user intent. Pass your intent, e.g. 'make a 20s highlight reel with karaoke captions'.",
            parameters: {
                type: "object",
                properties: {
                    projectId: { type: "string" },
                    userIntent: {
                        type: "string",
                        description: "Natural-language description of the desired edit.",
                    },
                },
                required: ["projectId", "userIntent"],
            },
        },
    },

    async handler(input) {
        try {
            const projectId = input.projectId;
            const userIntent = input.userIntent;
            if (typeof projectId !== "string" || projectId.length === 0) {
                return errResult("`projectId` is required");
            }
            if (typeof userIntent !== "string" || userIntent.length === 0) {
                return errResult("`userIntent` is required");
            }

            const llm = getLLMClient();
            if (!llm) {
                return errResult("LLM client not initialized");
            }

            const project = await loadProject(projectId);
            const raw = await fs.readFile(project.timelinePath, "utf8");
            const timeline = JSON.parse(raw);

            try {
                const plan = await planEdit({ llm, timeline, userIntent, projectId });
                await fs.writeFile(project.planPath, JSON.stringify(plan, null, 2), "utf8");

                return JSON.stringify({
                    success: true,
                    planPath: project.planPath,
                    videoClips: plan.tracks.video.length,
                    overlays: plan.tracks.overlays?.length ?? 0,
                });
            } catch (e) {
                if (e instanceof PlanValidationError) {
                    return JSON.stringify({
                        error: `plan validation failed: ${e.validationErrors.join("; ")}`,
                        attempts: 2,
                    });
                }
                throw e;
            }
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoRender: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_render",
            description:
                "Render the current edit_plan.json to an mp4 via FFmpeg. Requires a project with an analyzed timeline and a planned edit.",
            parameters: {
                type: "object",
                properties: {
                    projectId: { type: "string" },
                },
                required: ["projectId"],
            },
        },
    },

    async handler(input) {
        try {
            const projectId = input.projectId;
            if (typeof projectId !== "string" || projectId.length === 0) {
                return errResult("`projectId` is required");
            }
            const project = await loadProject(projectId);
            const raw = await fs.readFile(project.planPath, "utf8");
            const plan = JSON.parse(raw) as EditPlan;
            const result = await renderPlan(plan, project.rootDir);
            return JSON.stringify({
                success: true,
                outputPath: result.outputPath,
                logPath: result.logPath,
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoPatchPlan: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_patch_plan",
            description:
                "Apply an RFC 6902 JSON Patch to edit_plan.json and re-validate. Use for small tweaks without re-running the LLM planner.",
            parameters: {
                type: "object",
                properties: {
                    projectId: { type: "string" },
                    patch: {
                        type: "array",
                        description: "Array of RFC 6902 JSON Patch operations (replace/add/remove supported).",
                        items: { type: "object" },
                    },
                },
                required: ["projectId", "patch"],
            },
        },
    },

    async handler(input) {
        try {
            const projectId = input.projectId;
            const patch = input.patch;
            if (typeof projectId !== "string" || projectId.length === 0) {
                return errResult("`projectId` is required");
            }
            if (!Array.isArray(patch)) {
                return errResult("`patch` must be an array of JSON Patch ops");
            }

            const project = await loadProject(projectId);
            const raw = await fs.readFile(project.planPath, "utf8");
            const currentPlan = JSON.parse(raw);

            const patched = applyJsonPatch(currentPlan, patch as unknown as JsonPatchOp[]);
            const v = validateEditPlan(patched);
            if (!v.ok) {
                return errResult(`patched plan invalid: ${v.errors.join("; ")}`);
            }

            await fs.writeFile(project.planPath, JSON.stringify(v.plan, null, 2), "utf8");
            return JSON.stringify({
                success: true,
                opsApplied: (patch as unknown[]).length,
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoFfmpeg: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_ffmpeg",
            description:
                "ESCAPE HATCH: run raw ffmpeg. SAFETY: input paths must be inside data/video-projects/ or /tmp/. URLs and .. path traversal are BLOCKED. Prefer the higher-level tools.",
            parameters: {
                type: "object",
                properties: {
                    args: {
                        type: "array",
                        items: { type: "string" },
                        description: "Raw ffmpeg argv (excluding the binary itself).",
                    },
                },
                required: ["args"],
            },
        },
    },

    async handler(input) {
        try {
            const args = input.args;
            if (!Array.isArray(args) || args.some((x) => typeof x !== "string")) {
                return errResult("`args` must be an array of strings");
            }
            const check = validateFfmpegArgs(args as string[]);
            if (!check.ok) {
                return JSON.stringify({ error: check.reason });
            }

            const bin = ffmpegPath();
            try {
                const { stdout, stderr } = await execFileP(bin, args as string[], {
                    timeout: 60_000,
                    maxBuffer: 10 * 1024 * 1024,
                });
                return JSON.stringify({
                    success: true,
                    stdout: truncate(String(stdout), 4000),
                    stderr: truncate(String(stderr), 4000),
                });
            } catch (e) {
                const err = e as { message?: string; stdout?: string; stderr?: string };
                return JSON.stringify({
                    error: err.message ?? "ffmpeg failed",
                    stdout: truncate(String(err.stdout ?? ""), 4000),
                    stderr: truncate(String(err.stderr ?? ""), 4000),
                });
            }
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoListProjects: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_list_projects",
            description: "List all video editing projects in ATLAS's data directory, newest first.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler(_input) {
        try {
            const projects = await listProjects();
            return JSON.stringify({
                success: true,
                projects: projects.map((p) => ({
                    id: p.id,
                    rootDir: p.rootDir,
                    inputCount: p.inputs.length,
                })),
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};

export const videoSearchBroll: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "video_search_broll",
            description:
                "Search free stock b-roll footage by keyword. Defaults to Internet Archive (keyless, public-domain) — no API key required. Uses Pexels automatically if PEXELS_API_KEY is set for higher-quality modern clips. Optionally downloads the first N results into the project's assets/broll directory and returns local file paths.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search keyword, e.g. 'ocean waves' or 'city traffic'." },
                    count: {
                        type: "number",
                        description: "Max results to return. Default 5, max 25.",
                    },
                    provider: {
                        type: "string",
                        enum: ["internet_archive", "pexels"],
                        description:
                            "Force a provider. Omit to auto-select (pexels if PEXELS_API_KEY set, else internet_archive).",
                    },
                    projectId: {
                        type: "string",
                        description:
                            "If provided, downloads the returned clips into <project>/assets/broll/ and includes localPath in each result.",
                    },
                    downloadFirst: {
                        type: "number",
                        description:
                            "Number of top results to download locally when projectId is provided. Default 0 (search-only). Max equal to count.",
                    },
                },
                required: ["query"],
            },
        },
    },

    async handler(input) {
        try {
            const query = typeof input.query === "string" ? input.query.trim() : "";
            if (!query) return errResult("`query` is required and must be non-empty");

            const count = Math.min(25, Math.max(1, Number(input.count) || 5));
            const provider = typeof input.provider === "string" ? (input.provider as StockProvider) : undefined;
            const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
            const downloadFirst = Math.max(0, Math.min(count, Number(input.downloadFirst) || 0));

            const clips = await searchStockVideo(query, { count, provider });

            let downloads: Array<{ id: string; localPath: string }> = [];
            if (projectId && downloadFirst > 0) {
                const project = await loadProject(projectId);
                const destDir = path.join(project.rootDir, "assets", "broll");
                const toDownload = clips.slice(0, downloadFirst);
                downloads = await Promise.all(
                    toDownload.map(async (clip) => ({
                        id: clip.id,
                        localPath: await downloadStockClip(clip, destDir),
                    })),
                );
            }

            const localPathById = new Map(downloads.map((d) => [d.id, d.localPath]));

            return JSON.stringify({
                success: true,
                provider: clips[0]?.provider ?? provider ?? selectDefaultProvider(),
                count: clips.length,
                clips: clips.map((c) => ({
                    id: c.id,
                    provider: c.provider,
                    url: c.url,
                    thumbnailUrl: c.thumbnailUrl,
                    width: c.width,
                    height: c.height,
                    durationSec: c.durationSec,
                    localPath: localPathById.get(c.id),
                })),
            });
        } catch (e) {
            return errFromUnknown(e);
        }
    },
};
