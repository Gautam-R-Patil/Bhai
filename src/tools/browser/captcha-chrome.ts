// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The picture-CAPTCHA solver's driver for the Chrome extension (the owner's own
// Chrome). Clicks and drags go through CDP Input.dispatchMouseEvent (the extension's
// mouse_path command plays a whole gesture): real, trusted
// input that lands wherever the pixel is, including inside the cross-origin
// challenge frame (the bridge's click_at fires synthetic events in the top page,
// which the widgets ignore). The challenge frame's tiles, button and instruction
// come from the extension's captcha_frames command; screenshots from CDP.

import type { CaptchaDriver, ChallengeView, Frames, Rect } from "./captcha-vision.js";
import { CAPTURE_SCALE, FRAMES_JS } from "./captcha-vision.js";
import { sendBridgeCommand } from "./chrome-bridge.js";

/** One widget frame as the extension reads it, in that frame's own viewport. */
type FrameInfo = {
    kind: "challenge" | "checkbox";
    vw: number;
    tiles: Rect[];
    submit: Rect | null;
    tick: Rect | null;
    canvas: Rect | null;
    header: Rect | null;
    instruction: string;
    settled: boolean;
    blocked: boolean;
};

// biome-ignore lint/suspicious/noExplicitAny: ChromePageProxy
export function chromeDriver(page: any): CaptchaDriver {
    const cdp = (method: string, params: Record<string, unknown>) =>
        sendBridgeCommand("cdp", { method, params }, 10_000) as Promise<Record<string, unknown>>;
    // Gestures go to the extension whole (mouse_path) and it paces them: one round trip
    // per click or drag. Moves made while the button is down queue up until release.
    type Ev = {
        type: string;
        x: number;
        y: number;
        button: string;
        buttons: number;
        clickCount: number;
        delayMs: number;
    };
    let at: [number, number] = [0, 0];
    let pressed = false;
    let held: Ev[] = [];
    const ev = (type: string, x: number, y: number, delayMs: number, extra: Partial<Ev> = {}): Ev => ({
        type,
        x,
        y,
        button: pressed ? "left" : "none",
        buttons: pressed ? 1 : 0,
        clickCount: 0,
        delayMs,
        ...extra,
    });
    const play = (events: Ev[]) => sendBridgeCommand("mouse_path", { events }, 20_000);

    /** The widget frame of `kind`, with its rects moved from frame space onto the page. */
    async function read(kind: FrameInfo["kind"], box: Rect) {
        const infos = (await sendBridgeCommand("captcha_frames", {}, 8000).catch(() => null)) as FrameInfo[] | null;
        const f = Array.isArray(infos) ? infos.find((i) => i.kind === kind) : undefined;
        if (!f) return null;
        const s = f.vw > 0 ? box.w / f.vw : 1; // the iframe can be CSS-scaled
        const map = (r: Rect | null) => (r ? { x: box.x + r.x * s, y: box.y + r.y * s, w: r.w * s, h: r.h * s } : null);
        return { f, map };
    }

    return {
        frames: () => Promise.resolve(page.evaluate(FRAMES_JS)).catch(() => null) as Promise<Frames | null>,

        async challenge(frame): Promise<ChallengeView | null> {
            const r = await read("challenge", frame);
            if (!r) return null;
            const { f, map } = r;
            return {
                tiles: f.tiles.map((t) => map(t) as Rect),
                submit: map(f.submit),
                instruction: f.instruction,
                canvas: map(f.canvas),
                header: map(f.header),
                settled: f.settled,
                blocked: f.blocked,
            };
        },

        async tickBox(checkbox) {
            const r = await read("checkbox", checkbox);
            return r ? r.map(r.f.tick) : null;
        },

        async shot(area) {
            // Just the challenge, at CAPTURE_SCALE whatever the screen's density (clip is in page coordinates).
            const at = ((await page.evaluate("({ x: scrollX, y: scrollY })").catch(() => null)) as {
                x: number;
                y: number;
            } | null) ?? { x: 0, y: 0 };
            const { data } = await cdp("Page.captureScreenshot", {
                format: "png",
                clip: { x: area.x + at.x, y: area.y + at.y, width: area.w, height: area.h, scale: CAPTURE_SCALE },
            });
            return Buffer.from(String(data), "base64");
        },

        async move(x, y, steps = 1) {
            const [x0, y0] = at;
            const evs = Array.from({ length: steps }, (_, k) =>
                ev("mouseMoved", x0 + ((x - x0) * (k + 1)) / steps, y0 + ((y - y0) * (k + 1)) / steps, 16),
            );
            at = [x, y];
            if (pressed) held.push(...evs);
            else await play(evs);
        },

        async click(x, y) {
            at = [x, y];
            await play([
                ev("mouseMoved", x, y, 30),
                ev("mousePressed", x, y, 70, { button: "left", buttons: 1, clickCount: 1 }),
                ev("mouseReleased", x, y, 0, { button: "left", buttons: 0, clickCount: 1 }),
            ]);
        },

        async down() {
            pressed = true;
            held = [ev("mousePressed", at[0], at[1], 60, { clickCount: 1 })];
        },

        async up() {
            pressed = false;
            const release = ev("mouseReleased", at[0], at[1], 0, { button: "left", clickCount: 1 });
            const gesture = [...held, release];
            held = [];
            await play(gesture);
        },
    };
}
