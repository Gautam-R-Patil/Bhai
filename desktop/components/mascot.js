// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Bhai mascot — the 3D plush Bhai (sprites cut from assets/mascot/mascot-sheet.webp),
// animated like a living character rather than a sticker: it breathes, squashes
// and stretches on springs, hops and lands with a wobble, glances around, turns
// toward your pointer, waves its hand, catches light on its shades, nods when it
// talks and squishes when you poke it.
// Moods: sleepy · idle · listening · thinking · looking · working · happy · oops
// (plus idea · excited · typing · flying for one-offs).
//
// Usage: BhaiMascot.mount(hostEl, "idle"); later just set hostEl.dataset.mood.
//        BhaiMascot.react(hostEl, "boop" | "hop" | "nod" | "talk" | "wave" | "glint").
// The chat overlay (src/overlay/overlay.html) inlines this file with embedded
// sprites — run `node scripts/sync-overlay-mascot.mjs` after editing it.
(function () {
    "use strict";

    // Mood → pose sprite. Lists rotate (ROTATE_MS) for variety.
    const POSES = {
        sleepy: ["chill"],
        idle: ["hello", "hero"],
        listening: ["hero"],
        thinking: ["thinking"],
        looking: ["peek"],
        working: ["working", "typing"],
        happy: ["celebrating", "excited"],
        oops: ["thinking"],
        idea: ["idea"],
        excited: ["excited"],
        typing: ["typing"],
        flying: ["flying"],
    };
    const ROTATE_MS = { idle: 11000, working: 5200, happy: 1500 };

    // Sprite rigs, in sprite pixels. `lens` is how far down the shades go (for
    // the glint). Each limb is a hand cut at the wrist out of the body layer
    // (`hide`) and drawn on its own layer (`part`, reaching a little further down
    // the forearm so the joint never gaps) that swings around `pivot`, the wrist.
    // `role` picks how it moves.
    const RIGS = {
        hello: { w: 167, h: 146, lens: 0.45, limbs: [
            { role: "wave", pivot: [28, 64], hide: [[0, 0], [40, 0], [40, 58], [14, 68], [0, 68]], part: [[0, 0], [40, 0], [41, 62], [17, 72], [0, 72]] },
        ] },
        hero: { w: 600, h: 524, lens: 0.45, limbs: [
            { role: "point", pivot: [504, 318], hide: [[500, 160], [600, 160], [600, 340], [500, 340]], part: [[500, 160], [600, 160], [600, 340], [500, 340]] },
        ] },
        celebrating: { w: 203, h: 162, lens: 0.39, limbs: [
            { role: "flap", pivot: [27, 56], hide: [[0, 0], [36, 0], [37, 49], [16, 62], [0, 62]], part: [[0, 0], [36, 0], [38, 52], [19, 67], [0, 67]] },
            { role: "flap", pivot: [177, 71], hide: [[166, 0], [203, 0], [203, 95], [190, 95], [186, 78], [166, 63]], part: [[166, 0], [203, 0], [203, 95], [186, 95], [183, 82], [165, 67]] },
        ] },
        excited: { w: 211, h: 164, lens: 0.37, limbs: [
            { role: "flap", pivot: [36, 89], hide: [[0, 55], [41, 55], [41, 80], [30, 98], [0, 98]], part: [[0, 55], [41, 55], [42, 84], [34, 102], [0, 102]] },
            { role: "flap", pivot: [180, 72], hide: [[173, 0], [211, 0], [211, 100], [192, 100], [189, 80], [173, 62]], part: [[172, 0], [211, 0], [211, 100], [188, 100], [186, 84], [171, 66]] },
        ] },
        idea: { w: 157, h: 142, lens: 0.42, limbs: [
            { role: "wag", pivot: [22, 54], hide: [[0, 0], [34, 0], [35, 47], [10, 58], [0, 58]], part: [[0, 0], [34, 0], [36, 50], [13, 62], [0, 62]] },
        ] },
        thinking: { w: 139, h: 150, lens: 0.5 },
        working: { w: 198, h: 150, lens: 1 },     // the laptop catches the glint too
        typing: { w: 217, h: 135, lens: 1 },
        chill: { w: 205, h: 156, lens: 0.38 },
        peek: { w: 228, h: 267, lens: 0.6, shadow: 0 },
        flying: { w: 249, h: 218, lens: 0.5, shadow: 0.35 },
    };

    // Personality per mood: breathing (Hz, depth), idle sway (deg), resting
    // squash bias, how often it fidgets (s) and which fidgets it picks from.
    const MOODS = {
        sleepy:    { br: 0.16, ba: 0.034, sway: 1.4, sb: -0.03, every: [6, 11], acts: ["snore", "nodoff"] },
        idle:      { br: 0.3, ba: 0.016, sway: 1.6, sb: 0, every: [2.2, 5], acts: ["wave", "wave", "look", "look", "hop", "wiggle", "stretch", "glint", "glint"], enter: "perk" },
        listening: { br: 0.42, ba: 0.018, sway: 0.8, sb: 0.035, every: [1.8, 3.4], acts: ["nod", "glint", "point", "look"], enter: "perk" },
        thinking:  { br: 0.24, ba: 0.014, sway: 4.5, swayHz: 0.45, sb: 0, every: [2.5, 5], acts: ["hmm", "hmm", "glint"], enter: "hmm" },
        looking:   { br: 0.34, ba: 0.012, sway: 0, sb: 0.01, scan: 1, every: [1.4, 3], acts: ["glint", "glint", "hop"], enter: "glint" },
        working:   { br: 2.6, ba: 0.012, sway: 0.6, sb: 0, every: [2, 4], acts: ["nod", "glint", "wiggle"], enter: "nod" },
        happy:     { br: 0.5, ba: 0.02, sway: 2, sb: 0.02, every: [0.6, 1.1], acts: ["bighop"], flap: 1, enter: "bighop" },
        oops:      { br: 0.5, ba: 0.01, sway: 0, sb: -0.04, tilt: -6, every: [2.6, 4.5], acts: ["shake"], enter: "shake" },
        idea:      { br: 0.4, ba: 0.018, sway: 1, sb: 0.03, every: [1.4, 2.8], acts: ["wag", "hop", "glint"], enter: "hop" },
        excited:   { br: 0.5, ba: 0.02, sway: 2, sb: 0.02, every: [0.6, 1.1], acts: ["bighop"], flap: 1, enter: "bighop" },
        typing:    { br: 2.6, ba: 0.012, sway: 0.6, sb: 0, every: [2, 4], acts: ["nod", "glint"], enter: "nod" },
        flying:    { br: 0.5, ba: 0.012, sway: 2.5, sb: 0, hover: 1, every: [2, 4], acts: ["wiggle", "glint", "look"] },
    };

    const CSS = `
.bm-host { position: relative; display: inline-block; container-type: size; }
.bm-rig {
  position: absolute; left: 50%; bottom: 0;
  width: min(100cqw, calc(100cqh * var(--ar, 1)));
  height: min(100cqh, calc(100cqw / var(--ar, 1)));
  transform: translate(-50%, 0); transform-origin: 50% 100%;
  will-change: transform; pointer-events: none;
  filter: drop-shadow(0 5px 8px rgba(120, 50, 10, 0.16));
}
.bm-pose, .bm-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
.bm-layer { object-fit: fill; -webkit-user-drag: none; user-select: none; pointer-events: none; }
.bm-limb { will-change: transform; }
.bm-shadow {
  position: absolute; left: 50%; bottom: 0; pointer-events: none;
  width: calc(min(100cqw, calc(100cqh * var(--ar, 1))) * 0.56); height: 9%;
  transform: translate(-50%, 45%);
  background: radial-gradient(closest-side, rgba(110, 45, 10, 0.30), rgba(110, 45, 10, 0) 100%);
}
.bm-glint {
  opacity: 0; filter: url(#bm-lens);
  mask-image: linear-gradient(102deg, transparent 44.6%, #000 45.8%, #000 47.4%, transparent 48.6%, transparent 50%, #000 50.7%, transparent 51.5%), linear-gradient(#000 0 0);
  mask-size: 330% 100%, 100% var(--lens, 50%);
  mask-position: 100% 0, 0 0;
  mask-repeat: no-repeat;
  mask-composite: intersect;
}
.bm-glint.on { animation: bm-glint 1.05s cubic-bezier(.4, 0, .3, 1); }
@keyframes bm-glint {
  0% { opacity: 0; mask-position: 100% 0, 0 0; }
  18%, 80% { opacity: 0.92; }
  100% { opacity: 0; mask-position: 0% 0, 0 0; }
}
.bm-fx { position: absolute; inset: 0; pointer-events: none; }
.bm-fx::before, .bm-fx::after { position: absolute; opacity: 0; }

@keyframes bm-z { 0% { transform: translate(0, 0) scale(.6); opacity: 0; } 25% { opacity: .95; } 100% { transform: translate(40%, -140%) scale(1.15); opacity: 0; } }
@keyframes bm-sparkle { 0% { transform: scale(.3) rotate(0); opacity: 0; } 30% { opacity: 1; } 100% { transform: scale(1.3) rotate(90deg); opacity: 0; } }
@keyframes bm-drip { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(160%); opacity: 0; } }
@keyframes bm-dots { 0%, 100% { opacity: .35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-12%); } }
@keyframes bm-glow { 0%, 100% { opacity: .55; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.12); } }

/* sleepy — z's drift up */
[data-mood="sleepy"] .bm-fx::before, [data-mood="sleepy"] .bm-fx::after {
  content: "z"; right: 14%; top: 10%; color: #E87B2D;
  font: 800 clamp(8px, 17cqw, 30px)/1 -apple-system, BlinkMacSystemFont, sans-serif;
  animation: bm-z 3.2s ease-out infinite;
}
[data-mood="sleepy"] .bm-fx::after { content: "Z"; right: 4%; top: 2%; animation-delay: 1.6s; }
/* happy — sparkles burst */
:is([data-mood="happy"], [data-mood="excited"]) .bm-fx::before, :is([data-mood="happy"], [data-mood="excited"]) .bm-fx::after {
  content: "✦"; color: #FFC24B; left: 4%; top: 4%;
  font: 700 clamp(8px, 19cqw, 32px)/1 -apple-system, sans-serif;
  animation: bm-sparkle .9s ease-out infinite;
}
:is([data-mood="happy"], [data-mood="excited"]) .bm-fx::after { content: "✧"; left: auto; right: 2%; top: 14%; color: #FF8A5B; animation-delay: .45s; }
/* oops — a sweat drop */
[data-mood="oops"] .bm-fx::before {
  content: ""; right: 12%; top: 8%; width: 9%; height: 13%;
  background: #8FD0FF; border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%;
  animation: bm-drip 1.5s ease-in infinite;
}
/* thinking — a little thought bubble */
[data-mood="thinking"] .bm-fx::before {
  content: "•••"; right: -2%; top: -4%; color: #E87B2D; letter-spacing: 1px;
  font: 900 clamp(7px, 15cqw, 24px)/1 -apple-system, sans-serif;
  animation: bm-dots 1.2s ease-in-out infinite;
}
/* idea — the lightbulb comes on */
[data-mood="idea"] .bm-fx::before {
  content: "💡"; left: 2%; top: -6%;
  font: clamp(9px, 22cqw, 36px)/1 -apple-system, sans-serif;
  filter: drop-shadow(0 0 8px rgba(255, 210, 90, .9));
  animation: bm-glow 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .bm-glint, .bm-fx::before, .bm-fx::after { animation: none !important; }
}`;

    // Shades glint: keep only the darkest pixels (lenses, laptop) as white,
    // then a CSS mask sweeps a diagonal stripe of it across.
    const LENS_FILTER = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="bm-lens" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -5 -5 -5 0 3.6"/><feComposite in2="SourceAlpha" operator="in"/></filter></svg>';

    // Sprites live in ../assets/mascot/ relative to this script.
    const script = document.currentScript;
    const BASE = script && script.src ? new URL("../assets/mascot/", script.src).href : "assets/mascot/";
    let spriteUrl = (name) => BASE + name + ".png";

    const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    const live = new Set();
    let rafId = 0;
    let injected = false;

    function inject() {
        if (injected) return;
        injected = true;
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        const holder = document.createElement("div");
        holder.innerHTML = LENS_FILTER;
        document.body.appendChild(holder.firstChild);
        document.addEventListener("pointermove", onPointer, { passive: true });
    }

    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    // 0→1→0 bump, and an ease-in / hold / ease-out envelope.
    const bump = (p) => Math.sin(Math.PI * clamp(p, 0, 1));
    const hold = (p) => (p < 0.2 ? Math.sin((p / 0.2) * Math.PI / 2) : p > 0.8 ? Math.sin(((1 - p) / 0.2) * Math.PI / 2) : 1);
    const pct = (v, total) => +((v / total) * 100).toFixed(2) + "%";

    // ── Fidgets & reactions: each returns offsets for this frame (p = 0…1) ──
    // { tilt (deg), lean (× width), turn (deg, rotateY), sb (squash bias), limb (deg) }
    const ACTS = {
        look: { dur: () => rand(1.5, 2.3), init: (a) => { a.side = Math.random() < 0.5 ? -1 : 1; },
            f: (p, a) => ({ turn: a.side * 18 * hold(p), lean: a.side * 0.035 * hold(p), tilt: a.side * 3 * hold(p) }) },
        wiggle: { dur: () => 0.7, f: (p) => ({ tilt: Math.sin(p * Math.PI * 6) * 6 * (1 - p) }) },
        stretch: { dur: () => 1.3, f: (p) => ({ sb: 0.075 * hold(p), tilt: -2 * hold(p) }) },
        nod: { dur: () => 0.62, f: (p) => { const b = Math.abs(Math.sin(p * Math.PI * 2)); return { sb: -0.045 * b, tilt: 2.5 * b }; } },
        talk: { dur: () => 0.9, f: (p) => { const b = Math.abs(Math.sin(p * Math.PI * 3)); return { sb: -0.03 * b + 0.02, tilt: 1.5 * b }; } },
        hmm: { dur: () => rand(1.6, 2.4), init: (a) => { a.side = Math.random() < 0.5 ? -1 : 1; },
            f: (p, a) => ({ tilt: a.side * 8 * hold(p), turn: -a.side * 10 * hold(p) }) },
        shake: { dur: () => 0.9, f: (p) => ({ tilt: Math.sin(p * Math.PI * 9) * 8 * (1 - p), lean: Math.sin(p * Math.PI * 9) * 0.03 * (1 - p) }) },
        snore: { dur: () => 2.4, f: (p) => ({ sb: 0.045 * bump(p) }) },
        nodoff: { dur: () => 2.2, f: (p) => ({ tilt: p < 0.82 ? 9 * (p / 0.82) : 9 * (1 - (p - 0.82) / 0.18), sb: -0.02 }),
            end: (m) => { m.sqV += 2.4; } },
        perk: { dur: () => 0.5, f: (p) => ({ sb: 0.05 * bump(p) }) },
        wave: { dur: () => 1.7, roles: ["wave", "flap"], f: (p) => ({ limb: Math.sin(p * Math.PI * 5) * 17 * hold(p) }) },
        wag: { dur: () => 1.2, roles: ["wag"], f: (p) => ({ limb: Math.sin(p * Math.PI * 4) * 10 * hold(p) }) },
        point: { dur: () => 0.8, roles: ["point"], f: (p) => ({ limb: -11 * Math.abs(Math.sin(p * Math.PI * 2)) }) },
        glint: { dur: () => 0.1, init: (a, m) => glint(m), f: () => ({}) },
        hop: { dur: () => 0.13, f: (p) => ({ sb: -0.09 * Math.sin(p * Math.PI / 2) }), end: (m) => launch(m, 1.05) },
        bighop: { dur: () => 0.15, f: (p) => ({ sb: -0.13 * Math.sin(p * Math.PI / 2) }), end: (m) => launch(m, 1.45) },
        boop: { dur: () => 0.8, init: (a, m) => { m.sqV -= 4.5; glint(m); a.side = Math.random() < 0.5 ? -1 : 1; },
            f: (p, a) => ({ tilt: a.side * Math.sin(p * Math.PI * 5) * 7 * (1 - p), limb: Math.sin(p * Math.PI * 6) * 14 * (1 - p) }) },
    };

    function launch(m, v) {
        if (m.y > 0.001 || m.cfg.hover) return;
        m.vy = v;          // in rig-heights per second, up
        m.sqV += 2.4;      // stretch on take-off
    }

    function glint(m) {
        const g = m.glint;
        g.classList.remove("on");
        void g.offsetWidth;
        g.classList.add("on");
    }

    function play(m, name) {
        const def = ACTS[name];
        if (!def) return;
        // Limb-only acts fall back to something the current pose can do.
        if (def.roles && !m.limbs.some((l) => def.roles.includes(l.role))) {
            if (name === "wave") return play(m, m.limbs.some((l) => l.role === "point") ? "point" : "look");
            return play(m, "glint");
        }
        const a = { name, def, t0: m.t, dur: def.dur() };
        if (def.init) def.init(a, m);
        m.acts = m.acts.filter((x) => x.name !== name);
        m.acts.push(a);
    }

    // ── Poses ────────────────────────────────────────────────────────────
    function poly(points, rig) {
        return points.map(([x, y]) => pct(x, rig.w) + " " + pct(y, rig.h)).join(", ");
    }

    function buildPose(m, name) {
        const rig = RIGS[name] || RIGS.hello;
        const src = spriteUrl(name);
        m.rigEl.style.setProperty("--ar", (rig.w / rig.h).toFixed(4));
        m.host.style.setProperty("--ar", (rig.w / rig.h).toFixed(4));
        m.shadowK = rig.shadow ?? 1;
        const limbs = rig.limbs || [];
        // Body: the sprite with the swinging hands cut out (even-odd holes).
        let clip = "none";
        if (limbs.length) {
            clip = "polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%";
            for (const l of limbs) clip += ", " + poly(l.hide, rig) + ", " + poly([l.hide[0]], rig) + ", 0% 0%";
            clip += ")";
        }
        let html = `<img class="bm-layer bm-base" alt="" draggable="false" src="${src}" style="clip-path:${clip}">`;
        html += `<img class="bm-layer bm-glint" alt="" draggable="false" src="${src}" style="--lens:${Math.round(rig.lens * 100)}%">`;
        for (const l of limbs) {
            html += `<img class="bm-layer bm-limb" alt="" draggable="false" src="${src}" style="clip-path:polygon(${poly(l.part, rig)});transform-origin:${pct(l.pivot[0], rig.w)} ${pct(l.pivot[1], rig.h)}">`;
        }
        m.pose.innerHTML = html;
        m.glint = m.pose.querySelector(".bm-glint");
        const els = m.pose.querySelectorAll(".bm-limb");
        m.limbs = limbs.map((l, i) => ({ role: l.role, el: els[i], side: l.pivot[0] < rig.w / 2 ? -1 : 1 }));
        m.poseName = name;
    }

    function setPose(m, name, animate) {
        clearTimeout(m.swapTimer);
        if (m.poseName === name && m.pose.firstChild) return;
        // Only kick the springs when Bhai is on screen; otherwise impulses
        // would pile up unstepped and explode when it reappears.
        if (!animate || reduceMotion.matches || document.hidden || !m.host.offsetWidth) { buildPose(m, name); return; }
        // Anticipation: squash down, swap at the bottom, then pop up into the new pose.
        m.sqV -= 2.6;
        m.swapTimer = setTimeout(() => {
            buildPose(m, name);
            m.sqV += 3;
            m.pose.animate([{ opacity: 0.35, transform: "scale(0.94)" }, { opacity: 1, transform: "scale(1)" }],
                { duration: 220, easing: "cubic-bezier(.34, 1.56, .64, 1)" });
        }, 95);
    }

    function setMood(m, mood) {
        if (!POSES[mood]) mood = "idle";
        if (m.mood === mood) return;
        const first = !m.mood;
        m.mood = mood;
        m.cfg = MOODS[mood];
        m.poseIdx = 0;
        clearTimeout(m.rotateTimer);
        setPose(m, POSES[mood][0], !first);
        m.nextFidget = m.t + rand(0.8, 1.6) + (first ? 0.6 : 0);
        if (!first && m.cfg.enter) setTimeout(() => play(m, m.cfg.enter), 120);
        rotate(m);
    }

    function rotate(m) {
        const list = POSES[m.mood];
        if (list.length < 2 || !ROTATE_MS[m.mood]) return;
        m.rotateTimer = setTimeout(() => {
            m.poseIdx++;
            setPose(m, list[m.poseIdx % list.length], true);
            rotate(m);
        }, ROTATE_MS[m.mood] * rand(0.85, 1.15));
    }

    // ── Pointer: Bhai turns to look at you ──────────────────────────────
    function onPointer(e) {
        for (const m of live) {
            const r = m.host.getBoundingClientRect();
            if (!r.width) continue;
            const reach = Math.max(260, r.width * 4);
            m.lookX = clamp((e.clientX - (r.left + r.width / 2)) / reach, -1, 1);
            m.lookY = clamp((e.clientY - (r.top + r.height / 2)) / reach, -1, 1);
            m.lookT = m.t;
        }
    }

    // ── The frame loop: springs + actions → transforms ──────────────────
    function step(m, now) {
        const dt = Math.min(0.05, (now - (m.last || now)) / 1000);
        m.last = now;
        m.t += dt;
        const t = m.t;
        const cfg = m.cfg;
        m.sqV = clamp(m.sqV, -6, 6);

        if (t >= m.nextFidget) {
            play(m, pick(cfg.acts));
            m.nextFidget = t + rand(cfg.every[0], cfg.every[1]);
        }

        // Sum the targets: mood base + running actions + pointer attention.
        let tilt = (cfg.tilt || 0) + Math.sin(t * Math.PI * 2 * (cfg.swayHz || 0.23)) * cfg.sway;
        let lean = 0;
        let turn = 0;
        let sb = cfg.sb;
        let limb = 0;
        if (cfg.scan) {
            const s = Math.sin(t * 1.25);
            turn += s * 16;
            lean += s * 0.05;
            tilt += s * 2;
        }
        const keep = [];
        let limbAct = null;
        for (const a of m.acts) {
            const p = (t - a.t0) / a.dur;
            if (p >= 1) { if (a.def.end) a.def.end(m); continue; }
            const o = a.def.f(p, a);
            tilt += o.tilt || 0;
            lean += o.lean || 0;
            turn += o.turn || 0;
            sb += o.sb || 0;
            if (o.limb !== undefined) { limb += o.limb; limbAct = a; }
            keep.push(a);
        }
        m.acts = keep;
        const attentive = m.lookT !== undefined && t - m.lookT < 2.5 && m.mood !== "sleepy" && !cfg.scan;
        if (attentive) {
            turn += m.lookX * 16;
            tilt += m.lookX * 3;
            lean += m.lookX * 0.015;
            sb += Math.max(0, -m.lookY) * 0.02;   // stretches up a little to look up
        }

        // Springs (semi-implicit Euler). Squash is underdamped → jelly wobble.
        const k = 1 - Math.exp(-dt * 9);
        m.tilt += (tilt - m.tilt) * k;
        m.lean += (lean - m.lean) * k;
        m.turn += (turn - m.turn) * k;
        m.sqV += (-230 * (m.sq - sb) - 9 * m.sqV) * dt;
        m.sq += m.sqV * dt;

        // Hops: ballistic, then a squashy landing.
        if (cfg.hover) {
            m.y = 0.06 + Math.sin(t * 1.7) * 0.035;
        } else if (m.y > 0 || m.vy > 0) {
            m.vy -= 7.5 * dt;
            m.y += m.vy * dt;
            if (m.y <= 0) {
                m.sqV -= Math.abs(m.vy) * 1.7;
                m.y = 0;
                m.vy = 0;
            }
        }

        const breath = Math.sin(t * Math.PI * 2 * cfg.br) * cfg.ba;
        const s = clamp(m.sq + breath, -0.3, 0.3);
        const sx = 1 - s * 0.55;
        const sy = 1 + s;
        const w = m.host.clientWidth || 100;
        m.rigEl.style.transform =
            `translate(calc(-50% + ${(m.lean * 100).toFixed(2)}%), ${(-m.y * 100).toFixed(2)}%) ` +
            `perspective(${Math.round(w * 4)}px) rotateY(${m.turn.toFixed(2)}deg) rotate(${m.tilt.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

        const lift = clamp(m.y * 3.2, 0, 0.7);
        m.shadow.style.opacity = ((1 - lift) * m.shadowK).toFixed(3);
        m.shadow.style.transform = `translate(calc(-50% + ${(m.lean * 60).toFixed(2)}%), 45%) scale(${((1 - lift * 0.6) * sx).toFixed(3)}, ${(1 - lift * 0.4).toFixed(3)})`;

        // Hands: always a little alive; flapping when happy; acts drive the rest.
        for (let i = 0; i < m.limbs.length; i++) {
            const l = m.limbs[i];
            let a = Math.sin(t * 1.7 + i * 2.1) * 2.5;
            if (cfg.flap) a += Math.sin(t * 13 + i * Math.PI) * 11;
            if (limbAct && (!limbAct.def.roles || limbAct.def.roles.includes(l.role))) a += limb * (l.role === "flap" ? -l.side : 1);
            l.el.style.transform = `rotate(${a.toFixed(2)}deg)`;
        }
    }

    function frame(now) {
        rafId = 0;
        if (reduceMotion.matches) return;
        for (const m of live) {
            if (!m.host.isConnected) { live.delete(m); continue; }
            if (m.host.offsetWidth) step(m, now);
            else m.last = now;
        }
        if (live.size) rafId = requestAnimationFrame(frame);
    }

    function startLoop() {
        if (!rafId && live.size && !reduceMotion.matches) rafId = requestAnimationFrame(frame);
    }

    /** Render Bhai into `host`; afterwards just set `host.dataset.mood`. */
    function mount(host, mood) {
        inject();
        if (host._bm) { live.delete(host._bm); host._bm.observer.disconnect(); clearTimeout(host._bm.rotateTimer); }
        host.classList.add("bm-host");
        host.innerHTML = '<span class="bm-shadow"></span><div class="bm-rig"><div class="bm-pose"></div></div><span class="bm-fx" aria-hidden="true"></span>';
        const m = {
            host, rigEl: host.querySelector(".bm-rig"), pose: host.querySelector(".bm-pose"), shadow: host.querySelector(".bm-shadow"),
            t: 0, last: 0, acts: [], limbs: [], sq: 0, sqV: 0, tilt: 0, lean: 0, turn: 0, y: 0, vy: 0, shadowK: 1,
        };
        host._bm = m;
        host.dataset.mood = mood || host.dataset.mood || "idle";
        setMood(m, host.dataset.mood);
        m.observer = new MutationObserver(() => setMood(m, host.dataset.mood));
        m.observer.observe(host, { attributes: true, attributeFilter: ["data-mood"] });
        // Poke it: a squishy boop.
        host.addEventListener("pointerdown", () => play(m, "boop"));
        host.addEventListener("pointerenter", () => play(m, "perk"));
        live.add(m);
        startLoop();
    }

    /** Play a one-off reaction on a mounted mascot. */
    function react(host, name) {
        if (host && host._bm) play(host._bm, name);
    }

    /** Use embedded sprites (name → URL), e.g. data URIs in the chat overlay. */
    function setSprites(map) {
        spriteUrl = (name) => map[name] || map.hello;
        for (const m of live) buildPose(m, m.poseName);
    }

    // Reduce Motion switched on mid-animation: settle everyone at rest.
    if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", () => {
        if (reduceMotion.matches) {
            for (const m of live) {
                m.rigEl.style.transform = m.shadow.style.transform = m.shadow.style.opacity = "";
                for (const l of m.limbs) l.el.style.transform = "";
            }
        }
        startLoop();
    });

    window.BhaiMascot = { mount, react, setSprites, moods: Object.keys(POSES) };
})();
