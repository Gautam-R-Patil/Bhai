// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "Mark up page": lets the user draw on the visible page so Bhai sees what they
// mean. Injected on demand into the extension's isolated world; the background
// worker reads window.__bhaiDraw (hasInk / remove) around taking the screenshot.

(() => {
  if (window.__bhaiDraw) { window.__bhaiDraw.edit(); return; }

  const COLOR = '#f97316';
  const root = document.createElement('div');
  root.id = '__bhai_draw';
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;';
  root.appendChild(canvas);

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:center;' +
    'background:#1b1410;color:#fff;padding:6px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.3);' +
    'font:500 13px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;';
  const hint = document.createElement('span');
  hint.textContent = 'Draw on the page for Bhai';
  hint.style.cssText = 'padding:0 8px;opacity:.75;';
  bar.appendChild(hint);
  const tools = {};
  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'all:unset;cursor:pointer;padding:5px 10px;border-radius:8px;';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    bar.appendChild(b);
    return b;
  };
  root.appendChild(bar);
  document.documentElement.appendChild(root);

  const ctx = canvas.getContext('2d');
  const shapes = []; // { kind: 'pen', points } | { kind: 'box', x, y, w, h }
  let mode = 'pen';
  let current = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function redraw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.strokeStyle = COLOR;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of current ? [...shapes, current] : shapes) {
      ctx.beginPath();
      if (s.kind === 'box') {
        ctx.roundRect(s.x, s.y, s.w, s.h, 8);
      } else {
        s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      }
      ctx.stroke();
    }
  }
  function setMode(m) {
    mode = m;
    tools.pen.style.background = m === 'pen' ? COLOR : 'transparent';
    tools.box.style.background = m === 'box' ? COLOR : 'transparent';
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = mode === 'box'
      ? { kind: 'box', x: e.clientX, y: e.clientY, w: 0, h: 0, sx: e.clientX, sy: e.clientY }
      : { kind: 'pen', points: [[e.clientX, e.clientY]] };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    if (current.kind === 'box') {
      current.x = Math.min(current.sx, e.clientX);
      current.y = Math.min(current.sy, e.clientY);
      current.w = Math.abs(e.clientX - current.sx);
      current.h = Math.abs(e.clientY - current.sy);
    } else {
      current.points.push([e.clientX, e.clientY]);
    }
    redraw();
  });
  canvas.addEventListener('pointerup', () => {
    if (current && (current.kind === 'pen' ? current.points.length > 1 : current.w > 4 && current.h > 4)) shapes.push(current);
    current = null;
    redraw();
  });

  // Done: marks stay visible but the page is usable again.
  function finish() {
    canvas.style.pointerEvents = 'none';
    root.style.pointerEvents = 'none';
    bar.style.display = 'none';
  }
  function edit() {
    canvas.style.pointerEvents = '';
    root.style.pointerEvents = '';
    bar.style.display = 'flex';
  }

  tools.pen = mkBtn('✏️ Pen', () => setMode('pen'));
  tools.box = mkBtn('▭ Box', () => setMode('box'));
  mkBtn('Undo', () => { shapes.pop(); redraw(); });
  mkBtn('Clear', () => { shapes.length = 0; redraw(); });
  mkBtn('Done', finish);
  setMode('pen');

  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  addEventListener('keydown', onKey, true);
  addEventListener('resize', resize);
  resize();

  window.__bhaiDraw = {
    edit,
    hasInk: () => shapes.length > 0,
    hideBar: () => { bar.style.display = 'none'; },
    remove: () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', resize);
      root.remove();
      delete window.__bhaiDraw;
    },
  };
})();
