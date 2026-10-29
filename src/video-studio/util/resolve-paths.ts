// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Resolves video-studio resource paths in a bundle-aware way.
// Uses process.cwd() so paths work whether code runs as individual dist/ files
// or as a single esbuild bundle (where import.meta.url points to the bundle).

import path from "node:path";

export function getVSPythonDir(): string {
    return path.join(process.cwd(), "src", "video-studio", "python");
}

export function getVSPythonScript(filename: string): string {
    return path.join(getVSPythonDir(), filename);
}

export function getVSSfxDir(): string {
    return path.join(process.cwd(), "src", "video-studio", "assets", "sfx");
}
