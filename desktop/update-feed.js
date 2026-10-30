// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The update feed URL. electron-updater requests <channel>-mac.yml / <channel>.yml under it and
// keeps its query. An Intel Mac adds arch=x64: MacUpdater never installs an arm64 zip there, so
// the server answers 404 ("nothing published") until an Intel zip is listed.

const os = require("os");

function updateFeedUrl(
    base,
    channel,
    { platform = process.platform, arch = process.arch, osVersion = os.version() } = {},
) {
    const q = new URLSearchParams();
    if (channel !== "stable") q.set("channel", channel);
    // As MacUpdater decides: an Apple Silicon Mac running an x64 build (Rosetta) takes arm64 zips.
    if (platform === "darwin" && arch !== "arm64" && !osVersion.includes("ARM")) q.set("arch", "x64");
    const query = q.toString();
    return query ? `${base}?${query}` : base;
}

module.exports = { updateFeedUrl };
