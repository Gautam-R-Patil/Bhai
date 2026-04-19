// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Channels page bootstrap. Renders the 6-cell grid of ChannelCard components.
// Guarded by presence of #channels-grid so jsdom tests importing the file don't
// auto-trigger.
(function () {
    "use strict";

    const CHANNEL_TYPES = ["telegram", "discord", "slack", "whatsapp", "matrix", "email"];

    async function boot() {
        const grid = document.getElementById("channels-grid");
        if (!grid) return;
        const atlas = window.atlas || {};
        const C = window.SetupComponents || {};
        if (!C.ChannelCard) {
            const err = document.createElement("div");
            err.className = "info-card";
            err.textContent = "ChannelCard component unavailable.";
            grid.appendChild(err);
            return;
        }

        // (State isn't strictly required by ChannelCard — it reads from IPC on Test.
        // We still fetch it so a future version can pre-color cells by connection state.)
        let state = { channels: {} };
        if (typeof atlas.setupDetect === "function") {
            try { state = await atlas.setupDetect(); }
            catch { state = { channels: {} }; }
        }

        for (const type of CHANNEL_TYPES) {
            const cell = document.createElement("div");
            cell.className = "channel-cell";
            cell.setAttribute("data-sp-cell", type);
            grid.appendChild(cell);
            const card = new C.ChannelCard({
                type: type,
                onSaved: function () {
                    // When a channel saves, mark its cell green + dispatch an event so any
                    // parent (e.g., ready-hub's live updater) can react.
                    cell.classList.add("channel-cell--connected");
                    window.dispatchEvent(new CustomEvent("channels:saved", { detail: { type: type } }));
                },
            });
            card.mount(cell);
            // If detection said this channel is already connected, color the cell.
            const existing = state && state.channels && state.channels[type];
            if (existing && existing.connected) {
                cell.classList.add("channel-cell--connected");
            }
        }
    }

    if (typeof document !== "undefined" && document.getElementById && document.getElementById("channels-grid")) {
        boot();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { boot: boot, CHANNEL_TYPES: CHANNEL_TYPES };
    }
})();
