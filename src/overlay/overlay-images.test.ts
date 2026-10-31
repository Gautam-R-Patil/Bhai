// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Images in an overlay reply: thumbnails, the path only for the owner, and "Show in Finder"
// only for files under Bhai's workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import type { AgentResponse } from "../agent.js";

// Before overlay-chat is imported: paths.ts caches the workspace on first use.
process.env.ATLAS_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-images-"));
const { _isScreenQueryForTest: isScreenQuery, imageQuickActions, overlayImages, revealablePath, saveSentPhoto } = await import("./overlay-chat.js");
const { getImagesDir } = await import("../config/paths.js");

const png = (file: string, alpha: boolean) =>
    sharp({ create: { width: 2400, height: 1200, channels: alpha ? 4 : 3, background: { r: 200, g: 80, b: 20, alpha: alpha ? 0.5 : 1 } } })
        .png()
        .toFile(file);

it("thumbnails the reply's images; the path and Finder only for the owner's own files", async () => {
    const after = path.join(getImagesDir(), "after.png");
    const before = path.join(getImagesDir(), "before.png");
    await png(after, false);
    await png(before, true);
    const result = {
        text: "",
        toolCalls: 1,
        images: [{ path: after, mimeType: "image/png", prompt: "remove the man", kind: "edited", sourcePath: before }],
    } as unknown as AgentResponse;

    const [owner] = await overlayImages(result, true);
    expect(owner.url).toMatch(/^data:image\/jpeg;base64,/); // opaque → jpeg
    expect(owner.before).toMatch(/^data:image\/png;base64,/); // alpha stays png
    expect(owner.path).toBe(after);
    const meta = await sharp(Buffer.from(owner.url.split(",")[1], "base64")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);

    const [guest] = await overlayImages(result, false);
    expect(guest.path).toBeUndefined();
    expect(imageQuickActions([owner])).toContain("Undo that edit");
    expect(imageQuickActions([{ kind: "generated" }])).not.toContain("Undo that edit");
    // Combining photos has no single "before" (no sourcePath): nothing to undo to.
    const combined = { ...result, images: [{ ...result.images![0], sourcePath: undefined }] } as AgentResponse;
    expect(imageQuickActions(await overlayImages(combined, true))).toEqual(["Make another version", "Make it higher quality"]);

    expect(revealablePath(after)).toBe(fs.realpathSync(after));
    expect(revealablePath("/etc/hosts")).toBeNull();
    expect(revealablePath(path.join(getImagesDir(), "..", "..", "x.png"))).toBeNull();
    expect(revealablePath(123)).toBeNull();
});

it("an image reply's follow-up chips don't grab a screenshot", () => {
    for (const q of imageQuickActions([{ kind: "edited", before: "data:" }])) expect(isScreenQuery(q), q).toBe(false);
    expect(isScreenQuery("undo that")).toBe(true); // only the chips' own text
});

it("a photo the owner sends is kept for Chats' thumbnail; other files aren't", () => {
    const saved = saveSentPhoto("../my fruit.JPG", Buffer.from("jpegbytes").toString("base64"), "image/jpeg");
    expect(saved && path.dirname(saved)).toBe(path.join(getImagesDir(), "Sent"));
    expect(saved && path.basename(saved)).toMatch(/^my_fruit_\d+\.jpg$/);
    expect(saved && fs.readFileSync(saved, "utf8")).toBe("jpegbytes");
    expect(saveSentPhoto("notes.pdf", "AAAA", "application/pdf")).toBeUndefined();
    expect(saveSentPhoto("shot.heic", "AAAA", "image/heic")).toBeUndefined();
});
