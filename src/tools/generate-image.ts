// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// generate_image: create, edit, combine, vary and undo images with the Azure
// image model behind Convex /api/image (the key stays on the server). The
// result reaches the user through AgentResponse.images, not from here.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getConvexSiteUrl } from "../config/keys.js";
import { getImagesDir, getWorkspaceDir } from "../config/paths.js";
import { encryptedFetch } from "../crypto-transport.js";
import {
    currentGenerated,
    type InboundImage,
    lastGeneratedBatch,
    lastInboundImages,
    OWNER_IMAGE_KEY,
    pushGenerated,
    undoGenerated,
} from "../media/image-memory.js";
import { getSessionToken, handleAuthError } from "../session.js";
import {
    callerIsOwner,
    isOwnerCaller,
    noteGeneratedImages,
    ownerTurnMessage,
    turnConversationKey,
    turnImages,
    turnShowsImages,
} from "./cron-tool.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Server client (/api/image) ───────────────

export interface ImageRequest {
    prompt: string;
    /** Present => edit. Max 4, each <= 8MB decoded. */
    images?: Array<{ data: string; mimeType: string }>;
    /** "1024x1024" | "1024x1536" | "1536x1024" | "auto", or a custom "WxH" (edges multiples of 16). */
    size?: string;
    quality?: "low" | "medium" | "high";
    n?: number;
    background?: "transparent" | "opaque" | "auto";
}

export class ImageError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "ImageError";
    }
}

const NOT_SET_UP = "The image model isn't set up on the server yet, so I can't make or edit images right now.";

const NAMED_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);

async function callImageApi(
    req: ImageRequest,
): Promise<{ images: Array<{ buffer: Buffer; mimeType: string }>; credits?: number; dropped?: number }> {
    const token = await getSessionToken();
    const site = getConvexSiteUrl();
    if (!token || !site) throw new ImageError("I'm not signed in right now, so I can't reach the image model.");
    // Fresh options per attempt: encryptedFetch seals the body in place.
    const post = (bearer: string) =>
        encryptedFetch(`${site}/api/image`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify(req),
            // Azure takes up to ~2 min for a high-quality edit.
            signal: AbortSignal.timeout(190_000),
        });
    let res = await post(token);
    if (res.status === 401) {
        const fresh = await handleAuthError();
        if (fresh) res = await post(fresh);
    }
    const data = (await res.json().catch(() => ({}))) as {
        images?: Array<{ data: string; mimeType: string }>;
        credits?: number;
        dropped?: number;
        retryAfter?: number;
        error?: string;
        message?: string;
    };
    if (!res.ok) {
        const s = res.status;
        // A server without custom sizes yet: validation runs before billing, so this retry is free.
        if (s === 400 && data.error === "invalid size" && req.size && !NAMED_SIZES.has(req.size)) {
            const [w, h] = req.size.split("x").map(Number);
            return callImageApi({ ...req, size: req.images?.length ? "auto" : w > h ? "1536x1024" : "1024x1536" });
        }
        if (s === 402) throw new ImageError("You're out of AI credits, so I can't make images right now.", s);
        if (s === 429)
            throw new ImageError(
                `The image model is busy right now; try again in about ${data.retryAfter ?? 60}s. Don't retry in this turn.`,
                s,
            );
        if (s === 401) throw new ImageError("I'm not signed in right now, so I can't reach the image model.", s);
        if (s === 422)
            throw new ImageError(
                "The image model's safety filter blocked this request. Rephrase it more neutrally (or leave out the part that tripped it) and try again.",
                s,
            );
        if (s === 503 || s === 404) throw new ImageError(NOT_SET_UP, s);
        if (s === 413) throw new ImageError("That photo is too large for the image model. Send a smaller one.", s);
        if (s === 400)
            throw new ImageError(
                `The image model refused the request: ${data.message ?? data.error ?? "bad input"}.`,
                s,
            );
        // Not data.message: the provider's text (deployment, region, tier) isn't for the user.
        throw new ImageError(`The image model failed (error ${s}). Try again in a moment.`, s);
    }
    const images = (data.images ?? []).map((i) => ({ buffer: Buffer.from(i.data, "base64"), mimeType: i.mimeType }));
    if (!images.length) throw new ImageError("The image model returned no image. Try again in a moment.");
    return { images, credits: data.credits, ...(data.dropped ? { dropped: data.dropped } : {}) };
}

