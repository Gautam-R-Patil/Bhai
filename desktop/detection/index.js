// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// Detection orchestrator: runs every signal in parallel, caps each at a
// timeout, and collapses to a SystemState object. Fail-safe is always
// "show the step" — errors and timeouts never abort detection.

"use strict";

const signals = require("./signals");

const DEFAULT_SIGNAL_TIMEOUT_MS = 500;

function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(fallback);
        }, ms);
        Promise.resolve(promise).then(
            (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
            () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
        );
    });
}

function safeSync(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}

async function runDetection(deps) {
    const safeDeps = deps || {};
    const {
        proc, fs, os, systemPreferences, nativeTheme, globalShortcut,
        prefs, envObj, execFn, paths = {}, currentVersion, hotkey,
    } = safeDeps;
    const timeoutMs = safeDeps.signalTimeoutMs || DEFAULT_SIGNAL_TIMEOUT_MS;

    const platform = safeSync(() => signals.detectPlatform(proc), "linux");

    const [
        googleTokens,
        nodeInstalled,
        embeddingModel,
        slack,
        whatsapp,
    ] = await Promise.all([
        withTimeout(signals.detectGoogleTokens(fs, paths.googleTokens), timeoutMs, { connected: false }),
        withTimeout(signals.detectNodeInstalled(execFn), timeoutMs, false),
        withTimeout(signals.detectEmbeddingModel(fs, paths.homeDir), timeoutMs, false),
        withTimeout(signals.detectSlack(fs, paths.slackInstalls), timeoutMs, undefined),
        withTimeout(signals.detectWhatsApp(fs, paths.whatsappOwners), timeoutMs, undefined),
    ]);

    const isReconfigure = safeSync(() => signals.detectSetupFlag(fs, paths.setupFlag), false);
    const envPresent = safeSync(() => signals.detectEnvPresent(fs, paths.envFile), false);
    const account = safeSync(() => signals.detectOtplessSession(prefs), { signedIn: false });
    const playwright = safeSync(() => signals.detectPlaywrightChromium(fs, paths.botDir), false);
    const permissions = platform === "darwin"
        ? safeSync(() => signals.detectMacPermissions(systemPreferences), {
            accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown",
        })
        : { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" };
    const theme = safeSync(() => signals.detectTheme(nativeTheme), "light");
    const workspace = safeSync(() => signals.detectWorkspace(fs, paths.workspace), {
        path: paths.workspace, exists: false,
    });
    const hotkeyConflicts = safeSync(
        () => signals.detectHotkeyConflict(globalShortcut, hotkey),
        [],
    );
    const version = safeSync(
        () => signals.detectAppVersion(fs, currentVersion, paths.storedVersion),
        { current: currentVersion },
    );

    // Phase E additions
    const osUserName = safeSync(() => signals.detectOsUserName(os), "");
    const personalize = safeSync(
        () => signals.detectPersonalize(prefs, platform),
        {
            hotkey: platform === "win32" ? "Ctrl+Space" : "Alt+Space",
            theme: "system",
            voice: { backend: "gemini-live", name: "Aoede" },
            wakeWord: { enabled: false, phrase: "Hey Atlas" },
        },
    );

    const channels = {};
    const telegram = signals.detectTelegram(envObj);  if (telegram) channels.telegram = telegram;
    const discord  = signals.detectDiscord(envObj);   if (discord)  channels.discord  = discord;
    if (slack)    channels.slack    = slack;
    if (whatsapp) channels.whatsapp = whatsapp;
    const matrix   = signals.detectMatrix(envObj);    if (matrix)   channels.matrix   = matrix;
    const email    = signals.detectEmail(envObj);     if (email)    channels.email    = email;

    return {
        platform,
        isReconfigure,
        version,
        osUserName,
        envPresent,
        account,
        profile: { name: undefined, tone: undefined },
        personalize,
        voice: { ...personalize.voice },
        wakeWord: { ...personalize.wakeWord },
        permissions,
        installed: {
            node: nodeInstalled,
            playwright,
            embeddingModel,
            sox: false,
        },
        google: googleTokens,
        channels,
        hotkey: { current: hotkey, conflicts: hotkeyConflicts },
        theme,
        workspace,
    };
}

module.exports = { runDetection, withTimeout };
