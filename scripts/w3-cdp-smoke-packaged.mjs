// W3 packaged-.app smoke. Spawns /Applications/A.T.L.A.S.app's Electron
// binary with --remote-debugging-port + an isolated user-data-dir so the
// SETUP_FLAG check fails and the wizard window opens. Then attaches via
// Playwright CDP and exercises:
//   1. atlas.detectMagicMoment() IPC handler reachable + returns names[]
//   2. The packaged ready-hub.html loads MagicMoment + MagicMomentRanker
//   3. mount() paints W1 fallback then swaps in the ranker's rich signal
//
// Run via:
//   node scripts/w3-cdp-smoke-packaged.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_BIN  = "/Applications/A.T.L.A.S.app/Contents/MacOS/A.T.L.A.S";
const USER_DATA = "/tmp/atlas-cdp-w3-packaged";
const CDP_PORT  = 9224;

function log(...args) { console.log("[w3-packaged]", ...args); }

async function main() {
    try { rmSync(USER_DATA, { recursive: true, force: true }); } catch {}

    log("spawning packaged .app with user-data-dir=" + USER_DATA + " port=" + CDP_PORT);
    const proc = spawn(
        APP_BIN,
        [
            "--user-data-dir=" + USER_DATA,
            "--remote-debugging-port=" + CDP_PORT,
            "--no-sandbox",
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ELECTRON_ENABLE_LOGGING: "1",
            },
        },
    );

    const stdoutBuf = []; const stderrBuf = [];
    proc.stdout.on("data", b => stdoutBuf.push(b.toString()));
    proc.stderr.on("data", b => stderrBuf.push(b.toString()));
    let exited = false;
    proc.on("exit", (code) => { exited = true; log("electron exited code=" + code); });

    let browser = null;
    let result = { ok: false };
    try {
        await sleep(6000); // packaged app boots slower than dev
        if (exited) throw new Error("electron exited before CDP came up. stderr tail:\n" + stderrBuf.join("").slice(-1500));

        log("connecting Playwright over CDP");
        browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
        const ctx = browser.contexts()[0];
        if (!ctx) throw new Error("no browser context");
        const pages = ctx.pages();
        log("pages:", pages.map(p => p.url()).join(" | "));
        const wizard = pages.find(p => /wizard\.html/.test(p.url()))
            || pages.find(p => !/devtools/.test(p.url()));
        if (!wizard) throw new Error("no wizard page");

        // Navigate to ready-hub.html (packaged absolute path inside asar).
        const readyHubUrl = wizard.url().replace(/wizard\.html.*$/, "ready-hub.html");
        log("navigating to:", readyHubUrl);
        const consoleLines = [];
        wizard.on("console", m => consoleLines.push("[" + m.type() + "] " + m.text()));
        wizard.on("pageerror", e => consoleLines.push("[pageerror] " + e.message));
        await wizard.goto(readyHubUrl, { waitUntil: "domcontentloaded", timeout: 8000 });

        const phase1 = await wizard.evaluate(() => {
            const checks = {
                MagicMoment: typeof window.MagicMoment,
                MagicMomentRanker: typeof window.MagicMomentRanker,
                atlas: typeof window.atlas,
                detectMagicMoment: typeof (window.atlas && window.atlas.detectMagicMoment),
            };
            const host = document.createElement("div");
            host.id = "w3-host";
            host.style.padding = "20px";
            document.body.appendChild(host);
            const state = {
                profile: { name: "W3 Packaged", persona: "developer" },
                hourOfDay: "morning",
                monitorCount: 1,
            };
            window.__w3_host = host;
            window.__w3_state = state;
            const handle = window.MagicMoment.mount(host, state);
            const obs    = host.querySelector(".magic-obs");
            const follow = host.querySelector(".magic-follow");
            return {
                checks,
                hasNoteClass: host.classList.contains("magic-note"),
                fallbackObs: obs && obs.textContent,
                fallbackFollow: follow && follow.textContent,
            };
        });
        log("phase 1:", JSON.stringify(phase1));

        if (phase1.checks.MagicMoment !== "object" && phase1.checks.MagicMoment !== "function") {
            throw new Error("MagicMoment global missing in packaged build");
        }
        if (phase1.checks.MagicMomentRanker !== "object" && phase1.checks.MagicMomentRanker !== "function") {
            throw new Error("MagicMomentRanker global missing in packaged build");
        }
        if (phase1.checks.detectMagicMoment !== "function") {
            throw new Error("atlas.detectMagicMoment IPC bridge not exposed in packaged build");
        }
        if (!phase1.hasNoteClass) throw new Error("magic-note class not applied");
        if (!phase1.fallbackObs) throw new Error("fallback observation empty");

        await sleep(3500);
        const phase2 = await wizard.evaluate(() => {
            const host = window.__w3_host;
            const obs    = host.querySelector(".magic-obs");
            const follow = host.querySelector(".magic-follow");
            return {
                richObs: obs && obs.textContent,
                richFollow: follow && follow.textContent,
            };
        });
        log("phase 2:", JSON.stringify(phase2));

        const snapshot = await wizard.evaluate(async () => {
            try { return await window.atlas.detectMagicMoment(); }
            catch (e) { return { error: String(e && e.message || e) }; }
        });
        log("direct IPC snapshot:", JSON.stringify({
            names_count: Array.isArray(snapshot.names) ? snapshot.names.length : null,
            platform: snapshot.platform,
            sample: Array.isArray(snapshot.names) ? snapshot.names.slice(0, 6) : null,
            error: snapshot.error,
        }));
        if (snapshot.error) throw new Error("detectMagicMoment failed in packaged build: " + snapshot.error);
        if (!Array.isArray(snapshot.names)) throw new Error("snapshot.names is not an array");

        result = {
            ok: true,
            phase1: {
                hasNoteClass: phase1.hasNoteClass,
                fallbackFollow: phase1.fallbackFollow,
            },
            phase2,
            snapshot: {
                names_count: snapshot.names.length,
                platform: snapshot.platform,
                first_names: snapshot.names.slice(0, 5),
            },
            consoleErrorsTail: consoleLines.filter(l => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(-3),
        };
    } catch (err) {
        result = {
            ok: false,
            error: String(err && err.message || err),
            stderrTail: stderrBuf.join("").slice(-2000),
        };
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
        proc.kill("SIGTERM");
        await sleep(800);
        if (!exited) proc.kill("SIGKILL");
    }
    log("RESULT:", JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
