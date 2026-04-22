#!/usr/bin/env node
// Cross-platform replacement for patch-baileys.sh
// Patches Baileys 7.0.0-rc.9 to fix 405 connection failure

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BAILEYS = join(__dirname, "..", "node_modules", "@whiskeysockets", "baileys", "lib");

if (!existsSync(BAILEYS)) {
    console.log("[patch-baileys] Baileys not installed, skipping");
    process.exit(0);
}

console.log("[patch-baileys] Patching Baileys v7.0.0-rc.9...");

function patchFile(filePath, search, replace, label) {
    if (!existsSync(filePath)) return;
    let content = readFileSync(filePath, "utf-8");
    if (content.includes(search)) {
        content = content.split(search).join(replace);
        writeFileSync(filePath, content, "utf-8");
        console.log(`  ${label} patched`);
    } else {
        console.log(`  ${label} already patched`);
    }
}

// Patch 1: Fix hardcoded WhatsApp protocol version
patchFile(join(BAILEYS, "Defaults", "index.js"), "1027934701", "1034074495", "[1/4] Version (Defaults/index.js)");
patchFile(join(BAILEYS, "Utils", "generics.js"), "1027934701", "1034074495", "[1/4] Version (Utils/generics.js)");

// Patch 2: Fix passive:true -> passive:false
patchFile(join(BAILEYS, "Utils", "validate-connection.js"), "passive: true,", "passive: false,", "[2/4] Passive flag");

// Patch 3: Remove lidDbMigrated:false
const vcPath = join(BAILEYS, "Utils", "validate-connection.js");
if (existsSync(vcPath)) {
    let content = readFileSync(vcPath, "utf-8");
    if (content.includes("lidDbMigrated: false")) {
        content = content
            .split("\n")
            .filter(line => !line.includes("lidDbMigrated: false"))
            .join("\n")
            .replace(/device: device,\s*$/m, "device: device");
        writeFileSync(vcPath, content, "utf-8");
        console.log("  [3/4] lidDbMigrated removed");
    } else {
        console.log("  [3/4] lidDbMigrated already removed");
    }
}

// Patch 4: Remove await from noise.finishInit() race condition
patchFile(join(BAILEYS, "Socket", "socket.js"), "await noise.finishInit()", "noise.finishInit()", "[4/4] Noise race condition");

console.log("[patch-baileys] Done!");
