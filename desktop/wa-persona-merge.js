// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Merge a persona update from the desktop Settings UI onto the persisted
// WhatsApp persona. The Settings form only sends {name, systemPrompt,
// autoAllow}; a raw overwrite would drop allowedToolNames (which the owner
// customizes via the WhatsApp "set tools" command). Merge so unsent fields
// survive.
"use strict";

function mergeWaPersona(existing, incoming) {
    const base = existing && typeof existing === "object" ? existing : {};
    const update = incoming && typeof incoming === "object" ? incoming : {};
    const merged = Object.assign({}, base);
    for (const k of Object.keys(update)) {
        if (update[k] !== undefined) merged[k] = update[k];
    }
    return merged;
}

module.exports = { mergeWaPersona };
