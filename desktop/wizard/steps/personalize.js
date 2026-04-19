// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";
        const pz = (ctx && ctx.state && ctx.state.personalize) || {};
        const defaultHot = pz.hotkey || (platform === "win32" ? "Control+Space" : "Alt+Space");
        const defaultTheme = pz.theme || (ctx && ctx.state && ctx.state.theme) || "system";
        const defaultVoice = pz.voice || { backend: "gemini-live", name: "Aoede" };
        const defaultWake = pz.wakeWord || { enabled: false, phrase: "Hey Atlas" };
        const conflicts = (ctx && ctx.state && ctx.state.hotkey && ctx.state.hotkey.conflicts) || [];

        const section = document.createElement("section");
        section.className = "step step-personalize";

        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Make it yours";
        section.appendChild(title);

        // E3a: conflict banner — only shown when state.hotkey.conflicts is non-empty.
        let conflictBanner = null;
        if (conflicts.length > 0) {
            conflictBanner = document.createElement("div");
            conflictBanner.className = "step-banner step-banner--error";
            conflictBanner.id = "pz-conflict";
            conflictBanner.textContent = "Current hotkey (" + defaultHot + ") conflicts with " + conflicts[0] + ". Pick a different combo to continue.";
            section.appendChild(conflictBanner);
        }

        // Hotkey card
        const cardHotkey = document.createElement("div");
        cardHotkey.className = "card";
        cardHotkey.id = "card-hotkey";
        const hotHeader = document.createElement("h3");
        hotHeader.className = "card-title";
        hotHeader.textContent = "Hotkey";
        cardHotkey.appendChild(hotHeader);
        const hotkeyMount = document.createElement("div");
        cardHotkey.appendChild(hotkeyMount);
        section.appendChild(cardHotkey);

        // Theme card
        const cardTheme = document.createElement("div");
        cardTheme.className = "card";
        cardTheme.id = "card-theme";
        const themeHeader = document.createElement("h3");
        themeHeader.className = "card-title";
        themeHeader.textContent = "Theme";
        cardTheme.appendChild(themeHeader);
        const themeMount = document.createElement("div");
        cardTheme.appendChild(themeMount);
        section.appendChild(cardTheme);

        // Voice card
        const cardVoice = document.createElement("div");
        cardVoice.className = "card";
        cardVoice.id = "card-voice";
        const voiceHeader = document.createElement("h3");
        voiceHeader.className = "card-title";
        voiceHeader.textContent = "Voice";
        cardVoice.appendChild(voiceHeader);
        const voiceMount = document.createElement("div");
        cardVoice.appendChild(voiceMount);
        section.appendChild(cardVoice);

        // Wake word card (inline — no dedicated component)
        const cardWake = document.createElement("div");
        cardWake.className = "card";
        cardWake.id = "card-wake";
        const wakeHeader = document.createElement("h3");
        wakeHeader.className = "card-title";
        wakeHeader.textContent = "Wake word";
        cardWake.appendChild(wakeHeader);
        const enabledLabel = document.createElement("label");
        enabledLabel.className = "row";
        const enabledInput = document.createElement("input");
        enabledInput.type = "checkbox";
        enabledInput.id = "wake-enabled";
        enabledInput.checked = !!defaultWake.enabled;
        enabledLabel.appendChild(enabledInput);
        enabledLabel.appendChild(document.createTextNode(" Listen for a wake word"));
        cardWake.appendChild(enabledLabel);

        const phraseLabel = document.createElement("label");
        phraseLabel.className = "field";
        const phraseSpan = document.createElement("span");
        phraseSpan.textContent = "Phrase";
        phraseLabel.appendChild(phraseSpan);
        const phraseInput = document.createElement("input");
        phraseInput.id = "wake-phrase";
        phraseInput.type = "text";
        phraseInput.value = defaultWake.phrase || "Hey Atlas";
        phraseLabel.appendChild(phraseInput);
        cardWake.appendChild(phraseLabel);
        section.appendChild(cardWake);

        // Actions
        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.id = "pz-back"; back.type = "button"; back.className = "btn-ghost"; back.textContent = "Back";
        const next = document.createElement("button");
        next.id = "pz-next"; next.type = "button"; next.className = "btn-primary"; next.textContent = "Continue";
        if (conflicts.length > 0) next.disabled = true;
        actions.appendChild(back);
        actions.appendChild(next);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.id = "pz-err"; err.className = "step-error"; err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        // ── Mount the component children (PascalCase constructors per Phase E). ──
        const C = window.SetupComponents || {};

        let hotkeyValue = defaultHot;
        let hotkeyPicker = null;
        if (C.HotkeyPicker) {
            hotkeyPicker = new C.HotkeyPicker({
                platform: platform,
                initial: defaultHot,
                onChange: function (combo) {
                    hotkeyValue = combo;
                    // E3a: on a valid new combo, clear the conflict banner + re-enable Continue
                    if (conflictBanner) { conflictBanner.remove(); conflictBanner = null; }
                    next.disabled = false;
                },
            });
            hotkeyPicker.mount(hotkeyMount);
        }

        let themeValue = defaultTheme;
        let themeSwitch = null;
        if (C.ThemeSwitch) {
            themeSwitch = new C.ThemeSwitch({
                initial: defaultTheme,
                osPreference: (ctx && ctx.state && ctx.state.theme) || "light",
                onChange: function (sel) { themeValue = sel.pick; },
            });
            themeSwitch.mount(themeMount);
        }

        let voicePicker = null;
        if (C.VoicePicker) {
            voicePicker = new C.VoicePicker({
                onChange: function (v) {
                    if (v && v.backend && v.name) { defaultVoice.backend = v.backend; defaultVoice.name = v.name; }
                },
            });
            // mount is async for VoicePicker; swallow promise
            Promise.resolve(voicePicker.mount(voiceMount)).catch(function () {});
        }

        // Actions
        back.addEventListener("click", function () {
            if (ctx && typeof ctx.onBack === "function") ctx.onBack();
        });

        next.addEventListener("click", async function () {
            if (next.disabled) return;
            const payload = {
                hotkey: (hotkeyPicker && typeof hotkeyPicker.getValue === "function") ? hotkeyPicker.getValue() : hotkeyValue,
                theme: (themeSwitch && typeof themeSwitch.getValue === "function") ? themeSwitch.getValue() : themeValue,
                voice: (voicePicker && typeof voicePicker.getValue === "function") ? (voicePicker.getValue() || defaultVoice) : defaultVoice,
                wakeWord: {
                    enabled: enabledInput.checked,
                    phrase: phraseInput.value.trim() || "Hey Atlas",
                },
            };
            if (!window.atlas || typeof window.atlas.setupSavePersonalize !== "function") {
                err.textContent = "Save unavailable (IPC not ready).";
                return;
            }
            let res;
            try { res = await window.atlas.setupSavePersonalize(payload); }
            catch (e) { err.textContent = "Save failed: " + (e.message || e); return; }
            if (!res || !res.success) {
                err.textContent = (res && res.error) || "Save failed.";
                return;
            }
            if (ctx && typeof ctx.refreshState === "function") await ctx.refreshState();
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
    }

    window.WizardSteps = window.WizardSteps || {};
    window.WizardSteps.personalize = { render: render };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render };
    }
})();
