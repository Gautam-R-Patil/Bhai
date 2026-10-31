// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// An installed extension can be older than the bot: it stamps data-atlas-id and sends atlasId.
import { expect, it, vi } from "vitest";

const elements = [
    { label: 1, x: 1, y: 2, tag: "button", text: "New", bhaiId: "bhai-el-1" },
    { label: 2, x: 3, y: 4, tag: "button", text: "Old", atlasId: "atlas-el-2" },
];
vi.mock("./chrome-bridge.js", () => ({ sendBridgeCommand: async () => ({ elements }) }));

const { ChromeExtensionBackend } = await import("./chrome-backend.js");
const { SCROLL_TO_ELEMENT_JS } = await import("./core.js");

it("reads bhaiId, else atlasId, from a scan", async () => {
    const got = await new ChromeExtensionBackend().scanElements();
    expect(got.map((e) => e.bhaiId)).toEqual(["bhai-el-1", "atlas-el-2"]);
});

it("scrolls to an element stamped with either attribute", () => {
    const asked: string[] = [];
    const document = { querySelector: (sel: string) => (asked.push(sel), { scrollIntoView() {} }) };
    const scroll = new Function("document", `return ${SCROLL_TO_ELEMENT_JS}`)(document);
    expect(scroll("x")).toBe(true);
    expect(asked[0]).toBe('[data-bhai-id="x"],[data-atlas-id="x"]');
});
