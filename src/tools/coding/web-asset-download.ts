// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── web_asset_download ───────────────────────
// Fetches an image, video, audio, or Lottie JSON from a URL and
// writes it into the project's asset folder with a sanitized filename.
// Content-type is validated against an allowlist so the agent can't
// accidentally pull an HTML page and save it as `hero.jpg`. Returns
// the local path, size, and dimensions (for images) so the agent can
// drop a ready-to-use `<img src="..." />` reference.

import dns from "node:dns/promises";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

// ── SSRF guard ────────────────────────────────
// Hostnames and IP ranges the agent must never reach. Covers loopback,
// link-local (incl. AWS/GCP/Azure metadata 169.254.169.254), RFC1918
// private LANs, IPv6 equivalents, and .local / .internal suffixes.

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "metadata.azure.com",
]);

function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    // IPv4-mapped IPv6: ::ffff:<ipv4>
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isPrivateIPv4(mapped[1])) return true;
    return false;
}

async function assertPublicHost(urlStr: string): Promise<string | null> {
    let u: URL;
    try {
        u = new URL(urlStr);
    } catch {
        return "invalid URL";
    }
    const proto = u.protocol.toLowerCase();
    if (proto !== "http:" && proto !== "https:") return `blocked protocol: ${proto}`;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return "empty host";
    if (BLOCKED_HOSTNAMES.has(host)) return `blocked hostname: ${host}`;
    if (host.endsWith(".local") || host.endsWith(".internal")) return `blocked suffix: ${host}`;

    // Literal-IP shortcut — skip DNS
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        if (isPrivateIPv4(host)) return `blocked private IPv4: ${host}`;
        return null;
    }
    if (host.includes(":") || /^[0-9a-f]*::/.test(host)) {
        if (isPrivateIPv6(host)) return `blocked private IPv6: ${host}`;
        return null;
    }

    // DNS-resolve and verify EVERY address falls outside the blocklist.
    try {
        const records = await dns.lookup(host, { all: true, verbatim: true });
        for (const r of records) {
            if (r.family === 4 && isPrivateIPv4(r.address)) return `blocked via DNS to private IPv4: ${r.address}`;
            if (r.family === 6 && isPrivateIPv6(r.address)) return `blocked via DNS to private IPv6: ${r.address}`;
        }
    } catch (err) {
        return `DNS lookup failed: ${(err as Error).message}`;
    }
    return null;
}

const MAX_BYTES_DEFAULT = 8 * 1024 * 1024; // 8 MB per asset
const MAX_BYTES_HARD = 32 * 1024 * 1024; // 32 MB absolute ceiling
const DEFAULT_TIMEOUT_MS = 30_000;

// Allowlisted MIME types — keep tight; extend if a new asset class shows up.
const MIME_EXTENSION: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "application/json": ".json", // lottie
    "application/pdf": ".pdf",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
};

function extFromContentType(ct: string): string | null {
    const norm = ct.split(";")[0]?.trim().toLowerCase() ?? "";
    return MIME_EXTENSION[norm] ?? null;
}

function sanitizeFilename(input: string): string {
    return (
        input
            .replace(/[^\w.-]/g, "_")
            .replace(/_+/g, "_")
            .slice(0, 80) || `asset-${Date.now()}`
    );
}

function pngDims(buf: Buffer): { w: number; h: number } | null {
    if (buf.length < 24) return null;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A, IHDR at bytes 16-24
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegDims(buf: Buffer): { w: number; h: number } | null {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i < buf.length - 8) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        // SOFn markers carry dimensions
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
    }
    return null;
}