/**
 * Several transparent PNGs (~5.5M base64 chars each at high) or high-quality images overflow
 * one response, so those go as parallel n=1 requests; the ones that fail count as dropped.
 */
async function callImageApiSplit(req: ImageRequest): Promise<Awaited<ReturnType<typeof callImageApi>>> {
    const n = req.n ?? 1;
    if (!(n > 1 && (req.background === "transparent" || (req.quality === "high" && n > 2)))) return callImageApi(req);
    const settled = await Promise.allSettled(Array.from({ length: n }, () => callImageApi({ ...req, n: 1 })));
    const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
    const images = ok.flatMap((r) => r.images);
    const credits = ok.some((r) => r.credits !== undefined)
        ? ok.reduce((sum, r) => sum + (r.credits ?? 0), 0)
        : undefined;
    return { images, credits, ...(images.length < n ? { dropped: n - images.length } : {}) };
}

/** Generate (no `images`) or edit images via the server. Throws ImageError with a user-facing message. */
export async function requestImages(req: ImageRequest): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
    return (await callImageApi(req)).images;
}

// ── Sources ──────────────────────────────────

const MAX_SOURCE_PX = 2048;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// All sources together: base64 then encrypted-base64 grows ~1.8x, and Convex takes a ~20MB body.
const MAX_TOTAL_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PATH_SOURCE_BYTES = 50 * 1024 * 1024;
const PATH_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".gif", ".tif", ".tiff", ".avif"]);
const BAD_FORMAT = "I can't open that photo format. Send it as a normal photo (JPG/PNG).";

const extFor = (mime: string) => (mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg");
const mimeForPath = (p: string) =>
    p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";

/** macOS decodes what this sharp build can't (HEIC/HEVC): sips converts it to a JPEG. */
async function sipsToJpeg(buf: Buffer): Promise<Buffer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-sips-"));
    try {
        const src = path.join(dir, "in");
        const out = path.join(dir, "out.jpg");
        fs.writeFileSync(src, buf);
        await promisify(execFile)("sips", ["-s", "format", "jpeg", "-Z", String(MAX_SOURCE_PX), src, "--out", out], {
            timeout: 30_000,
        });
        return fs.readFileSync(out);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

type Prepared = { data: string; mimeType: string; buffer: Buffer; width: number; height: number };

/** <=2048px and <=maxBytes; png when the image has alpha (transparency survives), else jpeg. */
async function encodeSource(buf: Buffer, maxBytes: number): Promise<Prepared> {
    const sharp = (await import("sharp")).default;
    const opts = { limitInputPixels: 1e9 };
    const img = sharp(buf, opts)
        .rotate()
        .resize(MAX_SOURCE_PX, MAX_SOURCE_PX, { fit: "inside", withoutEnlargement: true });
    const alpha = (await sharp(buf, opts).metadata()).hasAlpha === true;
    let out = alpha
        ? await img.clone().png().toBuffer({ resolveWithObject: true })
        : await img.clone().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    let mimeType = alpha ? "image/png" : "image/jpeg";
    if (out.data.length > maxBytes) {
        // ponytail: a huge alpha png loses its transparency here; fine at 2048px in practice.
        out = await img.clone().jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
        mimeType = "image/jpeg";
    }
    // Several photos share one request budget: a noisy 2048px jpeg can still be too big.
    if (out.data.length > maxBytes)
        out = await sharp(buf, opts)
            .rotate()
            .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 75 })
            .toBuffer({ resolveWithObject: true });
    return {
        data: out.data.toString("base64"),
        mimeType,
        buffer: out.data,
        width: out.info.width,
        height: out.info.height,
    };
}

