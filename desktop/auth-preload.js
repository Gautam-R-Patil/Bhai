// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Preload for auth.html. Renderer never talks to the network directly — it
// forwards the OTPless SDK token to main, which proxies to Convex.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlasAuth", {
    submitToken: (token) => ipcRenderer.invoke("otpless:submit-token", { token }),
});
