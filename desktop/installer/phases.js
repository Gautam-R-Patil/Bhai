// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Declarative install phase list. Each phase is `{id, label, run(ctx, log), idempotent}`.
// `run()` receives a ctx with: BOT_DIR, DATA_DIR, SETUP_FLAG, runCommand, checkNodeInstalled,
// downloadAndInstallNode, loadEnvDecrypted, saveEnvEncrypted, documentsDir, options, sendProgress.
// All file-system touching helpers are injected so we can unit-test the module without
// Electron / without a real install.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const ALL_PHASE_IDS = [
    "node",
    "playwright-chromium",
    "embedding-model",
    "sox",
    "data-dir",
    "workspace",
    "setup-state-finalize",
];

const P = {
    node: () => ({
        id: "node",
        label: "Node.js 20",
        idempotent: true,
        async run(ctx, log) {
            log("Detecting Node.js on system PATH...");
            const has = await ctx.checkNodeInstalled();
            if (!has) {
                log("Node.js not found — downloading...");
                await ctx.downloadAndInstallNode(ctx.sendProgress);
            } else {
                log("Node.js 20+ detected \u2713");
            }
        },
    }),

    playwright: () => ({
        id: "playwright-chromium",
        label: "Browser engine",
        idempotent: true,
        async run(ctx, log) {
            log("Installing Chromium (~130MB)...");
            const cli = path.join(ctx.BOT_DIR, "node_modules", "playwright-core", "cli.js");
            await ctx.runCommand("node", [cli, "install", "chromium"], ctx.BOT_DIR, (l) => { if (l.trim()) log(l); });
        },
    }),

    embed: () => ({
        id: "embedding-model",
        label: "AI embedding model",
        idempotent: true,
        async run(ctx, log) {
            log("Pre-warming Xenova/all-MiniLM-L6-v2 (quantized)...");
            // Write the warmup script INSIDE BOT_DIR — not os.tmpdir(). ESM resolves
            // bare specifiers relative to the importing FILE's dir (walking up
            // node_modules), not cwd. From a temp dir, `import("@xenova/transformers")`
            // never reaches BOT_DIR/node_modules and ERR_MODULE_NOT_FOUNDs. BOT_DIR
            // holds the bundled, asar-unpacked @xenova (see desktop/package.json).
            // Also pin env.cacheDir to DATA_DIR/models so we warm the SAME cache the
            // runtime reads (src/memory/embeddings.ts), not the default HF cache —
            // otherwise the pre-warm is wasted and the bot re-downloads on first use.
            const modelsCacheDir = path.join(ctx.DATA_DIR, "models");
            const script = path.join(ctx.BOT_DIR, "_bhai_warmup.mjs");
            const body =
                'import("@xenova/transformers")' +
                '.then(t=>{t.env.cacheDir=' + JSON.stringify(modelsCacheDir) + ';' +
                'return t.pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{quantized:true});})' +
                '.then(()=>console.log("done")).catch(e=>console.error(e));';
            try {
                fs.writeFileSync(script, body);
            } catch (err) {
                // BOT_DIR can be read-only in some packaged layouts. The warmup is a
                // pure optimization — never fail the install over it.
                log("Skipping embed pre-warm (could not write to bot dir): " + (err && err.message ? err.message : String(err)));
                return;
            }
            try {
                await ctx.runCommand("node", [script], ctx.BOT_DIR, (l) => { if (l.trim()) log(l); });
            } finally {
                try { fs.unlinkSync(script); } catch { /* cleanup */ }
            }
        },
    }),

    sox: () => ({
        id: "sox",
        label: "Audio toolkit (sox)",
        idempotent: true,
        async run(ctx, log) {
            // Lifted from main.js:1599-1643; non-fatal on every branch.
            try {
                const has = await new Promise((r) => require("child_process").exec("sox --version", (e) => r(!e)));
                if (has) { log("sox detected \u2713"); return; }
                log("Installing sox (needed for live voice)...");
                if (process.platform === "darwin") {
                    try {
                        await ctx.runCommand("brew", ["install", "sox"], undefined, (l) => { if (l.trim()) log(l); });
                        log("sox via Homebrew \u2713");
                    } catch {
                        log("Install manually: brew install sox");
                    }
                } else if (process.platform === "linux") {
                    try {
                        await ctx.runCommand("sudo", ["apt-get", "install", "-y", "sox"], undefined, (l) => { if (l.trim()) log(l); });
                    } catch {
                        log("Install manually: sudo apt install sox");
                    }
                } else {
                    // Windows: winget \u2192 choco \u2192 manual URL. Fresh boxes have no
                    // Chocolatey, but winget ships with App Installer on Win10 1809+/
                    // Win11 (the Ollama phase already relies on it). The winget SoX
                    // package installs sox.exe but does NOT add it to PATH; that's
                    // fine here \u2014 this phase only needs the binary on disk, and the
                    // voice runtime resolves it separately. Choco's package is
                    // `sox.portable` (not `sox`). Whole branch stays non-fatal.
                    let installed = false;
                    try {
                        await ctx.runCommand("winget", ["install", "--id", "ChrisBagwell.SoX", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"], undefined, (l) => { if (l.trim()) log(l); });
                        log("sox via winget \u2713");
                        installed = true;
                    } catch { /* winget missing or package unavailable \u2014 try choco */ }
                    if (!installed) {
                        try {
                            await ctx.runCommand("choco", ["install", "sox.portable", "-y"], undefined, (l) => { if (l.trim()) log(l); });
                            log("sox via Chocolatey \u2713");
                            installed = true;
                        } catch { /* choco missing too */ }
                    }
                    if (!installed) {
                        log("sox not installed (winget/choco unavailable) \u2014 install manually: https://sox.sourceforge.net");
                    }
                }
            } catch {
                log("Audio tools check skipped (non-fatal)");
            }
        },
    }),

    dataDir: () => ({
        id: "data-dir",
        label: "Data directory",
        idempotent: true,
        async run(ctx, log) {
            // SAFETY: data-dir was historically only meant to run on FIRST install
            // — it wipes memory.db, hnsw, audit log, browser profile, etc. But
            // setup:install (as opposed to setup:resume-install) builds the FULL
            // phase list every time, so a reconfigure / tier-upgrade would nuke
            // the user's accumulated memories. Detect a prior install via a
            // setup-state.json marker for THIS phase and SKIP the destructive
            // block on subsequent runs. The "mkdir if missing" + "copy google
            // credentials" steps remain idempotent and always run.
            fs.mkdirSync(ctx.DATA_DIR, { recursive: true });
            let isFirstInstall = true;
            try {
                const statePath = path.join(ctx.DATA_DIR, "setup-state.json");
                if (fs.existsSync(statePath)) {
                    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
                    // Either marker proves a prior install exists. __finalizedAt
                    // is the stronger signal — if the user ever reached the
                    // finalize phase, their data MUST be preserved even if the
                    // data-dir marker somehow got lost (manual edit, partial
                    // write, schema migration). Belt-and-suspenders.
                    if (st && ((st["data-dir"] && st["data-dir"].completedAt) || st.__finalizedAt)) {
                        isFirstInstall = false;
                    }
                }
            } catch { /* malformed state → treat as first install */ }
            if (isFirstInstall) {
                log("First-time data directory setup...");
                const del = ["memory.db", "memory.db-shm", "memory.db-wal", "memory.hnsw.json", "audit.jsonl", "browser-strategies.json", "task-learnings.json"];
                const clear = ["browser-profile", "google-tokens", "research", "long-tasks", "process-logs"];
                for (const f of del) {
                    try { fs.unlinkSync(path.join(ctx.DATA_DIR, f)); } catch { /* ignore missing */ }
                }
                for (const d of clear) {
                    try { fs.rmSync(path.join(ctx.DATA_DIR, d), { recursive: true, force: true }); } catch { /* ignore */ }
                    fs.mkdirSync(path.join(ctx.DATA_DIR, d), { recursive: true });
                }
            } else {
                log("Data directory preserved (existing install) — ensuring required subdirs present...");
                // Just ensure the empty subdirs exist; don't wipe contents.
                for (const d of ["browser-profile", "google-tokens", "research", "long-tasks", "process-logs"]) {
                    fs.mkdirSync(path.join(ctx.DATA_DIR, d), { recursive: true });
                }
            }
            const bundled = path.join(ctx.BOT_DIR, "data", "google-credentials.json");
            const target = path.join(ctx.DATA_DIR, "google-credentials.json");
            // Only copy if user-side doesn't already have one — preserves any
            // creds the user may have manually placed.
            if (fs.existsSync(bundled) && !fs.existsSync(target)) {
                fs.copyFileSync(bundled, target);
            }
        },
    }),

    workspace: () => ({
        id: "workspace",
        label: "Workspace folder",
        idempotent: true,
        async run(ctx, log) {
            const ws = ctx.options && ctx.options.workspace;
            if (!ws) { log("No workspace requested \u2014 skipping"); return; }
            log("Creating: " + ws);
            try { fs.mkdirSync(ws, { recursive: true }); }
            catch (err) {
                log("Could not create " + ws + ": " + err.message);
                const fb = path.join(ctx.documentsDir, "Bhai Files");
                fs.mkdirSync(fb, { recursive: true });
                ctx.options.workspace = fb;
                const env = ctx.loadEnvDecrypted && ctx.loadEnvDecrypted();
                if (env) {
                    const updated = env.split("\n").map((l) => l.startsWith("BHAI_WORKSPACE=") ? "BHAI_WORKSPACE=" + fb : l).join("\n");
                    ctx.saveEnvEncrypted(updated);
                }
            }
        },
    }),

    finalize: () => ({
        id: "setup-state-finalize",
        label: "Finalize",
        idempotent: true,
        async run(ctx, log) {
            fs.writeFileSync(ctx.SETUP_FLAG, new Date().toISOString());
            const sp = path.join(ctx.DATA_DIR, "setup-state.json");
            let st = {};
            try { st = JSON.parse(fs.readFileSync(sp, "utf8")); } catch { /* fresh */ }
            st.__version = 2;
            st.__finalizedAt = new Date().toISOString();
            fs.writeFileSync(sp, JSON.stringify(st, null, 2));
            log("Setup complete \u2713");
        },
    }),
};

function buildPhaseList(state) {
    const s = state || { installed: {}, workspace: {} };
    const i = s.installed || {};
    const w = s.workspace || {};
    const out = [];
    if (!i.node) out.push(P.node());
    if (!i.playwright) out.push(P.playwright());
    if (!i.embeddingModel) out.push(P.embed());
    if (!i.sox) out.push(P.sox());

    // No optional vision-model phases: desktop control needs no local ML
    // download (accessibility tree + cloud grounding). The old Standard/Full
    // tiers installed OmniParser deps (~500 MB) and Ollama + UI-TARS (~4.5 GB).
    out.push(P.dataDir());
    if (w.path || !w.exists) out.push(P.workspace());
    out.push(P.finalize());
    return out;
}

module.exports = { buildPhaseList, ALL_PHASE_IDS };
