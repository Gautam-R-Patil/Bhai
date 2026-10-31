// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// os_type({ text: "45*12", key: "return" }) — what small models send — pressed only
// the key, dropped the text and reported success (Calculator showed 540×12 = 6,480).

import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    return [] as string[];
});
const front = vi.hoisted(() => ({ window: "" as string, sheet: false }));
const bg = vi.hoisted(() => ({
    front: "Terminal",
    insert: { ok: true } as { ok: boolean; error?: string },
    raises: true,
}));
vi.mock("../../screen/frontmost.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/frontmost.js")>()),
    getFrontmostApp: async () => ({ name: bg.front, bundleName: `${bg.front}.app`, bundleId: "x", pid: 1 }),
    pidOfApp: async () => 42,
    waitForFrontmost: async (app: string) => {
        if (!bg.raises) return null;
        bg.front = app;
        return { name: app, pid: 42 };
    },
    restoreFrontIfStolen: async () => undefined,
}));
vi.mock("../../screen/ax-dump.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/ax-dump.js")>()),
    axInsertText: async (_pid: number, text: string) => {
        if (bg.insert.ok) events.push(`insert:${text}`);
        return bg.insert;
    },
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
        bg.front = "Calculator";
        const r = JSON.parse(await osType.handler({ text: "45*12", key: "return", delay_ms: 1 }));
        expect(events).toEqual(["type:45*12", "osascript:key"]);
        expect(r).toMatchObject({ success: true, typed_chars: 5, pressed: "return" });
        bg.front = "Terminal";
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

    // "fn+a" pressed a bare "a", typing it into the document, and reported success.
    it("refuses a combo with a modifier it doesn't know", async () => {
        events.length = 0;
        const r = JSON.parse(await osType.handler({ combo: "fn+a", delay_ms: 1 }));
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Unknown modifier "fn"/);
        expect(events).toEqual([]);
        expect(JSON.parse(await osType.handler({ combo: "⌘+v", delay_ms: 1 })).success).toBe(true);
        expect(events).toEqual(["osascript:key"]);
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

    // From trycua/cua: type into an app without taking the user's front window.
    it("types into a named background app without raising it, else brings it forward", async () => {
        events.length = 0;
        bg.front = "Terminal";
        bg.insert = { ok: true };
        const r = JSON.parse(await osType.handler({ text: "hello", app: "TextEdit", delay_ms: 1 }));
        expect(r).toMatchObject({ success: true, method: "background", into: "TextEdit" });
        expect(events).toEqual(["insert:hello"]);
        expect(bg.front).toBe("Terminal");

        events.length = 0;
        bg.insert = { ok: false, error: "not_applied" };
        const f = JSON.parse(await osType.handler({ text: "hello", app: "Google Chrome", delay_ms: 1 }));
        expect(events).toEqual(["type:hello"]);
        expect(f.brought_forward).toMatch(/not_applied/);

        // It never came forward (cold launch, misspelled name): the user's window gets nothing.
        events.length = 0;
        bg.front = "Slack";
        bg.raises = false;
        const n = JSON.parse(await osType.handler({ text: "see you at 6", app: "WhatsApp", delay_ms: 1 }));
        bg.raises = true;
        expect(n.success).toBe(false);
        expect(events).toEqual([]);
        expect(bg.front).toBe("Slack");

        // Already in front: typed as usual.
        events.length = 0;
        bg.front = "TextEdit";
        JSON.parse(await osType.handler({ text: "hi", app: "TextEdit", delay_ms: 1 }));
        expect(events).toEqual(["type:hi"]);
    });

    // 40-task nano run: "123 times 45" typed into Calculator, n became natural log.
    it("turns operator words into operators for Calculator and refuses other letters", async () => {
        bg.front = "Calculator";
        events.length = 0;
        await osType.handler({ text: "123 times 45", delay_ms: 1 });
        expect(events).toEqual(["type:123 * 45"]);
        const r = JSON.parse(await osType.handler({ text: "log of 45", delay_ms: 1 }));
        expect(r.success).toBe(false);
        expect(events).toEqual(["type:123 * 45"]);
        bg.front = "Terminal";
    });

    // 40-task nano run: key "return" with app "Calculator" landed in TextEdit.
    it("a key for a named app brings that app forward first", async () => {
        bg.front = "TextEdit";
        events.length = 0;
        const r = JSON.parse(await osType.handler({ key: "return", app: "Calculator", delay_ms: 1 }));
        expect(bg.front).toBe("Calculator");
        expect(r.brought_forward).toBe("Calculator");
        expect(events).toEqual(["osascript:key"]);
        bg.front = "Terminal";
    });

    // PLAN run: "17*23" + return typed into TextEdit while Calculator was open.
    it("won't enter a sum in another app while Calculator is open, unless told to", async () => {
        bg.front = "TextEdit";
        events.length = 0;
        const r = JSON.parse(await osType.handler({ text: "17*23", key: "return", delay_ms: 1 }));
        expect(r.error).toMatch(/app "Calculator"/);
        expect(events).toEqual([]);
        await osType.handler({ text: "17*23", key: "return", app: "Calculator", delay_ms: 1 });
        expect(bg.front).toBe("Calculator");
        expect(events).toEqual(["type:17*23", "osascript:key"]);
        bg.front = "Terminal";
    });
});
