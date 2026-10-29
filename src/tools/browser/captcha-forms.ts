// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Form-style CAPTCHAs, read and answered by the vision models like a person would:
//   image-text     an image of distorted characters + a field: read it, type it
//   text-question  a question in the field's label ("If tomorrow is Saturday…"): answer it
//   click-image    an image with its own instructions: click the spots, in order
//   rotate         an image with rotate buttons: turn it upright
// The page's own submit is the agent's next step, as with any form. Works through either
// driver (Bhai's browser or the owner's Chrome) with real input.

import type { CaptchaType } from "./captcha.js";
import {
    askModel,
    askValue,
    type CaptchaDriver,
    centre,
    click,
    GRID,
    gridPrompt,
    type Rect,
    snapshot,
} from "./captcha-vision.js";

// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or the Chrome page proxy
type Page = any;

/** The widget's parts in viewport CSS px, after bringing them into view. Mirrors detectCaptcha's rules. */
const LOCATE_JS = `(() => {
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 10; };
  const fieldText = (i) => i.name + " " + i.id + " " + (i.placeholder || "") + " " + ((i.labels && i.labels[0] && i.labels[0].textContent) || "");
  const field = Array.from(document.querySelectorAll("input")).find((i) => /^(text|)$/i.test(i.type || "") && /captcha|verification code|security code|enter the (characters|code|text)/i.test(fieldText(i)) && shown(i));
  const img = Array.from(document.images).find((i) => /captcha/i.test(i.src + " " + i.id + " " + i.className + " " + i.alt) && !/logo|icon/i.test(i.alt + " " + i.className) && i.closest("form") && shown(i));
  const btn = (re) => Array.from(document.querySelectorAll("button")).find((b) => re.test(b.className + " " + b.textContent + " " + (b.getAttribute("aria-label") || "")));
  const right = btn(/rotate.?right|clockwise/i), left = btn(/rotate.?left|counter/i);
  (img || field).scrollIntoView({ block: "center", behavior: "instant" });
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const angle = img ? (/rotate\\((-?[\\d.]+)deg\\)/.exec(img.style.transform || "") || [])[1] : null;
  return {
    img: rect(img), src: img ? img.src : "", field: rect(field), right: rect(right), left: rect(left),
    question: field ? ((field.labels && field.labels[0] && field.labels[0].innerText) || field.placeholder || "").trim() : "",
    fieldKey: field ? (field.id ? "#" + CSS.escape(field.id) : field.name ? "input[name='" + field.name + "']" : "") : "",
    angle: angle === undefined || angle === null ? null : Number(angle),
  };
})()`;

