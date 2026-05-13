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

// Spawn the Ollama daemon detached. The bare binary name needs PATH
// augmentation — Electron's dock-launched PATH on Apple Silicon is
// /usr/bin:/bin only, which doesn't include /opt/homebrew/bin where the
// ollama binary lives. Without the env override the spawn ENOENTs silently
// (stdio: "ignore" eats the error) and the poll loop hits a dead daemon.
function spawnDaemonDetached(log) {
    const extraPaths = process.platform === "win32"
        ? []
        : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    const augmented = process.platform === "win32"
        ? (process.env.PATH || "")
        : [...new Set([...extraPaths, ...(process.env.PATH || "").split(":")])].join(":");
    require("child_process").spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: augmented },
    }).unref();
    if (log) log("Spawned `ollama serve` in background");
}

// Race an awaitable against a setTimeout-based abort. Used to prevent a single
// hanging subprocess from burning the full poll-budget wall-clock.
function raceWithTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
}

// Strip ANSI escape sequences (CSI cursor codes, color codes, mode switches).
// Ollama's `pull` progress UI emits cursor-control codes that pollute logs and
// hide the actual error text when a pull fails.
function stripAnsi(s) {
    if (s == null) return "";
    // Match: ESC [ ... <terminator>, ESC ] OSC sequences, and DEC private mode (?)
    return String(s).replace(/\[[?]?[0-9;]*[a-zA-Z]/g, "")
        .replace(/\][^]*/g, "")
        .replace(/\r/g, "");
}

