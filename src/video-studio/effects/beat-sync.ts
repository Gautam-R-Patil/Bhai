// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { EditPlan, VideoTrack } from "../plan/schema.js";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";
import { getVSPythonScript } from "../util/resolve-paths.js";

const PYTHON_SCRIPT = getVSPythonScript("beat_detect.py");

function nearestBeat(t: number, beats: number[]): { beat: number; distance: number } {
    let best = beats[0];
    let bestDist = Math.abs(t - beats[0]);
    for (const b of beats) {
        const d = Math.abs(t - b);
        if (d < bestDist) {
            best = b;
            bestDist = d;
        }
    }
    return { beat: best, distance: bestDist };
}

export async function detectBeats(audioPath: string): Promise<number[]> {
    try {
        await ensurePythonEnv();
        const stdout = await runPython(PYTHON_SCRIPT, [audioPath]);
        const beats = JSON.parse(stdout.trim()) as number[];
        return Array.isArray(beats) ? beats : [];
    } catch (err) {
        throw new Error(`Beat detection failed for "${audioPath}": ${(err as Error).message}`);
    }
}

export function snapCutsToBeats(plan: EditPlan, beats: number[], tolerance = 0.15): EditPlan {
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