type Parts = {
    img: Rect | null;
    src: string;
    field: Rect | null;
    right: Rect | null;
    left: Rect | null;
    question: string;
    fieldKey: string;
    angle: number | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

async function locate(page: Page): Promise<Parts | null> {
    return (await Promise.resolve(page.evaluate(LOCATE_JS)).catch(() => null)) as Parts | null;
}

/** Empties the field (React-safe), focuses it with a real click, and types the answer for real. */
async function fill(page: Page, d: CaptchaDriver, parts: Parts, text: string) {
    if (!parts.field) return;
    if (parts.fieldKey) {
        await Promise.resolve(
            page.evaluate(
                `(() => { const i = document.querySelector(${JSON.stringify(parts.fieldKey)}); if (!i || !i.value) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
            ),
        ).catch(() => {});
    }
    await click(d, centre(parts.field));
    await sleep(120);
    await d.type(text);
}

/** No token says an image check is done: the image itself is marked (detectCaptcha reads it). */
async function markAnswered(page: Page, src: string) {
    await Promise.resolve(
        page.evaluate(
            `document.querySelectorAll("img").forEach((i) => { if (i.src === ${JSON.stringify(src)}) i.setAttribute("data-bhai-answered", i.src); })`,
        ),
    ).catch(() => {});
}

async function shotUrl(d: CaptchaDriver, area: Rect): Promise<string> {
    return `data:image/png;base64,${(await d.shot(area)).toString("base64")}`;
}

const IMAGE_TEXT_PROMPT =
    'This image is a CAPTCHA on the user\'s own form. Reply {"text": "<the characters exactly as shown>"}: keep upper and lower case, no spaces unless the image has them, ignore lines and noise.';
const questionPrompt = (q: string) =>
    `A website's verification question, on the user's own form: "${q}". Reply {"text": "<just the answer: a word or a number>"}.`;
const ROTATE_PROMPT =
    'Each numbered square is the same picture turned a different amount. Which number shows it upright, the natural way (sky and ceilings up, people, animals and objects standing the right way)? Reply {"text": "<number>"}.';

const SHEET_TILE = 150;
const SHEET_COLS = 6;
/**
 * The picture as it would look after 0, 1, 2… presses (`deg` each, clockwise positive),
 * numbered on one sheet: models pick the upright one far better than they estimate an angle.
 * ponytail: at most 36 options (a 10° step and up); finer steps would need a coarse-then-fine pass.
 */
async function rotationSheet(png: Buffer, deg: number, presses: number[]): Promise<string> {
    const sharp = (await import("sharp")).default;
    const { width = 0, height = 0 } = await sharp(png).metadata();
    const tiles = await Promise.all(
        presses.map(async (k) => {
            const turned = await sharp(png)
                .rotate(k * deg, { background: "#ffffff" })
                .toBuffer({ resolveWithObject: true });
            // Keep the original frame around the centre, as the page shows it.
            const left = Math.max(0, Math.floor((turned.info.width - width) / 2));
            const top = Math.max(0, Math.floor((turned.info.height - height) / 2));
            return sharp(turned.data)
                .extract({
                    left,
                    top,
                    width: Math.min(width, turned.info.width),
                    height: Math.min(height, turned.info.height),
                })
                .resize(SHEET_TILE, SHEET_TILE, { fit: "contain", background: "#ffffff" })
                .toBuffer();
        }),
    );
    const rows = Math.ceil(presses.length / SHEET_COLS);
    const W = SHEET_COLS * SHEET_TILE;
    const H = rows * SHEET_TILE;
    const labels = presses
        .map((_, i) => {
            const x = (i % SHEET_COLS) * SHEET_TILE;
            const y = Math.floor(i / SHEET_COLS) * SHEET_TILE;
            return `<rect x="${x}" y="${y}" width="${SHEET_TILE}" height="${SHEET_TILE}" fill="none" stroke="#000" stroke-width="2"/><rect x="${x + 2}" y="${y + 2}" width="34" height="26" fill="#ffeb3b"/><text x="${x + 19}" y="${y + 22}" font-size="20" font-family="Arial" font-weight="bold" text-anchor="middle">${i + 1}</text>`;
        })
        .join("");
    const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
        .composite([
            ...tiles.map((t, i) => ({
                input: t,
                left: (i % SHEET_COLS) * SHEET_TILE,
                top: Math.floor(i / SHEET_COLS) * SHEET_TILE,
            })),
            {
                input: Buffer.from(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${labels}</svg>`,
                ),
                left: 0,
                top: 0,
            },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
    return `data:image/jpeg;base64,${sheet.toString("base64")}`;
}

function miss(type: CaptchaType, why: string): false {
    console.log(`  🧩 CAPTCHA (${type}): gave up, ${why}`);
    return false;
}

/** True once the check is answered (whether it was right shows when the agent submits the form). */
export async function solveFormCaptcha(page: Page, type: CaptchaType, d: CaptchaDriver): Promise<boolean> {
    const parts = await locate(page);
    if (!parts) return miss(type, "couldn't read the widget");

    if (type === "text-question") {
        if (!parts.question || !parts.field) return false;
        const answer = await askValue(questionPrompt(parts.question), null);
        console.log(`  🧩 CAPTCHA (question): "${parts.question.slice(0, 60)}" → ${answer ?? "no answer"}`);
        if (!answer) return false;
        await fill(page, d, parts, answer);
        return true;
    }

    if (!parts.img) return miss(type, "no CAPTCHA image found");

    if (type === "image-text") {
        if (!parts.field) return false;
        const answer = await askValue(IMAGE_TEXT_PROMPT, await shotUrl(d, pad(parts.img, 4)));
        console.log(`  🧩 CAPTCHA (image text) → ${answer ?? "no answer"}`);
        if (!answer) return false;
        await fill(page, d, parts, answer.replace(/\s+/g, ""));
        return true;
    }

    if (type === "click-image") {
        // The instruction is usually part of the image: the lettered grid covers all of it.
        const area = pad(parts.img, 2);
        const image = await snapshot(d, area, [], area);
        if (!image) return false;
        const ans = await askModel(gridPrompt(""), image, "grid");
        if (!ans || ans.unsolvable || !ans.answer.length) return false;
        const cw = area.w / GRID;
        const ch = area.h / GRID;
        console.log(`  🧩 CAPTCHA (click image) → ${ans.answer.join(",")}`);
        for (const c of ans.answer as string[]) {
            await click(d, [area.x + (Number(c.slice(1)) - 0.5) * cw, area.y + (c.charCodeAt(0) - 64.5) * ch]);
            await sleep(250);
        }
        await markAnswered(page, parts.src);
        return true;
    }

    if (type === "rotate") {
        const turn = parts.right ?? parts.left;
        if (!turn) return miss(type, "no rotate button found");
        // One press shows how far each press turns the picture.
        await click(d, centre(turn));
        await sleep(300);
        const after = await locate(page);
        const step = Math.abs((after?.angle ?? 0) - (parts.angle ?? 0)) || 0;
        if (!step || !after?.img) return miss(type, `a press didn't turn the picture (angle ${parts.angle} → ${after?.angle})`);
        const deg = parts.right ? step : -step; // what one press of `turn` does, clockwise positive
        const n = Math.round(360 / step);
        const options = Array.from({ length: Math.min(n, 36) }, (_, i) => Math.round((i * n) / Math.min(n, 36)));
        const sheet = await rotationSheet(await d.shot(after.img), deg, options);
        const pick = Number(await askValue(ROTATE_PROMPT, sheet));
        const presses = options[pick - 1];
        console.log(`  🧩 CAPTCHA (rotate): option ${pick} upright → ${presses ?? "?"} × ${deg}° presses`);
        if (presses === undefined) return false;
        for (let i = 0; i < presses; i++) {
            await click(d, centre(turn));
            await sleep(150);
        }
        await markAnswered(page, parts.src);
        return true;
    }
    return false;
}
