// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The web widget shows a turn live (status line, steps, the answer typing into its bubble).
// The served script runs against a minimal DOM stub; same contract as the overlay's turnView.
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { getWidgetScript } from "./widget.js";

type Fake = {
    tag: string;
    className: string;
    innerHTML: string;
    textContent: string;
    hidden: boolean;
    disabled: boolean;
    value: string;
    style: Record<string, string>;
    children: Fake[];
    scrollTop: number;
    scrollHeight: number;
    attrs: Record<string, string>;
    listeners: Record<string, Array<(e: unknown) => void>>;
    classList: {
        add(c: string): void;
        remove(c: string): void;
        toggle(c: string): boolean;
        contains(c: string): boolean;
    };
    appendChild(c: Fake): Fake;
    replaceChildren(...c: Fake[]): void;
    remove(): void;
    querySelector(sel: string): Fake;
    addEventListener(t: string, f: (e: unknown) => void): void;
    setAttribute(k: string, v: string): void;
    focus(): void;
};

function fake(tag: string): Fake {
    const found = new Map<string, Fake>();
    const o: Fake = {
        tag,
        className: "",
        innerHTML: "",
        textContent: "",
        hidden: false,
        disabled: false,
        value: "",
        style: {},
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        attrs: {},
        listeners: {},
        classList: {
            add: (c) => {
                if (!o.className.split(" ").includes(c)) o.className = `${o.className} ${c}`.trim();
            },
            remove: (c) => {
                o.className = o.className
                    .split(" ")
                    .filter((x) => x !== c)
                    .join(" ");
            },
            toggle: (c) => {
                const on = !o.className.split(" ").includes(c);
                if (on) o.classList.add(c);
                else o.classList.remove(c);
                return on;
            },
            contains: (c) => o.className.split(" ").includes(c),
        },
        appendChild: (c) => {
            o.children.push(c);
            return c;
        },
        replaceChildren: (...c) => {
            o.children = c;
        },
        remove: () => {},
        querySelector: (sel) => {
            if (!found.has(sel)) found.set(sel, fake("q"));
            return found.get(sel) as Fake;
        },
        addEventListener: (t, f) => {
            o.listeners[t] = [...(o.listeners[t] ?? []), f];
        },
        setAttribute: (k, v) => {
            o.attrs[k] = v;
        },
        focus: () => {},
    };
    return o;
}

class FakeWS {
    static last: FakeWS;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (e: { data: string }) => void;
    sent: string[] = [];
    constructor(public url: string) {
        FakeWS.last = this;
    }
    send(s: string) {
        this.sent.push(s);
    }
}

let win: Fake;
let frames: Array<() => void>;

function boot() {
    const created: Fake[] = [];
    frames = [];
    const doc = {
        currentScript: { src: "https://bhai.test/widget.js?token=t&open=true" },
        head: { appendChild: () => {} },
        body: { appendChild: (c: Fake) => c.attrs.id !== undefined && c },
        querySelector: () => null,
        createElement: (tag: string) => {
            const e = fake(tag);
            created.push(e);
            return e;
        },
    };
    // The window is the second element the script appends to the body.
    const bodyKids: Fake[] = [];
    doc.body.appendChild = (c: Fake) => {
        bodyKids.push(c);
        return c;
    };
    const sandbox: Record<string, unknown> = {
        document: doc,
        URL,
        WebSocket: FakeWS,
        console,
        setTimeout: () => 0,
        setInterval: () => 1,
        clearInterval: () => {},
        requestAnimationFrame: (f: () => void) => frames.push(f),
        cancelAnimationFrame: () => {},
    };
    sandbox.window = sandbox;
    vm.runInNewContext(getWidgetScript("ws://x"), sandbox);
    win = bodyKids[1];
    FakeWS.last.onopen?.();
}

const send = (msg: Record<string, unknown>) => FakeWS.last.onmessage?.({ data: JSON.stringify(msg) });
const flush = () => {
    for (const f of frames.splice(0)) f();
};
const messages = () => win.querySelector("#atlas-widget-messages");
const agents = () => messages().children.filter((c) => c.className.includes("agent"));
const status = () => win.querySelector("#atlas-widget-status");

beforeEach(boot);

