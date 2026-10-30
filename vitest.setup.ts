// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Tests never touch the real home folder. Modules build paths from os.homedir()
// (~/.atlas/data, ~/.atlas/store, the Chrome bridge's discovery and token files),
// and those are the files the owner's running Bhai is using: the suite wrote into
// them (tool analytics, forge telemetry) and stopped the live bot mid-run. Each test
// file gets its own empty home. Playwright's browsers stay where they are installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realHome = os.homedir();
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const cache =
        process.platform === "darwin"
            ? path.join(realHome, "Library", "Caches", "ms-playwright")
            : process.platform === "win32"
              ? path.join(process.env.LOCALAPPDATA ?? path.join(realHome, "AppData", "Local"), "ms-playwright")
              : path.join(realHome, ".cache", "ms-playwright");
    if (fs.existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
