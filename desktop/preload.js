// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── A.T.L.A.S Desktop — Preload Script ───────────
// Secure bridge between renderer (HTML UI) and main process.
// Exposes only specific IPC methods via contextBridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
    // ── Window Controls ───────────────────────
    minimize: () => ipcRenderer.invoke("window:minimize"),
    close: () => ipcRenderer.invoke("window:close"),

    // ── Bot Controls ──────────────────────────
    startBot: () => ipcRenderer.invoke("bot:start"),
    stopBot: () => ipcRenderer.invoke("bot:stop"),
    getBotStatus: () => ipcRenderer.invoke("bot:status"),
    getStats: () => ipcRenderer.invoke("bot:stats"),
    getMemoryData: () => ipcRenderer.invoke("bot:memory-data"),
    deleteTrait: (key) => ipcRenderer.invoke("bot:delete-trait", key),

    // ── Setup ─────────────────────────────────
    saveCredentials: (creds) => ipcRenderer.invoke("setup:save-credentials", creds),
    saveProfile: (profile) => ipcRenderer.invoke("setup:save-profile", profile),
    chooseWorkspace: () => ipcRenderer.invoke("setup:choose-workspace"),
    createWorkspace: (path) => ipcRenderer.invoke("setup:create-workspace", path),
    startInstall: (options) => ipcRenderer.invoke("setup:install", options),
    googleOAuth: () => ipcRenderer.invoke("setup:google-oauth"),
    isSetupComplete: () => ipcRenderer.invoke("setup:is-complete"),
    setupDetect: () => ipcRenderer.invoke("setup:detect"),
    setupPollPermissions: () => ipcRenderer.invoke("setup:poll-permissions"),
    setupRequestPermission: (name) => ipcRenderer.invoke("setup:request-permission", name),
    setupMarkPermissionSkipped: (name, skipped) => ipcRenderer.invoke("setup:mark-permission-skipped", name, skipped),
    setupTestHotkey: (combo) => ipcRenderer.invoke("setup:test-hotkey", combo),
    setupSaveHotkey: (combo) => ipcRenderer.invoke("setup:save-hotkey", combo),
    finishSetup: () => ipcRenderer.invoke("setup:finish"),

    // ── Events ────────────────────────────────
    onBotStatus: (callback) => {
        ipcRenderer.on("bot-status", (_, status) => callback(status));
    },
    onBotLog: (callback) => {
        ipcRenderer.on("bot-log", (_, msg) => callback(msg));
    },
    onInstallProgress: (callback) => {
        ipcRenderer.on("install-progress", (_, data) => callback(data));
    },
    onInstallLog: (callback) => {
        ipcRenderer.on("install-log", (_, msg) => callback(msg));
    },

    // ── App Info ──────────────────────────────
    getAppInfo: () => ipcRenderer.invoke("app:info"),

    // ── Settings ──────────────────────────────
    getSettings: () => ipcRenderer.invoke("settings:get"),
    saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
    chooseSettingsWorkspace: () => ipcRenderer.invoke("settings:choose-workspace"),
    openDataDir: () => ipcRenderer.invoke("settings:open-data-dir"),
    openLogsDir: () => ipcRenderer.invoke("settings:open-logs-dir"),
    onGoogleOAuthSuccess: (callback) => {
        ipcRenderer.on("google-oauth-success", (_, email) => callback(email));
    },

    // ── Account ──────────────────────────────
    // accountLogin receives an OTPless payload: { userId, token, email, phone, name }
    accountLogin: (otplessData) => ipcRenderer.invoke("account:login", otplessData),
    accountLogout: () => ipcRenderer.invoke("account:logout"),
    getAccountInfo: () => ipcRenderer.invoke("account:info"),
    onAccountStatusChange: (callback) => {
        ipcRenderer.on("account-status-change", (_, data) => callback(data));
    },

    // ── OTPless Auth Popup ──────────────────────────────
    // Opens a secure popup BrowserWindow loading the Hostinger-hosted auth page.
    // OTPless SDK runs on a real HTTPS domain (no file:// restriction).
    openAuthWindow: () => ipcRenderer.invoke("window:openAuth"),

    // ── Fallback SMS OTP (fast2sms) ─────────────────────
    otpSend: (phone, countryCode) => ipcRenderer.invoke("otp:send", { phone, countryCode }),
    otpVerify: (phone, countryCode, otp, orderId) => ipcRenderer.invoke("otp:verify", { phone, countryCode, otp, orderId }),

    // ── Auto-Updater ────────────────────────────────────
    checkForUpdates: () => ipcRenderer.invoke("update:check"),
    downloadUpdate: () => ipcRenderer.invoke("update:download"),
    installUpdate: () => ipcRenderer.invoke("update:install"),
    getUpdateStatus: () => ipcRenderer.invoke("update:status"),

    onUpdateAvailable: (callback) => {
        ipcRenderer.on("update-available", (_, data) => callback(data));
    },
    onUpdateProgress: (callback) => {
        ipcRenderer.on("update-progress", (_, data) => callback(data));
    },
    onUpdateReady: (callback) => {
        ipcRenderer.on("update-ready", (_, data) => callback(data));
    },
    onUpdateError: (callback) => {
        ipcRenderer.on("update-error", (_, msg) => callback(msg));
    },

    // ── Preferences ─────────────────────────────────────
    getPrefs: () => ipcRenderer.invoke("prefs:get"),
    setPref: (key, value) => ipcRenderer.invoke("prefs:set", key, value),
    resetPrefs: () => ipcRenderer.invoke("prefs:reset"),

    // ── Hotkey ──────────────────────────────────────────
    setOverlayHotkey: (accelerator) => ipcRenderer.invoke("hotkey:set-overlay", accelerator),
    resetOverlayHotkey: () => ipcRenderer.invoke("hotkey:reset-overlay"),
    setLiveVoiceHotkey: (accelerator) => ipcRenderer.invoke("hotkey:set-live-voice", accelerator),
    resetLiveVoiceHotkey: () => ipcRenderer.invoke("hotkey:reset-live-voice"),
    getLiveVoiceHotkey: () => ipcRenderer.invoke("hotkey:get-live-voice"),

    onThemeChanged: (callback) => {
        ipcRenderer.on("theme-changed", (_, theme) => callback(theme));
    },

    // ── Connection Status ────────────────────────────────
    getConnectionStatus: () => ipcRenderer.invoke("status:connections"),

    // ── Store ─────────────────────────────────────────────
    getStoreItems: () => ipcRenderer.invoke("store:list"),
    getInstalledStoreItems: () => ipcRenderer.invoke("store:installed"),
    installStoreItem: (item) => ipcRenderer.invoke("store:install", item),
    uninstallStoreItem: (item) => ipcRenderer.invoke("store:uninstall", item),
    getUserId: () => ipcRenderer.invoke("account:userId"),

    // ── Sideloading ─────────────────────────────────────
    sideloadPick: () => ipcRenderer.invoke("store:sideload-pick"),
    sideloadInstall: (filePath) => ipcRenderer.invoke("store:sideload-install", filePath),

    // ── Channels ─────────────────────────────────────
    getChannelConfig: () => ipcRenderer.invoke("channels:get-config"),
    saveChannelConfig: (config) => ipcRenderer.invoke("channels:save-config", config),

    // ── Channel Setup Helpers ────────────────────────
    testChannel: (channel, params) => ipcRenderer.invoke(`channel:test-${channel}`, params),
    getChannelStatuses: () => ipcRenderer.invoke("channel:status-all"),

    // ── WhatsApp QR ──────────────────────────────────
    onWhatsAppQR: (callback) => { ipcRenderer.on("whatsapp-qr", (_, qr) => callback(qr)); },
    onChannelStatusUpdate: (callback) => { ipcRenderer.on("channel-status-update", (_, data) => callback(data)); },

    // ── WhatsApp Multi-User Management ──────────────
    onWhatsAppOTP: (callback) => { ipcRenderer.on("whatsapp-otp", (_, data) => callback(data)); },
    waGetOwners: () => ipcRenderer.invoke("wa:get-owners"),
    waRemoveOwner: (jid) => ipcRenderer.invoke("wa:remove-owner", jid),
    waGenerateOTP: () => ipcRenderer.invoke("wa:generate-otp"),
    waGetPersona: () => ipcRenderer.invoke("wa:get-persona"),
    waSavePersona: (persona) => ipcRenderer.invoke("wa:save-persona", persona),
});
