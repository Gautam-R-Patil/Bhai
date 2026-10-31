// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_HOME } from "../config/paths.js";
import { withCurrentHome } from "./client.js";

describe("withCurrentHome", () => {
    it("points store servers installed under ~/.atlas at the copied ~/.bhai tree", () => {
        const home = "/h/.bhai";
        const old = path.join(LEGACY_HOME, "store", "mcp-servers", "x", "dist", "index.js");
        const out = withCurrentHome({ store_x: { command: "node", args: [old, "--flag"] } }, home);
        expect(out.store_x.args).toEqual([path.join(home, "store", "mcp-servers", "x", "dist", "index.js"), "--flag"]);
        expect(out.store_x.command).toBe("node");
    });

    it("leaves everything alone while Bhai still runs from ~/.atlas, and other paths always", () => {
        const cfg = { a: { command: path.join(LEGACY_HOME, "bin", "srv"), args: ["/elsewhere/x.js"] } };
        expect(withCurrentHome(cfg, LEGACY_HOME)).toBe(cfg);
        expect(withCurrentHome(cfg, "/h/.bhai").a.args).toEqual(["/elsewhere/x.js"]);
        expect(withCurrentHome({ b: { command: `${LEGACY_HOME}-other/x` } }, "/h/.bhai").b.command).toBe(`${LEGACY_HOME}-other/x`);
    });
});
