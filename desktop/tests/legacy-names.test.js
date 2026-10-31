// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pre-rename (ATLAS) names still read: settings lines, env vars, bot markers,
// log files, the account session, ~/.atlas and the auth page's bridge.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adoptLegacy, bhaiHome, copyLegacyDir, envOf, logDate, upgradeEnvText, upgradeMarkers, withLegacyEnvNames } from "../legacy-names.js";
import { parseCursorLine } from "../agent-cursor.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bhai-legacy-"));

describe("legacy names", () => {
    it("env: BHAI_X, else ATLAS_X", () => {
        expect(envOf("ENV", { BHAI_ENV: "dev", ATLAS_ENV: "prod" })).toBe("dev");
        expect(envOf("ENV", { ATLAS_ENV: "prod" })).toBe("prod");
        expect(envOf("ENV", { BHAI_ENV: "", ATLAS_ENV: "prod" })).toBe("");
        expect(envOf("ENV", {})).toBeUndefined();
    });

    it("settings: ATLAS_X lines become BHAI_X, and a BHAI_X line wins", () => {
        const text = "TELEGRAM_BOT_TOKEN=t\nATLAS_WORKSPACE=/old\n# ATLAS_NOTE=x\nATLAS_ENV=prod\nBHAI_ENV=dev\n";
        expect(upgradeEnvText(text)).toBe("TELEGRAM_BOT_TOKEN=t\nBHAI_WORKSPACE=/old\n# ATLAS_NOTE=x\nBHAI_ENV=dev\n");
        expect(upgradeEnvText("A=1\n")).toBe("A=1\n");
        expect(upgradeEnvText("")).toBe("");
    });

    it("a save after reading old settings leaves no ATLAS_ line for that key", () => {
        // what saveEnvKVs does: read (upgraded), set the key, write back
        const lines = upgradeEnvText("ATLAS_WORKSPACE=/old\nX=1").split("\n");
        const saved = lines.map((l) => (l.startsWith("BHAI_WORKSPACE=") ? "BHAI_WORKSPACE=" : l)).join("\n");
        expect(saved).toBe("BHAI_WORKSPACE=\nX=1");
    });

    it("bot markers: ##ATLAS_X## reads as ##BHAI_X##", () => {
        expect(upgradeMarkers("##ATLAS_READY## 812")).toBe("##BHAI_READY## 812");
        expect(upgradeMarkers("a\n##ATLAS_QR##abc##END_QR##")).toMatch(/##BHAI_QR##(.+)##END_QR##/);
        expect(parseCursorLine(upgradeMarkers('##ATLAS_CURSOR##{"t":"move","x":1,"y":2}'))).toEqual({ t: "move", x: 1, y: 2 });
        expect(upgradeMarkers("##BHAI_PERMS##{}")).toBe("##BHAI_PERMS##{}");
    });

    it("log retention reads both names", () => {
        expect(logDate("bhai-2026-10-31.log")).toBe("2026-10-31");
        expect(logDate("atlas-2026-10-01.log")).toBe("2026-10-01");
        expect(logDate("other-2026-10-01.log")).toBeNull();
        expect(logDate("bhai-2026-10-31.log.bak")).toBeNull();
    });

    it("account session: the old file is copied to the new name (kept for an older build), bytes unchanged", () => {
        const d = tmp();
        const oldF = path.join(d, "atlas-account.enc");
        const newF = path.join(d, "bhai-account.enc");
        fs.writeFileSync(oldF, Buffer.from([1, 2, 3]));
        expect(adoptLegacy(newF, oldF)).toBe(newF);
        expect(fs.readFileSync(newF)).toEqual(Buffer.from([1, 2, 3]));
        expect(fs.readFileSync(oldF)).toEqual(Buffer.from([1, 2, 3]));
        // the new file wins when it is newer…
        fs.writeFileSync(oldF, "stale");
        fs.utimesSync(oldF, new Date(1000), new Date(1000));
        expect(adoptLegacy(newF, oldF)).toBe(newF);
        expect(fs.readFileSync(newF)).toEqual(Buffer.from([1, 2, 3]));
        // …and the old one when an older build (channel downgrade) wrote it since
        fs.writeFileSync(oldF, "re-signed-in");
        fs.utimesSync(oldF, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
        expect(adoptLegacy(newF, oldF)).toBe(newF);
        expect(fs.readFileSync(newF, "utf8")).toBe("re-signed-in");
    });

    it("a failed copy falls back to the old path", () => {
        const d = tmp();
        const oldF = path.join(d, "atlas-account.enc");
        fs.writeFileSync(oldF, "x");
        expect(adoptLegacy(path.join(d, "missing-dir", "bhai-account.enc"), oldF)).toBe(oldF);
    });

    it("settings are saved with ATLAS_ twins for an older build, and load back without them", () => {
        const saved = withLegacyEnvNames("A=1\nBHAI_WORKSPACE=/w\nATLAS_WORKSPACE=/old\nBHAI_NO_X=true");
        expect(saved).toBe("A=1\nBHAI_WORKSPACE=/w\nATLAS_WORKSPACE=/w\nBHAI_NO_X=true\nATLAS_NO_X=true");
        expect(upgradeEnvText(saved)).toBe("A=1\nBHAI_WORKSPACE=/w\nBHAI_NO_X=true");
        expect(withLegacyEnvNames("A=1")).toBe("A=1");
    });

    it("~/.atlas is copied to ~/.bhai once and kept; models/ moved; BHAI_HOME/ATLAS_HOME override", () => {
        const home = tmp();
        expect(bhaiHome(home, {})).toBe(path.join(home, ".bhai")); // fresh install
        fs.rmSync(path.join(home, ".bhai"), { recursive: true, force: true });
        fs.mkdirSync(path.join(home, ".atlas", "store"), { recursive: true });
        fs.mkdirSync(path.join(home, ".atlas", "models", "kokoro"), { recursive: true });
        fs.writeFileSync(path.join(home, ".atlas", "models", "kokoro", "m.onnx"), "w");
        fs.writeFileSync(path.join(home, ".atlas", "overlay-local-token"), "tok");
        fs.mkdirSync(path.join(home, ".bhai.tmp-1")); // left by a copy that was killed
        fs.utimesSync(path.join(home, ".bhai.tmp-1"), new Date(1000), new Date(1000));
        expect(bhaiHome(home, {})).toBe(path.join(home, ".bhai"));
        expect(fs.readFileSync(path.join(home, ".bhai", "overlay-local-token"), "utf8")).toBe("tok");
        expect(fs.existsSync(path.join(home, ".bhai", "store"))).toBe(true);
        expect(fs.readFileSync(path.join(home, ".atlas", "overlay-local-token"), "utf8")).toBe("tok");
        expect(fs.readFileSync(path.join(home, ".bhai", "models", "kokoro", "m.onnx"), "utf8")).toBe("w");
        expect(fs.existsSync(path.join(home, ".atlas", "models"))).toBe(false);
        expect(fs.readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
        if (process.platform !== "win32") expect(fs.statSync(path.join(home, ".bhai")).mode & 0o777).toBe(0o700);
        expect(bhaiHome(home, { ATLAS_HOME: "/x" })).toBe("/x");
        expect(bhaiHome(home, { BHAI_HOME: "/y", ATLAS_HOME: "/x" })).toBe("/y");
    });

    it("a failed copy stays on ~/.atlas and isn't retried until a day later", () => {
        const home = tmp();
        fs.mkdirSync(path.join(home, ".atlas"));
        const spy = vi.spyOn(fs, "cpSync").mockImplementation(() => {
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        });
        try {
            expect(copyLegacyDir(path.join(home, ".bhai"), path.join(home, ".atlas"))).toBe(path.join(home, ".atlas"));
            expect(spy).toHaveBeenCalledTimes(1);
            expect(copyLegacyDir(path.join(home, ".bhai"), path.join(home, ".atlas"))).toBe(path.join(home, ".atlas"));
            expect(spy).toHaveBeenCalledTimes(1); // marker: not retried on the next start
        } finally {
            spy.mockRestore();
        }
        expect(fs.readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
    });

    it("a copy lost to another process (the bot) uses the new dir", () => {
        const home = tmp();
        const oldD = path.join(home, ".atlas");
        const newD = path.join(home, ".bhai");
        fs.mkdirSync(oldD);
        const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
            fs.mkdirSync(newD); // the other process renamed its copy into place first
            throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
        });
        try {
            expect(copyLegacyDir(newD, oldD)).toBe(newD);
        } finally {
            spy.mockRestore();
        }
        expect(fs.existsSync(path.join(oldD, ".bhai-copy-failed"))).toBe(false);
    });

    it("auth preload exposes the same bridge as bhaiAuth and atlasAuth", () => {
        const exposed = {};
        const fake = {
            contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
            ipcRenderer: { invoke: () => {} },
        };
        const load = Module._load;
        Module._load = function (req, ...rest) {
            return req === "electron" ? fake : load.call(this, req, ...rest);
        };
        try {
            createRequire(import.meta.url)("../auth-preload.js");
        } finally {
            Module._load = load;
        }
        expect(typeof exposed.bhaiAuth.submitToken).toBe("function");
        expect(exposed.atlasAuth).toBe(exposed.bhaiAuth);
    });
});
