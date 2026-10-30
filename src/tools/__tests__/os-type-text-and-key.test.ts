// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// os_type({ text: "45*12", key: "return" }) — what small models send — pressed only
// the key, dropped the text and reported success (Calculator showed 540×12 = 6,480).

import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    return [] as string[];
});
const front = vi.hoisted(() => ({ window: "" as string, sheet: false }));
vi.mock("../../screen/ax-dump.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/ax-dump.js")>()),
    dumpAccessibilityTree: async () => ({
        root: {
            role: "AXApplication",
            children: front.window
                ? [{ role: "AXWindow", label: front.window, children: front.sheet ? [{ role: "AXSheet", children: [] }] : [] }]
                : [],
        },
    }),
}));

vi.mock("../os-computer-action.js", async (orig) => ({
    ...(await orig<typeof import("../os-computer-action.js")>()),
    typeTextMac: async (text: string) => {
        events.push(`type:${text}`);
        return "keystroke";
    },
}));
vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
        if (cmd === "osascript" && String(args[0]).endsWith(".scpt")) events.push("osascript:key");
        cb(null, { stdout: "", stderr: "" });
    },
}));

await import("../index.js"); // macos.ts sits in an import cycle that index.ts resolves
const { osType } = await import("../macos.js");

describe("os_type with text and key together", () => {
    it("types the text, then presses the key", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ text: "45*12", key: "return", delay_ms: 1 }));
        expect(events).toEqual(["type:45*12", "osascript:key"]);
        expect(r).toMatchObject({ success: true, typed_chars: 5, pressed: "return" });
    });

    it("a key alone still just presses it", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ key: "return", delay_ms: 1 }));
        expect(events).toEqual(["osascript:key"]);
        expect(r.typed_chars).toBeUndefined();
    });

    it("text that is just a key name presses that key", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ text: "return", delay_ms: 1 }));
        expect(events).toEqual(["osascript:key"]);
        expect(r).toMatchObject({ success: true, pressed: "return" });
    });

    it("text that is just a shortcut presses it", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ text: "cmd+space", delay_ms: 1 }));
        expect(events).toEqual(["osascript:key"]);
        expect(r).toMatchObject({ success: true, pressed: "cmd+space" });
    });

    it("a key with + in it is the shortcut", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ key: "command+c", delay_ms: 1 }));
        expect(events).toEqual(["osascript:key"]);
        expect(r).toMatchObject({ success: true, pressed: "command+c" });
    });

    it("won't type a document's text into an Open file panel", async () => {
        events.length = 0;
        front.window = "Open";
        const r = JSON.parse(await osType.handler({ text: "hello from bhai", delay_ms: 1 }));
        expect(events).toEqual([]);
        expect(r.success).toBe(false);
        expect(r.next).toContain("command+n");
        // A Go to Folder sheet over the panel takes a typed path.
        front.sheet = true;
        expect(JSON.parse(await osType.handler({ text: "~/Desktop", delay_ms: 1 })).success).toBe(true);
        front.window = "";
        front.sheet = false;
    });
});
