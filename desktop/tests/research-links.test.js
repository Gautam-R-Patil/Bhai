// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A report link opens the URL it names, not the ')' or '>' the sentence put after it.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const html = fs.readFileSync(path.join(__dirname, "..", "panel.html"), "utf8");
const fn = html.match(/ {8}function linkifyReport\(html\) \{[\s\S]*?\n {8}\}\n/)?.[0] ?? "";
const linkify = (h) => vm.runInNewContext(`${fn}linkifyReport(h)`, { h });
const link = (u) => `<a href="#" class="research-link">${u}</a>`;

describe("report links", () => {
    it("leaves the punctuation and escaped brackets around a URL outside the link", () => {
        expect(linkify("_(source: https://site.com/page)_")).toBe(`_(source: ${link("https://site.com/page")})_`);
        expect(linkify("see https://x.com/a.")).toBe(`see ${link("https://x.com/a")}.`);
        expect(linkify("&lt;https://x.com/a&gt;")).toBe(`&lt;${link("https://x.com/a")}&gt;`);
        expect(linkify("&quot;https://x.com/a&quot;")).toBe(`&quot;${link("https://x.com/a")}&quot;`);
    });
    it("keeps a ')' the URL opened, and its query string", () => {
        expect(linkify("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(link("https://en.wikipedia.org/wiki/Foo_(bar)"));
        expect(linkify("https://x.com/?a=1&amp;b=2")).toBe(link("https://x.com/?a=1&amp;b=2"));
    });
});
