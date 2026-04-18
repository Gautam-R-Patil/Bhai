// desktop/auth-preload.js
// Preload script for the local auth.html popup.
// Exposes a minimal IPC bridge (window.atlasAuth) so the page can:
//   - Send/verify SMS OTP via fast2sms (main process IPC)
//   - Trigger Google OAuth (main process native flow) + create ATLAS session
// No OTPless SDK — no domain restrictions.
//
// Uses contextBridge.exposeInMainWorld to safely expose IPC methods
// with contextIsolation: true — renderer code cannot access ipcRenderer directly.

const { contextBridge, ipcRenderer } = require("electron");

// Bridge exposed to auth.html as window.atlasAuth via contextBridge
contextBridge.exposeInMainWorld("atlasAuth", {
    // Send OTP via fast2sms (IPC → otp:send in main.js)
    sendOtp: ({ phone, countryCode }) =>
        ipcRenderer.invoke("otp:send", { phone, countryCode }),

    // Verify OTP — on success, main.js saves session, closes popup, notifies main window
    verifyOtp: ({ phone, countryCode, otp }) =>
        ipcRenderer.invoke("otp:verify", { phone, countryCode, otp }),

    // Google Sign-In — opens system browser, exchanges token, creates ATLAS session
    googleOAuth: () =>
        ipcRenderer.invoke("account:google-signin"),
});
