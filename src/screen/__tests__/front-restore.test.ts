// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Another app taking the front between Bhai's steps (seen live: "45*12" typed into
// Chrome) is undone before typing; a security prompt never is.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    return { front: "com.apple.calculator", opened: [] as string[] };
});

vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
        if (cmd === "open") {
            h.opened.push(args[1]);
            h.front = args[1];
        }
        const stdout = cmd === "lsappinfo" && args[0] === "front" ? "ASN:0x0-0x1:\n" : `bundleID="${h.front}"\n`;
        cb(null, { stdout, stderr: "" });
    },
}));

const { noteFrontAfterStep, restoreFrontIfStolen } = await import("../frontmost.js");

describe("restoreFrontIfStolen", () => {
    beforeEach(async () => {
        h.front = "com.apple.calculator";
        h.opened.length = 0;
        await noteFrontAfterStep();
    });

    it("brings Bhai's app back when another one took the front", async () => {
        h.front = "com.google.Chrome";
        expect(await restoreFrontIfStolen()).toBe("com.apple.calculator");
        expect(h.opened).toEqual(["com.apple.calculator"]);
    });

    it("does nothing when the front is still Bhai's app", async () => {
        expect(await restoreFrontIfStolen()).toBeUndefined();
        expect(h.opened).toEqual([]);
    });

    it("never pushes a password prompt aside", async () => {
        h.front = "com.apple.SecurityAgent";
        expect(await restoreFrontIfStolen()).toBeUndefined();
        expect(h.opened).toEqual([]);
    });
});
