// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai mascot — the 3D plush Bhai (sprites cut from assets/mascot/mascot-sheet.webp)
// animated by mood: sleepy · idle · listening · thinking · looking · working ·
// happy · oops (plus idea · excited · typing · flying for one-offs).
//
// Usage: BhaiMascot.mount(hostEl, "idle"); later just set hostEl.dataset.mood.
// The chat overlay (src/overlay/overlay.html) inlines this file with embedded
// sprites — run `node scripts/sync-overlay-mascot.mjs` after editing it.
(function () {
    "use strict";

    // Mood → pose sprite. Arrays rotate through poses for a bit of life.
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
    const ROTATE_MS = { idle: 7000, working: 5000, happy: 900 };

    const CSS = `
.bm-host { position: relative; display: inline-block; container-type: size; }
.bm-float, .bm-img, .bm-fx { position: absolute; inset: 0; }
.bm-float { transform-origin: 50% 92%; will-change: transform; }
.bm-img {
  width: 100%; height: 100%; object-fit: contain; object-position: 50% 100%;
  transform-origin: 50% 92%;
  filter: drop-shadow(0 6px 10px rgba(120, 50, 10, 0.18));
  -webkit-user-drag: none; user-select: none; pointer-events: none;
}
.bm-img.bm-pop { animation: bm-pop 460ms cubic-bezier(.34, 1.56, .64, 1); }
.bm-fx { pointer-events: none; }
.bm-fx::before, .bm-fx::after { position: absolute; opacity: 0; }

@keyframes bm-pop { 0% { transform: scale(.8) translateY(8%); opacity: .3; } 60% { transform: scale(1.07); opacity: 1; } 100% { transform: scale(1); } }
@keyframes bm-float { 0%, 100% { transform: translateY(0) rotate(-1.2deg); } 50% { transform: translateY(-4%) rotate(1.2deg); } }
@keyframes bm-rock { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg) translateY(-1%); } }
@keyframes bm-lean { 0%, 100% { transform: translateX(-2%) rotate(-2deg); } 50% { transform: translateX(3%) rotate(2deg) scale(1.03); } }
@keyframes bm-busy { 0%, 100% { transform: translateY(0) scale(1, 1); } 35% { transform: translateY(-3%) scale(.98, 1.02); } 70% { transform: translateY(0) scale(1.02, .98); } }
@keyframes bm-hop { 0%, 100% { transform: translateY(0) scale(1, 1); } 30% { transform: translateY(-14%) scale(.95, 1.06); } 55% { transform: translateY(0) scale(1.08, .92); } 72% { transform: translateY(-3%); } }
@keyframes bm-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.03, .97); } }
@keyframes bm-shake { 0%, 100% { transform: translateX(0) rotate(-4deg); } 20% { transform: translateX(-4%) rotate(-7deg); } 40% { transform: translateX(4%) rotate(-1deg); } 60% { transform: translateX(-3%) rotate(-6deg); } 80% { transform: translateX(2%) rotate(-3deg); } }
@keyframes bm-z { 0% { transform: translate(0, 0) scale(.6); opacity: 0; } 25% { opacity: .95; } 100% { transform: translate(40%, -140%) scale(1.15); opacity: 0; } }
@keyframes bm-sparkle { 0% { transform: scale(.3) rotate(0); opacity: 0; } 30% { opacity: 1; } 100% { transform: scale(1.3) rotate(90deg); opacity: 0; } }
@keyframes bm-drip { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(160%); opacity: 0; } }
@keyframes bm-dots { 0%, 100% { opacity: .35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-12%); } }
@keyframes bm-glow { 0%, 100% { opacity: .55; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.12); } }

[data-mood="idle"] .bm-float, [data-mood="excited"] .bm-float, [data-mood="flying"] .bm-float { animation: bm-float 3.6s ease-in-out infinite; }
[data-mood="listening"] .bm-float { transform: rotate(5deg) scale(1.04); }
[data-mood="thinking"] .bm-float, [data-mood="idea"] .bm-float { animation: bm-rock 2.8s ease-in-out infinite; }
[data-mood="looking"] .bm-float { animation: bm-lean 2.4s ease-in-out infinite; }
[data-mood="working"] .bm-float, [data-mood="typing"] .bm-float { animation: bm-busy .7s ease-in-out infinite; }
[data-mood="happy"] .bm-float { animation: bm-hop .8s cubic-bezier(.34, 1.56, .64, 1) 2; }
[data-mood="sleepy"] .bm-float { animation: bm-breathe 4.8s ease-in-out infinite; }
[data-mood="oops"] .bm-float { animation: bm-shake .55s ease-in-out 3; transform: rotate(-4deg); }

/* sleepy — z's drift up */
[data-mood="sleepy"] .bm-fx::before, [data-mood="sleepy"] .bm-fx::after {
  content: "z"; right: 14%; top: 10%; color: #E87B2D;
  font: 800 clamp(8px, 17cqw, 30px)/1 -apple-system, BlinkMacSystemFont, sans-serif;
  animation: bm-z 3.2s ease-out infinite;
}
[data-mood="sleepy"] .bm-fx::after { content: "Z"; right: 4%; top: 2%; animation-delay: 1.6s; }
/* happy — sparkles burst */
[data-mood="happy"] .bm-fx::before, [data-mood="happy"] .bm-fx::after {
  content: "✦"; color: #FFC24B; left: 4%; top: 4%;
  font: 700 clamp(8px, 19cqw, 32px)/1 -apple-system, sans-serif;
  animation: bm-sparkle .9s ease-out infinite;
}
[data-mood="happy"] .bm-fx::after { content: "✧"; left: auto; right: 2%; top: 14%; color: #FF8A5B; animation-delay: .45s; }
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
/* idea — the lightbulb comes back on */
[data-mood="idea"] .bm-fx::before {
  content: "💡"; left: 2%; top: -6%;
  font: clamp(9px, 22cqw, 36px)/1 -apple-system, sans-serif;
  filter: drop-shadow(0 0 8px rgba(255, 210, 90, .9));
  animation: bm-glow 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .bm-float, .bm-img, .bm-fx::before, .bm-fx::after { animation: none !important; }
}`;

    let spriteUrl = (name) => BASE + name + ".png";
    // Sprites live in ../assets/mascot/ relative to this script.
    const script = document.currentScript;
    const BASE = script && script.src ? new URL("../assets/mascot/", script.src).href : "assets/mascot/";

    let styleInjected = false;
    function injectStyle() {
        if (styleInjected) return;
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        styleInjected = true;
    }

    function render(host) {
        const mood = POSES[host.dataset.mood] ? host.dataset.mood : "idle";
        const poses = POSES[mood];
        clearTimeout(host._bmTimer);
        let i = 0;
        const show = () => {
            const img = host.querySelector(".bm-img");
            const src = spriteUrl(poses[i % poses.length]);
            if (img.getAttribute("src") !== src) {
                img.classList.remove("bm-pop");
                void img.offsetWidth; // restart the pop animation
                img.setAttribute("src", src);
                img.classList.add("bm-pop");
            }
            if (poses.length > 1 && ROTATE_MS[mood]) {
                host._bmTimer = setTimeout(() => { i++; show(); }, ROTATE_MS[mood]);
            }
        };
        show();
    }

    /** Render Bhai into `host`; afterwards just set `host.dataset.mood`. */
    function mount(host, mood) {
        injectStyle();
        host.classList.add("bm-host");
        host.innerHTML = '<div class="bm-float"><img class="bm-img" alt="" draggable="false"></div><span class="bm-fx" aria-hidden="true"></span>';
        host.dataset.mood = mood || host.dataset.mood || "idle";
        render(host);
        if (host._bmObserver) host._bmObserver.disconnect();
        host._bmObserver = new MutationObserver(() => render(host));
        host._bmObserver.observe(host, { attributes: true, attributeFilter: ["data-mood"] });
    }

    /** Use embedded sprites (name → URL), e.g. data URIs in the chat overlay. */
    function setSprites(map) {
        spriteUrl = (name) => map[name] || map.hello;
    }

    window.BhaiMascot = { mount, setSprites, moods: Object.keys(POSES) };
})();
