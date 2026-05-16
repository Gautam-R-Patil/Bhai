/* ================================================================
   A.T.L.A.S onboarding — Apple-quiet-futurism direction
   ================================================================ */
(function () {
"use strict";

/* ────────────── State ────────────── */

const STEPS = [
    "awakening", "terms", "signin", "profile", "persona",
    "personalize", "permissions", "vision-tier", "install", "ready-hub"
];

const STEP_NUMS = {
    "awakening": "00", "terms": "01", "signin": "02", "profile": "03",
    "persona": "04", "personalize": "05", "permissions": "06",
    "vision-tier": "07", "install": "08", "ready-hub": "09"
};

const state = {
    stepIndex: 0,
    name: "Dheeraj",
    nameSource: "profile",   // "profile" | "os" | "none" — affects awakening greeting
    persona: null,
    hotkey: "⌥ Space",
    theme: "system",
    voice: "Aoede",
    wakeEnabled: true,
    wakePhrase: "Hey Atlas",
    personality: "casual_playful",
    permissions: { accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown" },
    permissionsSkipped: {},
    visionTier: "standard",
    timeOfDay: "evening",
    forcedPersona: "",
    audioOn: false,
};

const TOD_GREETINGS = {
    "morning":    "Good morning",
    "afternoon":  "Good afternoon",
    "evening":    "Good evening",
    "late-night": "Working late",
};

/* Build the awakening greeting from the three-tier lookup the real wizard
   uses: profile.name → osUserName (capitalized) → no-name fallback. */
function resolveGreeting() {
    const base = TOD_GREETINGS[state.timeOfDay];
    if (state.nameSource === "none") return base + ".";
    if (state.nameSource === "os") {
        const raw = (state.name || "").toLowerCase();
        const capped = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
        return capped ? base + ", " + capped + "." : base + ".";
    }
    return state.name ? base + ", " + state.name + "." : base + ".";
}

const PERSONAS = {
    developer: {
        title: "Developer",
        desc: "Terminal-first. Code-aware. Speaks git.",
        caps: ["Codebase memory across sessions", "Shell + IDE awareness", "Debug + review acceleration"],
        icon: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
    },
    founder: {
        title: "Founder",
        desc: "Calendar, comms, decisions. Move fast.",
        caps: ["Meeting summaries + decision log", "Calendar + email orchestration", "Research-to-decision in minutes"],
        icon: '<polygon points="12 2 15 8.5 22 9.5 17 14.5 18.5 22 12 18.5 5.5 22 7 14.5 2 9.5 9 8.5 12 2" stroke-linejoin="round"/>',
    },
    creator: {
        title: "Creator",
        desc: "Ideas, media, drafts. Make things.",
        caps: ["Reference + mood organization", "Script + caption generation", "Asset corral across tools"],
        icon: '<circle cx="12" cy="12" r="9"/><path d="M12 2v20M2 12h20"/>',
    },
    researcher: {
        title: "Researcher",
        desc: "Sources, citations, synthesis.",
        caps: ["Deep research across 500+ sources", "Credibility-scored citations", "Hypothesis tracking"],
        icon: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    },
    explorer: {
        title: "Explorer",
        desc: "Not sure yet — I'll learn as we go.",
        caps: ["No bias applied", "Adapts from your behavior", "You can pick a path later"],
        icon: '<polygon points="12 3 19 12 12 21 5 12 12 3"/>',
    },
};

const PERMS = [
    { key: "accessibility", name: "Accessibility", why: "So I can be summoned, anywhere.",
      icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>' },
    { key: "screen", name: "Screen", why: "So I can see what you see.",
      icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' },
    { key: "microphone", name: "Microphone", why: "So I can hear you naturally.",
      icon: '<path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>' },
    { key: "location", name: "Location", why: "So I remember where you are.",
      icon: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>' },
];

/* ────────────── DOM helpers ────────────── */

function el(tag, opts, ...children) {
    const e = document.createElement(tag);
    if (opts) {
        if (opts.class) e.className = opts.class;
        if (opts.id) e.id = opts.id;
        if (opts.text != null) e.textContent = opts.text;
        if (opts.html != null) e.innerHTML = opts.html;
        if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
        if (opts.on) for (const k in opts.on) e.addEventListener(k, opts.on[k]);
        if (opts.style) Object.assign(e.style, opts.style);
    }
    for (const c of children) {
        if (c == null) continue;
        if (typeof c === "string") e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
    }
    return e;
}

function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

function svgIcon(path, viewBox) {
    return '<svg viewBox="' + (viewBox || "0 0 24 24") + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}
function chevSvg() { return svgIcon('<polyline points="9 6 15 12 9 18"/>'); }
function arrowSvg() { return svgIcon('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'); }

/* ────────────── Folio + Indicator ────────────── */

function setFolio() {
    const folio = document.getElementById("chrome-folio");
    folio.textContent = String(state.stepIndex + 1).padStart(2, "0") + " / " + String(STEPS.length).padStart(2, "0");
}

function renderIndicator() {
    const host = document.getElementById("indicator");
    clear(host);
    for (let i = 1; i < STEPS.length; i++) {
        const cls = "indicator-dot" + (i === state.stepIndex ? " active" : i < state.stepIndex ? " done" : "");
        const dot = el("span", { class: cls, on: { click: () => jumpTo(i) } });
        host.appendChild(dot);
    }
}

/* ────────────── Iridescent rule scribe ────────────── */

function scribeRule() {
    const r = document.getElementById("iridescent-rule");
    r.classList.remove("scribe");
    void r.offsetWidth;
    r.classList.add("scribe");
}

/* ────────────── Step navigation ────────────── */

function renderStep(targetIdx, opts) {
    opts = opts || {};
    const root = document.getElementById("step-root");

    if (!opts.initial) {
        root.classList.add("leaving");
    }

    setTimeout(() => {
        /* Run cleanup hook from outgoing step (e.g. clears intervals or atmosphere class) */
        if (typeof root._cleanup === "function") {
            try { root._cleanup(); } catch (_) {}
            root._cleanup = null;
        }

        state.stepIndex = targetIdx;
        const stepId = STEPS[state.stepIndex];
        document.body.setAttribute("data-step", stepId);

        clear(root);
        root.classList.remove("leaving", "ready");
        root.classList.add("entering");

        const fn = STEP_RENDERERS[stepId];
        if (fn) fn(root);

        setFolio();
        renderIndicator();
        document.getElementById("dc-jump").value = stepId;
        if (stepId !== "awakening") scribeRule();

        const children = Array.from(root.children);
        children.forEach((c, i) => { c.style.setProperty("--enter-delay", (60 + i * 70) + "ms"); });

        requestAnimationFrame(() => {
            root.classList.remove("entering");
            requestAnimationFrame(() => root.classList.add("ready"));
        });
    }, opts.initial ? 0 : 220);
}

function advance() { if (state.stepIndex < STEPS.length - 1) renderStep(state.stepIndex + 1); }
function back()    { if (state.stepIndex > 0) renderStep(state.stepIndex - 1); }
function jumpTo(i) { if (i >= 0 && i < STEPS.length) renderStep(i); }

function actionsBar(opts) {
    opts = opts || {};
    const row = el("div", { class: "step-actions" });
    if (opts.back !== false) row.appendChild(el("button", { class: "btn btn-text", text: "Back", on: { click: back } }));
    row.appendChild(el("div", { class: "grow" }));
    if (opts.skip) row.appendChild(el("button", { class: "btn btn-link", text: opts.skip, on: { click: advance } }));
    const cta = el("button", {
        class: "btn btn-primary",
        on: { click: opts.onNext || advance },
        html: (opts.nextLabel || "Continue") + '<span class="chev">' + chevSvg() + '</span>',
    });
    row.appendChild(cta);
    return row;
}

/* ────────────── STEP RENDERERS ────────────── */

const STEP_RENDERERS = {};

/* ── 1. Awakening ── */

STEP_RENDERERS["awakening"] = function (root) {
    const wrap = el("div", { class: "awakening" });

    const glyph = el("div", { class: "awakening-glyph" });
    wrap.appendChild(glyph);

    /* Per-word reveal: build the greeting as <span class="word"> nodes with
       staggered --word-delay. CSS handles the blur-clear + lift + fade. */
    const greetText = resolveGreeting();
    const greet = el("h1", { class: "awakening-greet" });
    const words = greetText.split(/(\s+)/);
    let wordIdx = 0;
    words.forEach((token) => {
        if (/^\s+$/.test(token)) {
            greet.appendChild(el("span", { class: "space" }));
        } else if (token.length > 0) {
            const w = el("span", { class: "word", text: token });
            w.style.setProperty("--word-delay", (380 + wordIdx * 110) + "ms");
            wordIdx++;
            greet.appendChild(w);
        }
    });
    wrap.appendChild(greet);

    const iri = el("div", { class: "awakening-iri" });
    wrap.appendChild(iri);

    const status = el("div", { class: "awakening-status" });
    const swap = el("span", { class: "swap", text: "reading the room" });
    status.appendChild(swap);
    wrap.appendChild(status);

    const cta = el("div", { class: "awakening-cta" },
        el("button", {
            class: "btn btn-primary",
            on: { click: advance },
            html: 'Begin <span class="chev">' + chevSvg() + '</span>',
        }),
        el("div", { class: "hint", text: "Press ESC to skip" })
    );
    wrap.appendChild(cta);

    root.appendChild(wrap);
    root.classList.add("ready");

    const STATUS_SEQUENCE = ["reading the room", "setting the table", "ready when you are"];
    let cancelled = false;
    const timers = [];

    /* Bloom the atmosphere as the cinematic builds */
    timers.push(setTimeout(() => document.body.classList.add("atmosphere-on"), 60));

    timers.push(setTimeout(() => glyph.classList.add("in"),  120));
    timers.push(setTimeout(() => greet.classList.add("in"),  280));
    timers.push(setTimeout(() => iri.classList.add("in"),    1100));
    timers.push(setTimeout(() => status.classList.add("in"), 1450));
    timers.push(setTimeout(() => cta.classList.add("in"),    1850));

    /* Status crossfade — use the .swapping helper that triggers CSS blur */
    function swapStatusTo(text, delay) {
        timers.push(setTimeout(() => {
            if (cancelled) return;
            swap.classList.add("swapping");
            setTimeout(() => {
                swap.textContent = text;
                swap.classList.remove("swapping");
            }, 400);
        }, delay));
    }
    swapStatusTo(STATUS_SEQUENCE[1], 2700);
    swapStatusTo(STATUS_SEQUENCE[2], 3900);

    function skipNow() {
        cancelled = true;
        timers.forEach(clearTimeout);
        document.body.classList.add("atmosphere-on");
        glyph.classList.add("in");
        greet.classList.add("in");
        /* fast-forward word reveal — clear stagger so they're already visible */
        greet.querySelectorAll(".word").forEach((w) => { w.style.transition = "none"; });
        iri.classList.add("in");
        status.classList.add("in");
        swap.textContent = STATUS_SEQUENCE[2];
        cta.classList.add("in");
    }
    function onKey(e) { if (e.key === "Escape") { skipNow(); document.removeEventListener("keydown", onKey); } }
    document.addEventListener("keydown", onKey);

    /* Cleanup atmosphere class when leaving */
    root._cleanup = () => {
        document.body.classList.remove("atmosphere-on");
        document.removeEventListener("keydown", onKey);
        timers.forEach(clearTimeout);
    };
};

/* ── 2. Terms ── */

STEP_RENDERERS["terms"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Trust' }));
    root.appendChild(el("h1", { class: "step-title", text: "Read once. We won't ask again." }));
    root.appendChild(el("p", { class: "step-sub", text: "A short set of terms covering what A.T.L.A.S can do, what it stores, and how to back out." }));

    root.appendChild(el("div", { class: "terms-doc", html: `
        <h4>Terms of service</h4>
        <p>A.T.L.A.S is a personal AI agent that acts on your behalf across the channels you connect. By accepting, you authorize the agent to read, write, and execute within the scopes you grant.</p>
        <h4>Privacy</h4>
        <p>Memory and conversation history are stored locally on this device. Telemetry is anonymized and aggregated.</p>
        <h4>Acceptable use</h4>
        <p>You agree not to use A.T.L.A.S for activities that violate applicable law or the rights of others.</p>
        <h4>Disclaimer</h4>
        <p>A.T.L.A.S is software and can make mistakes. You retain responsibility for actions it takes on your behalf.</p>
        <h4>Refund</h4>
        <p>Subscriptions are refundable within 7 days of purchase, no questions asked.</p>
    `}));

    const labels = ["Terms of service", "Privacy policy", "Acceptable use", "Disclaimer", "Refund"];
    const checks = el("div", { class: "terms-checks" });
    const inputs = labels.map((lbl) => {
        const cb = el("input", { class: "checkbox", attrs: { type: "checkbox", checked: "checked" } });
        const row = el("label", { class: "check-row" }, cb, el("span", { text: "I accept the " + lbl }));
        checks.appendChild(row);
        return cb;
    });
    root.appendChild(checks);

    root.appendChild(actionsBar({
        back: false,
        nextLabel: "Accept",
        onNext: () => { if (inputs.every((i) => i.checked)) advance(); },
    }));
};

/* ── 3. Sign in ── */

STEP_RENDERERS["signin"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Identity' }));
    root.appendChild(el("h1", { class: "step-title", text: "Make this yours." }));
    root.appendChild(el("p", { class: "step-sub", text: "One tap to sync preferences and credits across your devices. No password to remember." }));

    const pane = el("div", { class: "signin-pane" });
    pane.appendChild(el("div", { class: "signin-glyph", html: svgIcon('<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>') }));

    const options = el("div", { class: "signin-options" });
    options.appendChild(el("button", { class: "signin-option", on: { click: advance }, html:
        svgIcon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/>') + '<span>Continue with email</span>' }));
    options.appendChild(el("button", { class: "signin-option", on: { click: advance }, html:
        svgIcon('<path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>') + '<span>Continue with phone</span>' }));
    pane.appendChild(options);
    pane.appendChild(el("p", { class: "signin-fineprint", text: "You can sign in later from Settings." }));
    root.appendChild(pane);

    /* No primary CTA or skip — the pane buttons ARE the primary action.
       Keep a back-only row so users can step backwards. */
    const back = el("div", { class: "step-actions" });
    back.appendChild(el("button", { class: "btn btn-text", text: "Back", on: { click: () => renderStep(state.stepIndex - 1) } }));
    root.appendChild(back);
};

/* ── 4. Profile ── */

STEP_RENDERERS["profile"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>You' }));
    root.appendChild(el("h1", { class: "step-title", text: "What should I call you?" }));
    root.appendChild(el("p", { class: "step-sub", text: "Used in greetings and when I get your attention. You can change it anytime in Settings." }));

    const field = el("div", { class: "field" },
        el("span", { class: "field-label", text: "Your name" }),
        el("input", { attrs: { type: "text", value: state.name, maxlength: "64", placeholder: "Dheeraj" } })
    );
    const input = field.querySelector("input");
    input.addEventListener("input", () => { state.name = input.value.trim() || "there"; });
    root.appendChild(field);

    root.appendChild(actionsBar({}));
};

/* ── 5. Persona ── */

STEP_RENDERERS["persona"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>How you work' }));
    root.appendChild(el("h1", { class: "step-title", text: "Pick a starting shape." }));
    root.appendChild(el("p", { class: "step-sub", text: "Shapes the examples I show, the tools I prioritize, and the way I talk. You can change this anytime." }));

    const grid = el("div", { class: "persona-grid" });
    const cards = {};
    ["developer", "founder", "creator", "researcher", "explorer"].forEach((k) => {
        const p = PERSONAS[k];
        const card = el("div", {
            class: "persona-card" + (k === "explorer" ? " explorer" : "") + (state.persona === k ? " active" : ""),
            on: { click: () => {
                state.persona = k;
                Object.entries(cards).forEach(([kk, cc]) => cc.classList.toggle("active", kk === k));
            }}
        },
            el("div", { class: "persona-icon", html: svgIcon(p.icon) }),
            el("h3", { class: "persona-title", text: p.title }),
            el("p", { class: "persona-desc", text: p.desc }),
            el("ul", { class: "persona-caps" }, ...p.caps.map((c) => el("li", { text: c })))
        );
        cards[k] = card;
        grid.appendChild(card);
    });
    root.appendChild(grid);

    root.appendChild(actionsBar({
        onNext: () => { if (!state.persona) state.persona = "explorer"; advance(); },
    }));
};

/* ── 6. Personalize ── */

STEP_RENDERERS["personalize"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Ritual' }));
    root.appendChild(el("h1", { class: "step-title", text: "How A.T.L.A.S shows up." }));
    root.appendChild(el("p", { class: "step-sub", text: "Small choices that shape every interaction — what summons it, how it sounds, the mood." }));

    const spec = el("div", { class: "spec" });

    /* Hotkey */
    const hotkeyChoices = el("div", { class: "choice-row" });
    ["⌥ Space", "⌃ Space", "⌘ .", "⌥ A"].forEach((combo) => {
        const c = el("button", {
            class: "chip" + (state.hotkey === combo ? " active" : ""),
            text: combo,
            on: { click: () => {
                state.hotkey = combo;
                hotkeyChoices.querySelectorAll(".chip").forEach((cc) => cc.classList.toggle("active", cc.textContent === combo));
            }}
        });
        hotkeyChoices.appendChild(c);
    });
    spec.appendChild(el("div", { class: "spec-row" },
        el("div", { class: "spec-label", text: "Summon gesture" }),
        el("div", { class: "spec-value" }, hotkeyChoices)
    ));

    /* Theme */
    const themeRow = el("div", { class: "theme-row" });
    const themes = [
        { v: "light",  l: "Light",  swatch: "linear-gradient(180deg, #f8f7f4, #d8d7d4)" },
        { v: "dark",   l: "Dark",   swatch: "linear-gradient(180deg, #1c1d24, #0a0b10)" },
        { v: "system", l: "System", swatch: "linear-gradient(135deg, #f8f7f4 50%, #0a0b10 50%)" },
    ];
    themes.forEach((t) => {
        const tile = el("button", {
            class: "theme-tile" + (state.theme === t.v ? " active" : ""),
            on: { click: () => {
                state.theme = t.v;
                themeRow.querySelectorAll(".theme-tile").forEach((tt, i) => tt.classList.toggle("active", themes[i].v === t.v));
            }}
        },
            el("div", { class: "theme-swatch", style: { background: t.swatch } }),
            el("span", { text: t.l })
        );
        themeRow.appendChild(tile);
    });
    spec.appendChild(el("div", { class: "spec-row" },
        el("div", { class: "spec-label", text: "Appearance" }),
        el("div", { class: "spec-value" }, themeRow)
    ));

    /* Voice */
    const voiceChoices = el("div", { class: "choice-row" });
    ["Aoede", "Charon", "Kore", "Fenrir", "Puck"].forEach((v) => {
        const c = el("button", {
            class: "chip" + (state.voice === v ? " active" : ""),
            text: v,
            on: { click: () => {
                state.voice = v;
                voiceChoices.querySelectorAll(".chip").forEach((cc) => cc.classList.toggle("active", cc.textContent === v));
            }}
        });
        voiceChoices.appendChild(c);
    });
    spec.appendChild(el("div", { class: "spec-row" },
        el("div", { class: "spec-label", text: "Voice" }),
        el("div", { class: "spec-value" }, voiceChoices)
    ));

    /* Personality */
    const presets = [
        { v: "casual_playful",       l: "Casual & playful",       ex: "lol fair point — let's give it a shot" },
        { v: "professional_concise", l: "Professional & concise", ex: "Got it. Running the analysis now." },
        { v: "warm_supportive",      l: "Warm & supportive",      ex: "That's a lot. Let's take it one step at a time." },
        { v: "direct_terse",         l: "Direct & no-nonsense",   ex: "Done. Output in /tmp/results.txt." },
    ];
    const radioList = el("div", { class: "radio-list" });
    presets.forEach((p) => {
        const row = el("div", {
            class: "radio-row" + (state.personality === p.v ? " active" : ""),
            on: { click: () => {
                state.personality = p.v;
                radioList.querySelectorAll(".radio-row").forEach((rr, i) => rr.classList.toggle("active", presets[i].v === p.v));
            }}
        },
            el("div", { class: "radio-mark" }),
            el("div", { class: "radio-text" },
                el("p", { class: "radio-name", text: p.l }),
                el("p", { class: "radio-example", text: '"' + p.ex + '"' })
            )
        );
        radioList.appendChild(row);
    });
    spec.appendChild(el("div", { class: "spec-row" },
        el("div", { class: "spec-label", text: "Tone" }),
        el("div", { class: "spec-value" }, radioList)
    ));

    /* Wake word */
    const wakeWrap = el("div");
    const switchRow = el("div", { class: "switch-row" },
        el("span", { class: "switch-label", text: "Listen for a wake word" })
    );
    const sw = el("input", { class: "switch", attrs: { type: "checkbox" } });
    sw.checked = state.wakeEnabled;
    sw.addEventListener("change", () => { state.wakeEnabled = sw.checked; phraseRow.style.display = sw.checked ? "" : "none"; });
    switchRow.appendChild(sw);
    wakeWrap.appendChild(switchRow);
    const phraseInput = el("input", { attrs: { type: "text", value: state.wakePhrase, placeholder: "Hey Atlas" } });
    phraseInput.addEventListener("input", () => state.wakePhrase = phraseInput.value);
    const phraseRow = el("div", { class: "field", style: { marginTop: "12px" } },
        el("span", { class: "field-label", text: "Phrase" }),
        phraseInput
    );
    if (!state.wakeEnabled) phraseRow.style.display = "none";
    wakeWrap.appendChild(phraseRow);
    spec.appendChild(el("div", { class: "spec-row" },
        el("div", { class: "spec-label", text: "Wake word" }),
        el("div", { class: "spec-value" }, wakeWrap)
    ));

    root.appendChild(spec);
    root.appendChild(actionsBar({}));
};

/* ── 7. Permissions ── */

STEP_RENDERERS["permissions"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Capabilities' }));
    root.appendChild(el("h1", { class: "step-title", text: "Unlock what I can do." }));
    root.appendChild(el("p", { class: "step-sub", text: "Each one is a capability, not a checkbox. Grant whatever feels right — you can revisit anytime." }));

    const list = el("div", { class: "perm-list" });
    const rows = {};
    PERMS.forEach((p) => {
        const row = el("div", { class: "perm-row" });
        const icon = el("div", { class: "perm-icon", html: svgIcon(p.icon) });
        const text = el("div", { class: "perm-text" },
            el("p", { class: "perm-name", text: p.name }),
            el("p", { class: "perm-why", text: p.why })
        );
        const actions = el("div", { class: "perm-actions" });
        const grant = el("button", { class: "btn btn-text", text: "Grant", on: { click: () => set(p.key, "granted") } });
        const skip  = el("button", { class: "btn btn-link", text: "Skip", on: { click: () => set(p.key, "skipped") } });
        actions.appendChild(grant); actions.appendChild(skip);

        row.appendChild(icon); row.appendChild(text); row.appendChild(actions);
        list.appendChild(row);
        rows[p.key] = { row, actions, grant, skip };
    });

    function set(key, kind) {
        state.permissions[key] = kind === "granted" ? "granted" : "denied";
        state.permissionsSkipped[key] = kind === "skipped";
        update(key);
    }
    function update(key) {
        const r = rows[key];
        r.row.classList.remove("granted", "skipped");
        clear(r.actions);
        if (state.permissions[key] === "granted") {
            r.row.classList.add("granted");
            r.actions.appendChild(el("span", { class: "perm-status", text: "Granted" }));
        } else if (state.permissionsSkipped[key]) {
            r.row.classList.add("skipped");
            r.actions.appendChild(el("span", { class: "perm-status", text: "Skipped" }));
            r.actions.appendChild(el("button", { class: "btn btn-link", text: "Undo", on: { click: () => unset(key) } }));
        } else {
            const grant = el("button", { class: "btn btn-text", text: "Grant", on: { click: () => set(key, "granted") } });
            const skip  = el("button", { class: "btn btn-link", text: "Skip", on: { click: () => set(key, "skipped") } });
            r.actions.appendChild(grant); r.actions.appendChild(skip);
        }
    }
    function unset(key) { state.permissions[key] = "unknown"; state.permissionsSkipped[key] = false; update(key); }

    root.appendChild(list);
    PERMS.forEach((p) => update(p.key));

    root.appendChild(actionsBar({ skip: "Skip all" }));
};

/* ── 8. Vision tier ── */

STEP_RENDERERS["vision-tier"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Sight' }));
    root.appendChild(el("h1", { class: "step-title", text: "How sharp should my eyes be?" }));
    root.appendChild(el("p", { class: "step-sub", text: "On-device vision lets me see your screen and reason about UI. Heavier tiers see more but take longer to install." }));

    const tiers = [
        { v: "lite",     l: "Lite",     size: "~200 MB", tag: "Snappy",      d: "Fast OCR + screenshot understanding. Great on older laptops without a GPU." },
        { v: "standard", l: "Standard", size: "~1.2 GB", tag: "Recommended", d: "OCR plus a lightweight vision model. Reads UI and reasons about layouts." },
        { v: "full",     l: "Full",     size: "~4.8 GB", tag: "Heavy",       d: "OCR + UI-TARS + OmniParser. Element-level grounding. Best on recent machines." },
    ];
    const list = el("div", { class: "tier-list" });
    tiers.forEach((t) => {
        const tier = el("div", {
            class: "tier" + (state.visionTier === t.v ? " active" : ""),
            on: { click: () => {
                state.visionTier = t.v;
                list.querySelectorAll(".tier").forEach((tt, i) => tt.classList.toggle("active", tiers[i].v === t.v));
            }}
        },
            el("div", { class: "tier-radio" }),
            el("div", { class: "tier-body" },
                el("div", { class: "tier-head" },
                    el("h3", { class: "tier-name", text: t.l }),
                    el("span", { class: "tier-tag", text: t.tag })
                ),
                el("p", { class: "tier-desc", text: t.d })
            ),
            el("span", { class: "tier-size", text: t.size })
        );
        list.appendChild(tier);
    });
    root.appendChild(list);
    root.appendChild(actionsBar({}));
};

/* ── 9. Install ── */

STEP_RENDERERS["install"] = function (root) {
    root.appendChild(el("div", { class: "eyebrow", html: '<span class="iri-dot"></span>Assembly' }));
    root.appendChild(el("h1", { class: "step-title", text: "Setting things up." }));

    const status = el("p", { class: "install-status", id: "demo-status", text: "Initializing…" });
    root.appendChild(status);

    const hero = el("div", { class: "install-hero" },
        el("div", { class: "install-pct", id: "demo-pct", html: '0<span class="unit">%</span>' })
    );
    root.appendChild(hero);
    const eta = el("p", { class: "install-eta", id: "demo-eta", text: "Estimating…" });
    root.appendChild(eta);

    const track = el("div", { class: "progress-track" }, el("div", { class: "progress-fill", id: "demo-bar" }));
    root.appendChild(track);

    const PHASES = [
        { id: "node",         l: "Runtime" },
        { id: "playwright",   l: "Browser engine" },
        { id: "embedding",    l: "Semantic memory" },
        { id: "sox",          l: "Audio toolkit" },
        { id: "ollama",       l: "Local model runtime" },
        { id: "vision-model", l: "Vision weights" },
        { id: "vision-deps",  l: "Vision dependencies" },
        { id: "data-dir",     l: "Data directory" },
        { id: "workspace",    l: "Workspace folder" },
        { id: "finalize",     l: "Finishing touches" },
    ];
    const list = el("ul", { class: "phase-list" });
    const rowMap = {};
    PHASES.forEach((p) => {
        const row = el("li", { class: "phase" },
            el("span", { class: "phase-dot" }),
            el("span", { class: "phase-label", text: p.l }),
            el("span", { class: "phase-tag", text: "Pending" })
        );
        rowMap[p.id] = row;
        list.appendChild(row);
    });
    root.appendChild(list);

    const fact = el("div", { class: "install-fact" },
        el("p", { class: "install-fact-eyebrow", text: "Did you know" }),
        el("p", { class: "install-fact-body", id: "demo-fact", text: "A.T.L.A.S remembers your preferences, communication style, and past conversations." })
    );
    root.appendChild(fact);

    const FACTS = [
        "A.T.L.A.S remembers your preferences, communication style, and past conversations.",
        "It automates browser tasks — form-filling, clicking, tab-switching — without you watching.",
        "It deploys multiple specialized agents to work on different parts of your task in parallel.",
        "Your data runs locally on your machine and never leaves your device.",
        "It keeps working even when your computer is closed — finishing tasks while you sleep.",
        "Sources come with credibility scores; facts are cross-referenced before you see them.",
        "It switches languages mid-sentence and auto-detects your preferred one.",
    ];
    let factIdx = 0;
    const factEl = root.querySelector("#demo-fact");
    const factTimer = setInterval(() => {
        factIdx = (factIdx + 1) % FACTS.length;
        factEl.style.opacity = "0";
        setTimeout(() => { factEl.textContent = FACTS[factIdx]; factEl.style.opacity = "1"; }, 280);
    }, 5500);

    let pct = 0;
    const startTs = Date.now();
    const totalMs = 24000;
    const bar = root.querySelector("#demo-bar");
    const pctEl = root.querySelector("#demo-pct");
    const etaEl = root.querySelector("#demo-eta");
    const statusEl = root.querySelector("#demo-status");

    function fmtEta(s) {
        if (!isFinite(s) || s < 0) return "Estimating…";
        if (s < 5) return "Almost done";
        if (s < 60) return "About " + Math.round(s) + "s remaining";
        const m = Math.floor(s / 60), r = Math.round(s % 60);
        return "About " + m + "m " + r + "s remaining";
    }

    let phaseIdx = 0;
    function tick() {
        const elapsed = Date.now() - startTs;
        pct = Math.min(100, (elapsed / totalMs) * 100);
        bar.style.width = pct + "%";
        pctEl.innerHTML = Math.round(pct) + '<span class="unit">%</span>';
        const remaining = ((100 - pct) / Math.max(0.001, pct)) * elapsed / 1000;
        etaEl.textContent = fmtEta(remaining);

        const target = Math.min(PHASES.length - 1, Math.floor(pct / (100 / PHASES.length)));
        while (phaseIdx <= target) {
            if (phaseIdx > 0) {
                const prev = rowMap[PHASES[phaseIdx - 1].id];
                prev.classList.remove("running"); prev.classList.add("done");
                prev.querySelector(".phase-tag").textContent = "Done";
            }
            const cur = rowMap[PHASES[phaseIdx].id];
            cur.classList.add("running");
            cur.querySelector(".phase-tag").textContent = "Working";
            statusEl.style.opacity = "0";
            const lab = PHASES[phaseIdx].l;
            setTimeout(() => { statusEl.textContent = lab + "…"; statusEl.style.opacity = "1"; }, 280);
            phaseIdx++;
        }

        if (pct >= 100) {
            clearInterval(loopTimer);
            clearInterval(factTimer);
            const last = rowMap[PHASES[PHASES.length - 1].id];
            last.classList.remove("running"); last.classList.add("done");
            last.querySelector(".phase-tag").textContent = "Done";
            etaEl.textContent = "Complete";
            statusEl.textContent = "All set.";
            setTimeout(advance, 700);
        }
    }
    const loopTimer = setInterval(tick, 280);
    tick();
};

/* ── 10. Ready Hub ── */

STEP_RENDERERS["ready-hub"] = function (root) {
    const wrap = el("div", { class: "hub" });

    const titleHtml = "Ready, <em>" + state.name + "</em>.";
    wrap.appendChild(el("h1", { class: "hub-title", html: titleHtml }));

    const dek = el("p", { class: "hub-dek" });
    dek.appendChild(document.createTextNode("Press "));
    dek.appendChild(el("span", { class: "hotkey", text: state.hotkey }));
    dek.appendChild(document.createTextNode(" anywhere on your computer. I'll be there."));
    wrap.appendChild(dek);

    wrap.appendChild(el("div", { class: "hub-iri" }));

    /* Magic moment */
    const OBS = computeMagicMoment();
    const mm = el("div", { class: "magic-note" });
    mm.appendChild(el("div", { class: "magic-eyebrow", html: '<span class="iri-dot"></span>I noticed something' }));
    const obsEl = el("h2", { class: "magic-obs", text: OBS[0].observation });
    const followEl = el("p", { class: "magic-follow", text: OBS[0].followup });
    mm.appendChild(obsEl); mm.appendChild(followEl);
    wrap.appendChild(mm);

    let oIdx = 0;
    const mmTimer = setInterval(() => {
        oIdx = (oIdx + 1) % OBS.length;
        obsEl.style.opacity = "0"; followEl.style.opacity = "0";
        setTimeout(() => {
            obsEl.textContent = OBS[oIdx].observation;
            followEl.textContent = OBS[oIdx].followup;
            obsEl.style.opacity = "1"; followEl.style.opacity = "1";
        }, 320);
    }, 7000);
    root._cleanup = () => clearInterval(mmTimer);

    /* Settings index */
    const index = el("div", { class: "hub-index" });
    const allGranted = Object.values(state.permissions).every((v) => v === "granted");
    const cells = [
        { label: "Account",     value: "Signed in" },
        { label: "Workspace",   value: "~/A.T.L.A.S Files" },
        { label: "Hotkey",      value: state.hotkey },
        { label: "Voice",       value: state.voice },
        { label: "Persona",     value: capitalize(state.persona || "explorer") },
        { label: "Permissions", value: allGranted ? "All granted" : "Partial",
          secondary: allGranted ? null : "Some features deferred" },
    ];
    cells.forEach((c) => {
        const cell = el("div", { class: "hub-cell" + (c.secondary ? " amber" : "") },
            el("span", { class: "hub-cell-label", text: c.label }),
            el("span", { class: "hub-cell-value", text: c.value }),
            c.secondary ? el("span", { class: "hub-cell-secondary", text: c.secondary }) : null
        );
        index.appendChild(cell);
    });
    wrap.appendChild(index);

    /* Actions */
    const acts = el("div", { class: "hub-actions" });
    acts.appendChild(el("button", {
        class: "btn btn-primary btn-launch",
        on: { click: () => alert("(demo) Launch — opens overlay") },
        html: 'Launch A.T.L.A.S <span class="chev">' + chevSvg() + '</span>',
    }));
    acts.appendChild(el("button", { class: "btn btn-secondary",
        on: { click: () => alert("(demo) Talk — starts live voice") },
        html: svgIcon('<path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>') + '<span>Talk</span>' }));
    acts.appendChild(el("button", { class: "btn btn-secondary",
        on: { click: () => alert("(demo) Type — opens overlay") },
        html: svgIcon('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>') + '<span>Type</span>' }));
    wrap.appendChild(acts);

    /* Try this */
    const trySec = el("div", { class: "try-section" },
        el("p", { class: "try-heading", text: "Try this" })
    );
    const tryList = el("div", { class: "try-list" });
    personaTryThis().forEach((t) => {
        const line = el("button", {
            class: "try-line",
            on: { click: () => alert("(demo) prompt: " + t) },
            html: '<span>' + t + '</span><span class="arrow">' + arrowSvg() + '</span>'
        });
        tryList.appendChild(line);
    });
    trySec.appendChild(tryList);
    wrap.appendChild(trySec);

    root.appendChild(wrap);
};

/* ────────────── Magic moment + try-this content ────────────── */

function computeMagicMoment() {
    const persona = state.forcedPersona || state.persona || "explorer";
    const tod = state.timeOfDay;
    const base = [];

    if (persona === "developer") base.push({ observation: "Looks like you're building something.", followup: "I'll prioritize codebase context and terminal awareness." });
    else if (persona === "founder") base.push({ observation: "You're in coordination mode.", followup: "I'll watch your calendar and surface what needs a decision." });
    else if (persona === "creator") base.push({ observation: "Creative tools open. I can keep references organized.", followup: "Drop a reference link anytime — I'll file it." });
    else if (persona === "researcher") base.push({ observation: "Sources on screen. I can chase the citations.", followup: "Tell me what you're investigating and I'll widen the net." });
    else base.push({ observation: "Workspace mapped. Ready when you are.", followup: "Talk to me however feels right — I'll learn." });

    if (tod === "late-night") base.push({ observation: "Late-night session. I'll keep things minimal.", followup: "Voice off by default. Hotkey-quiet mode." });
    else if (tod === "morning") base.push({ observation: "Fresh start. Want me to brief the day?", followup: "Calendar, inbox, what's overdue — in under ninety seconds." });

    base.push({ observation: "Dark mode and three monitors detected.", followup: "I'll spread out when I need to." });
    base.push({ observation: "Chrome's your daily driver.", followup: "I'll learn its tabs first." });
    return base.slice(0, 4);
}

function personaTryThis() {
    const persona = state.forcedPersona || state.persona || "explorer";
    const map = {
        developer:  ["Explain this codebase", "Summarize the last 10 commits", "Find usages of `runAgent`", "Run the tests and triage failures"],
        founder:    ["Prep me for my 10am", "Summarize unread email", "Draft a response to the latest investor thread", "What decisions am I behind on?"],
        creator:    ["Organize my reference tabs", "Draft five captions for this", "Find similar work I've referenced before", "Brainstorm ten angles on this idea"],
        researcher: ["Find the three strongest sources on X", "Score these citations for credibility", "Build a hypothesis tree", "What contradicts this claim?"],
        explorer:   ["Summarize my current screen", "Organize my tabs", "Catch me up on what changed today", "What can you do?"],
    };
    return map[persona] || map.explorer;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

/* ────────────── Demo controls ────────────── */

function wireDemoControls() {
    document.getElementById("dc-jump").addEventListener("change", (e) => {
        const idx = STEPS.indexOf(e.target.value);
        if (idx >= 0) jumpTo(idx);
    });
    document.getElementById("dc-tod").addEventListener("change", (e) => {
        state.timeOfDay = e.target.value;
        const cur = STEPS[state.stepIndex];
        if (cur === "awakening" || cur === "ready-hub") renderStep(state.stepIndex, { initial: true });
    });
    document.getElementById("dc-name-source").addEventListener("change", (e) => {
        state.nameSource = e.target.value;
        if (STEPS[state.stepIndex] === "awakening") renderStep(state.stepIndex, { initial: true });
    });
    /* Theme override: "auto" removes the attribute so prefers-color-scheme
       takes over; "light" / "dark" force the theme. */
    document.getElementById("dc-theme").addEventListener("change", (e) => {
        const v = e.target.value;
        if (v === "auto") document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", v);
    });
    /* Reflect the OS preference on first load so the dropdown isn't misleading. */
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    function syncThemeDropdown() {
        const dd = document.getElementById("dc-theme");
        if (dd.value === "auto") {
            const hint = mq.matches ? " (system: light)" : " (system: dark)";
            dd.options[0].textContent = "Auto" + hint;
        }
    }
    syncThemeDropdown();
    mq.addEventListener("change", syncThemeDropdown);
    document.getElementById("dc-persona").addEventListener("change", (e) => {
        state.forcedPersona = e.target.value;
        if (STEPS[state.stepIndex] === "ready-hub") renderStep(state.stepIndex, { initial: true });
    });
    document.getElementById("dc-nudge").addEventListener("click", showDay2Nudge);
    document.getElementById("dc-reset").addEventListener("click", () => {
        state.persona = null;
        Object.keys(state.permissions).forEach((k) => state.permissions[k] = "unknown");
        Object.keys(state.permissionsSkipped).forEach((k) => state.permissionsSkipped[k] = false);
        renderStep(0, { initial: true });
    });
    document.getElementById("dc-toggle").addEventListener("click", () => {
        document.getElementById("demo-controls").classList.toggle("collapsed");
    });
    document.getElementById("audio-toggle").addEventListener("click", () => {
        state.audioOn = !state.audioOn;
        const btn = document.getElementById("audio-toggle");
        btn.style.color = state.audioOn ? "var(--ink-0)" : "";
    });
}

function showDay2Nudge() {
    const host = document.getElementById("nudge-host");
    clear(host);
    const nudge = el("div", { class: "nudge" });
    nudge.appendChild(el("div", { class: "nudge-from", html: '<span class="iri-dot"></span>A.T.L.A.S · Day 2' }));
    nudge.appendChild(el("div", { class: "nudge-body",
        text: "I noticed you've been using " + state.hotkey + " a lot. Want me to personalize shortcuts based on your workflow?" }));
    const acts = el("div", { class: "nudge-actions" });
    acts.appendChild(el("button", {
        class: "btn btn-primary",
        html: 'Personalize <span class="chev">' + chevSvg() + '</span>',
        on: { click: () => { dismissNudge(); jumpTo(STEPS.indexOf("personalize")); } }
    }));
    acts.appendChild(el("button", { class: "btn btn-text", text: "Not now", on: { click: dismissNudge } }));
    acts.appendChild(el("button", { class: "nudge-dismiss", text: "Don't suggest more", on: { click: dismissNudge } }));
    nudge.appendChild(acts);
    host.appendChild(nudge);
    requestAnimationFrame(() => nudge.classList.add("in"));
}
function dismissNudge() {
    const host = document.getElementById("nudge-host");
    const n = host.querySelector(".nudge");
    if (!n) return;
    n.classList.remove("in");
    setTimeout(() => clear(host), 500);
}

/* ────────────── Boot ────────────── */

document.addEventListener("DOMContentLoaded", () => {
    wireDemoControls();
    renderStep(0, { initial: true });
});

})();
