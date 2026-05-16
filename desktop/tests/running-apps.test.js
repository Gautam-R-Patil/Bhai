// Tests the parsers in running-apps.js. We don't shell out — instead we
// stub child_process.exec via vi.spyOn to return canned strings.
//
// Note: running-apps.js is CJS (uses require("node:child_process")).
// vi.mock on the bare specifier doesn't intercept the CJS require,
// so we spy on the resolved module object directly — same Node-cached
// reference is shared with running-apps.js, so the stub takes effect.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import child_process from "node:child_process";

let execSpy;

function mockExecOnce(stdout, err = null) {
    execSpy.mockImplementationOnce((_cmd, _opts, cb) => {
        // exec(cmd, opts, callback) — running-apps.js always passes opts.
        cb(err, stdout);
    });
}

beforeEach(() => {
    execSpy = vi.spyOn(child_process, "exec").mockImplementation(() => {
        throw new Error("exec called without a per-test mock");
    });
});

afterEach(() => {
    execSpy.mockRestore();
});

describe("getRunningApps — macOS parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
    });

    it("parses comma-separated osascript output", async () => {
        mockExecOnce("Cursor, Slack, Chrome, Figma\n");
        const out = await getRunningApps("darwin");
        expect(out.platform).toBe("darwin");
        expect(out.names).toEqual(["cursor", "slack", "chrome", "figma"]);
    });

    it("returns empty array on osascript failure", async () => {
        mockExecOnce("", new Error("osascript failed"));
        const out = await getRunningApps("darwin");
        expect(out.names).toEqual([]);
    });

    it("dedupes and lowercases", async () => {
        mockExecOnce("Chrome, chrome, CHROME, Slack");
        const out = await getRunningApps("darwin");
        expect(out.names).toEqual(["chrome", "slack"]);
    });
});

describe("getRunningApps — Windows parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
    });

    it("parses tasklist CSV output and strips .exe", async () => {
        const csv = '"Code.exe","1234","Console","1","100 K"\n'
                  + '"Slack.exe","5678","Console","1","200 K"\n'
                  + '"chrome.exe","9012","Console","1","300 K"\n';
        mockExecOnce(csv);
        const out = await getRunningApps("win32");
        expect(out.platform).toBe("win32");
        expect(out.names).toEqual(["code", "slack", "chrome"]);
    });

    it("returns empty array when tasklist fails", async () => {
        mockExecOnce("", new Error("tasklist failed"));
        const out = await getRunningApps("win32");
        expect(out.names).toEqual([]);
    });
});

describe("getRunningApps — Linux parser", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
    });

    it("parses wmctrl -l output, takes window titles", async () => {
        const out = "0x12345 0 host slack - General\n0x67890 0 host VS Code\n";
        mockExecOnce(out);
        const result = await getRunningApps("linux");
        expect(result.platform).toBe("linux");
        // Names are full window titles in lowercase
        expect(result.names.length).toBeGreaterThan(0);
    });

    it("returns empty array when wmctrl isn't available", async () => {
        mockExecOnce("", new Error("wmctrl: command not found"));
        const out = await getRunningApps("linux");
        expect(out.names).toEqual([]);
    });
});

describe("getRunningApps — unknown platform", () => {
    let getRunningApps;
    beforeEach(async () => {
        vi.resetModules();
        getRunningApps = (await import("../detection/running-apps.js")).getRunningApps;
    });

    it("returns empty for unsupported platform", async () => {
        const out = await getRunningApps("freebsd");
        expect(out).toEqual({ names: [], platform: "freebsd" });
        expect(execSpy).not.toHaveBeenCalled();
    });
});
