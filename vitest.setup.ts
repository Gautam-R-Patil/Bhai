// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Tests never touch the real home folder. Modules build paths from os.homedir()
// (~/.bhai/data, ~/.bhai/store, the Chrome bridge's discovery and token files),
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
// An explicit state root (the desktop app's dev shell sets one) would point getBhaiHome() back at the real one.
delete process.env.BHAI_HOME;
delete process.env.ATLAS_HOME;
// Bhai's data dir too: unset, it falls back to ./data in the repo, so a test that saves
// state (proactive-daily.json, cron jobs…) wrote into the working tree and leaked into
// the next run. A test file that sets its own BHAI_DATA_DIR still wins.
if (!process.env.BHAI_DATA_DIR) process.env.BHAI_DATA_DIR = path.join(home, "data");
