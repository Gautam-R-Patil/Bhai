// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub body — renders the greeting + tile grid + live-updates the grid
// every 3s while visible (or when the account status changes).
(function () {
    "use strict";

    const REFRESH_MS = 3000;

    function renderHubBody(state) {
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

    function _getTileModel() {
        if (typeof window !== "undefined" && window.TileModel) return window.TileModel;
        return require("./tile-model.js");
    }

    function _getDiff() {
        if (typeof window !== "undefined" && window.DiffTiles) return window.DiffTiles;
        return require("./diff-tiles.js");
    }

    // Re-renders the tile grid from scratch. Keeps a Map of mounted StatusTile
    // instances (keyed by tile id) on the wrap element so live updates can use
    // StatusTile.update() rather than full remount.
    function renderTiles(tilesWrap, state) {
        if (!tilesWrap) return;
        const TM = _getTileModel();
        const C = (typeof window !== "undefined" && window.SetupComponents) || {};
        if (!TM || !C.StatusTile) return;

        // Clear previous tiles + instances.
        const prevInstances = tilesWrap._spInstances || new Map();
        for (const [, inst] of prevInstances) {
            try { if (typeof inst.unmount === "function") inst.unmount(); } catch {}
        }
        while (tilesWrap.firstChild) tilesWrap.removeChild(tilesWrap.firstChild);

        const instances = new Map();
        for (const id of TM.TILE_ORDER) {
            const model = TM.tileModel(state, id);
            if (!model) continue;
            const holder = document.createElement("div");
            holder.setAttribute("data-sp-tile", id);
            tilesWrap.appendChild(holder);
            const tile = new C.StatusTile({
                label: model.label,
                value: model.value,
                secondary: model.secondary,
                status: model.status,
            });
            tile.mount(holder);
            instances.set(id, tile);
        }
        tilesWrap._spInstances = instances;
    }

    // Apply a diff: for tiles still present (same id), call .update() with the
    // new props (which triggers the built-in green pulse animation from B1).
    // For tiles that appeared/disappeared, rebuild the grid so the count + order
    // stay correct.
    function applyDiff(tilesWrap, prevState, nextState) {
        if (!tilesWrap) return;
        const TM = _getTileModel();
        const Diff = _getDiff();
        const changed = Diff.diffTiles(prevState, nextState);
        if (changed.length === 0) return;

        const instances = tilesWrap._spInstances || new Map();
        let needsFullRender = false;
        for (const id of changed) {
            const inst = instances.get(id);
            const nextModel = TM.tileModel(nextState, id);
            const hadBefore = !!inst;
            const hasNow = !!nextModel;
            if (!hadBefore && !hasNow) continue;      // both null — impossible given diff said "changed"
            if (hadBefore !== hasNow) { needsFullRender = true; break; }
            // Same id, still present — update in place.
            inst.update({
                label: nextModel.label,
                value: nextModel.value,
                secondary: nextModel.secondary,
                status: nextModel.status,
            });
        }
        if (needsFullRender) renderTiles(tilesWrap, nextState);
    }

    function startLiveUpdates(container, initialState, atlasApi) {
        if (!container) return { stop: function () {} };
        const atlas = atlasApi || (typeof window !== "undefined" ? window.atlas : null) || {};
        let state = initialState || {};

        const tilesWrap = container.querySelector("#hub-tiles");

        async function refresh() {
            if (typeof atlas.setupDetect !== "function") return;
            if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") return;
            let next;
            try { next = await atlas.setupDetect(); }
            catch { return; }
            if (!next) return;
            applyDiff(tilesWrap, state, next);
            state = next;
        }

        let timer = null;
        timer = setInterval(refresh, REFRESH_MS);

        // Also subscribe to account status change — it's an instant signal we shouldn't
        // wait up to 3s for.
        if (typeof atlas.onAccountStatusChange === "function") {
            atlas.onAccountStatusChange(function () { refresh(); });
        }

        return {
            stop: function () {
                if (timer) { clearInterval(timer); timer = null; }
            },
            refreshNow: refresh,
        };
    }

    function mountHub(container, state, atlasApi) {
        if (!container) return { stop: function () {} };
        while (container.firstChild) container.removeChild(container.firstChild);
        const body = renderHubBody(state);
        container.appendChild(body);
        renderTiles(body.querySelector("#hub-tiles"), state);

        // Mount the "Try this" rotating strip inside #hub-try-this.
        let tryHandle = { stop: function () {} };
        if (typeof window !== "undefined" && window.TryThis && typeof window.TryThis.mount === "function") {
            const tryHost = body.querySelector("#hub-try-this");
            tryHandle = window.TryThis.mount(tryHost, state, {
                onClick: function (text) {
                    window.dispatchEvent(new CustomEvent("hub:try-prompt", { detail: { text: text } }));
                },
            });
        }

        const liveHandle = startLiveUpdates(body, state, atlasApi);
        return {
            stop: function () {
                if (tryHandle && typeof tryHandle.stop === "function") tryHandle.stop();
                if (liveHandle && typeof liveHandle.stop === "function") liveHandle.stop();
            },
            refreshNow: liveHandle.refreshNow,
        };
    }

    const api = {
        renderHubBody: renderHubBody,
        mountHub: mountHub,
        renderTiles: renderTiles,
        applyDiff: applyDiff,
        startLiveUpdates: startLiveUpdates,
        REFRESH_MS: REFRESH_MS,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.ReadyHubBody = api;
})();