describe("widget live turns", () => {
    it("answer deltas fill the agent bubble", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hel" });
        send({ type: "turn_answer", turn: "t1", seq: 2, attempt: 0, text: "lo **w**" });
        expect(frames.length).toBe(1); // many deltas, one render per frame
        flush();
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("Hello <strong>w</strong>");
    });

    it("reset clears it", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Wrong start" });
        send({ type: "turn_answer_reset", turn: "t1", seq: 2, attempt: 0 });
        flush();
        expect(agents()[0].innerHTML).toBe("...");
        send({ type: "turn_answer", turn: "t1", seq: 3, attempt: 0, text: "late text of the withdrawn attempt" });
        send({ type: "turn_answer", turn: "t1", seq: 4, attempt: 1, text: "Right" });
        flush();
        expect(agents()[0].innerHTML).toBe("Right");
    });

    it("response replaces streamed text", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_step", turn: "t1", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "turn_step", turn: "t1", seq: 2, id: "b", text: "Read it", state: "done" });
        send({ type: "turn_answer", turn: "t1", seq: 3, attempt: 0, text: "Streamed [OTP_1]" });
        flush();
        send({ type: "response", turn: "t1", text: "Final <b>answer</b>", worked: { secs: 5, steps: 2 } });
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("Final &lt;b&gt;answer&lt;/b&gt;");
        expect(win.querySelector("#atlas-widget-steps-toggle").textContent).toBe("Worked for 5s · 2 steps");
        send({ type: "turn_answer", turn: "t1", seq: 9, attempt: 0, text: "after the end" });
        flush();
        expect(agents()[0].innerHTML).toBe("Final &lt;b&gt;answer&lt;/b&gt;");
    });

    it("one step reads 1 step", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_step", turn: "t1", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "response", turn: "t1", text: "Done", worked: { secs: 3, steps: 1 } });
        expect(win.querySelector("#atlas-widget-steps-toggle").textContent).toBe("Worked for 3s · 1 step");
    });

    it("a plain or stopped answer keeps its Worked for line, with nothing to open", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hi th" });
        flush();
        send({ type: "response", turn: "t1", text: "Hi th\n\nStopped.", stopped: true, worked: { secs: 4, steps: 0 } });
        const toggle = win.querySelector("#atlas-widget-steps-toggle");
        expect(win.querySelector("#atlas-widget-steps-bar").hidden).toBe(false);
        expect(toggle.textContent).toBe("Worked for 4s");
        expect(toggle.disabled).toBe(true);
        // The next turn with steps can open its list again.
        send({ type: "thinking", turn: "t2" });
        send({ type: "turn_step", turn: "t2", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "response", turn: "t2", text: "Done", worked: { secs: 3, steps: 1 } });
        expect(toggle.textContent).toBe("Worked for 3s · 1 step");
        expect(toggle.disabled).toBe(false);
    });

    it("shows the live line with its step count and the steps as text only", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", seq: 1, text: "Searching the web", step: 2, elapsed: 7 });
        send({
            type: "turn_step",
            turn: "t1",
            seq: 2,
            id: "s",
            text: "<img src=x onerror=alert(1)>",
            state: "running",
        });
        flush();
        expect(status().textContent).toMatch(/^Searching the web · step 2 · \d+s$/);
        const list = win.querySelector("#atlas-widget-steps");
        expect(list.children).toHaveLength(1);
        expect(list.children[0].textContent).toBe("<img src=x onerror=alert(1)>");
        expect(win.querySelector("#atlas-widget-steps-bar").hidden).toBe(false);
    });

    it("never renders thinking_content into the bubble", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "thinking_content", turn: "t1", text: "private reasoning" });
        flush();
        expect(agents()[0].innerHTML).toBe("...");
    });

    it("ignores another turn's events while one is live", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "mine" });
        send({ type: "turn_answer", turn: "t2", seq: 1, attempt: 0, text: "theirs" });
        send({ type: "response", turn: "t2", text: "their reply" });
        flush();
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("mine");
    });

    it("a lost connection mid-answer says so and frees the next turn", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "half an ans" });
        flush();
        FakeWS.last.onclose?.();
        expect(messages().children.at(-1)?.innerHTML).toBe("Lost the connection mid-answer. Ask me again.");
        FakeWS.last.onopen?.();
        send({ type: "thinking", turn: "t2" });
        send({ type: "turn_answer", turn: "t2", seq: 1, attempt: 0, text: "next" });
        flush();
        expect(agents().at(-1)?.innerHTML).toBe("next");
    });

    it("an old bot (no turn ids) still answers in one bubble", () => {
        send({ type: "thinking" });
        send({ type: "response", text: "plain" });
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("plain");
    });
});
