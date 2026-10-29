// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub body — greeting + tile grid + Launch button + live updates.
(function () {
    "use strict";

    const REFRESH_MS = 3000;

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function renderHubBody(state) {
        const Copy = (typeof window !== "undefined" && window.Copy) || { get: function(){return null;} };

        const root = document.createElement("div");
        root.className = "hub";

        const name = (state && state.profile && state.profile.name)
                  || (state && state.osUserName)
                  || "";
        // The shortcut that is actually registered (main resolves custom/default/fallback).
        const hotkey = (state && (state.overlayShortcutLabel || state.overlayShortcut)) || "\u2318J";

        // Title \u2014 "Ready, <em>Name</em>." (name omitted if no name resolved)
        const title = document.createElement("h1");
        title.className = "hub-title";
        if (name) {
            title.innerHTML = "Ready, <em>" + escapeHtml(name) + "</em>.";
        } else {
            title.innerHTML = "Ready.";
        }
        root.appendChild(title);

        // Dek \u2014 "Press <kbd>hotkey</kbd> anywhere on your computer. I'll be there."
        const dek = document.createElement("p");
        dek.className = "hub-dek";
        dek.appendChild(document.createTextNode("Press "));
        const kbd = document.createElement("span");
        kbd.className = "hotkey";
        kbd.textContent = hotkey;
        dek.appendChild(kbd);
        dek.appendChild(document.createTextNode(" anywhere on your computer. I'll be there."));
        root.appendChild(dek);

        // Iridescent rule
        const iri = document.createElement("div");
        iri.className = "hub-iri";
        root.appendChild(iri);

        // Magic moment \u2014 placeholder div; magic-moment.js mounts into it.
        const magic = document.createElement("div");
        magic.id = "hub-magic-moment";
        root.appendChild(magic);

        // Settings index \u2014 3-col grid of (label, value)
        const index = document.createElement("div");
        index.id = "hub-tiles"; // keep the legacy id so renderTiles still finds it
        index.className = "hub-index";
        root.appendChild(index);

        // Actions
        const actions = document.createElement("div");
        actions.id = "hub-actions";
        actions.className = "hub-actions";
        const launch = document.createElement("button");
        launch.type = "button";
        launch.className = "btn btn-primary btn-launch";
        launch.setAttribute("data-action", "launch");
        launch.innerHTML = (Copy.get("ready-hub", "launch") || "Launch Bhai") + ' <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        const talk = document.createElement("button");
        talk.type = "button";
        talk.className = "btn btn-secondary";
        talk.setAttribute("data-action", "talk");
        talk.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg><span>' + (Copy.get("ready-hub", "talk") || "Talk") + '</span>';
        const type = document.createElement("button");
        type.type = "button";
        type.className = "btn btn-secondary";
        type.setAttribute("data-action", "type");
        type.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></svg><span>' + (Copy.get("ready-hub", "type") || "Type") + '</span>';
        actions.appendChild(launch); actions.appendChild(talk); actions.appendChild(type);
        root.appendChild(actions);

        const actionsErr = document.createElement("p");
        actionsErr.id = "hub-actions-err";
        actionsErr.className = "step-error";
        actionsErr.setAttribute("aria-live", "polite");
        root.appendChild(actionsErr);

        // Try this
        const trySec = document.createElement("div");
        trySec.className = "try-section";
        const tryHead = document.createElement("p");
        tryHead.className = "try-heading";
        const persona = state && state.profile && state.profile.persona;
        const personaLabel = persona && persona !== "explorer"
            ? (persona.charAt(0).toUpperCase() + persona.slice(1))
            : null;
        tryHead.textContent = personaLabel
            ? "Try this — " + personaLabel + " mode"
            : (Copy.get("ready-hub", "try_heading") || "Try this");
        trySec.appendChild(tryHead);
        const tryBox = document.createElement("div");
        tryBox.id = "hub-try-this";
        tryBox.className = "try-list";
        trySec.appendChild(tryBox);

        // Persona-suggested skills strip — small line under "Try this" with
        // 2-3 role-relevant capability hints. Visible signal that the persona
        // choice flavors the assistant's defaults.
        const PERSONA_SKILLS = {
            developer:  "Skills loaded: codebase comprehension · code review · test runner",
            founder:    "Skills loaded: calendar · email orchestration · meeting prep",
            creator:    "Skills loaded: image generation · reference filing · video edit",
            researcher: "Skills loaded: citation chase · paper summary · literature map",
        };
        if (persona && PERSONA_SKILLS[persona]) {
            const skillsLine = document.createElement("p");
            skillsLine.className = "try-persona-skills";
            skillsLine.textContent = PERSONA_SKILLS[persona];
            trySec.appendChild(skillsLine);
        }

        root.appendChild(trySec);

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
    async function handleTileRoute(route, atlas) {
        if (!route || typeof route !== "string") return;
        if (route === "channels") { window.location.href = "channels.html"; return; }
        if (route === "settings:account") {
            // Only open the auth window when actually signed out. Once the user
            // is signed in the tile should jump to the Account panel tab — the
            // old behavior reopened the login popup every click.
            let signedIn = false;
            if (atlas && typeof atlas.getAccountInfo === "function") {
                try {
                    const info = await atlas.getAccountInfo();
                    signedIn = !!(info && info.signedIn);
                } catch { signedIn = false; }
            }
            if (signedIn) { window.location.href = "panel.html#account"; return; }
            if (atlas && typeof atlas.openAuthWindow === "function") atlas.openAuthWindow();
            return;
        }
        if (route === "wizard:permissions") {
            // The permissions grid is on this page now — scroll to it in-place.
            const grid = document.querySelector(".hub-permissions");
            if (grid) grid.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
        // tileRouteHref keeps the full "settings:<section>" hash so the panel tab
        // router resolves the Settings tab (stripping it produced e.g. "#hotkey").
        const href = tileRouteHref(route);
        if (href) { window.location.href = href; return; }
        // Unknown route — no-op but dispatch an event for debugging
        window.dispatchEvent(new CustomEvent("hub:unhandled-route", { detail: { route: route } }));
    }

    // Map a tile route to a destination URL. Settings subsection routes keep
    // the full "settings:<section>" as the hash: panel.html's hash router splits
    // on [:?/] and resolves the FIRST segment ("settings") to the real tab.
    // Stripping the prefix produced "panel.html#hotkey" — no "tab-hotkey"
    // exists, so the panel silently stayed on the default Dashboard tab.
    function tileRouteHref(route) {
        if (!route || typeof route !== "string") return null;
        if (route === "channels") return "channels.html";
        if (route.indexOf("wizard:") === 0) return "wizard.html";
        if (route.indexOf("settings:") === 0) return "panel.html#" + route;
        return null;
    }

    function renderTiles(tilesWrap, state, atlas) {
        if (!tilesWrap) return;
        const TM = _getTileModel();
        if (!TM) return;
        while (tilesWrap.firstChild) tilesWrap.removeChild(tilesWrap.firstChild);

        // Cells we render in the new hub-index grid. Voice tile hidden until
        // voice selection is reliable end-to-end (see personalize.js note).
        const cellOrder = ["account", "workspace", "hotkey", "persona", "permissions"];
        for (const id of cellOrder) {
            const model = TM.tileModel(state, id);
            if (!model) continue;
            const cell = document.createElement("div");
            cell.className = "hub-cell" + (model.status === "amber" ? " amber" : "");
            cell.setAttribute("data-sp-tile", id);

            const label = document.createElement("span");
            label.className = "hub-cell-label";
            label.textContent = model.label;
            cell.appendChild(label);

            const value = document.createElement("span");
            value.className = "hub-cell-value";
            value.textContent = model.value || "—";
            cell.appendChild(value);

            if (model.secondary) {
                const sec = document.createElement("span");
                sec.className = "hub-cell-secondary";
                sec.textContent = model.secondary;
                cell.appendChild(sec);
            }

            const route = model.onClickRoute;
            if (route) {
                cell.style.cursor = "pointer";
                cell.addEventListener("click", function () { handleTileRoute(route, atlas); });
            }
            tilesWrap.appendChild(cell);
        }
    }

    function applyDiff(tilesWrap, prevState, nextState, atlas) {
        if (!tilesWrap) return;
        const Diff = _getDiff();
        const changed = Diff.diffTiles(prevState, nextState);
        if (changed.length === 0) return;
        // The new hub-index cells are plain divs (no StatusTile instances), so we
        // re-render the whole grid on any change. The grid is 6 cells — cheap.
        renderTiles(tilesWrap, nextState, atlas);
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

        // Render synchronously with whatever state we have. Account-info
        // enrichment runs in the background and refreshes tiles when it
        // lands. Awaiting it before the first paint blocks the whole hub
        // on a Convex round-trip, which on a slow / unreachable network
        // leaves the user staring at the chrome with an empty body.
        const initial = state || {};
        while (container.firstChild) container.removeChild(container.firstChild);
        const body = renderHubBody(initial);
        container.appendChild(body);
        renderTiles(body.querySelector("#hub-tiles"), initial, atlas);

        // Kick off enrichment in the background; never block the paint on it.
        let enriched = initial;
        mergeRealAccount(initial, atlas).then(function (next) {
            if (!next || next === initial) return;
            enriched = next;
            applyDiff(body.querySelector("#hub-tiles"), initial, next, atlas);
        }).catch(function () { /* best-effort */ });

        // Mount magic-moment if available + not killed by env.
        let mmHandle = null;
        if (window.MagicMoment && typeof window.MagicMoment.mount === "function"
            && !(typeof process !== "undefined" && process.env && process.env.ATLAS_NO_MAGIC_MOMENT === "true")) {
            const mmHost = body.querySelector("#hub-magic-moment");
            if (mmHost) mmHandle = window.MagicMoment.mount(mmHost, enriched);
        }

        // Permissions live here now (no separate setup screen): macOS grants for
        // screen recording, accessibility, microphone and location, live-polled.
        let permGrid = null;
        const C = window.SetupComponents || {};
        if (C.PermissionsGrid && initial.platform === "darwin") {
            const host = document.createElement("div");
            host.className = "hub-permissions";
            const tiles = body.querySelector("#hub-tiles");
            if (tiles && tiles.parentNode) tiles.parentNode.insertBefore(host, tiles.nextSibling);
            else body.appendChild(host);
            permGrid = new C.PermissionsGrid({ platform: initial.platform, skipped: (initial.permissions && initial.permissions.skipped) || {} });
            Promise.resolve(permGrid.mount(host)).catch(function () { /* best-effort */ });
        }

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
                if (mmHandle && typeof mmHandle.stop === "function") mmHandle.stop();
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
        tileRouteHref: tileRouteHref,
        mergeRealAccount: mergeRealAccount,
        REFRESH_MS: REFRESH_MS,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.ReadyHubBody = api;
})();
