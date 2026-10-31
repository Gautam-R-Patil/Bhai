// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The web widget shows a turn live (status line, steps, the answer typing into its bubble).
// The served script runs against a minimal DOM stub; same contract as the overlay's turnView.
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    parentNode?: Fake;
    appendChild(c: Fake): Fake;
    removeChild(c: Fake): Fake;
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
            c.parentNode = o;
            return c;
        },
        removeChild: (c) => {
            o.children = o.children.filter((x) => x !== c);
            c.parentNode = undefined;
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

function boot(timers: Record<string, unknown> = {}) {
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
        ...timers,
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
const messages = () => win.querySelector("#bhai-widget-messages");
const agents = () => messages().children.filter((c) => c.className.includes("agent"));
const status = () => win.querySelector("#bhai-widget-status");

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
        send({ type: "turn_status", turn: "t1", text: "Working", step: 0, elapsed: 20 }); // a long turn
        send({ type: "turn_step", turn: "t1", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "turn_step", turn: "t1", seq: 2, id: "b", text: "Read it", state: "done" });
        send({ type: "turn_answer", turn: "t1", seq: 3, attempt: 0, text: "Streamed [OTP_1]" });
        flush();
        send({ type: "response", turn: "t1", text: "Final <b>answer</b>", worked: { secs: 5, steps: 2 } });
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("Final &lt;b&gt;answer&lt;/b&gt;");
        expect(win.querySelector("#bhai-widget-steps-toggle").textContent).toBe("Worked for 5s · 2 steps");
        send({ type: "turn_answer", turn: "t1", seq: 9, attempt: 0, text: "after the end" });
        flush();
        expect(agents()[0].innerHTML).toBe("Final &lt;b&gt;answer&lt;/b&gt;");
    });

    it("one step reads 1 step", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", text: "Working", step: 0, elapsed: 20 });
        send({ type: "turn_step", turn: "t1", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "response", turn: "t1", text: "Done", worked: { secs: 3, steps: 1 } });
        expect(win.querySelector("#bhai-widget-steps-toggle").textContent).toBe("Worked for 3s · 1 step");
    });

    it("a plain or stopped answer keeps its Worked for line, with nothing to open", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", text: "Working", step: 0, elapsed: 20 });
        send({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hi th" });
        flush();
        send({ type: "response", turn: "t1", text: "Hi th\n\nStopped.", stopped: true, worked: { secs: 4, steps: 0 } });
        const toggle = win.querySelector("#bhai-widget-steps-toggle");
        expect(win.querySelector("#bhai-widget-steps-bar").hidden).toBe(false);
        expect(toggle.textContent).toBe("Worked for 4s");
        expect(toggle.disabled).toBe(true);
        // The next turn with steps can open its list again.
        send({ type: "thinking", turn: "t2" });
        send({ type: "turn_status", turn: "t2", text: "Working", step: 0, elapsed: 20 });
        send({ type: "turn_step", turn: "t2", seq: 1, id: "a", text: "Open page", state: "done" });
        send({ type: "response", turn: "t2", text: "Done", worked: { secs: 3, steps: 1 } });
        expect(toggle.textContent).toBe("Worked for 3s · 1 step");
        expect(toggle.disabled).toBe(false);
    });

    it("shows the live line with its step count and the steps as text only", () => {
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", seq: 1, text: "Searching the web", step: 2, elapsed: 17 });
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
        const list = win.querySelector("#bhai-widget-steps");
        expect(list.children).toHaveLength(1);
        expect(list.children[0].textContent).toBe("<img src=x onerror=alert(1)>");
        expect(win.querySelector("#bhai-widget-steps-bar").hidden).toBe(false);
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

    it("a lost connection before any answer text says so instead of a silent vanish", () => {
        for (const thinking of [{ type: "thinking", turn: "t1" }, { type: "thinking" }]) {
            boot();
            send(thinking);
            flush();
            FakeWS.last.onclose?.();
            expect(agents()).toHaveLength(0);
            const last = messages().children.at(-1);
            expect(last?.className).toBe("bhai-msg system");
            expect(last?.innerHTML).toBe("Connection lost. Ask me again.");
        }
    });

    it("an old bot (no turn ids) still answers in one bubble", () => {
        send({ type: "thinking" });
        send({ type: "response", text: "plain" });
        expect(agents()).toHaveLength(1);
        expect(agents()[0].innerHTML).toBe("plain");
    });
});

describe("widget live line waits for a long turn", () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    const bar = () => win.querySelector("#bhai-widget-steps-bar");
    const timed = () => {
        vi.useFakeTimers();
        boot({ Date, setInterval, clearInterval });
    };

    it("a quick turn shows no live line, no dots and no Worked for line", () => {
        timed();
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", seq: 1, text: "Thinking", step: 0, elapsed: 0 });
        flush();
        expect(status().textContent).toBe("Online");
        expect(agents()[0].style.display).toBe("none"); // no "..." bubble
        send({ type: "turn_answer", turn: "t1", seq: 2, attempt: 0, text: "Hi" });
        flush();
        expect(agents()[0].style.display).toBe(""); // the answer streams at once
        vi.advanceTimersByTime(2000);
        expect(status().textContent).toBe("Online");
        send({ type: "response", turn: "t1", text: "Hi there", worked: { secs: 2, steps: 0 } });
        expect(agents()[0].innerHTML).toBe("Hi there");
        expect(bar().hidden).toBe(true);
    });

    it("a long turn shows its line and steps at 15 s, then its Worked for line", () => {
        timed();
        send({ type: "thinking", turn: "t1" });
        send({ type: "turn_status", turn: "t1", seq: 1, text: "Searching the web", step: 1, elapsed: 0 });
        send({ type: "turn_step", turn: "t1", seq: 2, id: "a", text: "Search", state: "running" });
        flush();
        vi.advanceTimersByTime(14_000);
        expect(status().textContent).toBe("Online");
        expect(bar().hidden).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(status().textContent).toBe("Searching the web · step 1 · 15s");
        expect(bar().hidden).toBe(false);
        expect(win.querySelector("#bhai-widget-steps").children.at(-1)?.textContent).toBe("Search");
        expect(agents()[0].style.display).toBe("");
        send({ type: "response", turn: "t1", text: "Found it", worked: { secs: 18, steps: 1 } });
        expect(win.querySelector("#bhai-widget-steps-toggle").textContent).toBe("Worked for 18s · 1 step");
    });

    it("a rejoin snapshot past 15 s shows the line at once", () => {
        timed();
        send({
            type: "turn_snapshot",
            turn: "t1",
            seq: 5,
            status: { text: "Comparing flights", step: 3, elapsed: 21 },
            steps: [{ id: 1, text: "Search flights", state: "done" }],
            answer: "",
        });
        expect(status().textContent).toBe("Comparing flights · step 3 · 21s");
        expect(bar().hidden).toBe(false);
    });

    it("a rejoin snapshot under 15 s shows the line when the turn reaches 15 s", () => {
        timed();
        send({
            type: "turn_snapshot",
            turn: "t1",
            seq: 5,
            status: { text: "Reading", step: 1, elapsed: 10 },
            steps: [],
            answer: "",
        });
        expect(status().textContent).toBe("Online");
        vi.advanceTimersByTime(5000);
        expect(status().textContent).toBe("Reading · step 1 · 15s");
    });
});

describe("widget double-inject guard", () => {
    it("a page already running the pre-rename script (__atlasWidget) gets no second widget", () => {
        const createElement = vi.fn();
        const sandbox: Record<string, unknown> = { document: { createElement }, __atlasWidget: true };
        sandbox.window = sandbox;
        vm.runInNewContext(getWidgetScript("ws://x"), sandbox);
        expect(createElement).not.toHaveBeenCalled();
    });
});
