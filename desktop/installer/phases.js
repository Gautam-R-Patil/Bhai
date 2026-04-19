// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Declarative install phase list. Each phase is `{id, label, run(ctx, log), idempotent}`.
// `run()` receives a ctx with: BOT_DIR, DATA_DIR, SETUP_FLAG, runCommand, checkNodeInstalled,
// downloadAndInstallNode, loadEnvDecrypted, saveEnvEncrypted, documentsDir, options, sendProgress.
// All file-system touching helpers are injected so we can unit-test the module without
// Electron / without a real install.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const ALL_PHASE_IDS = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];

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
            const cli = path.join(ctx.BOT_DIR, "node_modules", "playwright", "cli.js");
            await ctx.runCommand("node", [cli, "install", "chromium"], ctx.BOT_DIR, (l) => { if (l.trim()) log(l); });
        },
    }),

    embed: () => ({
        id: "embedding-model",
        label: "AI embedding model",
        idempotent: true,
        async run(ctx, log) {
            log("Pre-warming Xenova/all-MiniLM-L6-v2 (quantized)...");
            const script = path.join(os.tmpdir(), "_atlas_warmup.mjs");
            fs.writeFileSync(script, 'import("@xenova/transformers").then(t=>t.pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{quantized:true})).then(()=>console.log("done")).catch(e=>console.error(e));');
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
                    try {
                        await ctx.runCommand("choco", ["install", "sox", "-y"], undefined, (l) => { if (l.trim()) log(l); });
                    } catch {
                        log("sox not found \u2014 https://sox.sourceforge.net");
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
            log("Setting up data directory...");
            fs.mkdirSync(ctx.DATA_DIR, { recursive: true });
            const del = ["memory.db", "memory.db-shm", "memory.db-wal", "memory.hnsw.json", "audit.jsonl", "browser-strategies.json", "task-learnings.json"];
            const clear = ["browser-profile", "google-tokens", "research", "long-tasks", "process-logs"];
            for (const f of del) {
                try { fs.unlinkSync(path.join(ctx.DATA_DIR, f)); } catch { /* ignore missing */ }
            }
            for (const d of clear) {
                try { fs.rmSync(path.join(ctx.DATA_DIR, d), { recursive: true, force: true }); } catch { /* ignore */ }
                fs.mkdirSync(path.join(ctx.DATA_DIR, d), { recursive: true });
            }
            const bundled = path.join(ctx.BOT_DIR, "data", "google-credentials.json");
            if (fs.existsSync(bundled)) {
                fs.copyFileSync(bundled, path.join(ctx.DATA_DIR, "google-credentials.json"));
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
                const fb = path.join(ctx.documentsDir, "A.T.L.A.S Files");
                fs.mkdirSync(fb, { recursive: true });
                ctx.options.workspace = fb;
                const env = ctx.loadEnvDecrypted && ctx.loadEnvDecrypted();
                if (env) {
                    const updated = env.split("\n").map((l) => l.startsWith("ATLAS_WORKSPACE=") ? "ATLAS_WORKSPACE=" + fb : l).join("\n");
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
    out.push(P.dataDir());
    // workspace runs if a path was requested OR the default workspace dir is missing
    if (w.path || !w.exists) out.push(P.workspace());
    out.push(P.finalize());
    return out;
}

module.exports = { buildPhaseList, ALL_PHASE_IDS };
