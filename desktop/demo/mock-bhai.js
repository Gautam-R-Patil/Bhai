// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Browser-only mock of the Electron `window.bhai` IPC bridge so the
// setup wizard, ready hub, and channels pages can be rendered in plain
// Chrome for design review. Must be loaded BEFORE wizard/router.js,
// wizard/boot.js, or any component that touches window.bhai.
(function () {
    "use strict";

    // ── Presets keyed by ?step= query param ─────────────────────────
    // Each preset returns the SystemState that router.getSteps() will
    // use to decide which step to show first. Boot renders steps[0],
    // so to land on "personalize" we mark everything before it done.
    function readParam(name, fallback) {
        try {
            const u = new URL(window.location.href);
            return u.searchParams.get(name) || fallback;
        } catch { return fallback; }
    }
    const step = readParam("step", "welcome");
    const fakeName = readParam("name", "Dheeraj");

    function makeState(stepId) {
        const base = {
            platform: "darwin",
            osUserName: fakeName,
            isReconfigure: false,
            account: { signedIn: false, email: "", plan: "free", credits: 0 },
            profile: null,
            personalize: null,
            hotkey: { current: "Alt+Space", conflicts: [] },
            theme: "dark",
            voice: null,
            wakeWord: null,
            permissions: {
                accessibility: "unknown",
                screen: "unknown",
                microphone: "unknown",
                location: "unknown",
            },
            google: { connected: false },
            channels: {},
            installed: { node: false, playwright: false, embeddingModel: false },
            workspace: { path: "", exists: false },
            setupFinalized: false,
        };

        // Walk the steps array and mark everything BEFORE the target as done.
        // Step order: welcome → signin → profile → personalize → permissions → install
        const signIn = () => { base.account = { signedIn: true, email: "demo@example.com", plan: "pro", credits: 1250 }; };
        const setProfile = () => { base.profile = { name: fakeName, tone: "friendly" }; };
        const setPersonalize = () => {
            base.personalize = {
                hotkey: "Alt+Space",
                theme: "dark",
                voice: { backend: "gemini-live", name: "Aoede" },
                wakeWord: { enabled: false, phrase: "Hey Bhai" },
            };
            base.voice = base.personalize.voice;
            base.wakeWord = base.personalize.wakeWord;
        };
        const grantAll = () => {
            base.permissions = {
                accessibility: "granted", screen: "granted",
                microphone: "granted", location: "granted",
            };
        };
        const installed = () => {
            base.installed = { node: true, playwright: true, embeddingModel: true };
            base.workspace = { path: "/Users/demo/bhai-workspace", exists: true };
            base.setupFinalized = true;
        };

        switch (stepId) {
            case "welcome":     break;
            case "signin":      /* welcome shows only when signed out on non-reconfigure; skip by marking reconfigure */ base.isReconfigure = false; break;
            case "profile":     signIn(); break;
            case "personalize": signIn(); setProfile(); break;
            case "permissions": signIn(); setProfile(); setPersonalize(); break;
            case "install":     signIn(); setProfile(); setPersonalize(); grantAll(); break;
            case "hub":         signIn(); setProfile(); setPersonalize(); grantAll(); installed(); break;
            default:            break;
        }
        return base;
    }

    // Current live state — used by setupDetect + permissions polling.
    const state = makeState(step);

    // Subscribers held in-memory per IPC channel.
    const accountSubs = [];
    const qrSubs = [];
    const progressSubs = [];
    const logSubs = [];

    // Progress simulator used by the Install step when the user clicks
    // "Begin install" in the demo.
    function simulateInstall() {
        const phases = [
            ["Running: Node.js 20",        10, 800],
            ["Running: Browser engine",    30, 1400],
            ["Running: AI model",          55, 1800],
            ["Running: Audio toolkit",     70, 900],
            ["Running: Data directory",    80, 500],
            ["Running: Workspace folder",  92, 500],
            ["Running: Finalize",         100, 400],
        ];
        let i = 0;
        function tick() {
            if (i >= phases.length) return;
            const [message, percent, delay] = phases[i++];
            progressSubs.forEach(cb => cb({ message, percent }));
            logSubs.forEach(cb => cb("[demo] " + message));
            setTimeout(tick, delay);
        }
        setTimeout(tick, 200);
    }

    // QR fake — emits a rotating code every 3s after setupWaPairStart.
    let qrTimer = null;
    function emitFakeQr() {
        const fake = "demo-qr-" + Math.random().toString(36).slice(2, 14);
        qrSubs.forEach(cb => cb(fake));
    }

    // Fake voice catalog so VoicePicker renders groups.
    const VOICES = [
        { backend: "gemini-live",    voices: ["Aoede", "Charon", "Kore", "Fenrir", "Puck"] },
        { backend: "openai-realtime", voices: ["alloy", "shimmer", "echo", "onyx"] },
        { backend: "elevenlabs",     voices: ["Rachel", "Adam", "Sam"] },
    ];

    // ── The mock bhai surface ──────────────────────────────────────
    window.bhai = {
        // Title-bar buttons — no-op in the browser.
        minimize: () => console.log("[demo] minimize"),
        close:    () => console.log("[demo] close (demo — use the X on the real app)"),

        // Detection + setup state.
        setupDetect:         async () => JSON.parse(JSON.stringify(state)),
        setupGetSetupState:  async () => ({ success: true, state: {} }),
        setupPollPermissions: async () => Object.assign({}, state.permissions),

        // Auth.
        openAuthWindow: async () => {
            console.log("[demo] openAuthWindow — auto-signing you in");
            state.account = { signedIn: true, email: "demo@example.com", plan: "pro", credits: 1250 };
            setTimeout(() => { accountSubs.forEach(cb => cb({ signedIn: true, email: "demo@example.com", plan: "pro", credits: 1250 })); }, 600);
            return { ok: true };
        },
        getAccountInfo: async () => Object.assign({}, state.account),
        onAccountStatusChange: (cb) => { if (typeof cb === "function") accountSubs.push(cb); },

        // Profile.
        saveProfile: async (p) => { state.profile = Object.assign({}, p); return { success: true }; },

        // Personalize.
        setupSavePersonalize: async (p) => {
            state.personalize = Object.assign({}, p);
            state.voice = p && p.voice;
            state.wakeWord = p && p.wakeWord;
            state.hotkey = { current: (p && p.hotkey) || state.hotkey.current, conflicts: [] };
            return { success: true };
        },
        setupSaveHotkey: async (combo) => { state.hotkey = { current: combo, conflicts: [] }; return { success: true }; },
        setupTestHotkey: async () => ({ ok: true, conflicts: [] }),
        setupListVoices: async () => VOICES,
        setupPreviewVoice: async () => ({ ok: false, url: null }), // skip audio in demo

        // Permissions.
        setupRequestPermission: async (key) => {
            state.permissions[key] = "granted";
            return { ok: true };
        },
        setupMarkPermissionSkipped: async () => ({ ok: true }),

        // Install.
        startInstall: async () => { simulateInstall(); return { success: true }; },
        setupResumeInstall: async () => { simulateInstall(); return { success: true }; },
        setupRetryInstallPhase: async () => { simulateInstall(); return { success: true }; },
        onInstallProgress: (cb) => { if (typeof cb === "function") progressSubs.push(cb); },
        onInstallLog:      (cb) => { if (typeof cb === "function") logSubs.push(cb); },

        // Channels.
        setupTestChannel: async () => ({ ok: true, testId: "demo-test-" + Date.now() }),
        setupSaveChannel: async (type) => {
            state.channels[type] = { connected: true };
            return { success: true };
        },
        setupSlackOAuthStart: async () => { console.log("[demo] slack oauth"); return { ok: true }; },
        setupWaPairStart: async () => {
            if (qrTimer) clearInterval(qrTimer);
            setTimeout(emitFakeQr, 800);
            qrTimer = setInterval(emitFakeQr, 20000);
            return { ok: true };
        },
        setupWaPairCancel: async () => {
            if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
            return { ok: true };
        },
        waGenerateOTP: async () => ({ ok: true }),
        onWhatsAppQR: (cb) => { if (typeof cb === "function") qrSubs.push(cb); },

        // Misc.
        finishSetup:      async () => { console.log("[demo] finishSetup — in the real app this opens the panel"); return { ok: true }; },
        showOverlay:      () => { console.log("[demo] showOverlay"); },
        triggerLiveVoice: async () => { console.log("[demo] triggerLiveVoice"); return { ok: true }; },
        setupReseedNow:   async () => ({ success: true }),
        app: { getVersion: async () => "0.2.0-demo" },
    };

    console.log("%c[demo] window.bhai mocked — step preset: %s", "color:#c471ed;font-weight:600", step);
})();