async function prepareSource(buf: Buffer, maxBytes = MAX_SOURCE_BYTES): Promise<Prepared> {
    try {
        return await encodeSource(buf, maxBytes);
    } catch (e) {
        if (process.platform === "darwin") {
            try {
                return await encodeSource(await sipsToJpeg(buf), maxBytes);
            } catch {}
        }
        console.log(`  🎨 generate_image: can't decode a source: ${(e as Error).message}`);
        throw new ImageError(BAD_FORMAT);
    }
}

/**
 * The size for a one-photo edit: a named size when the photo already has that shape, else the
 * photo's own ratio at >=~1MP (a mismatched named size reframes the photo; "auto" drifts more).
 */
export function editSizeFor(w: number, h: number): string {
    const r = w / h;
    if (Math.abs(r - 1) < 0.02) return "1024x1024";
    if (Math.abs(r - 2 / 3) < 0.02) return "1024x1536";
    if (Math.abs(r - 1.5) < 0.02) return "1536x1024";
    if (r > 3 || r < 1 / 3) return "auto";
    const k = Math.min(2048 / Math.max(w, h), Math.max(1, Math.sqrt((1024 * 1024) / (w * h))));
    const r16 = (x: number) => Math.min(2048, Math.round((x * k) / 16) * 16);
    return `${r16(w)}x${r16(h)}`;
}

/** A path source: the owner's, an image, really inside the workspace or the inbound-media dir (symlinks resolved). */
function allowedSourcePath(p: string): string | { error: string } {
    if (!isOwnerCaller())
        return { error: "I can only edit a file from disk for the owner. Send me the photo instead." };
    if (!path.isAbsolute(p))
        return { error: 'Give the image\'s full path (or say "attached" for the photo you sent).' };
    let real: string;
    let stat: fs.Stats;
    try {
        real = fs.realpathSync(p);
        stat = fs.statSync(real);
    } catch {
        return { error: `I couldn't find an image at ${p}. Send me the photo instead.` };
    }
    if (!stat.isFile()) return { error: `I couldn't find an image at ${p}. Send me the photo instead.` };
    if (!PATH_EXTS.has(path.extname(real).toLowerCase()))
        return { error: "I can only edit image files (PNG, JPG, WEBP, HEIC, GIF, TIFF, AVIF)." };
    if (stat.size > MAX_PATH_SOURCE_BYTES) return { error: "That image is over 50MB. Use a smaller one." };
    // atlas_media: media received before the rename to bhai_media.
    const roots = [getWorkspaceDir(), getImagesDir(), ...["bhai_media", "atlas_media"].map((d) => path.join(os.tmpdir(), d))].flatMap((r) => {
        try {
            return [fs.realpathSync(r)];
        } catch {
            return [];
        }
    });
    if (!roots.some((r) => real === r || real.startsWith(r + path.sep)))
        return {
            error: "I can only edit images in Bhai's files folder or ones you sent me. Send me the photo instead.",
        };
    return real;
}

/**
 * A local edit (remove/add a small thing): keep the source's pixels wherever the model didn't
 * really change anything, so faces and framing don't drift. null = use the raw output.
 */
