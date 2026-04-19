#!/usr/bin/env node
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Copies non-TypeScript assets that `tsc` doesn't touch into `dist/` so the
// production build (`node dist/index.js`) and the Electron bundle have
// everything they need at runtime.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function copyFile(src, dest) {
    if (!existsSync(src)) {
        console.warn(`[postbuild] skip (not found): ${src}`);
        return;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    console.log(`[postbuild] ${src} -> ${dest}`);
}

function copyTree(src, dest, filterFn) {
    if (!existsSync(src)) {
        console.warn(`[postbuild] skip (not found): ${src}`);
        return;
    }
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, {
        recursive: true,
        filter: filterFn,
    });
    console.log(`[postbuild] ${src}/ -> ${dest}/`);
}

// Overlay HTML (original postbuild hook)
copyFile(join(REPO_ROOT, "src/overlay/overlay.html"), join(REPO_ROOT, "dist/overlay/overlay.html"));

// Video studio Python sidecars + pyproject.toml
// These are referenced at runtime by face-track.ts, scene-detect.ts,
// transcribe.ts, beat-sync.ts, bg-remove.ts, model-cache.ts, and python-sidecar.ts
// via __dirname-relative paths that resolve to dist/video-studio/python/ in prod.
copyTree(join(REPO_ROOT, "src/video-studio/python"), join(REPO_ROOT, "dist/video-studio/python"), (src) => {
    // Skip Python bytecode caches — they're rebuilt on first run inside the venv
    return !src.includes("__pycache__");
});

console.log("[postbuild] Done copying assets.");
