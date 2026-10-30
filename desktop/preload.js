// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Bhai Desktop — Preload Script ───────────
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

    // ── Memory Studio ─────────────────────────
    studio: {
        graph: (opts) => ipcRenderer.invoke("memory:studio-graph", opts),
        search: (query, opts) => ipcRenderer.invoke("memory:studio-search", query, opts),
        getNode: (kind, id) => ipcRenderer.invoke("memory:studio-get-node", kind, id),
        connections: (kind, id) => ipcRenderer.invoke("memory:studio-connections", kind, id),
        you: () => ipcRenderer.invoke("memory:studio-you"),
        stats: () => ipcRenderer.invoke("memory:studio-stats"),
        updateMemory: (id, fields) => ipcRenderer.invoke("memory:studio-update-memory", id, fields),
        setImportance: (id, value) => ipcRenderer.invoke("memory:studio-set-importance", id, value),
        pinMemory: (id, pinned) => ipcRenderer.invoke("memory:studio-pin-memory", id, pinned),
        forgetMemory: (id, reason) => ipcRenderer.invoke("memory:studio-forget-memory", id, reason),
        bulkForget: (ids, reason) => ipcRenderer.invoke("memory:studio-bulk-forget", ids, reason),
        forgetTrait: (key, reason) => ipcRenderer.invoke("memory:studio-forget-trait", key, reason),
        forgetEntity: (id, reason, cascade) => ipcRenderer.invoke("memory:studio-forget-entity", id, reason, cascade),
        forgetLog: (limit) => ipcRenderer.invoke("memory:studio-forget-log", limit),
        insights: () => ipcRenderer.invoke("memory:studio-insights"),
        recomputeInsights: () => ipcRenderer.invoke("memory:studio-recompute-insights"),
    },

    // ── Setup ─────────────────────────────────
    saveCredentials: (creds) => ipcRenderer.invoke("setup:save-credentials", creds),
    saveProfile: (profile) => ipcRenderer.invoke("setup:save-profile", profile),
    saveLegalAcceptance: (payload) => ipcRenderer.invoke("setup:save-legal", payload),
    openExternalUrl: (url) => ipcRenderer.invoke("util:open-external", url),
    setupReseedNow: () => ipcRenderer.invoke("setup:reseed-now"),
    chooseWorkspace: () => ipcRenderer.invoke("setup:choose-workspace"),
    createWorkspace: (path) => ipcRenderer.invoke("setup:create-workspace", path),
    startInstall: (options) => ipcRenderer.invoke("setup:install", options),
    extensionStatus: () => ipcRenderer.invoke("extension:status"),
    extensionOpen: (what) => ipcRenderer.invoke("extension:open", what),
    googleOAuth: () => ipcRenderer.invoke("setup:google-oauth"),
    isSetupComplete: () => ipcRenderer.invoke("setup:is-complete"),
    setupDetect: () => ipcRenderer.invoke("setup:detect"),
    // W3: Magic Moment rich detection (running-app snapshot)
    detectMagicMoment: () => ipcRenderer.invoke("setup:detect-magic-moment"),
    setupPollPermissions: () => ipcRenderer.invoke("setup:poll-permissions"),
    setupRequestPermission: (name) => ipcRenderer.invoke("setup:request-permission", name),
    setupMarkPermissionSkipped: (name, skipped) => ipcRenderer.invoke("setup:mark-permission-skipped", name, skipped),
    setupTestHotkey: (combo) => ipcRenderer.invoke("setup:test-hotkey", combo),
    setupSaveHotkey: (combo) => ipcRenderer.invoke("setup:save-hotkey", combo),
    setupListVoices: () => ipcRenderer.invoke("setup:list-voices"),
    setupPreviewVoice: (backend, name) => ipcRenderer.invoke("setup:preview-voice", backend, name),
    setupTestChannel: (type, creds) => ipcRenderer.invoke("setup:test-channel", type, creds),
    setupSaveChannel: (type, creds, testId) => ipcRenderer.invoke("setup:save-channel", type, creds, testId),
    setupSlackOAuthStart: () => ipcRenderer.invoke("setup:slack-oauth-start"),
    setupWaPairStart: () => ipcRenderer.invoke("setup:wa-pair-start"),
    setupWaPairCancel: () => ipcRenderer.invoke("setup:wa-pair-cancel"),
    setupSavePersonalize: (cfg) => ipcRenderer.invoke("setup:save-personalize", cfg),
    setupRetryInstallPhase: (phaseId) => ipcRenderer.invoke("setup:retry-install-phase", phaseId),
    setupResumeInstall: () => ipcRenderer.invoke("setup:resume-install"),
    setupGetSetupState: () => ipcRenderer.invoke("setup:get-state"),
    setupGetPhaseIds: () => ipcRenderer.invoke("setup:get-phase-ids"),
    finishSetup: () => ipcRenderer.invoke("setup:finish"),
    showOverlay: () => ipcRenderer.send("overlay:show"),
    triggerLiveVoice: () => ipcRenderer.invoke("live-voice:trigger"),

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
    getIntegrations: () => ipcRenderer.invoke("settings:integrations"),
    testGithubToken: (token) => ipcRenderer.invoke("settings:test-github", token),
    googleDisconnect: (email) => ipcRenderer.invoke("settings:google-disconnect", email),
    openWorkspace: () => ipcRenderer.invoke("settings:open-workspace"),
    openDataDir: () => ipcRenderer.invoke("settings:open-data-dir"),
    openLogsDir: () => ipcRenderer.invoke("settings:open-logs-dir"),

    // ── Chats (chat bar history) ──────────────
    listChats: () => ipcRenderer.invoke("chats:list"),
    getUpcoming: () => ipcRenderer.invoke("schedule:upcoming"),
    getActivity: () => ipcRenderer.invoke("dash:activity"),
    chatSend: (chat, text) => ipcRenderer.invoke("chat:send", { chat, text }),
    chatStop: () => ipcRenderer.send("chat:stop"),
    onChatEvent: (callback) => { ipcRenderer.on("chat:event", (_, data) => callback(data)); },
    getChat: (id) => ipcRenderer.invoke("chats:get", id),
    clearChats: () => ipcRenderer.invoke("chats:clear"),
    onGoogleOAuthSuccess: (callback) => {
        ipcRenderer.on("google-oauth-success", (_, email) => callback(email));
    },

    // ── Account ──────────────────────────────
    accountLogout: () => ipcRenderer.invoke("account:logout"),
    getAccountInfo: () => ipcRenderer.invoke("account:info"),
    getDevices: () => ipcRenderer.invoke("account:devices"),
    removeDevice: (deviceId) => ipcRenderer.invoke("account:remove-device", deviceId),
    onAccountStatusChange: (callback) => {
        ipcRenderer.on("account-status-change", (_, data) => callback(data));
    },

    openAuthWindow: () => ipcRenderer.invoke("window:openAuth"),

    // ── Auto-Updater ────────────────────────────────────
    checkForUpdates: () => ipcRenderer.invoke("update:check"),
    downloadUpdate: () => ipcRenderer.invoke("update:download"),
    installUpdate: () => ipcRenderer.invoke("update:install"),
    getUpdateStatus: () => ipcRenderer.invoke("update:status"),
    setUpdateChannel: (channel) => ipcRenderer.invoke("update:setChannel", channel),

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
    getOverlayHotkey: () => ipcRenderer.invoke("hotkey:get-overlay"),
    getLiveVoiceHotkey: () => ipcRenderer.invoke("hotkey:get-live-voice"),

    onThemeChanged: (callback) => {
        ipcRenderer.on("theme-changed", (_, theme) => callback(theme));
    },

    // ── Connection Status ────────────────────────────────
    getConnectionStatus: () => ipcRenderer.invoke("status:connections"),

    // ── Store ─────────────────────────────────────────────
    getStoreItems: () => ipcRenderer.invoke("store:list"),
    getInstalledStoreItems: () => ipcRenderer.invoke("store:installed"),
    startStoreInstall: (args) => ipcRenderer.invoke("store:start-install", args),
    confirmStoreInstall: (args) => ipcRenderer.invoke("store:confirm-install", args),
    installStoreItem: (item) => ipcRenderer.invoke("store:install", item),
    uninstallStoreItem: (item) => ipcRenderer.invoke("store:uninstall", item),
    getUserId: () => ipcRenderer.invoke("account:userId"),

    // ── Sideloading ─────────────────────────────────────
    sideloadPick: () => ipcRenderer.invoke("store:sideload-pick"),
    sideloadInstall: (filePath, options) => ipcRenderer.invoke("store:sideload-install", filePath, options),

    // ── Channels ─────────────────────────────────────
    getChannelConfig: () => ipcRenderer.invoke("channels:get-config"),
    saveChannelConfig: (config) => ipcRenderer.invoke("channels:save-config", config),

    // ── Channel Setup Helpers ────────────────────────
    testChannel: (channel, params) => ipcRenderer.invoke(`channel:test-${channel}`, params),
    telegramWaitOwner: (token) => ipcRenderer.invoke("channel:telegram-wait-owner", { token }),
    clipboardToken: (kind) => ipcRenderer.invoke("channel:clipboard-token", kind),
    bhaiMailClaim: (ownerEmail) => ipcRenderer.invoke("channel:bhai-mail-claim", { ownerEmail }),
    telegramManagedStart: () => ipcRenderer.invoke("channel:telegram-managed-start"),
    telegramManagedWait: (username) => ipcRenderer.invoke("channel:telegram-managed-wait", { username }),
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

    // ── Vault (values stay in main; "reveal" needs Touch ID / the vault password) ──
    vault: {
        list: () => ipcRenderer.invoke("vault:list"),
        save: (entry, password) => ipcRenderer.invoke("vault:save", entry, password),
        remove: (id, password) => ipcRenderer.invoke("vault:delete", id, password),
        reveal: (id, password) => ipcRenderer.invoke("vault:reveal", id, password),
        setPassword: (password, oldPassword) => ipcRenderer.invoke("vault:set-password", password, oldPassword),
        submitCvv: (id, cvv) => ipcRenderer.invoke("vault:cvv-submit", id, cvv),
        onCvvRequest: (callback) => { ipcRenderer.on("vault:cvv-request", (_, req) => callback(req)); },
    },
});
