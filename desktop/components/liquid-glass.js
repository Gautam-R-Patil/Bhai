// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// Liquid Glass for panel.html (body.hig). Three jobs:
//  1. Refraction. Each big glass surface gets an SVG <filter> sized in pixels
//     to its border box. The filter's feImage is a displacement map drawn on a
//     canvas from a rounded-rect signed distance field run through a convex
//     bezel profile: pixels near the rim sample the backdrop from further in
//     (strongest at the rim, zero `bezel` px in, flat clear centre), so the
//     backdrop bends and magnifies along the edges and corners like a thick
//     glass bezel. Applied as `backdrop-filter: blur() url(#lg-N) …` via the
//     --lg-refract custom property (styles.css falls back to plain blur when
//     it is unset). Maps are encoded once per (size, radius, bezel) and shared
//     by every element of that size; a ResizeObserver keeps them current.
//  2. Specular that follows the pointer: --lg-x / --lg-y on the glass under it.
//  3. The droplet nav indicator: `LiquidGlass.slide(pill, item)`.
(function () {
    'use strict';

    // ── 1. Refraction maps ───────────────────────────────────────────
    // Displacement weight across the bezel: t = 0 at the rim → 1 inside.
    // (1 − t)² with zero slope at t = 1 so the bezel melts into the flat centre.
    const profile = (t) => (1 - t) * (1 - t);
    const NEUTRAL = 0x8080; // R = G = 128: no displacement

    // Map value for pixel (x, y) of a w×h box with corner radius r: the inward
    // normal of a rounded-rect signed distance field, weighted by the bezel
    // profile and packed as (G << 8) | R. feDisplacementMap reads R as x and G
    // as y, so R > 128 pulls the backdrop from the right (inward on the left).
    function displacementAt(x, y, w, h, r, bezel) {
        const hx = w / 2, hy = h / 2;
        const cx = x + 0.5 - hx, cy = y + 0.5 - hy;
        const qx = Math.abs(cx) - (hx - r), qy = Math.abs(cy) - (hy - r);
        let d, nx, ny; // SDF (negative inside) and outward normal in |p| space
        if (qx > 0 && qy > 0) {
            const l = Math.hypot(qx, qy);
            d = l - r; nx = qx / l; ny = qy / l;
        } else if (qx > qy) {
            d = qx - r; nx = 1; ny = 0;
        } else {
            d = qy - r; nx = 0; ny = 1;
        }
        const t = -d / bezel;
        if (t >= 1) return NEUTRAL; // flat centre
        const k = 127 * profile(t < 0 ? 0 : t);
        // Inward = minus the outward normal, mirrored back into the quadrant.
        const R = 128 + Math.round(k * nx * (cx < 0 ? 1 : -1));
        const G = 128 + Math.round(k * ny * (cy < 0 ? 1 : -1));
        return (G << 8) | R;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { displacementAt };
        // `node desktop/components/liquid-glass.js` checks the map math.
        if (require.main === module) {
            const assert = require('node:assert');
            const at = (x, y) => { const v = displacementAt(x, y, 200, 100, 20, 16); return [v & 0xff, v >> 8]; };
            assert.deepEqual(at(100, 50), [128, 128], 'flat centre');
            assert.ok(at(0, 50)[0] > 200 && at(199, 50)[0] < 56, 'left/right rims push inward');
            assert.ok(at(100, 0)[1] > 200 && at(100, 99)[1] < 56, 'top/bottom rims push inward');
            assert.ok(at(0, 50)[0] > at(8, 50)[0] && at(8, 50)[0] > 128 && at(16, 50)[0] === 128, 'fades to zero across the bezel');
            const c = at(6, 6);
            assert.ok(c[0] > 128 && Math.abs(c[0] - c[1]) <= 1, 'corners bend along the diagonal');
            console.log('liquid-glass map: ok');
        }
    }
    if (typeof window === 'undefined') return; // node (tests): the pure math is all there is

    const SVGNS = 'http://www.w3.org/2000/svg';
    // Real refraction only on the big surfaces + a few controls that sit
    // directly on the orbs (nested glass has no orbs behind it to bend).
    const REFRACT = [
        ['.panel-sidebar, .status-card', 22, 0.7],
        ['.stat-card, .info-cards, .pref-section, .about-hero, .about-details, .account-profile-card, .auth-card, .coming-soon-section', 18, 0.65],
        ['.connection-item', 9, 0.6],
    ]; // [selector, bezel px, max displacement as a fraction of the bezel]
    // Above ½ the outermost band folds back on itself (a thin mirrored rim, like
    // real thick glass); the rest of the bezel magnifies.
    // Everything that wears the glass material (pointer-tracked specular).
    const GLASS = '.panel-sidebar, .surface-card, .info-cards, .settings-section, .coming-soon-section, .update-banner, .installed-item, .connection-item, .btn';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    function drawMap(w, h, r, bezel) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        const px = new Uint32Array(img.data.buffer); // little-endian: 0xAABBGGRR
        for (let y = 0, i = 0; y < h; y++) {
            for (let x = 0; x < w; x++, i++) px[i] = 0xff800000 | displacementAt(x, y, w, h, r, bezel);
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
    }

    let defs = null;
    let seq = 0;
    const filters = new Map(); // key → { id, node, refs }
    const applied = new WeakMap(); // element → key

    function acquire(w, h, r, bezel, scale) {
        const key = `${w}x${h}r${r}b${bezel}s${scale}`;
        let f = filters.get(key);
        if (!f) {
            if (!defs) {
                defs = document.createElementNS(SVGNS, 'svg');
                defs.setAttribute('class', 'lg-defs');
                defs.setAttribute('aria-hidden', 'true');
                defs.setAttribute('focusable', 'false');
                document.body.appendChild(defs);
            }
            const id = `lg-${seq++}`;
            const node = document.createElementNS(SVGNS, 'filter');
            const attrs = { id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' };
            for (const k in attrs) node.setAttribute(k, attrs[k]);
            const map = document.createElementNS(SVGNS, 'feImage');
            for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map', href: drawMap(w, h, r, bezel) })) map.setAttribute(k, v);
            const disp = document.createElementNS(SVGNS, 'feDisplacementMap');
            // offset = scale·(C − ½) and C − ½ ≈ ½·weight, so scale = 2 × max offset.
            for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'map', scale: 2 * scale, xChannelSelector: 'R', yChannelSelector: 'G' })) disp.setAttribute(k, v);
            node.append(map, disp);
            defs.appendChild(node);
            f = { id, node, refs: 0 };
            filters.set(key, f);
        }
        f.refs++;
        return { key, id: f.id };
    }

    function release(key) {
        const f = filters.get(key);
        if (f && --f.refs <= 0) {
            f.node.remove();
            filters.delete(key);
        }
    }

    function refract(el, bezelMax, ratio) {
        const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
        if (!w || !h) return; // hidden tab: keep the last filter, it fits again on return
        const cs = getComputedStyle(el);
        const r = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
        const bezel = Math.max(4, Math.min(bezelMax, Math.floor(Math.min(w, h) / 2)));
        const scale = Math.round(bezel * ratio);
        const prev = applied.get(el);
        const next = acquire(w, h, Math.round(r), bezel, scale);
        if (prev) release(prev);
        applied.set(el, next.key);
        el.style.setProperty('--lg-refract', `url(#${next.id})`);
    }

    function initRefraction() {
        if (!(window.CSS && CSS.supports('backdrop-filter', 'url(#lg) blur(1px)')) || !window.ResizeObserver) return;
        const spec = new Map(); // element → [bezel, ratio]
        for (const [sel, bezel, ratio] of REFRACT) {
            document.querySelectorAll(sel).forEach((el) => { if (!spec.has(el)) spec.set(el, [bezel, ratio]); });
        }
        // Re-encode only once a size has settled (window drags fire every frame).
        const pending = new Set();
        let timer = 0;
        const flush = () => { pending.forEach((el) => refract(el, ...spec.get(el))); pending.clear(); };
        const ro = new ResizeObserver((entries) => {
            // The lens is fixed-size: drop it while a real resize is under way (plain
            // frost until it settles). Hiding (0×0) or an unchanged size keeps it.
            for (const e of entries) {
                const box = e.borderBoxSize && e.borderBoxSize[0];
                const w = box ? Math.round(box.inlineSize) : 0, h = box ? Math.round(box.blockSize) : 0;
                const key = applied.get(e.target);
                if (w && h && !(key && key.startsWith(`${w}x${h}r`))) e.target.style.removeProperty('--lg-refract');
                pending.add(e.target);
            }
            clearTimeout(timer);
            timer = setTimeout(flush, 140);
        });
        spec.forEach((_, el) => ro.observe(el, { box: 'border-box' }));
        // ponytail: static element list; add a MutationObserver if glass cards start being inserted at runtime.
    }

    // ── 2. Pointer-tracked specular ──────────────────────────────────
    let lastMove = null, moveRaf = 0, lit = [];
    function track() {
        moveRaf = 0;
        const e = lastMove;
        const next = [];
        for (let el = e.target instanceof Element ? e.target.closest(GLASS) : null; el; el = el.parentElement && el.parentElement.closest(GLASS)) next.push(el);
        for (const el of lit) {
            if (!next.includes(el)) { el.style.removeProperty('--lg-x'); el.style.removeProperty('--lg-y'); }
        }
        for (const el of next) {
            const b = el.getBoundingClientRect();
            el.style.setProperty('--lg-x', `${(e.clientX - b.left).toFixed(1)}px`);
            el.style.setProperty('--lg-y', `${(e.clientY - b.top).toFixed(1)}px`);
        }
        lit = next;
    }
    function onMove(e) {
        lastMove = e;
        if (!moveRaf) moveRaf = requestAnimationFrame(track);
    }

    // ── 3. Droplet nav indicator ─────────────────────────────────────
    // Top and bottom edges ride separate springs: the leading edge is stiff and
    // bouncy, the trailing edge soft, so the pill stretches toward the target,
    // thins while stretched (volume kept), then settles with a small wobble.
    const LEAD = { k: 520, c: 2 * Math.sqrt(520) * 0.55 };
    const TRAIL = { k: 190, c: 2 * Math.sqrt(190) * 0.85 };

    function paintPill(pill, s) {
        const len = Math.max(s.h * 0.55, s.b - s.a);
        const stretch = (len - s.h) / s.h;
        const sx = Math.max(0.9, Math.min(1.06, 1 - stretch * 0.07));
        pill.style.height = `${len.toFixed(2)}px`;
        pill.style.transform = `translateY(${s.a.toFixed(2)}px) scaleX(${sx.toFixed(4)})`;
    }

    function slide(pill, item) {
        const ta = item.offsetTop, h = item.offsetHeight, tb = ta + h;
        let s = pill._lg;
        if (!s || reduce.matches) {
            if (s && s.raf) cancelAnimationFrame(s.raf);
            s = pill._lg = { a: ta, b: tb, va: 0, vb: 0, ta, tb, h, raf: 0 };
            paintPill(pill, s);
            return;
        }
        Object.assign(s, { ta, tb, h, down: ta > s.a });
        if (s.raf) return;
        pill.classList.add('lg-moving');
        let last = performance.now();
        const step = (now) => {
            let dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const top = s.down ? TRAIL : LEAD, bot = s.down ? LEAD : TRAIL;
            for (; dt > 0; dt -= 0.004) { // 4 ms substeps keep the stiff spring stable
                const h = Math.min(0.004, dt);
                s.va += (-top.k * (s.a - s.ta) - top.c * s.va) * h; s.a += s.va * h;
                s.vb += (-bot.k * (s.b - s.tb) - bot.c * s.vb) * h; s.b += s.vb * h;
            }
            const settled = Math.abs(s.a - s.ta) < 0.05 && Math.abs(s.b - s.tb) < 0.05 && Math.abs(s.va) < 1 && Math.abs(s.vb) < 1;
            if (settled) { s.a = s.ta; s.b = s.tb; s.va = s.vb = 0; }
            paintPill(pill, s);
            if (settled) { s.raf = 0; pill.classList.remove('lg-moving'); }
            else s.raf = requestAnimationFrame(step);
        };
        s.raf = requestAnimationFrame(step);
    }

    function init() {
        initRefraction();
        document.addEventListener('pointermove', onMove, { passive: true });
        document.documentElement.addEventListener('pointerleave', () => { lastMove = { target: null }; if (!moveRaf) moveRaf = requestAnimationFrame(track); });
    }

    window.LiquidGlass = { slide };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
