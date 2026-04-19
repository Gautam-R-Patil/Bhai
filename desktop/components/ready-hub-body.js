// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub body — renders the greeting + tile grid.
// MINIMAL STUB (D1) — real implementation lands in Task D5.
(function () {
    "use strict";

    function renderHubBody(state) {
        // Returns a DOM node (NOT an HTML string — Phase E rule).
        const root = document.createElement("div");
        root.className = "hub-root";

        const header = document.createElement("h1");
        header.className = "hub-title";
        header.textContent = "Ready to go";
        root.appendChild(header);

        const name = state && state.osUserName ? ", " + state.osUserName : "";
        const sub = document.createElement("p");
        sub.className = "hub-sub";
        sub.textContent = "A.T.L.A.S is configured" + name + ". Launch when you are ready.";
        root.appendChild(sub);

        const tilesWrap = document.createElement("div");
        tilesWrap.id = "hub-tiles";
        tilesWrap.className = "hub-tiles";
        root.appendChild(tilesWrap);

        const tryBox = document.createElement("div");
        tryBox.id = "hub-try-this";
        tryBox.className = "hub-try-this";
        root.appendChild(tryBox);

        return root;
    }

    function mountHub(container, state) {
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);
        const body = renderHubBody(state);
        container.appendChild(body);
        renderTiles(body.querySelector("#hub-tiles"), state);
    }

    function renderTiles(tilesWrap, state) {
        if (!tilesWrap) return;
        const tm = window.TileModel;
        const C = window.SetupComponents || {};
        if (!tm || !C.StatusTile) return;
        while (tilesWrap.firstChild) tilesWrap.removeChild(tilesWrap.firstChild);
        for (const id of tm.TILE_ORDER) {
            const model = tm.tileModel(state, id);
            if (!model) continue;
            const holder = document.createElement("div");
            holder.setAttribute("data-sp-tile", id);
            tilesWrap.appendChild(holder);
            new C.StatusTile({
                label: model.label,
                value: model.value,
                secondary: model.secondary,
                status: model.status,
            }).mount(holder);
        }
    }

    const api = { renderHubBody: renderHubBody, mountHub: mountHub, renderTiles: renderTiles };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.ReadyHubBody = api;
})();
