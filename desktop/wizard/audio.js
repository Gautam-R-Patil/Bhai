// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Audio cues for the wizard. Two clips. Default off — user opts in via
// the speaker toggle in the chrome bar, which writes personalize.audio.enabled.
(function () {
    "use strict";

    const CLIPS = {
        confirm:  "audio/confirm.ogg",
        awakeningChime: "audio/awakening-chime.ogg",
    };

    let _audioElements = null;
    let _enabled = false;

    function preload() {
        if (_audioElements) return;
        if (typeof Audio === "undefined") return; // node / test env — no DOM Audio
        _audioElements = {};
        for (const id in CLIPS) {
            const a = new Audio(CLIPS[id]);
            a.preload = "auto";
            a.volume = 0.4;
            _audioElements[id] = a;
        }
    }

    function setEnabled(v) { _enabled = !!v; }

    function play(id) {
        if (!_enabled) return;
        if (typeof process !== "undefined" && process.env && process.env.ATLAS_NO_ONBOARDING_AUDIO === "true") return;
        preload();
        if (!_audioElements) return;
        const a = _audioElements[id];
        if (!a) return;
        try {
            a.currentTime = 0;
            const p = a.play();
            if (p && typeof p.catch === "function") p.catch(function () { /* autoplay block — silently ignore */ });
        } catch (_) { /* ignore */ }
    }

    const api = { preload: preload, setEnabled: setEnabled, play: play };
    if (typeof window !== "undefined") window.WizardAudio = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
