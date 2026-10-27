#!/usr/bin/env node
// Windows dependency checker — run before npm run dev on Windows
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

if (process.platform !== "win32") process.exit(0);

const exec = promisify(execFile);
const missing = [];

async function check(name, cmd, args, installHint) {
    try {
        await exec(cmd, args, { timeout: 5000 });
        console.log(`  ✓ ${name}`);
    } catch {
        console.log(`  ✗ ${name} — install: ${installHint}`);
        missing.push(name);
    }
}

console.log("[check-deps] Checking Windows dependencies...");

await check("Git Bash", "git", ["--version"], "https://git-scm.com/download/win");
await check("Node.js 20+", "node", ["--version"], "https://nodejs.org");
await check("ffmpeg", "ffmpeg", ["-version"], "winget install Gyan.FFmpeg  OR  choco install ffmpeg");
await check("Python 3", "python", ["--version"], "https://www.python.org/downloads/windows/");

if (missing.length > 0) {
    console.log(`\n⚠️  Missing: ${missing.join(", ")}. Some Bhai features may not work.`);
} else {
    console.log("\n✓ All dependencies found.");
}
