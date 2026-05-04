// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { auditLog } from "./audit-log.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpy = any;

describe("auditLog", () => {
    // Use `any` on the spy types to sidestep vitest's strict mock-signature
    // overload matching for fs builtins — the TypeScript types for
    // fs.appendFile (3-arg overload) vs vi.spyOn (generic return) don't
    // unify cleanly without this widening. We assert only on
    // mock.calls / mock.calls[n] which are typed separately.
    let appendSpy: AnySpy;
    let existsSpy: AnySpy;
    let mkdirSpy: AnySpy;

    beforeEach(() => {
        // Intercept every fs call the module makes so tests never
        // touch the real data/audit.jsonl and work even when the
        // parent data/ dir doesn't exist.
        appendSpy = vi
            .spyOn(fs, "appendFile")
            .mockImplementation((_p, _d, cb) => {
                if (typeof cb === "function") (cb as (e: unknown) => void)(null);
            });
        existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("entry format", () => {
        it("appends a single JSONL line per call", () => {
            auditLog("file_read", { path: "/tmp/foo" });
            expect(appendSpy).toHaveBeenCalledOnce();
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            // Single line + trailing newline (JSONL convention)
            expect(data.endsWith("\n")).toBe(true);
            expect(data.match(/\n/g)).toHaveLength(1);
        });

        it("emits valid JSON on the entry line", () => {
            auditLog("shell_exec", { command: "ls", args: ["-la"] });
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            const entry = JSON.parse(data.trim());
            expect(entry.action).toEqual("shell_exec");
            expect(entry.command).toEqual("ls");
            expect(entry.args).toEqual(["-la"]);
        });

        it("writes an ISO-8601 timestamp", () => {
            auditLog("test", {});
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            const entry = JSON.parse(data.trim());
            expect(entry.timestamp).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
            );
            // And it's within the last minute.
            const t = new Date(entry.timestamp).getTime();
            const now = Date.now();
            expect(now - t).toBeLessThan(60_000);
            expect(now - t).toBeGreaterThanOrEqual(0);
        });

        it("spreads the details object at the top level", () => {
            auditLog("write", { path: "/x", size: 42, tool: "edit" });
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            const entry = JSON.parse(data.trim());
            expect(entry.path).toEqual("/x");
            expect(entry.size).toEqual(42);
            expect(entry.tool).toEqual("edit");
            expect(entry.action).toEqual("write");
        });

        it("preserves the exact action string", () => {
            auditLog("custom_action_name_123", { ok: true });
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            const entry = JSON.parse(data.trim());
            expect(entry.action).toEqual("custom_action_name_123");
        });

        it("handles empty details", () => {
            auditLog("ping", {});
            const [, data] = appendSpy.mock.calls[0] as unknown as [string, string, unknown];
            const entry = JSON.parse(data.trim());
            expect(Object.keys(entry).sort()).toEqual(["action", "timestamp"]);
        });
    });

    describe("file path", () => {
        it("targets data/audit.jsonl", () => {
            auditLog("test", {});
            const [target] = appendSpy.mock.calls[0] as unknown as [string, unknown, unknown];
            expect(target).toMatch(/data[\/\\]audit\.jsonl$/);
        });
    });

    describe("directory creation", () => {
        it("creates data/ when it doesn't exist", () => {
            existsSpy.mockReturnValue(false);
            auditLog("test", {});
            expect(mkdirSpy).toHaveBeenCalledOnce();
            const [dir, opts] = mkdirSpy.mock.calls[0] as unknown as [
                string,
                { recursive?: boolean },
            ];
            expect(dir).toMatch(/data$/);
            expect(opts).toEqual({ recursive: true });
        });

        it("skips mkdir when data/ already exists", () => {
            existsSpy.mockReturnValue(true);
            auditLog("test", {});
            expect(mkdirSpy).not.toHaveBeenCalled();
        });
    });

    describe("fail-open guarantees", () => {
        it("does not throw when fs.appendFile fails asynchronously", () => {
            appendSpy.mockImplementation((_p: unknown, _d: unknown, cb: unknown) => {
                if (typeof cb === "function") {
                    (cb as (e: unknown) => void)(new Error("disk full"));
                }
            });
            expect(() => auditLog("test", {})).not.toThrow();
        });

        it("does not throw when mkdirSync throws", () => {
            existsSpy.mockReturnValue(false);
            mkdirSpy.mockImplementation(() => {
                throw new Error("permission denied");
            });
            expect(() => auditLog("test", {})).not.toThrow();
        });

        it("does not throw when details contains a circular structure", () => {
            // JSON.stringify throws on circular refs; auditLog's try/catch
            // must swallow that so callers in the tool-execution hot path
            // never see an audit failure.
            type Cycle = { self?: unknown };
            const bad: Cycle = {};
            bad.self = bad;
            expect(() => auditLog("test", { bad })).not.toThrow();
            // When the entry couldn't be serialized, appendFile was
            // never called — no half-written log line.
            expect(appendSpy).not.toHaveBeenCalled();
        });

        it("does not throw when fs.existsSync throws", () => {
            existsSpy.mockImplementation(() => {
                throw new Error("stat failed");
            });
            expect(() => auditLog("test", {})).not.toThrow();
        });
    });

    describe("multiple calls", () => {
        it("appends independently per call (no internal batching)", () => {
            auditLog("a", { i: 1 });
            auditLog("b", { i: 2 });
            auditLog("c", { i: 3 });
            expect(appendSpy).toHaveBeenCalledTimes(3);
        });

        it("each call produces a distinct timestamp field (monotonic or equal)", () => {
            auditLog("a", {});
            auditLog("b", {});
            const calls = appendSpy.mock.calls as unknown as Array<[string, string, unknown]>;
            const t1 = JSON.parse(calls[0][1].trim()).timestamp;
            const t2 = JSON.parse(calls[1][1].trim()).timestamp;
            expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
        });
    });
});
