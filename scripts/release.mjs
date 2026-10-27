#!/usr/bin/env node
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Bhai desktop release script.
//
// End-to-end flow:
//   1. Bump desktop/package.json version (or take --version).
//   2. Build the mac + win installers with blockmap generation.
//   3. Compute SHA-512 (base64) + byte size for each artifact.
//   4. Upload DMG / EXE + .blockmap files to the Cloudflare R2 bucket.
//   5. Emit the `npx convex env set ...` commands that point the Convex
//      updater endpoint at the new version; optionally run them.
//
// Why wrangler: it's the officially supported R2 upload path, ships
// as a regular npm package, and needs zero additional dependencies in
// this repo — `npx wrangler@latest` works on a fresh clone.
//
// Usage:
//   node scripts/release.mjs --version 0.2.1
//   node scripts/release.mjs --version 0.2.1 --channel beta
//   node scripts/release.mjs --version 0.2.1 --skip-build   # dev iteration
//   node scripts/release.mjs --version 0.2.1 --apply-convex # set env vars
//
// Required env:
//   R2_BUCKET              — bucket name, e.g. "atlas-releases"
//   R2_PUBLIC_BASE         — public URL prefix, e.g. "https://dl.example.com"
//                            (custom domain) or "https://<id>.r2.dev"
//   CLOUDFLARE_ACCOUNT_ID  — R2 S3 endpoint uses <account>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID       — R2-specific S3 Access Key ID (from Dashboard →
//                            R2 → Manage R2 API Tokens). NOT the regular CF token.
//   R2_SECRET_ACCESS_KEY   — paired secret for the Access Key ID above
// Optional env:
//   CONVEX_DEPLOYMENT      — pinned via .env.local; --apply-convex uses it

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DESKTOP_DIR = resolve(REPO_ROOT, "desktop");
const DIST_DIR = resolve(DESKTOP_DIR, "dist");

// ── CLI arg parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const next = args[i + 1];
    // Treat flags-without-values as boolean true
    if (!next || next.startsWith("--")) return true;
    return next;
}
const VERSION = arg("version");
const CHANNEL = String(arg("channel", "stable")).toLowerCase();
const SKIP_BUILD = !!arg("skip-build", false);
const APPLY_CONVEX = !!arg("apply-convex", false);
const SKIP_WIN = !!arg("skip-win", false);
const SKIP_MAC = !!arg("skip-mac", false);

if (!VERSION) fatal("missing --version. Example: --version 0.2.1");
if (!["stable", "beta", "alpha", "canary"].includes(CHANNEL)) {
    fatal(`invalid --channel "${CHANNEL}". Must be stable|beta|alpha|canary.`);
}

const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
if (
    !R2_BUCKET ||
    !R2_PUBLIC_BASE ||
    !CLOUDFLARE_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY
) {
    fatal(
        "Missing R2 credentials. Required env vars:\n" +
            "  R2_BUCKET               e.g. atlas-releases\n" +
            "  R2_PUBLIC_BASE          e.g. https://pub-<id>.r2.dev\n" +
            "  CLOUDFLARE_ACCOUNT_ID   (shown on Cloudflare dashboard home)\n" +
            "  R2_ACCESS_KEY_ID        from R2 → Manage R2 API Tokens\n" +
            "  R2_SECRET_ACCESS_KEY    paired secret\n",
    );
}

// R2's S3-compatible endpoint. The AWS SDK uses this for multipart uploads,
// which is required for anything >300 MiB (wrangler's hard limit).
const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// ── Utilities ──────────────────────────────────────────────────────────────
function fatal(msg) {
    console.error(`\n❌  ${msg}\n`);
    process.exit(1);
}
function log(msg) {
    console.log(`• ${msg}`);
}
function headline(msg) {
    console.log(`\n━━ ${msg} ━━`);
}

