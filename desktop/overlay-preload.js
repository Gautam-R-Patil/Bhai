// desktop/overlay-preload.js
// Preload script for the overlay chat window.
// Exposes a minimal IPC bridge (window.atlasOverlay) so the overlay HTML can:
//   - Read and subscribe to the user's light/dark theme preference

const { ipcRenderer, contextBridge } = require("electron");

contextBridge.exposeInMainWorld("atlasOverlay", {
    // Open a finished research report (a .md file in the Research folder) in the default app
    openReport: (filePath) => ipcRenderer.send("overlay:open-report", filePath),

    // The page's content height changed: the window follows it.
    setHeight: (h) => ipcRenderer.send("overlay:height", h),

    // Read the user's current theme: "light" | "dark" | "system".
    getTheme: () => ipcRenderer.invoke("overlay:getTheme"),

    // Subscribe to live theme changes. Returns an unsubscribe function.
    onThemeChanged: (callback) => {
        const handler = (_event, theme) => callback(theme);
        ipcRenderer.on("theme-changed", handler);
        return () => ipcRenderer.removeListener("theme-changed", handler);
    },
});
