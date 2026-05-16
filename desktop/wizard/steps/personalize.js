// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
(function () {
    "use strict";

    function render(root, ctx) {
        const Copy = window.Copy;
        const platform = (ctx && ctx.state && ctx.state.platform) || "darwin";
        const pz = (ctx && ctx.state && ctx.state.personalize) || {};
        const defaultHot   = pz.hotkey   || (platform === "win32" ? "Control+Space" : "Alt+Space");
        const defaultTheme = pz.theme    || "";
        const defaultVoice = pz.voice    || { backend: "gemini-live", name: "Aoede" };
        const defaultWake  = pz.wakeWord || { enabled: false, phrase: "Hey Atlas" };
        const defaultPersonality = pz.personality || { preset: "casual_playful", notes: "" };

        const section = document.createElement("section");
        section.className = "step step-personalize";

        const eyebrow = document.createElement("div");
        eyebrow.className = "eyebrow";
        eyebrow.innerHTML = '<span class="iri-dot"></span>' + Copy.get("personalize", "eyebrow");
        section.appendChild(eyebrow);

        const title = document.createElement("h1");
        title.className = "step-title";
        title.textContent = Copy.get("personalize", "title");
        section.appendChild(title);

        const sub = document.createElement("p");
        sub.className = "step-sub";
        sub.textContent = Copy.get("personalize", "sub");
        section.appendChild(sub);

        const spec = document.createElement("div");
        spec.className = "spec";

        function row(labelText, valueEl) {
            const r = document.createElement("div");
            r.className = "spec-row";
            const l = document.createElement("div");
            l.className = "spec-label";
            l.textContent = labelText;
            const v = document.createElement("div");
            v.className = "spec-value";
            v.appendChild(valueEl);
            r.appendChild(l);
            r.appendChild(v);
            return r;
        }

        const hotkeyMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_hotkey"), hotkeyMount));

        const themeMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_theme"), themeMount));

        const voiceMount = document.createElement("div");
        spec.appendChild(row(Copy.get("personalize", "label_voice"), voiceMount));

        // Personality presets (kept inline — small radio list).
        const presetWrap = document.createElement("div");
        presetWrap.className = "radio-list";
        let personaPreset = defaultPersonality.preset || "casual_playful";
        const presets = [
            { value: "casual_playful",       label: "Casual & playful",        ex: "lol fair point — let's give it a shot" },
            { value: "professional_concise", label: "Professional & concise",  ex: "Got it. Running the analysis now." },
            { value: "warm_supportive",      label: "Warm & supportive",       ex: "That's a lot. Let's take it one step at a time." },
            { value: "direct_terse",         label: "Direct & no-nonsense",    ex: "Done. Output in /tmp/results.txt." },
        ];
        for (const p of presets) {
            const r = document.createElement("div");
            r.className = "radio-row" + (p.value === personaPreset ? " active" : "");
            r.innerHTML = '<div class="radio-mark"></div>'
                       + '<div class="radio-text">'
                       + '<p class="radio-name">' + p.label + '</p>'
                       + '<p class="radio-example">"' + p.ex + '"</p>'
                       + '</div>';
            r.addEventListener("click", function () {
                personaPreset = p.value;
                presetWrap.querySelectorAll(".radio-row").forEach(function (rr, i) {
                    rr.classList.toggle("active", presets[i].value === p.value);
                });
            });
            presetWrap.appendChild(r);
        }
        spec.appendChild(row(Copy.get("personalize", "label_personality"), presetWrap));

        // Wake word
        const wakeWrap = document.createElement("div");
        const switchRow = document.createElement("div");
        switchRow.className = "switch-row";
        const switchLabel = document.createElement("span");
        switchLabel.className = "switch-label";
        switchLabel.textContent = Copy.get("personalize", "wake_toggle");
        const sw = document.createElement("input");
        sw.type = "checkbox";
        sw.className = "switch";
        sw.checked = !!defaultWake.enabled;
        switchRow.appendChild(switchLabel);
        switchRow.appendChild(sw);
        wakeWrap.appendChild(switchRow);

        const phraseField = document.createElement("div");
        phraseField.className = "field";
        phraseField.style.marginTop = "12px";
        const phraseLabel = document.createElement("span");
        phraseLabel.className = "field-label";
        phraseLabel.textContent = Copy.get("personalize", "wake_phrase_label");
        const phraseInput = document.createElement("input");
        phraseInput.type = "text";
        phraseInput.value = defaultWake.phrase || "Hey Atlas";
        phraseField.appendChild(phraseLabel);
        phraseField.appendChild(phraseInput);
        if (!sw.checked) phraseField.style.display = "none";
        sw.addEventListener("change", function () { phraseField.style.display = sw.checked ? "" : "none"; });
        wakeWrap.appendChild(phraseField);

        spec.appendChild(row(Copy.get("personalize", "label_wake"), wakeWrap));

        section.appendChild(spec);

        const actions = document.createElement("div");
        actions.className = "step-actions";
        const back = document.createElement("button");
        back.type = "button"; back.className = "btn btn-text"; back.textContent = "Back";
        back.addEventListener("click", function () { if (ctx && typeof ctx.onBack === "function") ctx.onBack(); });
        const grow = document.createElement("div"); grow.className = "grow";
        const cta = document.createElement("button");
        cta.type = "button"; cta.className = "btn btn-primary";
        cta.innerHTML = 'Continue <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg></span>';
        actions.appendChild(back); actions.appendChild(grow); actions.appendChild(cta);
        section.appendChild(actions);

        const err = document.createElement("p");
        err.className = "step-error"; err.setAttribute("aria-live", "polite");
        section.appendChild(err);

        root.appendChild(section);

        // Mount existing components (unchanged API).
        const C = window.SetupComponents || {};
        let hotkeyValue = defaultHot, hotkeyPicker = null;
        if (C.HotkeyPicker) {
            hotkeyPicker = new C.HotkeyPicker({
                platform: platform, initial: defaultHot,
                onChange: function (combo) { hotkeyValue = combo; },
            });
            hotkeyPicker.mount(hotkeyMount);
        }
        let themeValue = defaultTheme, themeSwitch = null;
        if (C.ThemeSwitch) {
            themeSwitch = new C.ThemeSwitch({
                initial: defaultTheme || ((ctx && ctx.state && ctx.state.theme) || "system"),
                osPreference: (ctx && ctx.state && ctx.state.theme) || "light",
                onChange: function (sel) {
                    themeValue = sel.pick;
                    // Live preview — apply immediately so the wizard reflects the choice.
                    const root = document.documentElement;
                    if (!themeValue || themeValue === "system") root.removeAttribute("data-theme");
                    else root.setAttribute("data-theme", themeValue);
                },
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
            Promise.resolve(voicePicker.mount(voiceMount)).catch(function () {});
        }

        cta.addEventListener("click", async function () {
            const payload = {
                hotkey:   (hotkeyPicker && typeof hotkeyPicker.getValue === "function") ? hotkeyPicker.getValue() : hotkeyValue,
                theme:    (themeSwitch  && typeof themeSwitch.getValue  === "function") ? themeSwitch.getValue()  : themeValue,
                voice:    (voicePicker  && typeof voicePicker.getValue  === "function") ? (voicePicker.getValue() || defaultVoice) : defaultVoice,
                wakeWord: { enabled: sw.checked, phrase: phraseInput.value.trim() || "Hey Atlas" },
                personality: { preset: personaPreset, notes: defaultPersonality.notes || "" },
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
    if (typeof module !== "undefined" && module.exports) module.exports = { render: render };
})();
