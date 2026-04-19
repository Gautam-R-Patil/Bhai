// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { buildChips, CHIP_ORDER } from "../../wizard/chips.js";

function fully() {
    return {
        account: { signedIn: true, email: "a@b.com" },
        google: { connected: true, email: "a@b.com" },
        channels: {
            telegram: { connected: true },
            discord: { connected: true },
            slack: { connected: true },
            whatsapp: { connected: true },
            matrix: { connected: true },
            email: { connected: true },
        },
        workspace: { path: "/tmp/ws", exists: true },
        personalize: {
            hotkey: "Alt+Space",
            theme: "dark",
            voice: { backend: "gemini-live", name: "Aoede" },
        },
    };
}

describe("buildChips", () => {
    it("fresh state → empty array", () => {
        expect(buildChips({})).toEqual([]);
    });
    it("nullish state → empty array (no throw)", () => {
        expect(buildChips(undefined)).toEqual([]);
        expect(buildChips(null)).toEqual([]);
    });
    it("fully configured → 12 chips in canonical order", () => {
        const chips = buildChips(fully());
        expect(chips).toHaveLength(12);
        expect(chips.map((c) => c.id)).toEqual(CHIP_ORDER);
    });
    it("every chip has string id/label/value/stepTarget", () => {
        for (const c of buildChips(fully())) {
            expect(typeof c.id).toBe("string");
            expect(typeof c.label).toBe("string");
            expect(typeof c.value).toBe("string");
            expect(typeof c.stepTarget).toBe("string");
        }
    });
    it("partial state preserves canonical ordering", () => {
        const chips = buildChips({
            account: { signedIn: true, email: "x@y.z" },
            channels: { telegram: { connected: true } },
        });
        expect(chips.map((c) => c.id)).toEqual(["account", "telegram"]);
    });
    it("account chip uses email if present, fallback text otherwise", () => {
        const withEmail = buildChips({ account: { signedIn: true, email: "dheeraj@xagi.ai" } });
        expect(withEmail[0].value).toBe("dheeraj@xagi.ai");
        const noEmail = buildChips({ account: { signedIn: true } });
        expect(noEmail[0].value).toBe("signed in");
    });
    it("voice chip formats as 'backend · name' when both present", () => {
        const chips = buildChips({ personalize: { voice: { backend: "openai-realtime", name: "shimmer" } } });
        expect(chips[0].value).toBe("openai-realtime \u00b7 shimmer");
    });
    it("voice chip shows name only when backend missing", () => {
        const chips = buildChips({ personalize: { voice: { name: "alloy" } } });
        expect(chips[0].value).toBe("alloy");
    });
    it("channel stepTargets use step:manage-<channel> form", () => {
        const chips = buildChips({ channels: { telegram: { connected: true }, whatsapp: { connected: true } } });
        expect(chips.find((c) => c.id === "telegram").stepTarget).toBe("step:manage-telegram");
        expect(chips.find((c) => c.id === "whatsapp").stepTarget).toBe("step:manage-whatsapp");
    });
    it("disconnected channels are omitted", () => {
        const chips = buildChips({ channels: { telegram: { connected: false }, discord: null } });
        expect(chips.map((c) => c.id)).toEqual([]);
    });
    it("CHIP_ORDER is the canonical 12-entry order", () => {
        expect(CHIP_ORDER).toEqual([
            "account", "google",
            "telegram", "discord", "slack", "whatsapp", "matrix", "email",
            "workspace", "hotkey", "theme", "voice",
        ]);
    });
    it("workspace only shows when path is set", () => {
        expect(buildChips({ workspace: { exists: true } }).length).toBe(0);
        expect(buildChips({ workspace: { path: "/tmp/ws" } })[0].id).toBe("workspace");
    });
});
