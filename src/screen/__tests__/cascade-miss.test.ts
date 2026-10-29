// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import type { AxDump, AxNode } from "../ax-dump.js";
import { AX_PERMISSION_ERROR } from "../ax-dump.js";
import { frontmostMatches } from "../frontmost.js";
import { type CascadeMiss, findClickTarget } from "../perception-router.js";

const n = (role: string, label: string | null, x: number, y: number, children: AxNode[] = [], enabled = true): AxNode => ({
    role, label, value: null, x, y, w: 80, h: 24, focusable: false, enabled, children,
});
const dump = (kids: AxNode[], error?: string): AxDump => ({
    app: "Mail", pid: 0, trusted: true, depth: 20, elapsedMs: 0, source: "swift", error,
    root: { ...n("AXWindow", "w", 0, 0, kids), w: 800, h: 600 },
});
const NO_VISION = { skipTiers: ["omniparser", "cloud_grounding"] as const, forceProfile: "lite" as const };

async function miss(instruction: string, axDumpHint: AxDump): Promise<CascadeMiss | undefined> {
    process.env.ATLAS_NO_AX_RETRY = "true";
    let m: CascadeMiss | undefined;
    const r = await findClickTarget(instruction, { ...NO_VISION, skipTiers: [...NO_VISION.skipTiers], axDumpHint, onMiss: (x) => (m = x) });
    expect(r).toBeNull();
    return m;
}

describe("cascade miss says why", () => {
    it("a tie is reported with the candidates", async () => {
        const m = await miss("Reply", dump([n("AXButton", "Reply", 10, 10), n("AXButton", "Reply", 10, 300)]));
        expect(m?.reason).toBe("ambiguous");
        expect(m?.ambiguous).toHaveLength(2);
    });

    it("a disabled-only match is not a missing label", async () => {
        expect((await miss("Send", dump([n("AXButton", "Send", 10, 10, [], false)])))?.reason).toBe("disabled");
    });

    it("a missing grant is not a bad label", async () => {
        const m = await miss("Send", dump([], `${AX_PERMISSION_ERROR} (not_trusted)`));
        expect(m?.reason).toBe("ax_permission_missing");
    });

    it("a plain miss lists the nearest labels and why vision didn't run", async () => {
        const m = await miss("Archive all three folders now", dump([n("AXButton", "Archive", 10, 10), n("AXButton", "Junk", 10, 60)]));
        expect(m?.reason).toBe("not_found");
        expect(m?.nearest?.[0].label).toBe("Archive");
        expect(m?.axElementCount).toBe(2);
        expect(m?.tierErrors.cloud_grounding).toBe("no_screenshot");
    });

    it("an AX hit carries what AXPress needs", async () => {
        const r = await findClickTarget("Junk", { ...NO_VISION, skipTiers: [...NO_VISION.skipTiers], axDumpHint: dump([n("AXButton", "Junk", 10, 60)]) });
        expect(r?.ax).toMatchObject({ path: [0], role: "AXButton", bbox: { x: 10, y: 60, w: 80, h: 24 } });
    });
});

describe("frontmostMatches", () => {
    const vsc = { name: "Visual Studio Code", bundleName: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", pid: 1 };
    it("accepts the name, the .app, a path or the bundle id", () => {
        for (const a of ["visual studio code", "Visual Studio Code.app", "/Applications/Visual Studio Code.app", "com.microsoft.vscode"]) {
            expect(frontmostMatches(a, vsc)).toBe(true);
        }
        expect(frontmostMatches("Safari", vsc)).toBe(false);
        expect(frontmostMatches("", vsc)).toBe(false);
    });
});
