// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { type AxDump, type AxNode, findElementByLabel, flattenInteractive } from "../ax-dump.js";

// ── Test fixtures ─────────────────────────────────

function node(
    role: string | null,
    label: string | null,
    x: number,
    y: number,
    w = 100,
    h = 30,
    children: AxNode[] = [],
    value: string | null = null,
): AxNode {
    return {
        role,
        subrole: null,
        label,
        value,
        x,
        y,
        w,
        h,
        focusable: true,
        enabled: true,
        children,
    };
}

function dump(root: AxNode): AxDump {
    return {
        app: "test",
        pid: 1,
        root,
        trusted: true,
        depth: 12,
        elapsedMs: 5,
        source: "swift",
    };
}

describe("flattenInteractive", () => {
    it("returns empty when tree has no interactive elements", () => {
        const d = dump(node("AXWindow", "main", 0, 0, 800, 600));
        expect(flattenInteractive(d)).toEqual([]);
    });

    it("collects macOS-style interactive roles", () => {
        const d = dump(
            node("AXWindow", "main", 0, 0, 800, 600, [
                node("AXButton", "Save", 50, 100),
                node("AXTextField", "search", 50, 200, 200, 30, [], "hello"),
                node("AXImage", null, 50, 300), // no label, no value → dropped
            ]),
        );
        const els = flattenInteractive(d);
        expect(els.length).toBe(2);
        expect(els[0].label).toBe("Save");
        expect(els[1].label).toBe("search");
        expect(els[1].value).toBe("hello");
    });

    it("collects Windows-style roles (Button, Edit, ComboBox)", () => {
        const d = dump(
            node("Window", "main", 0, 0, 800, 600, [
                node("Button", "OK", 50, 100),
                node("Edit", "email", 50, 200),
                node("ComboBox", "country", 50, 300),
            ]),
        );
        const els = flattenInteractive(d);
        expect(els.map((e) => e.role)).toEqual(["Button", "Edit", "ComboBox"]);
    });

    it("collects Linux AT-SPI roles (push button, entry, etc.)", () => {
        const d = dump(
            node("frame", "main", 0, 0, 800, 600, [
                node("push button", "Cancel", 50, 100),
                node("entry", "url", 50, 200),
            ]),
        );
        const els = flattenInteractive(d);
        expect(els.length).toBe(2);
    });

    it("computes element center correctly", () => {
        const d = dump(node("AXWindow", "main", 0, 0, 800, 600, [node("AXButton", "Save", 100, 200, 80, 40)]));
        const [el] = flattenInteractive(d);
        expect(el.center).toEqual({ x: 140, y: 220 });
    });

    it("drops elements with zero bbox", () => {
        const d = dump(
            node("AXWindow", "main", 0, 0, 800, 600, [
                node("AXButton", "InvisibleSave", 0, 0, 0, 0),
                node("AXButton", "VisibleSave", 50, 100),
            ]),
        );
        const els = flattenInteractive(d);
        expect(els.length).toBe(1);
        expect(els[0].label).toBe("VisibleSave");
    });

    it("assigns sequential ids starting at 1", () => {
        const d = dump(
            node("AXWindow", "main", 0, 0, 800, 600, [
                node("AXButton", "A", 50, 100),
                node("AXButton", "B", 50, 200),
                node("AXButton", "C", 50, 300),
            ]),
        );
        const els = flattenInteractive(d);
        expect(els.map((e) => e.id)).toEqual([1, 2, 3]);
    });

    it("captures depth + breadcrumb path", () => {
        const d = dump(
            node("AXWindow", "main", 0, 0, 800, 600, [
                node("AXGroup", null, 0, 0, 800, 100, [node("AXButton", "Nested", 50, 50)]),
            ]),
        );
        const [el] = flattenInteractive(d);
        expect(el.depth).toBe(2);
        expect(el.path).toEqual([0, 0]);
    });
});

describe("findElementByLabel", () => {
    const sample = flattenInteractive(
        dump(
            node("AXWindow", "main", 0, 0, 800, 600, [
                node("AXButton", "Save Document", 50, 100),
                node("AXButton", "Cancel", 50, 200),
                node("AXButton", "Save As...", 50, 300),
                node("AXTextField", "URL", 50, 400, 200, 30, [], "example.com"),
            ]),
        ),
    );

    it("returns null on empty query", () => {
        expect(findElementByLabel(sample, "")).toBeNull();
    });

    it("finds exact match", () => {
        const el = findElementByLabel(sample, "Cancel");
        expect(el).not.toBeNull();
        expect(el?.label).toBe("Cancel");
    });

    it("finds substring match", () => {
        const el = findElementByLabel(sample, "save");
        expect(el).not.toBeNull();
        expect(el?.label).toMatch(/Save/i);
    });

    it("matches against value when label is missing", () => {
        const el = findElementByLabel(sample, "example.com");
        expect(el).not.toBeNull();
        expect(el?.label).toBe("URL");
    });

    it("returns null when no match meets minScore", () => {
        const el = findElementByLabel(sample, "xyz123", 0.9);
        expect(el).toBeNull();
    });

    it("picks the best match when multiple substrings match", () => {
        // "Save" matches both "Save Document" and "Save As..." with score 0.85 (substring).
        // Picker is deterministic: returns one of them with the higher score (or first if tied).
        const el = findElementByLabel(sample, "Save");
        expect(el?.label).toMatch(/Save/i);
    });
});
