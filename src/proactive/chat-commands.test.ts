// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryProactiveCommand } from "./chat-commands.js";

describe("tryProactiveCommand", () => {
    let dir: string;
    let file: string;
    const original = { ...process.env };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-cc-"));
        file = join(dir, "cfg.json");
        delete process.env.ATLAS_PROACTIVE_DISABLE;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.env = { ...original };
    });

    it("`shut up` sets global disable", () => {
        const r = tryProactiveCommand("shut up", { configPath: file });
        expect(r?.reply).toMatch(/quiet/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
    });

    it("`atlas, shut up` works too", () => {
        const r = tryProactiveCommand("atlas, shut up", { configPath: file });
        expect(r?.reply).toMatch(/quiet/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
    });

    it("`resume` clears the disable flag", () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = tryProactiveCommand("resume", { configPath: file });
        expect(r?.reply).toMatch(/resuming/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
    });

    it("`atlas resume` works too", () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = tryProactiveCommand("atlas resume", { configPath: file });
        expect(r?.reply).toMatch(/resuming/i);
    });

    it("`set whatsapp to ambient` persists posture", () => {
        const r = tryProactiveCommand("set whatsapp to ambient", { configPath: file });
        expect(r?.reply).toMatch(/whatsapp/i);
        expect(r?.reply).toMatch(/ambient/i);
        // Reload and verify persistence
        const r2 = tryProactiveCommand("proactive status", { configPath: file });
        expect(r2?.reply).toMatch(/whatsapp: ambient/i);
    });

    it("`set telegram to active` works too", () => {
        const r = tryProactiveCommand("set telegram to active", { configPath: file });
        expect(r?.reply).toMatch(/telegram/i);
        expect(r?.reply).toMatch(/active/i);
    });

    it("rejects unknown channel", () => {
        const r = tryProactiveCommand("set xmpp to calm", { configPath: file });
        expect(r?.reply).toMatch(/unknown channel/i);
    });

    it("rejects unknown preset", () => {
        const r = tryProactiveCommand("set whatsapp to spammy", { configPath: file });
        expect(r?.reply).toMatch(/unknown preset/i);
    });

    it("`proactive status` shows current postures", () => {
        const r = tryProactiveCommand("proactive status", { configPath: file });
        expect(r?.reply).toMatch(/current postures/i);
        expect(r?.reply).toMatch(/whatsapp: calm/i);
        expect(r?.reply).toMatch(/telegram: active/i);
    });

    it("status reply reflects global disable", () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = tryProactiveCommand("proactive status", { configPath: file });
        expect(r?.reply).toMatch(/disabled/i);
    });

    it("returns null for non-command text", () => {
        expect(tryProactiveCommand("hello", { configPath: file })).toBeNull();
        expect(tryProactiveCommand("what does that do?", { configPath: file })).toBeNull();
    });

    it("plain `stop` returns null (handled by stop-signal flow, not us)", () => {
        expect(tryProactiveCommand("stop", { configPath: file })).toBeNull();
    });
});