function sh(cmd, opts = {}) {
    console.log(`$ ${cmd}`);
    return execSync(cmd, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
}

function sha512Base64(filePath) {
    // electron-updater YAMLs use raw base64 SHA-512.
    const h = createHash("sha512");
    h.update(readFileSync(filePath));
    return h.digest("base64");
}

function fileSize(filePath) {
    return statSync(filePath).size;
}

function findFirst(dir, patterns) {
    if (!existsSync(dir)) return null;
    const names = readdirSync(dir);
    for (const pattern of patterns) {
        const m = names.find((n) => pattern.test(n));
        if (m) return resolve(dir, m);
    }
    return null;
}

function r2Key(channel, version, filename) {
    // Path pattern: <channel>/<version>/<filename>
    // (e.g. stable/0.2.1/Bhai-0.2.1-arm64.dmg)
    return `${channel}/${version}/${filename}`;
}

function r2PublicUrl(key) {
    const base = R2_PUBLIC_BASE.replace(/\/+$/, "");
    return `${base}/${key}`;
}

function contentTypeFor(name) {
    if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
    if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
    if (name.endsWith(".blockmap")) return "application/octet-stream";
    if (name.endsWith(".yml") || name.endsWith(".yaml")) return "text/yaml; charset=utf-8";
    return "application/octet-stream";
}

async function uploadToR2(filePath) {
    const name = basename(filePath);
    const key = r2Key(CHANNEL, VERSION, name);
    const size = fileSize(filePath);
    const sizeMb = (size / 1024 / 1024).toFixed(1);
    log(`↑ ${name} (${sizeMb} MB) → r2://${R2_BUCKET}/${key}`);

    // 8 MiB parts, up to 4 in flight — lets the 435 MB DMG land in ~55
    // chunks and saturates a residential uplink without blowing memory.
    const upload = new Upload({
        client: s3,
        params: {
            Bucket: R2_BUCKET,
            Key: key,
            Body: createReadStream(filePath),
            ContentType: contentTypeFor(name),
            // Let the public URL serve a sensible filename.
            ContentDisposition: `inline; filename="${name}"`,
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
        leavePartsOnError: false,
    });

    let lastPct = -1;
    upload.on("httpUploadProgress", (p) => {
        if (!p.total) return;
        const pct = Math.floor((p.loaded / p.total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`   … ${pct}%\n`);
            lastPct = pct;
        }
    });

    await upload.done();
    return r2PublicUrl(key);
}

// ── Phase 1: bump version ──────────────────────────────────────────────────
headline("Updating desktop/package.json version");
const pkgPath = resolve(DESKTOP_DIR, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
if (pkg.version !== VERSION) {
    pkg.version = VERSION;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + "\n");
    log(`desktop/package.json → ${VERSION}`);
} else {
    log(`desktop/package.json already at ${VERSION}`);
}

// ── Phase 2: build ─────────────────────────────────────────────────────────
if (!SKIP_BUILD) {
    if (!SKIP_MAC && process.platform === "darwin") {
        headline("Building macOS installer (DMG + blockmap)");
        // build:mac:release uses electron-builder's own DMG step, which
        // writes <name>.dmg.blockmap alongside the DMG. The custom
        // create-dmg.sh does NOT emit a blockmap — don't use it here.
        sh("npm run build:mac:release", { cwd: DESKTOP_DIR });
    } else if (!SKIP_MAC) {
        log("Skipping mac build (not on darwin host)");
    }

    if (!SKIP_WIN && process.platform === "win32") {
        headline("Building Windows installer (NSIS + blockmap)");
        sh("npm run build:win", { cwd: DESKTOP_DIR });
    } else if (!SKIP_WIN) {
        log("Skipping win build (not on win32 host — build on Windows separately)");
    }
} else {
    log("Skipping build (--skip-build)");
}

// ── Phase 3: locate + hash artifacts ──────────────────────────────────────
headline("Locating artifacts");

const macDmg = findFirst(DIST_DIR, [
    new RegExp(`A\\.T\\.L\\.A\\.S-${VERSION.replace(/\./g, "\\.")}-arm64\\.dmg$`),
    /\.dmg$/,
]);
const macBlockmap = macDmg ? `${macDmg}.blockmap` : null;
const winExe = findFirst(DIST_DIR, [
    new RegExp(`A\\.T\\.L\\.A\\.S.*${VERSION.replace(/\./g, "\\.")}.*\\.exe$`, "i"),
    /Setup.*\.exe$/i,
    /\.exe$/i,
]);
const winBlockmap = winExe ? `${winExe}.blockmap` : null;
const macYml = resolve(DIST_DIR, "latest-mac.yml");
const winYml = resolve(DIST_DIR, "latest.yml");

const artifacts = [];
if (macDmg && existsSync(macDmg)) {
    artifacts.push({ platform: "mac", path: macDmg, kind: "binary" });
    if (macBlockmap && existsSync(macBlockmap)) {
        artifacts.push({ platform: "mac", path: macBlockmap, kind: "blockmap" });
    } else {
        log(`⚠ no blockmap for ${basename(macDmg)} — delta updates disabled for mac`);
    }
    if (existsSync(macYml)) {
        artifacts.push({ platform: "mac", path: macYml, kind: "yml" });
    }
}
if (winExe && existsSync(winExe)) {
    artifacts.push({ platform: "win", path: winExe, kind: "binary" });
    if (winBlockmap && existsSync(winBlockmap)) {
        artifacts.push({ platform: "win", path: winBlockmap, kind: "blockmap" });
    } else {
        log(`⚠ no blockmap for ${basename(winExe)} — delta updates disabled for win`);
    }
    if (existsSync(winYml)) {
        artifacts.push({ platform: "win", path: winYml, kind: "yml" });
    }
}

if (!artifacts.length) {
    fatal(`No artifacts found in ${DIST_DIR}. Build first, or remove --skip-build.`);
}

for (const a of artifacts) {
    const size = fileSize(a.path);
    log(`  ${a.platform}/${a.kind}: ${basename(a.path)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// ── Phase 4: upload ───────────────────────────────────────────────────────
headline(`Uploading to R2 bucket "${R2_BUCKET}" (channel=${CHANNEL}, version=${VERSION})`);

const urls = {};
for (const a of artifacts) {
    const url = await uploadToR2(a.path);
    if (a.kind === "binary") urls[a.platform] = url;
}

// ── Phase 5: compute metadata ─────────────────────────────────────────────
headline("Computing SHA-512 + sizes");

const meta = {};
if (macDmg && existsSync(macDmg)) {
    meta.mac = {
        url: urls.mac,
        sha512: sha512Base64(macDmg),
        size: fileSize(macDmg),
    };
    log(`mac: ${meta.mac.size} bytes, sha512=${meta.mac.sha512.slice(0, 16)}…`);
}
if (winExe && existsSync(winExe)) {
    meta.win = {
        url: urls.win,
        sha512: sha512Base64(winExe),
        size: fileSize(winExe),
    };
    log(`win: ${meta.win.size} bytes, sha512=${meta.win.sha512.slice(0, 16)}…`);
}

// ── Phase 6: emit / apply Convex env ──────────────────────────────────────
headline("Convex env vars");

const suffix = CHANNEL === "stable" ? "" : `_${CHANNEL.toUpperCase()}`;
const cmds = [];
cmds.push(`npx convex env set UPDATE_VERSION${suffix} ${VERSION}`);
cmds.push(`npx convex env set UPDATE_RELEASE_DATE${suffix} ${new Date().toISOString()}`);
if (meta.mac) {
    cmds.push(`npx convex env set UPDATE_URL_MAC${suffix} ${meta.mac.url}`);
    cmds.push(`npx convex env set UPDATE_SHA512_MAC${suffix} ${meta.mac.sha512}`);
    cmds.push(`npx convex env set UPDATE_SIZE_MAC${suffix} ${meta.mac.size}`);
}
if (meta.win) {
    cmds.push(`npx convex env set UPDATE_URL_WIN${suffix} ${meta.win.url}`);
    cmds.push(`npx convex env set UPDATE_SHA512_WIN${suffix} ${meta.win.sha512}`);
    cmds.push(`npx convex env set UPDATE_SIZE_WIN${suffix} ${meta.win.size}`);
}

if (APPLY_CONVEX) {
    log("Applying Convex env vars:");
    for (const c of cmds) {
        const r = spawnSync("sh", ["-c", c], { stdio: "inherit", cwd: REPO_ROOT });
        if (r.status !== 0) fatal(`Convex env command failed: ${c}`);
    }
    log("✅ Convex env updated.");
} else {
    console.log("\nRun these to point the updater at the new release:\n");
    for (const c of cmds) console.log(`  ${c}`);
    console.log("\n(Re-run with --apply-convex to execute them automatically.)");
}

headline("Done");
log(`Version:  ${VERSION}`);
log(`Channel:  ${CHANNEL}`);
if (meta.mac) log(`macOS:    ${meta.mac.url}`);
if (meta.win) log(`Windows:  ${meta.win.url}`);
log(`Feed:     https://flexible-panther-179.convex.site/api/updates${CHANNEL === "stable" ? "" : `?channel=${CHANNEL}`}`);
console.log("");