// ponytail: thresholds tuned on 3 images (bake-off), revisit with more
export async function blendLocal(src: Buffer, out: Buffer): Promise<Buffer | null> {
    const sharp = (await import("sharp")).default;
    const { width: w = 0, height: h = 0 } = await sharp(src).metadata();
    const { width: ow = 0, height: oh = 0 } = await sharp(out).metadata();
    if (!w || !h || !ow || !oh || Math.abs(ow / oh / (w / h) - 1) > 0.02) return null;
    const rgb = { raw: { width: w, height: h, channels: 3 as const } };
    const gray = { raw: { width: w, height: h, channels: 1 as const } };
    const a = await sharp(src).removeAlpha().raw().toBuffer();
    const b = await sharp(out).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const ab = await sharp(a, rgb).blur(4).raw().toBuffer();
    const bb = await sharp(b, rgb).blur(4).raw().toBuffer();
    let m = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) {
        const d =
            Math.abs(ab[i * 3] - bb[i * 3]) +
            Math.abs(ab[i * 3 + 1] - bb[i * 3 + 1]) +
            Math.abs(ab[i * 3 + 2] - bb[i * 3 + 2]);
        m[i] = d / 3 > 22 ? 255 : 0;
    }
    m = await sharp(m, gray).blur(24).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < m.length; i++) m[i] = m[i] > 20 ? 255 : 0;
    m = await sharp(m, gray).blur(10).extractChannel(0).raw().toBuffer();
    let changed = 0;
    const o = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
        const t = m[i] / 255;
        if (t > 0.5) changed++;
        for (let c = 0; c < 3; c++) o[i * 3 + c] = Math.round(a[i * 3 + c] * (1 - t) + b[i * 3 + c] * t);
    }
    // Most of the frame changed: not a local edit after all.
    if (changed > 0.35 * w * h) return null;
    return sharp(o, rgb).jpeg({ quality: 95 }).toBuffer();
}

// ── Output ───────────────────────────────────

const NOTE =
    "The image is already shown to the user with your reply (an email reply attaches it). Don't call send_file and don't paste the file path; reply in one short line.";
const SEND_NOTE =
    "This chat doesn't show images by itself: send it to the user with send_file (file_path above), then reply in one short line.";
const noteFor = () => (turnShowsImages() ? NOTE : SEND_NOTE);

const slugify = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "image";

/** A new file in `dir` ("wx": nothing, a source included, is overwritten; a taken name gets _k). */
function writeNew(dir: string, name: string, ext: string, buf: Buffer): string {
    for (let k = 0; ; k++) {
        const file = path.join(dir, `${name}${k ? `_${k}` : ""}.${ext}`);
        try {
            fs.writeFileSync(file, buf, { flag: "wx" });
            return file;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST" || k > 20) throw e;
        }
    }
}

/** Saves into the Images folder; if that fails, into the inbound-media tmp dir (the image is paid for). */
function save(buf: Buffer, mimeType: string, slug: string, stamp: number, i?: number): string {
    const name = `${slug}_${stamp}${i === undefined ? "" : `_${i}`}`;
    try {
        return writeNew(getImagesDir(), name, extFor(mimeType), buf);
    } catch (e) {
        console.log(`  🎨 generate_image: can't save to Images (${(e as Error).message}), using tmp`);
        const tmp = path.join(os.tmpdir(), "bhai_media");
        fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
        return writeNew(tmp, name, extFor(mimeType), buf);
    }
}

/** The model's JPEGs are always q95: q85 is ~2.4x smaller at no visible cost (bake-off MAD ~1). PNG untouched. */
async function compact(img: { buffer: Buffer; mimeType: string }): Promise<Buffer> {
    if (img.mimeType !== "image/jpeg") return img.buffer;
    try {
        const sharp = (await import("sharp")).default;
        const out = await sharp(img.buffer).jpeg({ quality: 85 }).toBuffer();
        return out.length < img.buffer.length ? out : img.buffer;
    } catch {
        return img.buffer;
    }
}

const SIZES = {
    square: "1024x1024",
    portrait: "1024x1536",
    landscape: "1536x1024",
    phone: "1088x1920",
    desktop: "1920x1088",
    auto: "auto",
} as const;

// A contact's images (WhatsApp persona, guest) and autonomous runs bill the owner: one at a time, a few a day.
const GUEST_DAILY_CAP = 3;
const guestUse = new Map<string, { day: string; n: number }>();

const err = (error: string) => JSON.stringify({ error });

// ── Tool ─────────────────────────────────────

