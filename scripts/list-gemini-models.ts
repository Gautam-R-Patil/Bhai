// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// List Gemini models the configured API key can access, focusing on live/audio.
import { initSession, getSessionToken } from "../src/session.js";
import { getConvexSiteUrl } from "../src/config/keys.js";

async function main() {
    await initSession();
    const token = await getSessionToken();
    if (!token) throw new Error("no session token");
    const res = await fetch(`${getConvexSiteUrl()}/api/keys/voice`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { googleApiKey?: string };
    const key = data.googleApiKey;
    if (!key) throw new Error("no googleApiKey");
    console.log("Key len:", key.length);
    const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=300`,
    );
    const d = (await r.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    const all = d.models || [];
    console.log("Total models:", all.length);
    const bidi = all.filter((m) =>
        (m.supportedGenerationMethods || []).some((x) => x === "bidiGenerateContent"),
    );
    console.log("\nModels that support bidiGenerateContent:");
    for (const m of bidi) console.log("  ", m.name);
    const live = all.filter((m) => /live|audio|native/i.test(m.name));
    console.log("\nModels with 'live'/'audio'/'native' in the name:");
    for (const m of live) {
        console.log(
            "  ",
            m.name,
            "  methods=" + (m.supportedGenerationMethods || []).join(","),
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("ERROR:", err);
        process.exit(1);
    });
