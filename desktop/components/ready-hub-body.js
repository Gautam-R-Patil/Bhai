// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub body — greeting + tile grid + Launch button + live updates.
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

        const actions = document.createElement("div");
        actions.id = "hub-actions";
        actions.className = "hub-actions";

        const launchBtn = document.createElement("button");
        launchBtn.type = "button";
        launchBtn.className = "btn-primary btn-launch";
        launchBtn.setAttribute("data-action", "launch");
        launchBtn.textContent = "Launch A.T.L.A.S";

        const talkBtn = document.createElement("button");
        talkBtn.type = "button";
        talkBtn.className = "btn-ghost";
        talkBtn.setAttribute("data-action", "talk");
        talkBtn.textContent = "\uD83C\uDF99 Talk";

        const typeBtn = document.createElement("button");
        typeBtn.type = "button";
        typeBtn.className = "btn-ghost";
        typeBtn.setAttribute("data-action", "type");
        typeBtn.textContent = "\u2328\uFE0F Type";

        const actionsErr = document.createElement("p");
        actionsErr.id = "hub-actions-err";
        actionsErr.className = "step-error";
        actionsErr.setAttribute("aria-live", "polite");

        actions.appendChild(launchBtn);
        actions.appendChild(talkBtn);
        actions.appendChild(typeBtn);
        root.appendChild(actions);
        root.appendChild(actionsErr);

        const tilesWrap = document.createElement("div");
        tilesWrap.id = "hub-tiles";
        tilesWrap.className = "hub-tiles";
        root.appendChild(tilesWrap);

        const tryHeading = document.createElement("div");
        tryHeading.className = "hub-try-heading";
        tryHeading.textContent = "Try this";
        root.appendChild(tryHeading);

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

    // Route a tile click based on its onClickRoute string.
    function handleTileRoute(route, atlas) {
        if (!route || typeof route !== "string") return;
        if (route === "channels") { window.location.href = "channels.html"; return; }
        if (route === "settings:account") {
            if (atlas && typeof atlas.openAuthWindow === "function") atlas.openAuthWindow();
            return;
        }
        if (route.indexOf("wizard:") === 0) { window.location.href = "wizard.html"; return; }
        if (route.indexOf("settings:") === 0) {
            // Open the panel with a hash the panel tab router can consume.
            window.location.href = "panel.html#" + route.slice("settings:".length);
            return;
        }
        // Unknown route — no-op but dispatch an event for debugging
        window.dispatchEvent(new CustomEvent("hub:unhandled-route", { detail: { route: route } }));
    }

    function renderTiles(tilesWrap, state, atlas) {
        if (!tilesWrap) return;
        const TM = _getTileModel();
        const C = (typeof window !== "undefined" && window.SetupComponents) || {};
        if (!TM || !C.StatusTile) return;

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
            const route = model.onClickRoute;
            const tile = new C.StatusTile({
                label: model.label,
                value: model.value,
                secondary: model.secondary,
                status: model.status,
                onClick: route ? function () { handleTileRoute(route, atlas); } : undefined,
            });
            tile.mount(holder);
            instances.set(id, tile);
        }
        tilesWrap._spInstances = instances;
    }

    function applyDiff(tilesWrap, prevState, nextState, atlas) {
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
            if (!hadBefore && !hasNow) continue;
            if (hadBefore !== hasNow) { needsFullRender = true; break; }
            const route = nextModel.onClickRoute;
            inst.update({
                label: nextModel.label,
                value: nextModel.value,
                secondary: nextModel.secondary,
                status: nextModel.status,
                onClick: route ? function () { handleTileRoute(route, atlas); } : undefined,
            });
        }
        if (needsFullRender) renderTiles(tilesWrap, nextState, atlas);
    }

    // Merge the real account-info IPC result into the detection state so the
    // Account tile reflects the OTPless session, which is NOT stored in the
    // electron-store `account` key that runDetection reads.
    async function mergeRealAccount(state, atlas) {
        if (!atlas || typeof atlas.getAccountInfo !== "function") return state;
        try {
            const info = await atlas.getAccountInfo();
            if (info && info.signedIn) {
                const acct = {
                    signedIn: true,
                    email: info.email || (state.account && state.account.email) || "",
                    plan: info.plan || "free",
                    credits: typeof info.credits === "number" ? info.credits : 0,
                };
                return Object.assign({}, state, { account: acct });
            }
        } catch { /* best-effort */ }
        return state;
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
            next = await mergeRealAccount(next, atlas);
            applyDiff(tilesWrap, state, next, atlas);
            state = next;
        }

        let timer = setInterval(refresh, REFRESH_MS);
        if (typeof atlas.onAccountStatusChange === "function") {
            atlas.onAccountStatusChange(function () { refresh(); });
        }
        return {
            stop: function () { if (timer) { clearInterval(timer); timer = null; } },
            refreshNow: refresh,
        };
    }

    async function mountHub(container, state, atlasApi) {
        if (!container) return { stop: function () {} };
        const atlas = atlasApi || (typeof window !== "undefined" ? window.atlas : null) || {};

        // Enrich with real account info before first render.
        const enriched = await mergeRealAccount(state || {}, atlas);

        while (container.firstChild) container.removeChild(container.firstChild);
        const body = renderHubBody(enriched);
        container.appendChild(body);
        renderTiles(body.querySelector("#hub-tiles"), enriched, atlas);

        const errEl = body.querySelector("#hub-actions-err");

        // Wire Launch button — fires setup:finish which main.js handles by
        // closing the wizard window and opening the panel (see main.js:1809).
        const launchBtn = body.querySelector('[data-action="launch"]');
        if (launchBtn) {
            launchBtn.addEventListener("click", async function () {
                launchBtn.disabled = true;
                if (typeof atlas.finishSetup === "function") {
                    try { await atlas.finishSetup(); }
                    catch (e) { if (errEl) errEl.textContent = "Launch failed: " + (e.message || e); launchBtn.disabled = false; }
                } else if (errEl) {
                    errEl.textContent = "Launch IPC unavailable.";
                    launchBtn.disabled = false;
                }
            });
        }

        const talkBtn = body.querySelector('[data-action="talk"]');
        if (talkBtn) {
            talkBtn.addEventListener("click", async function () {
                if (typeof atlas.triggerLiveVoice !== "function") {
                    if (errEl) errEl.textContent = "Live voice unavailable.";
                    return;
                }
                try {
                    const res = await atlas.triggerLiveVoice();
                    if (!res || !res.ok) {
                        if (errEl) errEl.textContent = "Couldn't start voice: " + ((res && res.error) || "unknown");
                    } else if (errEl) errEl.textContent = "";
                } catch (e) { if (errEl) errEl.textContent = "Voice error: " + (e.message || e); }
            });
        }

        const typeBtn = body.querySelector('[data-action="type"]');
        if (typeBtn) {
            typeBtn.addEventListener("click", function () {
                if (typeof atlas.showOverlay === "function") atlas.showOverlay();
                else if (errEl) errEl.textContent = "Overlay unavailable.";
            });
        }

        // Mount the "Try this" rotating strip.
        let tryHandle = { stop: function () {} };
        if (typeof window !== "undefined" && window.TryThis && typeof window.TryThis.mount === "function") {
            const tryHost = body.querySelector("#hub-try-this");
            tryHandle = window.TryThis.mount(tryHost, enriched, {
                onClick: function (text) {
                    // Clicking a prompt opens the overlay pre-filled with the suggestion.
                    if (typeof atlas.showOverlay === "function") atlas.showOverlay();
                    window.dispatchEvent(new CustomEvent("hub:try-prompt", { detail: { text: text } }));
                },
            });
        }

        const liveHandle = startLiveUpdates(body, enriched, atlas);
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
        handleTileRoute: handleTileRoute,
        mergeRealAccount: mergeRealAccount,
        REFRESH_MS: REFRESH_MS,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.ReadyHubBody = api;
})();
