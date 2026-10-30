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

/** Nothing published for this app (the feed answers 404), or the feed is off (401/403). */
function isFeedMissing(err) {
    const msg = err?.message || "";
    return (
        err?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" ||
        ["404", "Not Found", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "401", "403"].some((s) => msg.includes(s))
    );
}

/** "Check for updates" in Settings: a feed with nothing published is "up to date", and a fetched
 * feed is an update only when electron-updater says so (it returns updateInfo either way). */
async function checkResult(check) {
    try {
        const r = await check();
        return { available: !!r?.isUpdateAvailable, version: r?.updateInfo?.version };
    } catch (err) {
        return isFeedMissing(err) ? { available: false } : { error: err.message };
    }
}

module.exports = { updateFeedUrl, isFeedMissing, checkResult };
