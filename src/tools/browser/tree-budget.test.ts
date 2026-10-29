// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The accessibility tree must never push the element labels past the result cap.
import { describe, expect, it, vi } from "vitest";

// chrome-bridge → overlay → agent → tools/index would re-enter navigation.js mid-load.
vi.mock("./chrome-bridge.js", () => ({}));
const { addTreeWithinBudget } = await import("./navigation.js");

describe("addTreeWithinBudget", () => {
    const tree = Array.from({ length: 200 }, (_, i) => `- link "Item \\"${i}\\""`).join("\n");
    it("keeps the result (labels included) under the cap", () => {
        const labels = Array.from({ length: 60 }, (_, i) => `[${i}]<a>Link ${i}`).join("\n");
        const r: Record<string, unknown> = { success: true, title: "T", interactive_elements_text: labels };
        addTreeWithinBudget(r, tree, 4000);
        const json = JSON.stringify(r);
        expect(json.length).toBeLessThanOrEqual(4000);
        expect(String(r.accessibility_tree)).toContain("…(truncated)");
        expect(json.indexOf("interactive_elements_text")).toBeLessThan(json.indexOf("accessibility_tree"));
    });
    it("drops the tree when the labels fill the cap; screenshots don't count", () => {
        const r: Record<string, unknown> = { interactive_elements_text: "x".repeat(3900) };
        addTreeWithinBudget(r, tree, 4000);
        expect(r.accessibility_tree).toBeUndefined();
        const s: Record<string, unknown> = { screenshot_base64: "y".repeat(50_000), interactive_elements_text: "z" };
        addTreeWithinBudget(s, "- heading \"Hi\"", 6000);
        expect(s.accessibility_tree).toBe("- heading \"Hi\"");
    });
});
