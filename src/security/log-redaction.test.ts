// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The console wrapper formats whatever it is given, including an unhandled
// rejection reason that came out of a vm sandbox. util.inspect would call that
// value's custom-inspect hook with host objects, so the wrapper must not.
import { describe, expect, it, vi } from "vitest";

describe("console wrapper never runs custom inspect hooks", () => {
    it("formats an object without calling its inspect hook", async () => {
        const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await import("./log-redaction.js");
            let hookCalls = 0;
            const value = {
                a: 1,
                [Symbol.for("nodejs.util.inspect.custom")]() {
                    hookCalls++;
                    return "hooked";
                },
            };
            console.error("reason:", value);
            console.log(value);
            expect(hookCalls).toBe(0);
        } finally {
            out.mockRestore();
            err.mockRestore();
        }
    });
});
