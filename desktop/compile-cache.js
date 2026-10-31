// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Node keeps its V8 compile cache (NODE_COMPILE_CACHE) in one folder per
// Node version, arch and flags: v24.19.0-arm64-bfb3c1cf-501. After an update
// the old versions' folders are never read again, so drop them.
const fs = require("node:fs");
const path = require("node:path");

async function pruneCompileCache(dir, version = process.versions.node, arch = process.arch) {
    let names;
    try {
        names = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const keep = `v${version}-${arch}-`;
    const stale = names
        .filter((d) => d.isDirectory() && /^v\d+\.\d+\.\d+-/.test(d.name) && !d.name.startsWith(keep))
        .map((d) => d.name);
    await Promise.all(
        stale.map((n) => fs.promises.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})),
    );
    return stale;
}

module.exports = { pruneCompileCache };
