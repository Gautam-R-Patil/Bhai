// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { smartChunkMessage } from "./alive-ux.js";
import {
    chunkMarkdownForTelegram,
    isStopCommand,
    isStuckReplyPhrase,
    markdownToPlainText,
    markdownToTelegramHtml,
    STUCK_REPLY_LINE,
    stuckCallbackMessage,
    stuckKeyboard,
    takeStuckMarker,
    withStuckReplyLine,
} from "./channel-text.js";

const fenceCount = (s: string) => s.split("\n").filter((l) => l.trimStart().startsWith("```")).length;

describe("markdownToTelegramHtml", () => {
    it("leaves python code untouched by inline rules", () => {
        const md =
            "Here:\n```python\nclass A:\n    def __init__(self):\n        # comment\n        x = 1 < 2 and **kw\n```\nDone **bold**";
        const html = markdownToTelegramHtml(md);
        expect(html).toContain(
            '<pre><code class="language-python">class A:\n    def __init__(self):\n        # comment\n        x = 1 &lt; 2 and **kw</code></pre>',
        );
        expect(html).not.toContain("<u>");
        expect(html).toContain("Done <b>bold</b>");
    });

    it("escapes ts generics and keeps inline code literal", () => {
        const md = "Use `Map<string, __T__>` and\n```ts\nconst a: Array<number> = [];\n// - not a bullet\n```";
        const html = markdownToTelegramHtml(md);
        expect(html).toContain("<code>Map&lt;string, __T__&gt;</code>");
        expect(html).toContain(
            '<pre><code class="language-ts">const a: Array&lt;number&gt; = [];\n// - not a bullet</code></pre>',
        );
    });

    it("handles fences without language, one-line fences and unclosed fences", () => {
        expect(markdownToTelegramHtml("```\n# x\n```")).toBe("<pre># x</pre>");
        expect(markdownToTelegramHtml("```print(1)```")).toBe("<pre>print(1)</pre>");
        expect(markdownToTelegramHtml("```js\nlet a = 1")).toBe(
            '<pre><code class="language-js">let a = 1</code></pre>',
        );
    });

    it("leaves a stray ``` in prose literal instead of swallowing the rest", () => {
        const md = "Use ``` to start a fence.\n\n**Bold** after";
        expect(markdownToTelegramHtml(md)).toBe("Use ``` to start a fence.\n\n<b>Bold</b> after");
        expect(markdownToPlainText(md)).toBe("Use ``` to start a fence.\n\nBold after");
        expect(markdownToTelegramHtml("Run ```npm i``` now")).toBe("Run <pre>npm i</pre> now");
    });

    it("still formats prose", () => {
        expect(markdownToTelegramHtml('# Title\n- item\n[a](https://x.y/?a=1&b="2")')).toBe(
            '<b>Title</b>\n• item\n<a href="https://x.y/?a=1&amp;b=&quot;2&quot;">a</a>',
        );
    });

    it("plain fallback strips markers", () => {
        expect(markdownToPlainText("**b** `c`\n```py\nx\n```")).toBe("b c\nx");
    });

    it("keeps spaced asterisks as arithmetic, not emphasis", () => {
        expect(markdownToTelegramHtml("5 * 3 * 2 = 30, and 2 ** 10 ** 2")).toBe("5 * 3 * 2 = 30, and 2 ** 10 ** 2");
        expect(markdownToPlainText("5 * 3 * 2 = 30")).toBe("5 * 3 * 2 = 30");
        expect(markdownToTelegramHtml("*really* and **bold** and 2*3*4")).toBe("<i>really</i> and <b>bold</b> and 2*3*4");
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
    it.each([
        "stop",
        "Stop!!",
        "/stop",
        "/stop@BhaiBot",
        "  cancel ",
        "please stop",
        "don't continue",
        "Ruk jao",
        "bas",
        "wait, stop",
        "never mind.",
        "stop bhai",
        "Bhai stop!",
        "cancel it",
        "cancel that",
        "stop everything",
        "stop the task",
        "abort task",
        "bas yaar",
        "leave it bhai",
        "leave it yaar",
        "never mind bhai",
    ])("matches %s", (t) => expect(isStopCommand(t)).toBe(true));
    it.each([
        "quite",
        "can't stop laughing",
        "stop the music in the kitchen",
        "bus stop near me?",
        "cancel my 3pm meeting",
        "abortion law",
        "basically",
        "don't stop",
        "bhai",
        "stop the music please now",
        "it",
    ])("ignores %s", (t) => expect(isStopCommand(t)).toBe(false));
});

describe("stuck-report handoff", () => {
    it("builds one row of three buttons with stuck:<action> data", () => {
        expect(stuckKeyboard().inline_keyboard).toEqual([
            [
                { text: "I'll take over", callback_data: "stuck:takeover" },
                { text: "Retry", callback_data: "stuck:retry" },
                { text: "Skip", callback_data: "stuck:skip" },
            ],
        ]);
    });

    it("maps each button to the message it sends as the user", () => {
        expect(stuckCallbackMessage("stuck:retry")).toBe("Try that again, with a different approach this time.");
        expect(stuckCallbackMessage("stuck:skip")).toBe("Skip that part and carry on with the rest.");
        expect(stuckCallbackMessage("stuck:takeover")).toBe(
            "I'll take it from here myself. Tell me exactly where you stopped so I can continue.",
        );
    });

    it("offers reply phrases no stop handler swallows", () => {
        for (const phrase of ["retry it", "skip it", "I'll take over"]) expect(isStopCommand(phrase)).toBe(false);
    });

    it("ignores unknown or foreign callback data", () => {
        expect(stuckCallbackMessage("stuck:toString")).toBeUndefined();
        expect(stuckCallbackMessage("stuck:")).toBeUndefined();
        expect(stuckCallbackMessage("cmd:retry")).toBeUndefined();
    });

    it("appends the plain reply line only to a stuck report for the owner", () => {
        expect(withStuckReplyLine({ text: "Need your OTP.", stuck: true }, true)).toBe(
            `Need your OTP.\n\n${STUCK_REPLY_LINE}`,
        );
        expect(STUCK_REPLY_LINE).toBe("Reply: retry it · skip it · I'll take over");
        expect(withStuckReplyLine({ text: "Done, it's in Sent." }, true)).toBe("Done, it's in Sent.");
        expect(withStuckReplyLine({ text: "Need the owner's OTP.", stuck: true }, false)).toBe("Need the owner's OTP.");
    });

    it("recognizes exactly the reply line's phrases", () => {
        for (const q of ["retry it", "Skip it.", "I'll take over", "I’ll take over!"])
            expect(isStuckReplyPhrase(q), q).toBe(true);
        for (const q of ["skip", "retry", "retry it later", "Reply: retry it"])
            expect(isStuckReplyPhrase(q), q).toBe(false);
    });
});

describe("takeStuckMarker", () => {
    it("keeps the closing markdown of the word before an inline marker", () => {
        expect(takeStuckMarker("Blocked on **OTP**[[STUCK]]")).toEqual({ text: "Blocked on **OTP**", stuck: true });
        expect(takeStuckMarker("Run `npm i`[[STUCK]]")).toEqual({ text: "Run `npm i`", stuck: true });
        expect(takeStuckMarker("Report\n`[[STUCK]]`")).toEqual({ text: "Report", stuck: true });
        expect(takeStuckMarker("Report\n__[[STUCK]]__")).toEqual({ text: "Report", stuck: true });
    });
    it("strips the marker on its own line and flags the reply stuck", () => {
        expect(takeStuckMarker("Done: drafted it.\nBlocked: Gmail wants an OTP.\n\n[[STUCK]]")).toEqual({
            text: "Done: drafted it.\nBlocked: Gmail wants an OTP.",
            stuck: true,
        });
    });

    it("catches spaced, bold and trailing variants", () => {
        for (const marker of [
            "[[ stuck ]]",
            "**[[STUCK]]**",
            "  [[Stuck]]  ",
            "`[[STUCK]]`",
            "_[[STUCK]]_",
            "*[[STUCK]]*",
            "__[[STUCK]]__",
        ]) {
            expect(takeStuckMarker(`Need your sign-in.\n${marker}\n\nThen I'll finish.`)).toEqual({
                text: "Need your sign-in.\n\nThen I'll finish.",
                stuck: true,
            });
        }
        expect(takeStuckMarker("Need your sign-in. [[STUCK]]")).toEqual({ text: "Need your sign-in.", stuck: true });
    });

    it("strips a marker followed by more text and still flags the reply stuck", () => {
        expect(takeStuckMarker("Blocked: Gmail wants your OTP. [[STUCK]]\nPing me when you have it.")).toEqual({
            text: "Blocked: Gmail wants your OTP.\nPing me when you have it.",
            stuck: true,
        });
        expect(takeStuckMarker("Need your OTP.\n[[STUCK]] — waiting on you")).toEqual({
            text: "Need your OTP.\n— waiting on you",
            stuck: true,
        });
    });

    it("leaves a normal reply untouched, even when it quotes a [STUCK] label", () => {
        const text = "All done — it's in Sent.  \n";
        expect(takeStuckMarker(text)).toEqual({ text, stuck: false });
        expect(takeStuckMarker("I got stuck in traffic").stuck).toBe(false);
        for (const quoted of [
            "Open issues:\n- [STUCK] CI flaky on main\n- Fix login",
            "[Stuck]\nPayment webhook retries",
        ]) {
            expect(takeStuckMarker(quoted)).toEqual({ text: quoted, stuck: false });
        }
    });
});
