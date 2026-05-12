// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Per-monitor drift calibration (Phase 5).
 *
 * Learns a 2D affine transform `[a b tx; c d ty]` that maps "predicted click
 * coords" to "actual click coords" on a given monitor, based on observed miss
 * vectors. Persisted to `<data>/drift-calibration.json`.
 *
 * Usage:
 *   1. On every click, after the post-click outcome classifier runs, call
 *      `recordCalibrationSample(monitorId, predicted, actual)`.
 *   2. Before any click, call `applyCalibration(monitorId, x, y)` to adjust the
 *      output. If <5 samples for the monitor, returns input unchanged.
 *
 * The transform is fit via simple least-squares over the recent 32 samples per
 * monitor (rolling window). On a fresh user with no samples, applyCalibration
 * is a no-op (returns input). Once the user has ~10 successful clicks, the
 * transform starts compensating for systematic offsets (e.g. DPI mismatches,
 * coordinate-system bugs in user's specific OS configuration).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AffineTransform {
    a: number;
    b: number;
    tx: number;
    c: number;
    d: number;
    ty: number;
}

interface MonitorSamples {
    samples: Array<{ px: number; py: number; ax: number; ay: number; ts: number }>;
    transform: AffineTransform;
    lastFit: number;
}

interface DriftStore {
    version: number;
    monitors: Record<string, MonitorSamples>;
}

const IDENTITY: AffineTransform = { a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 };
const SAMPLE_WINDOW = 32;
const MIN_SAMPLES_FOR_FIT = 5;
const STORE_VERSION = 1;

let _store: DriftStore | null = null;
let _storePath: string | null = null;

function getStorePath(): string {
    if (_storePath) return _storePath;
    _storePath = join(process.cwd(), "data", "drift-calibration.json");
    return _storePath;
}

export function setDriftStorePath(p: string): void {
    _storePath = p;
    _store = null;
}

function loadStore(): DriftStore {
    if (_store) return _store;
    const path = getStorePath();
    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, "utf-8");
            const parsed = JSON.parse(raw) as DriftStore;
            if (parsed.version === STORE_VERSION && parsed.monitors) {
                _store = parsed;
                return _store;
            }
        } catch {
            /* corrupt or stale — start fresh */
        }
    }
    _store = { version: STORE_VERSION, monitors: {} };
    return _store;
}

function persistStore(): void {
    if (!_store) return;
    const path = getStorePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(path, JSON.stringify(_store, null, 2), { mode: 0o600 });
    } catch {
        /* persist is best-effort */
    }
}

/** Record an observed (predicted → actual) coordinate pair for a monitor. */
export function recordCalibrationSample(
    monitorId: string,
    predicted: { x: number; y: number },
    actual: { x: number; y: number },
): void {
    const store = loadStore();
    if (!store.monitors[monitorId]) {
        store.monitors[monitorId] = { samples: [], transform: { ...IDENTITY }, lastFit: 0 };
    }
    const m = store.monitors[monitorId];
    m.samples.push({ px: predicted.x, py: predicted.y, ax: actual.x, ay: actual.y, ts: Date.now() });
    if (m.samples.length > SAMPLE_WINDOW) m.samples = m.samples.slice(-SAMPLE_WINDOW);
    if (m.samples.length >= MIN_SAMPLES_FOR_FIT) {
        m.transform = fitAffine(m.samples);
        m.lastFit = Date.now();
    }
    persistStore();
}

/** Apply the learned drift correction to a predicted click coordinate. */
export function applyCalibration(monitorId: string, x: number, y: number): { x: number; y: number } {
    const store = loadStore();
    const m = store.monitors[monitorId];
    if (!m || m.samples.length < MIN_SAMPLES_FOR_FIT) {
        return { x, y };
    }
    const t = m.transform;
    return {
        x: Math.round(t.a * x + t.b * y + t.tx),
        y: Math.round(t.c * x + t.d * y + t.ty),
    };
}

/** Get the current transform for a monitor (identity if no samples). */
export function getCalibrationTransform(monitorId: string): AffineTransform {
    const store = loadStore();
    return store.monitors[monitorId]?.transform || { ...IDENTITY };
}

/** Clear all calibration data. */
export function clearCalibration(): void {
    _store = { version: STORE_VERSION, monitors: {} };
    persistStore();
}

/** Least-squares fit of a 2D affine transform mapping (px,py) → (ax,ay). */
export function fitAffine(samples: Array<{ px: number; py: number; ax: number; ay: number }>): AffineTransform {
    if (samples.length < 3) return { ...IDENTITY };
    let sxx = 0,
        sxy = 0,
        syy = 0,
        sx = 0,
        sy = 0,
        n = 0;
    let sxu = 0,
        syu = 0,
        su = 0;
    let sxv = 0,
        syv = 0,
        sv = 0;
    for (const s of samples) {
        sxx += s.px * s.px;
        sxy += s.px * s.py;
        syy += s.py * s.py;
        sx += s.px;
        sy += s.py;
        sxu += s.px * s.ax;
        syu += s.py * s.ax;
        su += s.ax;
        sxv += s.px * s.ay;
        syv += s.py * s.ay;
        sv += s.ay;
        n++;
    }
    const m = [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx, sy, n],
    ];
    const abTx = solve3x3(m, [sxu, syu, su]);
    const cdTy = solve3x3(m, [sxv, syv, sv]);
    if (!abTx || !cdTy) return { ...IDENTITY };
    return {
        a: abTx[0],
        b: abTx[1],
        tx: abTx[2],
        c: cdTy[0],
        d: cdTy[1],
        ty: cdTy[2],
    };
}

function solve3x3(m: number[][], b: number[]): number[] | null {
    const det =
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) < 1e-9) return null;
    const detX =
        b[0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (b[1] * m[2][2] - m[1][2] * b[2]) +
        m[0][2] * (b[1] * m[2][1] - m[1][1] * b[2]);
    const detY =
        m[0][0] * (b[1] * m[2][2] - m[1][2] * b[2]) -
        b[0] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * b[2] - b[1] * m[2][0]);
    const detZ =
        m[0][0] * (m[1][1] * b[2] - b[1] * m[2][1]) -
        m[0][1] * (m[1][0] * b[2] - b[1] * m[2][0]) +
        b[0] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    return [detX / det, detY / det, detZ / det];
}
