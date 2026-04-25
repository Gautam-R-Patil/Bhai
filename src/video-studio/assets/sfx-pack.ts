// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createRequire } from "node:module";
import { join } from "node:path";
import { getVSSfxDir } from "../util/resolve-paths.js";

const SFX_DIR = getVSSfxDir();
const _require = createRequire(import.meta.url);

export type SFXCategory = "whoosh" | "pop" | "ding" | "impact" | "transition" | "notification" | "typing" | "ambient";

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
    _rawManifest.map((m) => [m.name, { ...m, path: join(SFX_DIR, `${m.name}.mp3`) }]),
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
