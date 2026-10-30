// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS Focus is seen from Assertions.json: the old checks read keys that no longer exist,
// so Smart DND never held anything back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { macFocusActive } from "./dnd.js";

const file = (data: unknown) => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "focus-")), "Assertions.json");
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
};

it("a switched-on Focus is an assertion record; ended ones leave only invalidations", async () => {
    const on = file({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: "com.apple.donotdisturb.mode.default" } }] }], header: { version: 1 } });
    const off = file({ data: [{ storeInvalidationRecords: [{ invalidationReason: "user-requested" }] }], header: { version: 1 } });
    expect(await macFocusActive(on)).toBe(true);
    expect(await macFocusActive(off)).toBe(false);
    expect(await macFocusActive(file({ data: [{ storeAssertionRecords: [] }] }))).toBe(false);
    expect(await macFocusActive("/nonexistent/Assertions.json")).toBeNull(); // unreadable: can't tell (Bhai without Full Disk Access)
});