export const generateImage: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "generate_image",
            description: [
                "Create or edit images with an AI image model. The result is shown to the user in the chat automatically.",
                '- Create ("make/draw/design an image of…"): omit source; write a rich prompt (subject, style, composition, lighting, colors, mood, any text to render in quotes).',
                '- Edit the user\'s photo (change background, restyle, add/remove something, fix lighting): source "attached". Write the prompt as a precise instruction that also says what to keep unchanged, e.g. "Remove the man on the left. Keep everything else exactly the same — same framing, lighting, colors and people." or "Replace the background with a sunny beach. Keep the person, pose, face and clothes exactly the same."',
                "  Keep the prompt short; don't list every object to preserve. For a remove/erase/add-a-small-object edit set local true.",
                '- Combine photos ("put me and my dog together", "use this logo on this shirt"): source "attached" uses every image the user sent this turn; say in the prompt how each one is used.',
                '- Change the image you just made ("make it brighter", "now in blue"): source "last".',
                '- Variations ("give me a few options"): count 2-4. To change one of them ("edit the second one", "make the 3rd one brighter"): source "variation N" (1-based, in the order they came back).',
                '- Another version / higher quality of an EDIT: source = that result\'s source_path with the same prompt (not "last"). Of a created image: same prompt, no source.',
                '- HD of the current image: source "last", quality high, prompt "Re-render this exact image with finer detail; keep composition, subjects, colors and text identical."',
                '- Undo ("go back", "undo that"): undo true; no other fields needed.',
                "Aspect: phone for a phone wallpaper/story, desktop for a desktop wallpaper/banner, portrait for a poster, landscape for a thumbnail/header, square for a logo/icon/sticker/profile picture (add transparent true for a logo/icon/sticker). Leave aspect unset for edits to keep the photo's shape.",
                "Never use web_search to find an image the user asked you to make. After it succeeds, reply in one short line; don't describe the image at length.",
                "Call it for every new image request even if it failed earlier in this chat: outages and busy spells pass.",
            ].join("\n"),
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "What to create, or for an edit a precise instruction that says what to change and what to keep exactly the same.",
                    },
                    source: {
                        type: "string",
                        description:
                            'Omit to create from scratch. "attached" = the image(s) the user sent (this turn, else the last one they sent). "last" = the last image you made or edited here. "variation N" = the Nth image (1-based) of the last batch of variations. Or an absolute path to an image file in Bhai\'s files folder (owner only).',
                    },
                    aspect: {
                        type: "string",
                        enum: ["square", "portrait", "landscape", "phone", "desktop", "auto"],
                        description:
                            "Shape of the result. Default square for new images, the source's shape for edits.",
                    },
                    quality: {
                        type: "string",
                        enum: ["low", "medium", "high"],
                        description:
                            "Default medium for new images, low for edits. high only when the user asks for best quality (~35s, 4x the credits).",
                    },
                    count: { type: "number", description: "1-4 variations. Default 1." },
                    transparent: {
                        type: "boolean",
                        description: "Transparent background (PNG): logos, icons, stickers, cutouts.",
                    },
                    local: {
                        type: "boolean",
                        description:
                            "Set true for remove/erase/add-a-small-object edits: everything the edit didn't touch stays pixel-identical.",
                    },
                    undo: {
                        type: "boolean",
                        description:
                            "Go back to the version before the last edit and show it again (free, no prompt needed).",
                    },
                    filename: { type: "string", description: "Optional base filename (no extension)." },
                },
                required: ["prompt"],
            },
        },
    },

    async handler(input) {
        const key = turnConversationKey() ?? "default";
        // The owner's versions follow them across channels; a photo they send stays in its chat (key).
        const history = callerIsOwner() === true ? OWNER_IMAGE_KEY : key;
        const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
        const started = Date.now();

        if (input.undo === true) {
            const current = currentGenerated(history);
            const prev = undoGenerated(history, fs.existsSync);
            if (!prev) return err("There's no earlier version to go back to in this chat.");
            console.log(`  🎨 generate_image: undo → ${path.basename(prev)}`);
            const mimeType = mimeForPath(prev);
            noteGeneratedImages([
                { path: prev, mimeType, prompt, kind: "undo", ...(current ? { sourcePath: current } : {}) },
            ]);
            return JSON.stringify({
                success: true,
                kind: "undo",
                images: [{ file_path: prev, mime_type: mimeType }],
                source_path: current,
                note: noteFor(),
            });
        }

        if (!prompt) return err("Say what image to make, or what to change.");

        // Sources: base64 for the API, plus a file for undo/"before" (saved when the source has none).
        const source = typeof input.source === "string" ? input.source.trim() : "";
        let raw: Array<{ buffer: Buffer; file?: string }> = [];
        if (source === "attached") {
            const turn = turnImages() ?? [];
            const imgs: InboundImage[] = turn.length ? turn : lastInboundImages(key);
            if (!imgs.length) return err("I don't see a photo to edit. Ask the user to send it here.");
            raw = imgs.slice(0, 4).map((i) => ({ buffer: Buffer.from(i.base64, "base64") }));
        } else if (source === "last") {
            const last = currentGenerated(history);
            if (!last || !fs.existsSync(last))
                return err("I haven't made an image in this chat yet. Ask what to create, or for the photo to edit.");
            raw = [{ buffer: fs.readFileSync(last), file: last }];
        } else if (/^variation\s*#?\d+$/i.test(source)) {
            const batch = lastGeneratedBatch(history);
            const n = Number(source.match(/\d+/)?.[0]);
            if (!batch) return err('I haven\'t made several variations here. Use source "last" for the last image.');
            if (n < 1 || n > batch.length)
                return err(`There were ${batch.length} variations; pick variation 1 to ${batch.length}.`);
            const file = batch[n - 1];
            if (!fs.existsSync(file)) return err(`Variation ${n} isn't on disk any more. Ask which image to use.`);
            raw = [{ buffer: fs.readFileSync(file), file }];
        } else if (source) {
            const p = allowedSourcePath(source);
            if (typeof p !== "string") return err(p.error);
            raw = [{ buffer: fs.readFileSync(p), file: p }];
        }
        const isEdit = raw.length > 0;

        let count = Math.min(4, Math.max(1, Math.round(Number(input.count) || 1)));
        const aspect = SIZES[input.aspect as keyof typeof SIZES] ? (input.aspect as keyof typeof SIZES) : undefined;
        let quality = ["low", "medium", "high"].includes(input.quality as string)
            ? (input.quality as NonNullable<ImageRequest["quality"]>)
            : isEdit
              ? "low"
              : "medium";
        // Spend guard: high quality and several images only when the owner's own words ask for them
        // (not text in a photo or page, not a swarm's guess). The image buttons' text passes.
        const said = ownerTurnMessage();
        if (quality === "high" && !/\b(high|best|hd|sharp|quality|4k|detailed)\b/i.test(said)) quality = "medium";
        if (count > 1 && !/\b([2-4]|two|three|four|options|variations|versions|few|several)\b/i.test(said)) count = 1;
        // Contacts get low quality; they and autonomous runs (a cron job, a report built from web
        // pages that could plant "draw 50 images") get one image a call and a daily cap.
        if (callerIsOwner() !== true) quality = "low";
        if (!isOwnerCaller()) {
            count = 1;
            const day = new Date().toDateString();
            const used = guestUse.get(key);
            const n = used?.day === day ? used.n : 0;
            if (n >= GUEST_DAILY_CAP) return err("I can only make a couple of images a day here.");
            // ponytail: in-memory, resets on restart; persist it if contacts abuse that.
            if (guestUse.size > 500) for (const [k, v] of guestUse) if (v.day !== day) guestUse.delete(k);
            guestUse.set(key, { day, n: n + 1 });
        }
        const transparent = input.transparent === true;
        const slug = slugify(
            typeof input.filename === "string" && input.filename
                ? input.filename
                : prompt.split(/\s+/).slice(0, 6).join(" "),
        );
        const stamp = Date.now();

        try {
            const perSource = Math.min(MAX_SOURCE_BYTES, Math.floor(MAX_TOTAL_SOURCE_BYTES / Math.max(1, raw.length)));
            const prepared = await Promise.all(raw.map((r) => prepareSource(r.buffer, perSource)));
            const size = aspect
                ? SIZES[aspect]
                : raw.length === 1
                  ? editSizeFor(prepared[0].width, prepared[0].height)
                  : isEdit
                    ? "auto"
                    : SIZES.square;
            const { images, credits, dropped } = await callImageApiSplit({
                prompt,
                ...(isEdit ? { images: prepared.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
                size,
                quality,
                n: count,
                ...(transparent ? { background: "transparent" as const } : {}),
            });

            if (
                input.local === true &&
                raw.length === 1 &&
                images.length === 1 &&
                images[0].mimeType === "image/jpeg"
            ) {
                const blended = await blendLocal(prepared[0].buffer, images[0].buffer).catch((e) => {
                    console.log(`  🎨 generate_image: local blend failed: ${(e as Error).message}`);
                    return null;
                });
                if (blended) images[0] = { buffer: blended, mimeType: "image/jpeg" };
            }

            // The "before" of a one-photo edit, as a file: undo goes back to it. Combined photos
            // have no single "before", so no undo target.
            let sourcePath = raw.length === 1 ? raw[0].file : undefined;
            if (raw.length === 1 && !sourcePath)
                sourcePath = save(prepared[0].buffer, prepared[0].mimeType, `${slug}_original`, stamp);
            if (sourcePath && currentGenerated(history) !== sourcePath) pushGenerated(history, sourcePath);

            const files: Array<{ file_path: string; mime_type: string }> = [];
            for (const [i, img] of images.entries())
                files.push({
                    file_path: save(
                        await compact(img),
                        img.mimeType,
                        slug,
                        stamp,
                        images.length > 1 ? i + 1 : undefined,
                    ),
                    mime_type: img.mimeType,
                });
            // One history entry per call: undo after variations goes back past all of them, "last" = the last one.
            pushGenerated(
                history,
                files.map((f) => f.file_path),
            );
            const kind = isEdit ? "edited" : "generated";
            // The turn's reply carries them (AgentResponse.images), also when a sub-agent made them.
            noteGeneratedImages(
                files.map((f) => ({
                    path: f.file_path,
                    mimeType: f.mime_type,
                    prompt,
                    kind,
                    ...(sourcePath ? { sourcePath } : {}),
                })),
            );
            console.log(
                `  🎨 generate_image: ${kind} ${files.length}${dropped ? ` (${dropped} dropped)` : ""} (${quality}, ${size}${raw.length ? `, ${raw.length} source` : ""}) in ${((Date.now() - started) / 1000).toFixed(1)}s → ${path.basename(files[0].file_path)}`,
            );
            return JSON.stringify({
                success: true,
                kind,
                images: files,
                ...(sourcePath ? { source_path: sourcePath } : {}),
                ...(credits !== undefined ? { credits } : {}),
                ...(dropped ? { dropped } : {}),
                note: `${dropped ? `Only ${files.length} of ${files.length + dropped} images came back; say so. ` : ""}${noteFor()}`,
            });
        } catch (e) {
            const msg =
                e instanceof ImageError
                    ? e.message
                    : (e as Error).name === "TimeoutError"
                      ? "The image model took too long to answer. Try again, maybe with quality medium."
                      : e instanceof TypeError && /fetch failed/i.test(e.message)
                        ? "I couldn't reach Bhai's server. Check the connection and try again."
                        : `Image generation failed: ${(e as Error).message}`;
            console.log(`  🎨 generate_image: failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${msg}`);
            // Outages pass; without this the model reads an old failure in history and stops calling the tool.
            if (e instanceof ImageError && (e.status === 422 || e.status === 413 || e.status === 400)) return err(msg);
            return JSON.stringify({
                error: msg,
                note: "This failure is about this moment only. When the user asks for an image in a later message, call generate_image again; never answer from an earlier failure.",
            });
        }
    },
};
