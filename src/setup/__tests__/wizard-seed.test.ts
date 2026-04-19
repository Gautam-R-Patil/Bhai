// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { buildIdentityUpdate, seedProfileIfPresent, resolveProfilePaths } from "../wizard-seed.js";

// ── Fake filesystem for unit-testing without touching real disk ──
interface FileMap { [path: string]: string; }
function makeFs(files: FileMap): any {
    return {
        existsSync: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
        readFileSync: (p: string) => {
            if (!Object.prototype.hasOwnProperty.call(files, p)) {
                const err: any = new Error("ENOENT");
                err.code = "ENOENT";
                throw err;
            }
            return files[p];
        },
        renameSync: (from: string, to: string) => {
            if (!Object.prototype.hasOwnProperty.call(files, from)) throw new Error("ENOENT");
            files[to] = files[from];
            delete files[from];
        },
    };
}

describe("buildIdentityUpdate", () => {
    it("maps name directly to identity.name", () => {
        expect(buildIdentityUpdate({ name: "Dheeraj" })).toEqual({ name: "Dheeraj" });
    });
    it("maps tone to preferences.communication_style", () => {
        const out = buildIdentityUpdate({ name: "A", tone: "playful" });
        expect(out.preferences).toEqual({ communication_style: "playful" });
    });
    it("trims whitespace from name and tone", () => {
        const out = buildIdentityUpdate({ name: "  Ava  ", tone: "  friendly  " });
        expect(out.name).toBe("Ava");
        expect(out.preferences?.communication_style).toBe("friendly");
    });
    it("does NOT set name if it's only whitespace", () => {
        const out = buildIdentityUpdate({ name: "   " });
        expect(out.name).toBeUndefined();
    });
    it("preserves legacy v1 fields (age, gender) into extra", () => {
        const out = buildIdentityUpdate({ name: "Dheeraj", tone: "friendly", age: 25, gender: "m" });
        expect(out.extra).toEqual({ age: 25, gender: "m" });
    });
    it("preserves arbitrary unknown fields into extra", () => {
        const out = buildIdentityUpdate({ name: "X", favoriteFood: "dosa", timezone: "IST" });
        expect(out.extra).toEqual({ favoriteFood: "dosa", timezone: "IST" });
    });
    it("omits extra key entirely when no unknown fields are present", () => {
        const out = buildIdentityUpdate({ name: "X", tone: "friendly" });
        expect(out.extra).toBeUndefined();
    });
    it("skips null/undefined values when building extra", () => {
        const out = buildIdentityUpdate({ name: "X", tone: "friendly", age: undefined as any, foo: null as any });
        expect(out.extra).toBeUndefined();
    });
    it("empty profile → empty update (no name)", () => {
        expect(buildIdentityUpdate({})).toEqual({});
    });
});

describe("resolveProfilePaths", () => {
    it("prefers userDataDir when both are provided", () => {
        const p = resolveProfilePaths({ userDataDir: "/ud", dataDir: "/dd" });
        expect(p.source).toContain("/ud");
        expect(p.marker).toContain("/ud");
    });
    it("falls back to dataDir when userDataDir missing", () => {
        const p = resolveProfilePaths({ dataDir: "/dd" });
        expect(p.source).toContain("/dd");
    });
    it("uses empty base when neither dir is provided", () => {
        const p = resolveProfilePaths({});
        expect(p.source).toBe(".user-profile.json");
    });
});

describe("seedProfileIfPresent", () => {
    it("no-op when profile file is absent", () => {
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs({}), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res).toEqual({ ran: false, reason: "no-file" });
        expect(updates).toEqual([]);
    });

    it("seeds identity on first boot, renames source to marker", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ name: "Dheeraj", tone: "friendly" }) };
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res.ran).toBe(true);
        expect(res.reason).toBe("seeded");
        expect(res.seeded).toEqual({ name: "Dheeraj", tone: "friendly" });
        expect(updates).toHaveLength(1);
        expect(updates[0].name).toBe("Dheeraj");
        expect(updates[0].preferences.communication_style).toBe("friendly");
        // Source file renamed to marker
        expect(files["/ud/.user-profile.json"]).toBeUndefined();
        expect(files["/ud/.user-profile.seeded.json"]).toBeDefined();
    });

    it("idempotent on repeat boots — skips when marker exists", () => {
        const files: FileMap = {
            "/ud/.user-profile.json": JSON.stringify({ name: "X", tone: "friendly" }),
            "/ud/.user-profile.seeded.json": "previous-boot-data",
        };
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res).toEqual({ ran: false, reason: "already-seeded" });
        expect(updates).toEqual([]);
    });

    it("parse error returns reason + does not update identity", () => {
        const files: FileMap = { "/ud/.user-profile.json": "not json" };
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res.ran).toBe(false);
        expect(res.reason).toBe("parse-error");
        expect(updates).toEqual([]);
        // Source file is NOT renamed on parse error — leave for inspection / retry
        expect(files["/ud/.user-profile.json"]).toBeDefined();
    });

    it("no-name profile returns 'no-name' reason + leaves file for next boot", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ tone: "friendly", age: 25 }) };
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res).toEqual({ ran: false, reason: "no-name" });
        expect(updates).toEqual([]);
        expect(files["/ud/.user-profile.json"]).toBeDefined(); // NOT renamed
    });

    it("preserves legacy age/gender via extra on seed", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ name: "Ava", tone: "friendly", age: 30, gender: "f" }) };
        const updates: any[] = [];
        seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (u: any) => updates.push(u) as any },
        );
        expect(updates[0].extra).toEqual({ age: 30, gender: "f" });
    });

    it("updateFn throw is caught and returned as parse-error", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ name: "X" }) };
        const updateFn = () => { throw new Error("db closed"); };
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: updateFn as any },
        );
        expect(res.ran).toBe(false);
        expect(res.error).toMatch(/db closed/);
    });

    it("rename failure is non-fatal — still returns ran:true (identity already updated)", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ name: "X" }) };
        const fsLike = makeFs(files) as any;
        fsLike.renameSync = () => { throw new Error("EPERM"); };
        const updates: any[] = [];
        const res = seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike, updateFn: (u: any) => updates.push(u) as any },
        );
        expect(res.ran).toBe(true);
        expect(updates).toHaveLength(1);
    });

    it("log function receives seed summary on success", () => {
        const files: FileMap = { "/ud/.user-profile.json": JSON.stringify({ name: "Dheeraj" }) };
        const logs: string[] = [];
        seedProfileIfPresent(
            { userDataDir: "/ud" },
            { fsLike: makeFs(files), updateFn: (() => ({}) as any) as any, log: (m) => logs.push(m) },
        );
        expect(logs.some((l) => /seeded identity for Dheeraj/.test(l))).toBe(true);
    });
});
