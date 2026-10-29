// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The extension's scan reports elements in the tab's coordinates, iframes included: a
// frame's own coordinates would send the click somewhere else on the page.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("../../../chrome-extension/background.js", import.meta.url), "utf8");
const start = src.indexOf("function scanPageElements()");
let end = src.indexOf("{", start);
for (let depth = 0; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
}
const fn = src.slice(start, end + 1);

// One Monaco editor at frame-local (10,20) 100×100, centre (60,70).
const editor = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }), setAttribute() {} };
const document = { querySelectorAll: (sel: string) => (sel === ".monaco-editor" ? [editor] : []), body: null };
const scan = (window: object) =>
    (new Function("window", "document", "getComputedStyle", `${fn}; return scanPageElements();`)(window, document, () => ({})) as Array<{
        x: number;
        y: number;
    }>).map((e) => [e.x, e.y]);

it("adds each enclosing frame's offset, and skips frames it can't place", () => {
    const top: { top?: object } = {};
    top.top = top;
    expect(scan(top)).toEqual([[60, 70]]);
    const frame = { parent: top, top, frameElement: { getBoundingClientRect: () => ({ left: 100, top: 200 }), clientLeft: 2, clientTop: 2 } };
    expect(scan(frame)).toEqual([[162, 272]]);
    const nested = { parent: frame, top, frameElement: { getBoundingClientRect: () => ({ left: 5, top: 5 }) } };
    expect(scan(nested)).toEqual([[167, 277]]);
    expect(scan({ parent: top, top, frameElement: null })).toEqual([]); // inside another origin
});
