// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The cinematic opener. Greets the user by OS-detected name, then a single
// iridescent rule scribes beneath, then status text rotates, then CTA.
// Total runtime ~2.5s. ESC fast-forwards.
(function () {
    "use strict";

    const TOD = {
        "morning": "Good morning", "afternoon": "Good afternoon",
        "evening": "Good evening", "late-night": "Working late",
    };

    function timeOfDay(d) {
        const h = (d || new Date()).getHours();
        if (h >= 5 && h < 12)  return "morning";
        if (h >= 12 && h < 17) return "afternoon";
        if (h >= 17 && h < 23) return "evening";
        return "late-night";
    }

    // Three-tier name lookup: stored profile → OS-detected (capitalized) → null.
    function resolveName(state) {
        const profile = (state && state.profile) || {};
        if (profile.name) return profile.name;
        const os = (state && state.osUserName) || "";
        if (!os) return null;
        const lc = os.toLowerCase();
        return lc.charAt(0).toUpperCase() + lc.slice(1);
    }

    function buildGreeting(state) {
        const base = TOD[timeOfDay()];
        const name = resolveName(state);
        return name ? base + ", " + name + "." : base + ".";
    }

    function svgChev() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>';
    }

    function render(root, ctx) {
        const Copy = window.Copy;
        const state = (ctx && ctx.state) || {};

        const wrap = document.createElement("div");
        wrap.className = "awakening";

        const glyph = document.createElement("div");
        glyph.className = "awakening-glyph";
        wrap.appendChild(glyph);

        const greet = document.createElement("h1");
        greet.className = "awakening-greet";
        const greetText = buildGreeting(state);
        const tokens = greetText.split(/(\s+)/);
        let wordIdx = 0;
        tokens.forEach(function (t) {
            if (/^\s+$/.test(t)) {
                const sp = document.createElement("span");
                sp.className = "space";
                greet.appendChild(sp);
            } else if (t.length) {
                const w = document.createElement("span");
                w.className = "word";
                w.textContent = t;
                w.style.setProperty("--word-delay", (380 + wordIdx * 110) + "ms");
                wordIdx++;
                greet.appendChild(w);
            }
        });
        wrap.appendChild(greet);

        const iri = document.createElement("div");
        iri.className = "awakening-iri";
        wrap.appendChild(iri);

        const status = document.createElement("div");
        status.className = "awakening-status";
        const swap = document.createElement("span");
        swap.className = "swap";
        swap.textContent = Copy.get("awakening", "status1");
        status.appendChild(swap);
        wrap.appendChild(status);

        const cta = document.createElement("div");
        cta.className = "awakening-cta";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-primary";
        btn.innerHTML = Copy.get("awakening", "cta") + ' <span class="chev">' + svgChev() + '</span>';
        btn.addEventListener("click", function () {
            if (ctx && typeof ctx.onAdvance === "function") ctx.onAdvance();
        });
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = Copy.get("awakening", "hint");
        cta.appendChild(btn);
        cta.appendChild(hint);
        wrap.appendChild(cta);

        root.appendChild(wrap);
        // Skip the default cascade entry — this step has its own timeline.
        root.classList.add("ready");

        // ---- Timeline ----
        const SEQ = [Copy.get("awakening", "status2"), Copy.get("awakening", "status3")];
        let cancelled = false;
        const timers = [];

        timers.push(setTimeout(function () { document.body.classList.add("atmosphere-on"); }, 60));
        timers.push(setTimeout(function () { glyph.classList.add("in");  }, 120));
        timers.push(setTimeout(function () { greet.classList.add("in");  }, 280));
        timers.push(setTimeout(function () { iri.classList.add("in");    }, 1100));
        timers.push(setTimeout(function () {
            if (window.WizardAudio && window.WizardAudio.play) window.WizardAudio.play("awakeningChime");
        }, 1450));
        timers.push(setTimeout(function () { status.classList.add("in"); }, 1450));
        timers.push(setTimeout(function () { cta.classList.add("in");    }, 1850));

        function swapTo(text, delay) {
            timers.push(setTimeout(function () {
                if (cancelled) return;
                swap.classList.add("swapping");
                setTimeout(function () {
                    swap.textContent = text;
                    swap.classList.remove("swapping");
                }, 400);
            }, delay));
        }
        swapTo(SEQ[0], 2700);
        swapTo(SEQ[1], 3900);

        function onKey(e) {
            if (e.key !== "Escape") return;
            cancelled = true;
            timers.forEach(clearTimeout);
            document.body.classList.add("atmosphere-on");
            glyph.classList.add("in"); greet.classList.add("in");
            greet.querySelectorAll(".word").forEach(function (w) { w.style.transition = "none"; });
            iri.classList.add("in"); status.classList.add("in");
            swap.textContent = SEQ[1];
            cta.classList.add("in");
            document.removeEventListener("keydown", onKey);
        }
        document.addEventListener("keydown", onKey);

        root._cleanup = function () {
            cancelled = true;
            timers.forEach(clearTimeout);
            document.body.classList.remove("atmosphere-on");
            document.removeEventListener("keydown", onKey);
        };
    }

    if (typeof window !== "undefined") {
        window.WizardSteps = window.WizardSteps || {};
        window.WizardSteps.awakening = { render: render };
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { render: render, _internals: { resolveName: resolveName, buildGreeting: buildGreeting, timeOfDay: timeOfDay } };
    }
})();