function gifDims(buf: Buffer): { w: number; h: number } | null {
    if (buf.length < 10 || buf.slice(0, 3).toString("ascii") !== "GIF") return null;
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function webpDims(buf: Buffer): { w: number; h: number } | null {
    if (buf.length < 30) return null;
    if (buf.slice(0, 4).toString("ascii") !== "RIFF") return null;
    if (buf.slice(8, 12).toString("ascii") !== "WEBP") return null;
    const chunkType = buf.slice(12, 16).toString("ascii");
    if (chunkType === "VP8 ") {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunkType === "VP8L") {
        const b0 = buf[21],
            b1 = buf[22],
            b2 = buf[23],
            b3 = buf[24];
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + ((b3 << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunkType === "VP8X") {
        return {
            w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
            h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
    }
    return null;
}

function extractDims(buf: Buffer, ext: string): { w: number; h: number } | null {
    switch (ext) {
        case ".png":
            return pngDims(buf);
        case ".jpg":
        case ".jpeg":
            return jpegDims(buf);
        case ".gif":
            return gifDims(buf);
        case ".webp":
            return webpDims(buf);
        default:
            return null;
    }
}

// ── Tool ─────────────────────────────────────

export const webAssetDownload: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "web_asset_download",
            description:
                "Download an image / video / audio / Lottie JSON / font from a URL to a local path in the project. Validates Content-Type against an allowlist so malformed responses never get saved with a misleading extension. Extracts dimensions for common image formats. Typical flow: stock_image_search → pick a URL → web_asset_download to `public/images/hero.jpg` → reference in JSX.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Source URL (must be http:// or https://).",
                    },
                    dest_path: {
                        type: "string",
                        description:
                            "Destination file path (absolute or relative to cwd). The extension is auto-corrected to match the actual Content-Type. Typical: 'public/images/hero.jpg'.",
                    },
                    max_bytes: {
                        type: "number",
                        description: `Maximum file size in bytes. Default ${MAX_BYTES_DEFAULT} (8 MB), hard cap ${MAX_BYTES_HARD} (32 MB).`,
                    },
                    timeout_ms: {
                        type: "number",
                        description: `Fetch timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
                    },
                    overwrite: {
                        type: "boolean",
                        description: "If false (default), refuses to overwrite an existing file. Set true to replace.",
                    },
                },
                required: ["url", "dest_path"],
            },
        },
    },

    async handler(input) {
        const url = (input.url as string) || "";
        const destPath = (input.dest_path as string) || "";
        if (!url.trim() || !destPath.trim()) {
            return JSON.stringify({ error: "url and dest_path are required" });
        }
        if (!/^https?:\/\//i.test(url)) {
            return JSON.stringify({ error: "url must start with http:// or https://" });
        }

        const maxBytes = Math.min(MAX_BYTES_HARD, Math.max(1024, Number(input.max_bytes) || MAX_BYTES_DEFAULT));
        const timeoutMs = Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS);
        const overwrite = input.overwrite === true;

        const absDest = path.resolve(destPath);
        if (!isPathAllowed(absDest)) {
            const reason = getPathBlockedReason(absDest) ?? `Path "${absDest}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(absDest)) {
            return JSON.stringify({ error: `Path "${absDest}" is write-protected.` });
        }

        // Refuse overwrite unless asked
        try {
            const s = statSync(absDest);
            if (s.isFile() && !overwrite) {
                return JSON.stringify({ error: `File already exists: ${absDest}. Pass overwrite=true to replace.` });
            }
        } catch {
            /* fresh file — proceed */
        }

        auditLog("web_asset_download", { url: url.slice(0, 200), dest: absDest });

        // Manual redirect loop — re-validate every hop against the SSRF blocklist.
        const controller = new AbortController();
        const killTimer = setTimeout(() => controller.abort(), timeoutMs);
        const MAX_HOPS = 5;
        let currentUrl = url;
        let res: Response;
        try {
            let hop = 0;
            while (true) {
                const ssrfErr = await assertPublicHost(currentUrl);
                if (ssrfErr) {
                    clearTimeout(killTimer);
                    return JSON.stringify({ error: `SSRF guard: ${ssrfErr}` });
                }
                res = await fetch(currentUrl, {
                    signal: controller.signal,
                    headers: { "User-Agent": "ATLAS/1.0 asset-downloader" },
                    redirect: "manual",
                });
                if (res.status >= 300 && res.status < 400) {
                    const loc = res.headers.get("location");
                    if (!loc) break;
                    if (++hop > MAX_HOPS) {
                        clearTimeout(killTimer);
                        return JSON.stringify({ error: `Too many redirects (>${MAX_HOPS})` });
                    }
                    currentUrl = new URL(loc, currentUrl).toString();
                    continue;
                }
                break;
            }
        } catch (err) {
            clearTimeout(killTimer);
            return JSON.stringify({ error: `Fetch failed: ${(err as Error).message}` });
        }
        clearTimeout(killTimer);

        if (!res.ok) {
            return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText} fetching ${currentUrl}` });
        }

        const contentLength = Number(res.headers.get("content-length") || 0);
        if (contentLength > maxBytes) {
            return JSON.stringify({ error: `Asset too large: ${contentLength} bytes > max ${maxBytes}` });
        }

        const contentType = res.headers.get("content-type") || "";
        const mimeExt = extFromContentType(contentType);
        if (!mimeExt) {
            return JSON.stringify({
                error: `Refused: Content-Type "${contentType}" is not in the allowlist. Likely not a media file (possibly HTML or a blocked download).`,
            });
        }

        const arr = new Uint8Array(await res.arrayBuffer());
        if (arr.byteLength > maxBytes) {
            return JSON.stringify({ error: `Asset too large: ${arr.byteLength} bytes > max ${maxBytes}` });
        }
        const buf = Buffer.from(arr);

        // Correct the extension if the caller guessed wrong
        const originalExt = path.extname(absDest).toLowerCase();
        const finalPath =
            originalExt === mimeExt ? absDest : absDest.slice(0, absDest.length - originalExt.length) + mimeExt;
        const finalName = path.basename(finalPath);
        const sanitized = path.join(path.dirname(finalPath), sanitizeFilename(finalName));

        try {
            mkdirSync(path.dirname(sanitized), { recursive: true });
            writeFileSync(sanitized, buf);
        } catch (err) {
            return JSON.stringify({ error: `Write failed: ${(err as Error).message}` });
        }

        const dims = extractDims(buf, mimeExt);
        return JSON.stringify({
            success: true,
            path: sanitized,
            bytes: buf.byteLength,
            content_type: contentType.split(";")[0]?.trim(),
            extension: mimeExt,
            dimensions: dims,
            corrected_extension:
                originalExt !== mimeExt
                    ? `Extension corrected ${originalExt || "(none)"} → ${mimeExt} based on Content-Type`
                    : undefined,
        });
    },
};
