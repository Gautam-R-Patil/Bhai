// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Background provisioner for the OmniParser tier — venv + python deps +
 * icon_detect weights. Mirrors ensureUITarsForFullTier (ui-tars.ts): boot-time,
 * non-blocking, opt-in (heavy ~500MB deps), detached so it survives the parent
 * exiting. The dep/repo args MUST match the installer's omniparserDeps phase
 * (desktop/installer/phases.js) — keep them in sync.
 */

import { join } from "node:path";
import { getDataDir } from "../config/paths.js";
import { omniParserDepsPresent, omniParserWeightsPresent } from "./omniparser.js";
import { spawnDetachedLogged } from "./spawn-detached.js";

function venvPython(): string {
    const dataDir = getDataDir();
    return process.platform === "win32"
        ? join(dataDir, "python-venv", "Scripts", "python.exe")
        : join(dataDir, "python-venv", "bin", "python");
}

/**
 * Ensure the OmniParser tier is usable on Standard/Full boxes. Warns (with
 * manual steps) by default; only auto-provisions when ATLAS_OMNIPARSER_AUTOSETUP
 * is opted in (heavy download). Called once at boot, non-blocking.
 */
export async function ensureOmniParser(profile: string): Promise<void> {
    if (profile !== "standard" && profile !== "full") return;
    if (process.env.ATLAS_NO_OMNIPARSER === "true") return;

    const depsOk = await omniParserDepsPresent().catch(() => false);
    const weightsOk = omniParserWeightsPresent();
    if (depsOk && weightsOk) return; // healthy

    if (process.env.ATLAS_OMNIPARSER_AUTOSETUP !== "true") {
        console.warn(
            `⚠️  [vision-nav] OmniParser tier unavailable (deps:${depsOk} weights:${weightsOk}). ` +
            `It improves visual click grounding on ${profile} tier. To enable: set ATLAS_OMNIPARSER_AUTOSETUP=true ` +
            `(auto-provisions ~500MB next boot), or install manually: \`pip install ultralytics Pillow huggingface_hub\` ` +
            `+ download microsoft/OmniParser-v2.0 icon_detect weights to ~/.cache/omniparser/icon_detect.pt.`,
        );
        return;
    }

    // Detached provisioner: venv (if missing) → deps → weights. Same args as the
    // installer's omniparserDeps phase. `python3 -m venv` is a no-op if present.
    const dataDir = getDataDir();
    const venvDir = join(dataDir, "python-venv");
    const sysPy = process.platform === "win32" ? "python" : "python3";

    // One shell pipeline so the detached process runs the full sequence. Bash on
    // POSIX; on Windows fall back to a plain spawn of python (venv assumed) since
    // the chained form needs a shell.
    const dl =
        "import os,shutil;from huggingface_hub import hf_hub_download;" +
        "d=os.path.expanduser('~/.cache/omniparser');os.makedirs(d,exist_ok=True);" +
        "p=hf_hub_download(repo_id='microsoft/OmniParser-v2.0',filename='icon_detect/model.pt');" +
        "shutil.copy(p,os.path.join(d,'icon_detect.pt'));print('weights OK')";

    if (process.platform !== "win32") {
        const script = [
            `"${sysPy}" -m venv "${venvDir}" 2>/dev/null || true`,
            `"${venvPython()}" -m pip install --quiet --upgrade pip`,
            `"${venvPython()}" -m pip install --quiet ultralytics Pillow huggingface_hub`,
            `"${venvPython()}" -c '${dl}'`,
        ].join(" && ");
        const r = spawnDetachedLogged("omniparser-setup", "bash", ["-lc", script]);
        logProvisionResult(r);
    } else {
        // Windows: full sequence via PowerShell (creates venv if missing, installs
        // deps, downloads weights) — mirrors the POSIX bash path. `;` chains;
        // `2>$null` swallows the venv no-op error when it already exists.
        const vp = venvPython();
        const psScript = [
            `& '${sysPy}' -m venv '${venvDir}' 2>$null`,
            `& '${vp}' -m pip install --quiet --upgrade pip`,
            `& '${vp}' -m pip install --quiet ultralytics Pillow huggingface_hub`,
            `& '${vp}' -c "${dl.replace(/"/g, '\\"')}"`,
        ].join("; ");
        const r = spawnDetachedLogged("omniparser-setup", "powershell", ["-NoProfile", "-Command", psScript]);
        logProvisionResult(r);
    }
}

function logProvisionResult(r: "started" | "locked" | "error"): void {
    if (r === "started") {
        console.log(`🔧 [vision-nav] Provisioning OmniParser in background (deps + weights, ~500MB, detached). Tier activates once complete.`);
    } else if (r === "locked") {
        console.log(`🔧 [vision-nav] OmniParser provisioning already in progress.`);
    } else {
        console.warn(`⚠️  [vision-nav] Could not start OmniParser auto-setup.`);
    }
}
