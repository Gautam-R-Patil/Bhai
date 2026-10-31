// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// For a release after the rename the extension also works with a bot from before it (stamps
// data-atlas-id and sends atlasId) and with an older bot's native host (com.atlas.bridge).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("../../../chrome-extension/background.js", import.meta.url), "utf8");
function fnSource(sig: string): string {
    const start = src.indexOf(sig);
    let end = src.indexOf("{", start);
    for (let depth = 0; end < src.length; end++) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}" && --depth === 0) break;
    }
    return src.slice(start, end + 1);
}

it("stamps both element-id attributes", () => {
    const attrs: Record<string, string> = {};
    const editor = {
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }),
        setAttribute: (k: string, v: string) => (attrs[k] = v),
    };
    const document = { querySelectorAll: (sel: string) => (sel === ".monaco-editor" ? [editor] : []), body: null };
    const top: { top?: object } = {};
    top.top = top;
    const [el] = new Function("window", "document", "getComputedStyle", `${fnSource("function scanPageElements()")}; return scanPageElements();`)(
        top,
        document,
        () => ({}),
    );
    expect(el.bhaiId).toMatch(/^bhai-editor-monaco-/);
    expect(attrs).toEqual({ "data-bhai-id": el.bhaiId, "data-atlas-id": el.bhaiId });
});

it("sends atlasId alongside bhaiId", () => {
    expect(src).toMatch(/bhaiId: el\.bhaiId,\s*atlasId: el\.bhaiId,/);
});

it("asks com.bhai.bridge first, then com.atlas.bridge", async () => {
    const asked: string[] = [];
    const chrome = {
        runtime: {
            lastError: undefined as unknown,
            sendNativeMessage(host: string, _msg: unknown, cb: (r: unknown) => void) {
                asked.push(host);
                chrome.runtime.lastError = host === "com.bhai.bridge" ? { message: "not found" } : undefined;
                cb(host === "com.atlas.bridge" ? { success: true, token: "t" } : undefined);
            },
        },
    };
    const nativeConfig = new Function(
        "chrome",
        `${fnSource("function nativeConfigFrom(")}; ${fnSource("async function nativeConfig()")}; return nativeConfig;`,
    )(chrome);
    expect(await nativeConfig()).toEqual({ success: true, token: "t" });
    expect(asked).toEqual(["com.bhai.bridge", "com.atlas.bridge"]);
});

it("clears the pre-rename keepalive alarm", () => {
    expect(src).toContain('chrome.alarms.clear("atlas-keepalive")');
});
