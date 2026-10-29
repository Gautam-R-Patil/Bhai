// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Pure helper: diff the model output for two SystemStates and return the list
// of tile ids whose model changed. Used by ready-hub-body to decide which
// tiles to re-render + pulse-animate on the next 3s refresh.
(function () {
    "use strict";

    function _getTileModel() {
        if (typeof window !== "undefined" && window.TileModel) return window.TileModel;
        // Node path: require the CommonJS module directly.
        return require("./tile-model.js");
    }

    function diffTiles(prev, next) {
        const TM = _getTileModel();
        const changed = [];
        for (const name of TM.TILE_ORDER) {
            const a = TM.tileModel(prev, name);
            const b = TM.tileModel(next, name);
            if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(name);
        }
        return changed;
    }

    const api = { diffTiles: diffTiles };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.DiffTiles = api;
})();
