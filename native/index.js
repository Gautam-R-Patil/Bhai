// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Fail-open front for the napi-rs loader. `napi build --js binding.js` regenerates
// binding.js, which throws when no .node binary exists for this platform. Modules
// that `import * as native from ".../native/index.js"` can't catch that, so one
// missing binary used to take down every importer (and the bot at boot). Here a
// missing binary leaves an empty binding: each export reads undefined and callers
// fall back to JS. Keep the last line a bare `module.exports = require(...)`;
// that exact shape is how Node's ESM import finds binding.js's named exports.
try {
    require("./binding.js");
} catch (e) {
    // A dev checkout whose last native build predates the rename still has
    // atlas-native.<triple>.node instead of bhai-native.<triple>.node.
    let legacy = null;
    try {
        const name = require("node:fs")
            .readdirSync(__dirname)
            .find((f) => f.startsWith(`atlas-native.${process.platform}-${process.arch}`) && f.endsWith(".node"));
        if (name) legacy = require(`./${name}`);
    } catch {
        /* no usable old binary either */
    }
    // CI on macOS ships the binary, so a load failure there is a real break.
    if (!legacy && process.env.BHAI_REQUIRE_NATIVE === "true") throw e;
    const id = require.resolve("./binding.js");
    require.cache[id] = { id, filename: id, loaded: true, exports: legacy ?? {} };
}
module.exports = require("./binding.js");
