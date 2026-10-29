// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
    } catch {
        // Will generate below
    }

    await execFileAsync(ffmpegPath(), [
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:r=30",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        FIXTURE_PATH,
    ]);

    return FIXTURE_PATH;
}
