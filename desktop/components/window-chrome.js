// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Window buttons for frameless pages. These pages' CSP (script-src 'self')
// blocks inline onclick handlers, so the buttons are wired here instead.
document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-window-action]");
    if (!btn || !window.bhai) return;
    const action = btn.getAttribute("data-window-action");
    if (action === "minimize") window.bhai.minimize();
    else if (action === "close") window.bhai.close();
});
