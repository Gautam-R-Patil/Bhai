// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Preload for auth.html. Renderer never talks to the network directly — it
// forwards the OTPless SDK token to main, which proxies to Convex.

const { contextBridge, ipcRenderer } = require("electron");

const bhaiAuth = {
    submitToken: (token) => ipcRenderer.invoke("otpless:submit-token", { token }),
};
contextBridge.exposeInMainWorld("bhaiAuth", bhaiAuth);
// The live /auth-login page updates apart from this app; one from before the rename looks for atlasAuth.
contextBridge.exposeInMainWorld("atlasAuth", bhaiAuth);
