// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { migrateLegacySetup, runMigrationIfNeeded } from "../../migration/v2-setup.js";

describe("migrateLegacySetup — pure function", () => {
    it("adds setup-version: 2 to bare prefs", () => {
        const out = migrateLegacySetup({ hotkey: "Alt+Space", theme: "dark" });
        expect(out["setup-version"]).toBe(2);
        expect(out.hotkey).toBe("Alt+Space");
        expect(out.theme).toBe("dark");
    });

    it("preserves age + gender from legacy v1 profile (don't lose user data)", () => {
        const legacy = { profile: { name: "Ava", age: 30, gender: "f", tone: "friendly" } };
        const out = migrateLegacySetup(legacy);
        expect(out.profile.age).toBe(30);
        expect(out.profile.gender).toBe("f");
        expect(out.profile.tone).toBe("friendly");
        expect(out.profile.name).toBe("Ava");
    });

    it("is idempotent on already-v2 prefs (returns same object)", () => {
        const v2 = { "setup-version": 2, profile: { name: "A" } };
        expect(migrateLegacySetup(v2)).toBe(v2);
    });

    it("creates empty channels when missing", () => {
        const out = migrateLegacySetup({});
        expect(out.channels).toEqual({});
    });

    it("fills permissions with 'unknown' defaults", () => {
        const out = migrateLegacySetup({});
        expect(out.permissions).toEqual({
            accessibility: "unknown",
            screen: "unknown",
            microphone: "unknown",
            location: "unknown",
        });
    });

    it("preserves existing channels object", () => {
        const out = migrateLegacySetup({ channels: { telegram: { connected: true } } });
        expect(out.channels).toEqual({ telegram: { connected: true } });
    });

    it("preserves existing permissions object", () => {
        const out = migrateLegacySetup({ permissions: { accessibility: "granted", screen: "granted", microphone: "denied", location: "unknown" } });
        expect(out.permissions.accessibility).toBe("granted");
        expect(out.permissions.microphone).toBe("denied");
    });

    it("handles null input without throwing", () => {
        const out = migrateLegacySetup(null);
        expect(out["setup-version"]).toBe(2);
    });

    it("returns a NEW object (doesn't mutate input)", () => {
        const input = { profile: { name: "X" } };
        const out = migrateLegacySetup(input);
        expect(out).not.toBe(input);
        expect(input["setup-version"]).toBeUndefined();
    });
});

describe("runMigrationIfNeeded — filesystem behavior", () => {
    let tmp;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-mig-")); });

    it("no-op when setupFlag is absent (fresh install)", async () => {
        const res = await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        expect(res).toEqual({ ran: false, reason: "no-setup-flag" });
        expect(fs.existsSync(path.join(tmp, "prefs.json"))).toBe(false);
    });

    it("no-op when prefs already v2", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), JSON.stringify({ "setup-version": 2 }));
        const res = await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        expect(res).toEqual({ ran: false, reason: "already-v2" });
    });

    it("migrates v1 prefs → v2, preserving legacy profile fields", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), JSON.stringify({
            profile: { name: "Dheeraj", age: 25, gender: "m", tone: "friendly" },
            hotkey: { current: "Alt+Space", conflicts: [] },
        }));
        const res = await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        expect(res.ran).toBe(true);
        const migrated = JSON.parse(fs.readFileSync(path.join(tmp, "prefs.json"), "utf8"));
        expect(migrated["setup-version"]).toBe(2);
        expect(migrated.profile.age).toBe(25);
        expect(migrated.profile.gender).toBe("m");
        expect(migrated.profile.name).toBe("Dheeraj");
    });

    it("seeds setup-state.json with all phases complete on migration", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), JSON.stringify({ profile: { name: "X" } }));
        await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        const state = JSON.parse(fs.readFileSync(path.join(tmp, "setup-state.json"), "utf8"));
        for (const id of ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"]) {
            expect(state[id].completedAt).toBeDefined();
        }
        expect(state.__version).toBe(2);
    });

    it("does NOT overwrite existing setup-state.json", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), JSON.stringify({ profile: { name: "X" } }));
        fs.writeFileSync(path.join(tmp, "setup-state.json"), JSON.stringify({ custom: "preserved" }));
        await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        const state = JSON.parse(fs.readFileSync(path.join(tmp, "setup-state.json"), "utf8"));
        expect(state.custom).toBe("preserved");
    });

    it("tolerates corrupt prefs.json by treating as {} and migrating", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), "not json{");
        const res = await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
        });
        expect(res.ran).toBe(true);
        const migrated = JSON.parse(fs.readFileSync(path.join(tmp, "prefs.json"), "utf8"));
        expect(migrated["setup-version"]).toBe(2);
    });

    it("calls loadEnvDecrypted best-effort but does not fail migration on env error", async () => {
        fs.writeFileSync(path.join(tmp, ".setup-complete"), "marker");
        fs.writeFileSync(path.join(tmp, "prefs.json"), JSON.stringify({ profile: { name: "X" } }));
        const logs = [];
        const res = await runMigrationIfNeeded({
            userDataDir: tmp,
            setupFlagPath: path.join(tmp, ".setup-complete"),
            loadEnvDecrypted: () => { throw new Error("no env key"); },
            log: (m) => logs.push(m),
        });
        expect(res.ran).toBe(true);
        expect(logs.some((m) => /env decrypt warn/.test(m))).toBe(true);
    });

    it("skips when userDataDir is missing (no throw)", async () => {
        const res = await runMigrationIfNeeded({});
        expect(res.ran).toBe(false);
        expect(res.reason).toBe("missing-paths");
    });
});
