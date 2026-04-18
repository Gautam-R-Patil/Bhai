// desktop/overlay-preload.js
// Preload script for the overlay chat window.
// Exposes a minimal IPC bridge (window.atlasOverlay) so the overlay HTML can:
//   - Request the main process to show/focus the overlay window
//   - Send system notifications from background research completion

const { ipcRenderer, contextBridge } = require("electron");

contextBridge.exposeInMainWorld("atlasOverlay", {
    // Show and focus the overlay window (used by research_complete handler)
    showWindow: () => ipcRenderer.send("overlay:show"),

    // Send a native OS notification
    notify: (title, body) => ipcRenderer.send("overlay:notify", { title, body }),
});
