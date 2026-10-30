// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it, vi } from "vitest";

const node = (role: string, label: string | null, value: string | null = null, children: unknown[] = []) => ({
    role, label, value, x: 0, y: 0, w: 1, h: 1, focusable: false, enabled: true, children,
});
let root: unknown;
vi.mock("../screen/ax-dump.js", () => ({ dumpAccessibilityTree: async () => ({ app: "Bhai", pid: 1, root, trusted: true, depth: 20 }) }));

import "./index.js"; // load the registry first, as the app does (macos.ts is in an import cycle with it)
import { frontAppHasText } from "./macos.js";

describe("os_visual_verify accessibility fallback", () => {
    it("counts the front window's text, not a button's own name, a typed draft or another window", async () => {
        const panel = node("AXWindow", "Bhai", null, [node("AXButton", "Research"), node("AXTextArea", null, "hello there")]);
        const overlay = node("AXWindow", "Overlay", null, [node("AXStaticText", null, "click 'Research'")]);
        root = node("AXApplication", "Bhai", null, [panel, overlay]);
        expect(await frontAppHasText("Research")).toBe(false);
        expect(await frontAppHasText("hello there")).toBe(false);

        // Web/Electron: a button's name and a text area's draft sit in child AXStaticText nodes.
        panel.children.push(
            node("AXButton", null, null, [node("AXStaticText", null, "Research")]),
            node("AXTextArea", null, null, [node("AXStaticText", null, "hello there")]),
        );
        expect(await frontAppHasText("Research")).toBe(false);
        expect(await frontAppHasText("hello there")).toBe(false);

        panel.children.push(node("AXHeading", "Research"), node("AXStaticText", null, "1,234"));
        expect(await frontAppHasText("research")).toBe(true);
        expect(await frontAppHasText("1,234")).toBe(true); // Calculator's display
    });
});