// Persist the actually-pulled UI-TARS tag to .env.enc so the bot's runtime
// (src/screen/ui-tars.ts) uses the same tag at inference time. Otherwise the
// bot would hardcode `ui-tars:7b` even when the install pulled `:1.5-7b`.
function persistUiTarsTag(ctx, tag) {
    try {
        const env = (ctx.loadEnvDecrypted && ctx.loadEnvDecrypted()) || "";
        const lines = env.split("\n").filter((l) => !l.startsWith("ATLAS_UI_TARS_TAG="));
        lines.push("ATLAS_UI_TARS_TAG=" + tag);
        if (ctx.saveEnvEncrypted) ctx.saveEnvEncrypted(lines.filter(Boolean).join("\n"));
    } catch { /* best-effort */ }
}

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
                // Linux path. Refuse to blindly pipe a remote script into a shell \u2014
                // if ollama.com or DNS is compromised, that would run arbitrary code
                // as the user. Instead: download to a uniquely-named temp file
                // (cryptographically random suffix defeats symlink-prediction
                // attacks on shared /tmp), refuse pre-existing path, log full
                // SHA-256, then execute. The script does its own sudo.
                const crypto = require("crypto");
                const rand = crypto.randomBytes(12).toString("hex");
                const tmp = path.join(os.tmpdir(), `atlas_ollama_install_${rand}.sh`);
                // Atomically create the file with O_EXCL — fails if ANY fs entry
                // (file/symlink/dir) exists at the path. This collapses the TOCTOU
                // window: even if an attacker plants a symlink in the microsecond
                // between random generation and the open, openSync(... "wx") fails
                // on the symlink inode itself. Without this, curl -o would follow
                // a pre-planted symlink and truncate the target before our post-
                // download lstat check could fire.
                try {
                    const fd = fs.openSync(tmp, "wx", 0o600);
                    fs.closeSync(fd);
                } catch (e) {
                    throw new Error("Could not create temp file (possible symlink attack): " + e.message);
                }
                try {
                    log("Downloading install script to " + tmp + "...");
                    await ctx.runCommand("curl", ["-fsSL", "-o", tmp, "https://ollama.com/install.sh"], undefined, (l) => { if (l.trim()) log(l); });
                    // Defense-in-depth: confirm the path is still a regular file
                    // post-download. Should always pass given the O_EXCL above.
                    const lst = fs.lstatSync(tmp);
                    if (!lst.isFile()) {
                        throw new Error("Downloaded path is not a regular file: " + tmp);
                    }
                    // Audit trail: full SHA-256 so the user can paste-compare
                    // against any published reference. Size sanity check covers
                    // gross tampering (captive portal HTML, truncated download).
                    const hash = crypto.createHash("sha256").update(fs.readFileSync(tmp)).digest("hex");
                    log("Script size=" + lst.size + " bytes, sha256=" + hash);
                    if (lst.size < 1024 || lst.size > 64 * 1024) {
                        throw new Error("Install script size out of expected range (" + lst.size + " bytes)");
                    }
                    await ctx.runCommand("sh", [tmp], undefined, (l) => { if (l.trim()) log(l); });
                    log("Installed via install script \u2713");
                } catch (err) {
                    throw new Error("Install failed. Visit https://ollama.com/download/linux, then click Retry. (" + err.message + ")");
                } finally {
                    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
                }
            }
            // Start the daemon so the next phase (model pull) can talk to it.
            // `ollama list` alone DOES NOT auto-start the daemon on a fresh
            // brew install. Explicit service start is the canonical way; the
            // detached spawn is a last-resort fallback. The poll loop converges
            // regardless of which path succeeded.
            log("Waiting for runtime to start...");
            if (process.platform === "darwin") {
                try {
                    await ctx.runCommand("brew", ["services", "start", "ollama"], undefined, (l) => { if (l.trim()) log(l); });
                    log("Started runtime via brew services ✓");
                } catch {
                    try {
                        spawnDaemonDetached(log);
                        log("Started runtime via background spawn");
                    } catch { /* poll below will catch */ }
                }
            } else if (process.platform === "linux") {
                // Ollama install.sh registers a SYSTEM-level service; --user is the
                // wrong scope. Try system-level first (no-password sudo may be
                // configured by the install script); fall back to detached spawn.
                try {
                    await ctx.runCommand("systemctl", ["start", "ollama"], undefined, () => {});
                } catch {
                    try { spawnDaemonDetached(log); } catch { /* polled below */ }
                }
            }
            // Poll up to 15s for the daemon to be reachable. Wrap each attempt
            // in a 2-second timeout so a hung `ollama list` can't burn the whole
            // budget on one call (a partially-started daemon can accept TCP
            // connections but not respond — runCommand's 10-min default would
            // block the wall-clock deadline check otherwise).
            const deadline = Date.now() + 15000;
            let daemonUp = false;
            while (Date.now() < deadline) {
                try {
                    await raceWithTimeout(
                        ctx.runCommand("ollama", ["list"], undefined, () => {}),
                        2000,
                    );
                    daemonUp = true;
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 750));
                }
            }
            if (daemonUp) {
                log("Runtime is reachable ✓");
            } else {
                log("Warning: runtime installed but didn't come up within 15s — next phase may need a Retry");
            }
        },
    }),

    uiTarsModel: () => ({
        id: "ui-tars-model",
        label: "Vision model (~4.5 GB)",
        idempotent: true,
        async run(ctx, log) {
            // Ensure the daemon is reachable before attempting the pull.
            // The previous phase tries hard to start it, but cold-boot timing
            // is finicky \u2014 if `ollama list` fails here, give it another shot
            // by spawning the daemon ourselves + polling, then only fail if
            // it's truly unreachable.
            async function ensureDaemonOrThrow() {
                try {
                    await raceWithTimeout(ctx.runCommand("ollama", ["list"], undefined, () => {}), 2000);
                    return;
                } catch { /* daemon not yet reachable */ }
                log("Runtime not reachable \u2014 attempting to start it...");
                try {
                    if (process.platform === "darwin") {
                        try { await ctx.runCommand("brew", ["services", "start", "ollama"], undefined, () => {}); } catch { /* try spawn */ }
                    } else if (process.platform === "linux") {
                        try { await ctx.runCommand("systemctl", ["start", "ollama"], undefined, () => {}); } catch { /* try spawn */ }
                    }
                    spawnDaemonDetached(log);
                } catch { /* polling below decides */ }
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                    try {
                        await raceWithTimeout(ctx.runCommand("ollama", ["list"], undefined, () => {}), 2000);
                        log("Runtime is reachable \u2713");
                        return;
                    } catch {
                        await new Promise((r) => setTimeout(r, 750));
                    }
                }
                const hint = process.platform === "darwin"
                    ? "Run `brew services start ollama` or `ollama serve` manually"
                    : process.platform === "win32"
                        ? "Re-run the Ollama installer from https://ollama.com/download/windows"
                        : "Run `sudo systemctl start ollama` or `ollama serve` manually";
                throw new Error("Local model runtime did not come up within 15s. " + hint + ", then click Retry.");
            }

            await ensureDaemonOrThrow();

            // Candidate tags in priority order.
            // (1) Common community Ollama Modelfile uploads — these wrap the
            //     HF safetensors as Ollama-native GGUF models. Most reliable
            //     because they're already in the Ollama public registry.
            // (2) `hf.co/<repo>` direct fetch — Ollama 0.4+ can pull any HF
            //     model directly. The official ByteDance-Seed/UI-TARS-1.5-7B
            //     is safetensors (no GGUF), so this only works if Ollama can
            //     auto-convert (it can for many qwen2_5_vl-class models).
            // (3) Bare `ui-tars:*` — kept for forward-compat if Ollama ever
            //     publishes an official tag.
            const CANDIDATES = [
                "ui-tars:1.5-7b",
                "ui-tars:7b",
                "hf.co/ByteDance-Seed/UI-TARS-1.5-7B",
            ];

            // Check if ANY candidate is already pulled + manifest-valid.
            let alreadyHave = null;
            try {
                let listOutput = "";
                await ctx.runCommand("ollama", ["list"], undefined, (l) => { listOutput += l; });
                for (const tag of CANDIDATES) {
                    // Escape `:` for regex use, anchored by word boundaries.
                    const re = new RegExp("\\b" + tag.replace(/[.:]/g, "\\$&") + "\\b");
                    if (re.test(listOutput)) {
                        try {
                            await ctx.runCommand("ollama", ["show", tag], undefined, () => {});
                            alreadyHave = tag;
                            break;
                        } catch { /* manifest corrupt \u2014 fall through */ }
                    }
                }
            } catch {
                throw new Error("Local model runtime stopped responding mid-phase. Click Retry.");
            }
            if (alreadyHave) {
                log("Vision model already pulled (" + alreadyHave + ") \u2713");
                persistUiTarsTag(ctx, alreadyHave);
                return;
            }

            log("Pulling vision model \u2014 this can take 5-15 minutes depending on connection...");
            let pulled = null;
            const errors = [];
            for (const tag of CANDIDATES) {
                try {
                    await ctx.runCommand("ollama", ["pull", tag], undefined, (l) => {
                        if (l.trim()) log(stripAnsi(l));
                    });
                    pulled = tag;
                    break;
                } catch (err) {
                    // Strip ANSI before storing \u2014 ollama emits cursor-control
                    // codes that mask the actual reason for failure.
                    const clean = stripAnsi(err && err.message ? err.message : String(err));
                    errors.push(tag + ": " + clean.slice(0, 200));
                    log("Tag " + tag + " not available \u2014 trying next...");
                }
            }
            if (!pulled) {
                // Soft-fail: the bot's perception cascade already falls back
                // to OmniParser (Standard tier) and cloud-VLM when UI-TARS is
                // missing. Stranding the entire install on a model that isn't
                // strictly necessary makes for a worse user experience than
                // letting them finish setup and install the model later.
                log("");
                log("\u26a0\ufe0f  Could not pull vision model from Ollama's public registry.");
                log("   UI-TARS is the Full-tier OPTIONAL grounding model \u2014 A.T.L.A.S");
                log("   still works without it (uses cloud vision-LLM as fallback).");
                log("");
                log("   To enable it later, run ONE of these manually in Terminal:");
                for (const t of CANDIDATES) log("     ollama pull " + t);
                log("");
                log("   Or import the model from Hugging Face directly:");
                log("     https://huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B");
                log("");
                log("Continuing without vision model \u2014 install will finish normally.");
                // Return without throwing \u2192 phase marked completed \u2192 install
                // pipeline advances to data-dir / finalize.
                return;
            }
            log("Vision model ready (" + pulled + ") \u2713");
            persistUiTarsTag(ctx, pulled);
        },
    }),

    omniparserDeps: () => ({
        id: "omniparser-deps",
        label: "Vision deps (~500 MB)",
        idempotent: true,
        async run(ctx, log) {
            // Probe system Python first \u2014 we need it to build the venv.
            const sysPy = process.platform === "win32" ? "python" : "python3";
            try {
                await ctx.runCommand(sysPy, ["--version"], undefined, () => {});
            } catch {
                throw new Error("Python is not installed. On macOS: `brew install python`. Then click Retry.");
            }
            // Build paths to the dedicated venv. We can't use `pip install --user`
            // anymore: modern Homebrew Python (3.11+) ships PEP 668's
            // EXTERNALLY-MANAGED marker and refuses system-level installs. A
            // dedicated venv is the canonical fix \u2014 and lets us pin a known
            // python interpreter for the bot regardless of the user's PATH.
            const venvDir = path.join(ctx.DATA_DIR, "python-venv");
            const venvPy = process.platform === "win32"
                ? path.join(venvDir, "Scripts", "python.exe")
                : path.join(venvDir, "bin", "python");
            // Check if the venv already has the deps importable.
            if (fs.existsSync(venvPy)) {
                try {
                    await ctx.runCommand(venvPy, ["-c", "import ultralytics, PIL"], undefined, () => {});
                    log("Vision deps already installed in venv \u2713");
                    return;
                } catch { /* venv exists but deps missing \u2014 proceed to install */ }
            } else {
                log("Creating Python virtual environment...");
                try {
                    await ctx.runCommand(sysPy, ["-m", "venv", venvDir], undefined, (l) => { if (l.trim()) log(l); });
                } catch (err) {
                    throw new Error("Could not create venv at " + venvDir + ". Ensure `python3 -m venv` works, then click Retry. (" + err.message + ")");
                }
            }
            log("Installing vision deps into venv (~500 MB)...");
            try {
                // Use the venv's python directly \u2014 PEP 668 doesn't apply inside
                // a venv. `--quiet` keeps the install log readable.
                await ctx.runCommand(venvPy, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], undefined, () => {});
                await ctx.runCommand(venvPy, ["-m", "pip", "install", "--quiet", "ultralytics", "Pillow"], undefined, (l) => {
                    if (l.trim()) log(l);
                });
                log("Vision deps installed \u2713");
            } catch (err) {
                throw new Error("pip install failed. Retry, or run manually: `" + venvPy + " -m pip install ultralytics Pillow`. (" + err.message + ")");
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
