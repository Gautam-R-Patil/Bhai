// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { type AxDump, type AxNode, findElementByLabel, flattenInteractive, matchElementByLabel } from "../ax-dump.js";

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
        const el = findElementByLabel(sample, "save document");
        expect(el).not.toBeNull();
        expect(el?.label).toBe("Save Document");
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

    it("reports a tie instead of clicking whichever came first", () => {
        // "Save" scores 0.85 against both "Save Document" and "Save As...".
        expect(findElementByLabel(sample, "Save")).toBeNull();
        const m = matchElementByLabel(sample, "Save");
        expect(m.ambiguous?.map((e) => e.label)).toEqual(["Save Document", "Save As..."]);
    });

    it("a positional word breaks the tie", () => {
        expect(findElementByLabel(sample, "the bottom Save")?.label).toBe("Save As...");
        expect(findElementByLabel(sample, "the top Save")?.label).toBe("Save Document");
    });
});

describe("matchElementByLabel — disabled, nested, off-screen", () => {
    const btn = (label: string, x: number, y: number, enabled = true) => ({
        ...node("AXButton", label, x, y),
        enabled,
    });

    it("never picks a disabled element, and says so", () => {
        const els = flattenInteractive(dump(node("AXWindow", "w", 0, 0, 800, 600, [btn("Send", 10, 10, false)])));
        const m = matchElementByLabel(els, "Send");
        expect(m.el).toBeNull();
        expect(m.disabled?.label).toBe("Send");
    });

    it("prefers the enabled one of two equal matches", () => {
        const els = flattenInteractive(
            dump(node("AXWindow", "w", 0, 0, 800, 600, [btn("Send", 10, 10, false), btn("Send", 10, 300)])),
        );
        expect(findElementByLabel(els, "Send")?.center.y).toBe(315);
    });

    it("a row and its own caption are one target, and the control wins over static text", () => {
        const row = node("AXRow", null, 0, 100, 300, 30, [node("AXStaticText", "Downloads", 20, 105, 100, 20)]);
        const caption = node("AXStaticText", "Downloads", 400, 10, 100, 20); // window title text elsewhere
        const els = flattenInteractive(dump(node("AXWindow", "w", 0, 0, 800, 600, [row, caption])));
        expect(findElementByLabel(els, "Downloads")?.role).toBe("AXRow");
    });

    it("flags elements scrolled outside their window", () => {
        const els = flattenInteractive(
            dump(node("AXWindow", "w", 0, 0, 800, 600, [btn("Visible", 10, 10), btn("Far", 10, 2000)])),
        );
        expect(els.find((e) => e.label === "Visible")?.offscreen).toBeUndefined();
        expect(els.find((e) => e.label === "Far")?.offscreen).toBe(true);
    });

    it("treats Dock items as clickable", () => {
        const els = flattenInteractive(
            dump(node("AXApplication", "Dock", 0, 0, 0, 0, [node("AXDockItem", "Safari", 400, 900, 44, 56)])),
        );
        expect(findElementByLabel(els, "Safari in the Dock", 0.8)?.label).toBe("Safari");
    });
});

describe("findElementByLabel — Calculator-style instructions", () => {
    const keys = ["7", "8", "9", "Multiply", "4", "5", "6", "Subtract", "1", "2", "3", "Add", "0", "Equals"];
    const calc = flattenInteractive(
        dump(
            node("AXWindow", "Calculator", 0, 0, 300, 400, [
                node("AXStaticText", "Display", 10, 10, 280, 60, [], "128 × 46"),
                ...keys.map((k, i) => node("AXButton", k, 10 + (i % 4) * 70, 100 + Math.floor(i / 4) * 70, 60, 60)),
            ]),
        ),
    );

    it("finds a quoted key despite app and container words", () => {
        expect(findElementByLabel(calc, 'the "1" button on the Calculator keypad', 0.95, "Calculator")?.label).toBe(
            "1",
        );
    });

    it("finds an unquoted key once app/container words are ignored", () => {
        expect(findElementByLabel(calc, "the 1 key on the Calculator keypad", 0.8, "Calculator")?.label).toBe("1");
    });

    it("maps symbols to Calculator's names", () => {
        expect(findElementByLabel(calc, "×", 0.8)?.label).toBe("Multiply");
        expect(findElementByLabel(calc, '"="', 0.8)?.label).toBe("Equals");
        expect(findElementByLabel(calc, "the + button", 0.8)?.label).toBe("Add");
    });

    it("never clicks the display because its value contains the symbol", () => {
        expect(findElementByLabel(calc, "×", 0.5)?.label).not.toBe("Display");
    });

    // From the model-ladder eval: "the clear button" scored 0.65 against "All Clear" and fell
    // through to a cloud vision call.
    it("a key named by one word of a two-word label clears the fuzzy threshold", () => {
        const withClear = flattenInteractive(
            dump(node("AXWindow", "Calculator", 0, 0, 300, 400, [node("AXButton", "All Clear", 10, 10, 60, 60)])),
        );
        expect(findElementByLabel(withClear, "the clear button", 0.8)?.label).toBe("All Clear");
    });

    it("still prefers the label that names exactly what was asked", () => {
        const both = flattenInteractive(
            dump(
                node("AXWindow", "Calculator", 0, 0, 300, 400, [
                    node("AXButton", "All Clear", 10, 10, 60, 60),
                    node("AXButton", "Clear", 80, 10, 60, 60),
                ]),
            ),
        );
        expect(findElementByLabel(both, "the clear button", 0.8)?.label).toBe("Clear");
    });
});

describe("findElementByLabel — app-name stripping can't pick the wrong element", () => {
    const els = (labels: Array<[string, string?]>) =>
        flattenInteractive(
            dump(
                node(
                    "AXWindow",
                    "w",
                    0,
                    0,
                    800,
                    600,
                    labels.map(([l, v], i) => node("AXButton", l, 10, 10 + i * 40, 100, 30, [], v)),
                ),
            ),
        );

    it("'All Mail' in Mail is All Mail, not Install", () => {
        expect(findElementByLabel(els([["Install"], ["All Mail"]]), "All Mail", 0.8, "Mail")?.label).toBe("All Mail");
    });

    it("'the AC button in Calculator' is All Clear, not the Calculator menu", () => {
        // The live miss: the app's own menu-bar item won on the app name in the instruction.
        expect(
            findElementByLabel(
                els([["Calculator"], ["All Clear"], ["7"]]),
                "the AC button in Calculator",
                0.8,
                "Calculator",
            )?.label,
        ).toBe("All Clear");
        expect(findElementByLabel(els([["Calculator"], ["All Clear"]]), "the 7 key", 0.8, "Calculator")).toBeNull();
    });

    it("an instruction left with only stopwords still matches on its full words", () => {
        expect(
            findElementByLabel(els([["General"], ["Settings"]]), "Settings button", 0.8, "System Settings")?.label,
        ).toBe("Settings");
    });

    it("label-less static text (macOS puts it in the value) still matches a description", () => {
        expect(
            findElementByLabel(
                els([
                    ["", "Downloads"],
                    ["", "Documents"],
                ]),
                "Downloads folder in the sidebar",
                0.8,
            )?.value,
        ).toBe("Downloads");
    });
});
