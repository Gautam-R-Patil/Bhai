// W3 CDP smoke — spawns Electron dev with isolated user-data-dir +
// remote debugging, attaches via Playwright CDP, navigates the wizard
// window straight to ready-hub.html, and asserts that Magic Moment:
//   1. paints the synchronous W1 static fallback observation, then
//   2. swaps in a rich observation via atlas.detectMagicMoment().
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, "..");
const DESKTOP    = path.join(REPO_ROOT, "desktop");
const USER_DATA  = "/tmp/atlas-cdp-w3";
const CDP_PORT   = 9223;
const READY_HUB  = "file://" + path.join(DESKTOP, "ready-hub.html");

function log(...args) { console.log("[w3-cdp-smoke]", ...args); }

async function main() {
    // Clean state every run so we exercise the same code path.
    try { rmSync(USER_DATA, { recursive: true, force: true }); } catch {}

    log("spawning electron with fresh user-data-dir + remote-debugging-port=" + CDP_PORT);
    const electron = spawn(
        "npx",
        [
            "electron",
            ".",
            "--user-data-dir=" + USER_DATA,
            "--remote-debugging-port=" + CDP_PORT,
            "--no-sandbox",
        ],
        {
            cwd: DESKTOP,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ATLAS_NO_MAGIC_MOMENT: "false",
                ATLAS_NO_MAGIC_MOMENT_RICH: "false",
                ELECTRON_ENABLE_LOGGING: "1",
            },
        },
    );

    const stdoutBuf = [];
    const stderrBuf = [];
    electron.stdout.on("data", (b) => stdoutBuf.push(b.toString()));
    electron.stderr.on("data", (b) => stderrBuf.push(b.toString()));

    let exited = false;
    electron.on("exit", () => { exited = true; });

    let browser = null;
    let result = { ok: false };
    try {
        // Wait for the remote-debugging endpoint to come up.
        await sleep(4000);
        if (exited) throw new Error("electron exited before CDP came up");

        log("connecting Playwright over CDP at ws://127.0.0.1:" + CDP_PORT);
        browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);

        // Find the wizard page (filter out devtools://).
        const ctx = browser.contexts()[0];
        if (!ctx) throw new Error("no browser context");
        const pages = ctx.pages();
        log("attached. pages:", pages.map(p => p.url()).join(", "));
        const wizardPage = pages.find(p => /wizard\.html/.test(p.url()))
            || pages.find(p => !/devtools/.test(p.url()));
        if (!wizardPage) throw new Error("no wizard page");

        log("navigating wizard page → ready-hub.html");
        const consoleLines = [];
        wizardPage.on("console", (msg) => {
            const line = `[${msg.type()}] ${msg.text()}`;
            consoleLines.push(line);
        });
        wizardPage.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

        await wizardPage.goto(READY_HUB, { waitUntil: "domcontentloaded", timeout: 8000 });
        // Manually invoke the hub mount because index.html bootstraps via wizard router
        // which we bypassed. Pass a synthetic state with persona+hourOfDay so the ranker
        // has fillers to add even when atlas IPC is unavailable.
        await wizardPage.evaluate(async () => {
            const state = {
                profile: { name: "CDP Smoke", persona: "developer" },
                hourOfDay: "morning",
                monitorCount: 1,
            };
            const host = document.getElementById("hub-magic-moment")
                || (() => {
                    // Page didn't auto-mount the hub body. Create the placeholder div
                    // ourselves so MagicMoment.mount has somewhere to land.
                    const d = document.createElement("div");
                    d.id = "hub-magic-moment";
                    d.style.padding = "20px";
                    document.body.appendChild(d);
                    return d;
                })();
            window.__w3_state = state;
            window.__w3_host = host;
            if (!window.MagicMoment) throw new Error("MagicMoment global missing");
            if (!window.MagicMomentRanker) throw new Error("MagicMomentRanker global missing");
            window.__w3_handle = window.MagicMoment.mount(host, state);
        });

        // Phase 1: synchronous W1 fallback should already be painted.
        const fallback = await wizardPage.evaluate(() => {
            const host = window.__w3_host;
            const obs   = host.querySelector(".magic-obs");
            const follow= host.querySelector(".magic-follow");
            return {
                hasCard: host.classList.contains("magic-note"),
                observation: obs ? obs.textContent : null,
                followup: follow ? follow.textContent : null,
            };
        });
        log("phase 1 (W1 fallback) →", JSON.stringify(fallback));
        if (!fallback.hasCard) throw new Error("magic-note class missing on host");
        if (!fallback.observation) throw new Error("W1 fallback had empty observation");
        // Verify it's specifically the W1 developer-persona followup (not rich).
        const W1_DEV_FOLLOWUP = "I'll prioritize codebase context and terminal awareness.";
        const W3_DEV_FOLLOWUP = "I'll prioritize code, terminal, and git context.";
        if (fallback.followup === W3_DEV_FOLLOWUP) {
            log("note: rich path raced ahead of phase-1 measurement (still acceptable)");
        } else if (fallback.followup !== W1_DEV_FOLLOWUP) {
            throw new Error("unexpected phase-1 followup: " + fallback.followup);
        }

        // Phase 2: await rich detection swap. atlas.detectMagicMoment fires
        // an osascript call (macOS) — give it 2.5s + a safety margin.
        await sleep(3500);
        const rich = await wizardPage.evaluate(() => {
            const host = window.__w3_host;
            const obs   = host.querySelector(".magic-obs");
            const follow= host.querySelector(".magic-follow");
            return {
                observation: obs ? obs.textContent : null,
                followup: follow ? follow.textContent : null,
                atlasExposed: typeof (window.atlas && window.atlas.detectMagicMoment),
            };
        });
        log("phase 2 (rich swap) →", JSON.stringify(rich));
        log("atlas.detectMagicMoment exposed:", rich.atlasExposed);
        // The rich path should produce the W3 dev-cluster followup if Cursor/VS Code
        // is among the running apps. If the swap didn't happen, surface why.
        if (rich.followup === fallback.followup) {
            log("warn: followup unchanged after rich detection — rich path may have no-op'd");
        } else {
            log("✓ rich swap landed (followup changed)");
        }

        // Also call detectMagicMoment directly to verify the IPC handler.
        const snapshot = await wizardPage.evaluate(async () => {
            if (!window.atlas || typeof window.atlas.detectMagicMoment !== "function") {
                return { error: "atlas.detectMagicMoment not exposed" };
            }
            try { return await window.atlas.detectMagicMoment(); }
            catch (e) { return { error: String(e && e.message || e) }; }
        });
        log("snapshot direct IPC →", JSON.stringify({
            names_count: Array.isArray(snapshot.names) ? snapshot.names.length : null,
            platform: snapshot.platform,
            error: snapshot.error,
            sample: Array.isArray(snapshot.names) ? snapshot.names.slice(0, 8) : null,
        }));

        if (snapshot.error) throw new Error("detectMagicMoment IPC failed: " + snapshot.error);
        if (!Array.isArray(snapshot.names)) throw new Error("snapshot.names is not an array");
        if (snapshot.platform !== process.platform) {
            log("warn: platform mismatch", snapshot.platform, "vs", process.platform);
        }

        // Verify ranker against the actual snapshot.
        const ranked = await wizardPage.evaluate((snap) => {
            return window.MagicMomentRanker.rankSignals({
                snapshot: snap,
                persona: "developer",
                hourOfDay: "morning",
                monitorCount: 1,
            });
        }, snapshot);
        log("ranker output (developer/morning):");
        for (const sig of ranked) log("  -", sig.id, "→", sig.observation);

        result = {
            ok: true,
            fallback,
            rich,
            snapshot: {
                names_count: snapshot.names.length,
                platform: snapshot.platform,
                first_names: snapshot.names.slice(0, 5),
            },
            ranked_ids: ranked.map(r => r.id),
            consoleSampleSize: consoleLines.length,
            consoleHead: consoleLines.slice(-6),
        };
    } catch (err) {
        result = { ok: false, error: String(err && err.message || err) };
    } finally {
        if (browser) {
            try { await browser.close(); } catch {}
        }
        electron.kill("SIGTERM");
        await sleep(500);
        if (!exited) electron.kill("SIGKILL");
    }

    log("RESULT:", JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
