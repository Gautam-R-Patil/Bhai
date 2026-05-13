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

const ALL_PHASE_IDS = [
    "node",
    "playwright-chromium",
    "embedding-model",
    "sox",
    "ollama",
    "ui-tars-model",
    "omniparser-deps",
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

    // \u2500\u2500 Optional vision-nav ML deps (added conditionally based on user's tier choice) \u2500\u2500

    ollama: () => ({
        id: "ollama",
        label: "Local model runtime",
        idempotent: true,
        async run(ctx, log) {
            // Check first \u2014 runtime may already be installed by hand.
            try {
                await ctx.runCommand("ollama", ["--version"], undefined, () => {});
                log("Local model runtime already installed \u2713");
                return;
            } catch { /* not installed */ }
            log("Installing local model runtime (~140 MB)...");
            if (process.platform === "darwin") {
                try {
                    await ctx.runCommand("brew", ["install", "ollama"], undefined, (l) => { if (l.trim()) log(l); });
                    log("Installed via Homebrew \u2713");
                } catch (err) {
                    throw new Error("Install failed. Run `brew install ollama` manually, then click Retry. (" + err.message + ")");
                }
            } else if (process.platform === "win32") {
                try {
                    await ctx.runCommand("winget", ["install", "--id", "Ollama.Ollama", "-e", "--silent"], undefined, (l) => { if (l.trim()) log(l); });
                    log("Installed via winget \u2713");
                } catch (err) {
                    throw new Error("Install failed. Download from https://ollama.com/download/windows, then click Retry. (" + err.message + ")");
                }
            } else {
                try {
                    await ctx.runCommand("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], undefined, (l) => { if (l.trim()) log(l); });
                    log("Installed via install script \u2713");
                } catch (err) {
                    throw new Error("Install failed. Visit https://ollama.com/download/linux, then click Retry. (" + err.message + ")");
                }
            }
            // Start the service so the next phase (model pull) can talk to it.
            try {
                if (process.platform === "darwin" || process.platform === "linux") {
                    await ctx.runCommand("ollama", ["list"], undefined, () => {});
                }
            } catch { /* startup probe is best-effort */ }
        },
    }),

    uiTarsModel: () => ({
        id: "ui-tars-model",
        label: "Vision model (~4.5 GB)",
        idempotent: true,
        async run(ctx, log) {
            // Check if model already pulled \u2014 `ollama list` lists installed models.
            try {
                let listOutput = "";
                await ctx.runCommand("ollama", ["list"], undefined, (l) => { listOutput += l; });
                if (listOutput.includes("ui-tars")) {
                    log("Vision model already pulled \u2713");
                    return;
                }
            } catch {
                throw new Error("Local model runtime is not running or not installed. Install it first, then click Retry.");
            }
            log("Pulling vision model \u2014 this can take 5-15 minutes depending on connection...");
            try {
                await ctx.runCommand("ollama", ["pull", "ui-tars:7b"], undefined, (l) => {
                    if (l.trim()) log(l);
                });
                log("Vision model ready \u2713");
            } catch (err) {
                throw new Error("Model pull failed. You can retry, or pull manually with `ollama pull ui-tars:7b`. (" + err.message + ")");
            }
        },
    }),

    omniparserDeps: () => ({
        id: "omniparser-deps",
        label: "Vision deps (~500 MB)",
        idempotent: true,
        async run(ctx, log) {
            // Probe Python first
            const py = process.platform === "win32" ? "python" : "python3";
            try {
                await ctx.runCommand(py, ["--version"], undefined, () => {});
            } catch {
                throw new Error("Python is not installed. On macOS: `brew install python`. Then click Retry.");
            }
            // Check if vision deps are already importable (fast probe \u2014 failure means we install)
            let needsInstall = false;
            try {
                await ctx.runCommand(py, ["-c", "import ultralytics, PIL"], undefined, () => {});
                log("Vision deps already importable \u2713");
            } catch {
                needsInstall = true;
            }
            if (!needsInstall) return;
            log("Installing vision deps (~500 MB)...");
            try {
                await ctx.runCommand(py, ["-m", "pip", "install", "--user", "--quiet", "ultralytics", "Pillow"], undefined, (l) => {
                    if (l.trim()) log(l);
                });
                log("Vision deps installed \u2713");
            } catch (err) {
                throw new Error("pip install failed. You can retry, or install manually: `pip install ultralytics Pillow`. (" + err.message + ")");
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
    const tier = s.visionTierChoice || "lite";
    const deps = s.visionDeps || {};
    const out = [];
    if (!i.node) out.push(P.node());
    if (!i.playwright) out.push(P.playwright());
    if (!i.embeddingModel) out.push(P.embed());
    if (!i.sox) out.push(P.sox());

    // ── Vision-nav optional deps — gated by user's tier choice ──
    // Standard tier: OmniParser Python deps (~500 MB)
    // Full tier: Ollama + UI-TARS-7B model (~4.5 GB) + OmniParser deps too
    // Each phase is idempotent and self-checks so re-running is safe.
    if (tier === "standard" || tier === "full") {
        if (!deps.omniparser) out.push(P.omniparserDeps());
    }
    if (tier === "full") {
        if (!deps.ollama) out.push(P.ollama());
        if (!deps.uiTarsModel) out.push(P.uiTarsModel());
    }

    out.push(P.dataDir());
    if (w.path || !w.exists) out.push(P.workspace());
    out.push(P.finalize());
    return out;
}

module.exports = { buildPhaseList, ALL_PHASE_IDS };
