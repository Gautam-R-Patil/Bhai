// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Ready Hub margin-note. Picks one observation from a small ranker driven
// by best-effort signals. W3 will swap the data source for rich detection.
(function () {
    "use strict";

    function hourBucket(now) {
        const h = (now || new Date()).getHours();
        if (h >= 5 && h < 12)  return "morning";
        if (h >= 12 && h < 17) return "afternoon";
        if (h >= 17 && h < 23) return "evening";
        return "late-night";
    }

    function pickObservations(state) {
        const out = [];
        const persona = (state && state.profile && state.profile.persona) || null;
        const hour    = (state && state.hourOfDay) || hourBucket();
        const theme   = (state && state.theme) || null;
        const browser = (state && state.defaultBrowser) || null;
        const mon     = (state && state.monitorCount) || 0;

        if (persona === "developer") {
            out.push({ observation: "Looks like you're building something.",
                       followup: "I'll prioritize codebase context and terminal awareness." });
        } else if (persona === "founder") {
            out.push({ observation: "You're in coordination mode.",
                       followup: "I'll watch your calendar and surface what needs a decision." });
        } else if (persona === "creator") {
            out.push({ observation: "Creative tools open. I can keep references organized.",
                       followup: "Drop a reference link anytime — I'll file it." });
        } else if (persona === "researcher") {
            out.push({ observation: "Sources on screen. I can chase the citations.",
                       followup: "Tell me what you're investigating and I'll widen the net." });
        } else {
            out.push({ observation: "Workspace mapped. Ready when you are.",
                       followup: "Talk to me however feels right — I'll learn." });
        }

        if (hour === "late-night") {
            out.push({ observation: "Late-night session. I'll keep things minimal.",
                       followup: "Voice off by default. Hotkey-quiet mode." });
        } else if (hour === "morning") {
            out.push({ observation: "Fresh start. Want me to brief the day?",
                       followup: "Calendar, inbox, what's overdue — in under ninety seconds." });
        }

        if (theme === "dark" && mon >= 2) {
            out.push({ observation: "Dark mode and " + mon + " monitors. I'll spread out when I need to.",
                       followup: "Drag me to whichever screen feels right." });
        } else if (mon >= 3) {
            out.push({ observation: mon + " monitors detected. I'll spread out when I need to.",
                       followup: "Drag me to whichever screen feels right." });
        }

        if (browser) {
            out.push({ observation: browser + " is your daily driver.",
                       followup: "I'll learn its tabs first." });
        }

        return out.slice(0, 4);
    }

    async function mount(container, state) {
        if (!container) return { stop: function () {} };

        // 1. Synchronous fallback (W1 static signals) so the card is never empty.
        let observations = pickObservations(state);
        if (observations.length === 0) return { stop: function () {} };

        container.classList.add("magic-note");
        container.innerHTML = ''
            + '<div class="magic-eyebrow"><span class="iri-dot"></span>I noticed something</div>'
            + '<h2 class="magic-obs"></h2>'
            + '<p class="magic-follow"></p>';
        const obsEl    = container.querySelector(".magic-obs");
        const followEl = container.querySelector(".magic-follow");

        let idx = 0;
        function paint() {
            obsEl.textContent    = observations[idx].observation;
            followEl.textContent = observations[idx].followup;
        }
        paint();

        let timer = null;
        function scheduleRotation() {
            if (observations.length > 1 && timer == null) {
                timer = setInterval(function () {
                    idx = (idx + 1) % observations.length;
                    obsEl.style.opacity = "0"; followEl.style.opacity = "0";
                    setTimeout(function () {
                        paint();
                        obsEl.style.opacity = "1"; followEl.style.opacity = "1";
                    }, 320);
                }, 7000);
            }
        }
        scheduleRotation();

        // 2. Async rich detection (best-effort).
        if (typeof window !== "undefined" && window.atlas && typeof window.atlas.detectMagicMoment === "function"
            && window.MagicMomentRanker) {
            try {
                const snapshot = await window.atlas.detectMagicMoment();
                if (snapshot && Array.isArray(snapshot.names) && snapshot.names.length > 0) {
                    const rich = window.MagicMomentRanker.rankSignals({
                        snapshot: snapshot,
                        persona: (state && state.profile && state.profile.persona) || null,
                        hourOfDay: state && state.hourOfDay,
                        monitorCount: state && state.monitorCount,
                    });
                    if (rich && rich.length > 0) {
                        observations = rich;
                        idx = 0;
                        paint();
                        // Reset the rotation timer in case observations length changed.
                        if (timer) { clearInterval(timer); timer = null; }
                        scheduleRotation();
                    }
                }
            } catch (_) {
                // Rich detection failed — stay with the W1 fallback.
            }
        }

        return { stop: function () { if (timer) { clearInterval(timer); timer = null; } } };
    }

    const api = { pickObservations: pickObservations, mount: mount };
    if (typeof window !== "undefined") window.MagicMoment = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
        module.exports.pickObservations = pickObservations;
        module.exports.mount = mount;
    }
})();
