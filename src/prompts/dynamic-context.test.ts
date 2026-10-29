// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Someone venting wants to be heard; someone frustrated with a task wants it fixed.
import { describe, expect, it } from "vitest";
import { buildDynamicContextReminder } from "./dynamic-context.js";

describe("venting vs asking", () => {
    it("a complaint with no request gets 'be heard', a request while frustrated still gets 'fix first'", () => {
        const venting = buildDynamicContextReminder("ugh long day, the demo crashed twice in front of the client");
        expect(venting).toMatch(/venting/);
        expect(venting).not.toMatch(/fix first/);
        const asking = buildDynamicContextReminder("ugh the build keeps failing, can you check the logs?");
        expect(asking).toMatch(/fix first/);
        expect(asking).not.toMatch(/venting/);
    });
});
