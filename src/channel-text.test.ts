// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { smartChunkMessage } from "./alive-ux.js";
import { chunkMarkdownForTelegram, isStopCommand, markdownToPlainText, markdownToTelegramHtml } from "./channel-text.js";

const fenceCount = (s: string) => s.split("\n").filter((l) => l.trimStart().startsWith("```")).length;

describe("markdownToTelegramHtml", () => {
    it("leaves python code untouched by inline rules", () => {
        const md = "Here:\n```python\nclass A:\n    def __init__(self):\n        # comment\n        x = 1 < 2 and **kw\n```\nDone **bold**";
        const html = markdownToTelegramHtml(md);
        expect(html).toContain('<pre><code class="language-python">class A:\n    def __init__(self):\n        # comment\n        x = 1 &lt; 2 and **kw</code></pre>');
        expect(html).not.toContain("<u>");
        expect(html).toContain("Done <b>bold</b>");
    });

    it("escapes ts generics and keeps inline code literal", () => {
        const md = "Use `Map<string, __T__>` and\n```ts\nconst a: Array<number> = [];\n// - not a bullet\n```";
        const html = markdownToTelegramHtml(md);
        expect(html).toContain("<code>Map&lt;string, __T__&gt;</code>");
        expect(html).toContain('<pre><code class="language-ts">const a: Array&lt;number&gt; = [];\n// - not a bullet</code></pre>');
    });

    it("handles fences without language, one-line fences and unclosed fences", () => {
        expect(markdownToTelegramHtml("```\n# x\n```")).toBe("<pre># x</pre>");
        expect(markdownToTelegramHtml("```print(1)```")).toBe("<pre>print(1)</pre>");
        expect(markdownToTelegramHtml("```js\nlet a = 1")).toBe('<pre><code class="language-js">let a = 1</code></pre>');
    });

    it("leaves a stray ``` in prose literal instead of swallowing the rest", () => {
        const md = "Use ``` to start a fence.\n\n**Bold** after";
        expect(markdownToTelegramHtml(md)).toBe("Use ``` to start a fence.\n\n<b>Bold</b> after");
        expect(markdownToPlainText(md)).toBe("Use ``` to start a fence.\n\nBold after");
        expect(markdownToTelegramHtml("Run ```npm i``` now")).toBe("Run <pre>npm i</pre> now");
    });

    it("still formats prose", () => {
        expect(markdownToTelegramHtml("# Title\n- item\n[a](https://x.y/?a=1&b=\"2\")")).toBe(
            '<b>Title</b>\n• item\n<a href="https://x.y/?a=1&amp;b=&quot;2&quot;">a</a>',
        );
    });

    it("plain fallback strips markers", () => {
        expect(markdownToPlainText("**b** `c`\n```py\nx\n```")).toBe("b c\nx");
    });
});

describe("smartChunkMessage fences", () => {
    it("closes and reopens a split fence with the same language", () => {
        const code = Array.from({ length: 200 }, (_, i) => `    value_${i} = compute(${i})`).join("\n");
        const md = `Intro\n\n\`\`\`python\n${code}\n\`\`\`\n\nOutro`;
        const chunks = smartChunkMessage(md, 1000);
        expect(chunks.length).toBeGreaterThan(3);
        for (const c of chunks) {
            expect(c.length).toBeLessThanOrEqual(1000);
            expect(fenceCount(c) % 2).toBe(0);
        }
        expect(chunks.slice(1, -1).every((c) => c.startsWith("```python\n"))).toBe(true);
        // No code line lost
        const joined = chunks.join("\n");
        for (let i = 0; i < 200; i++) expect(joined).toContain(`value_${i} = compute(${i})`);
    });

    it("does not treat a one-line ```span``` as an unclosed fence", () => {
        const prose = Array.from({ length: 60 }, (_, i) => `Sentence ${i} is here and it is long enough.`).join(" ");
        const chunks = smartChunkMessage(`\`\`\`npm install foo\`\`\`\n\n${prose}`, 200);
        expect(chunks.filter((c) => c.includes("npm install foo"))).toHaveLength(1);
        for (const c of chunks) expect(c).not.toContain("\n```");
        expect(chunks.join(" ").replace(/\s+/g, " ")).toContain(prose);
        const withTail = smartChunkMessage(`\`\`\`npm install foo\`\`\` then restart the server\n\n${prose}`, 200);
        expect(withTail.filter((c) => c.includes("npm install foo"))).toHaveLength(1);
        for (const c of withTail) expect(c).not.toContain("\n```");
    });

    it("cuts after a block that closes in the window instead of inside it", () => {
        const md = `${"a ".repeat(100)}\n\n\`\`\`\nline1\n\nline2\n\`\`\`\n${"b".repeat(300)}`;
        const chunks = smartChunkMessage(md, 260);
        for (const c of chunks) expect(fenceCount(c) % 2).toBe(0);
    });
});

describe("chunkMarkdownForTelegram", () => {
    it("keeps every chunk's HTML within the limit even when escaping inflates it", () => {
        const md = `\`\`\`html\n${"<div>&amp;</div>\n".repeat(600)}\`\`\`\n\n${"x < y & z ".repeat(500)}`;
        const chunks = chunkMarkdownForTelegram(md);
        expect(chunks.length).toBeGreaterThan(2);
        for (const c of chunks) {
            expect(c.html.length).toBeLessThanOrEqual(4096);
            expect((c.html.match(/<pre>|<pre /g) || []).length).toBe((c.html.match(/<\/pre>/g) || []).length);
        }
    });

    it("returns a single chunk for short text", () => {
        expect(chunkMarkdownForTelegram("hi **there**")).toEqual([{ md: "hi **there**", html: "hi <b>there</b>" }]);
    });
});

describe("isStopCommand", () => {
    it.each(["stop", "Stop!!", "/stop", "/stop@BhaiBot", "  cancel ", "please stop", "don't continue", "Ruk jao", "bas", "wait, stop", "never mind.", "stop bhai", "Bhai stop!", "cancel it", "cancel that", "stop everything", "stop the task", "abort task", "bas yaar", "leave it bhai", "leave it yaar", "never mind bhai"])(
        "matches %s",
        (t) => expect(isStopCommand(t)).toBe(true),
    );
    it.each(["quite", "can't stop laughing", "stop the music in the kitchen", "bus stop near me?", "cancel my 3pm meeting", "abortion law", "basically", "don't stop", "bhai", "stop the music please now", "it"])(
        "ignores %s",
        (t) => expect(isStopCommand(t)).toBe(false),
    );
});
