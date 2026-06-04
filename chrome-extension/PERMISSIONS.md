# ATLAS Bridge — permission rationale

Notes on why the manifest requests its permissions. Kept out of `manifest.json`
because Chrome warns on unrecognized (`_`-prefixed) manifest keys.

- **`debugger`** — required for `chrome.debugger.attach` + `Runtime.evaluate`
  fallback in `background.js`. The only reliable way to run page-context JS on
  strict-CSP sites (Gmail/GitHub) where `chrome.scripting.executeScript`
  `world:MAIN` fails. Also gates the `rawCDP()` pass-through with the
  `CDP_ALLOWED_METHODS` allowlist (`Input.insertText`, `DOM.setFileInputFiles`,
  `Page.captureScreenshot`, `Accessibility.getFullAXTree`). Cannot drop without
  losing AX-tree extraction + CSP-safe JS injection.

- **`host_permissions: <all_urls>`** — the agent operates on whatever tab the
  user is on; we cannot enumerate a finite host list at install time.
  `activeTab` is insufficient: it only grants access on user-gesture-initiated
  invocations, not the agent-driven flows where the operator says "use my Gmail
  tab" programmatically. Content-script injection is gated by `chrome.tabs.query`
  at runtime; debugger access requires explicit `chrome.debugger.attach`, which
  surfaces an OS-level "A.T.L.A.S started debugging this browser" banner.

- **`host_permissions: http://127.0.0.1:18800/*` + `http://127.0.0.1:18792/*`** —
  the extension fetches `http://127.0.0.1:18800/discover` (bridge token + overlay
  localToken) and opens WebSockets to the bridge (18800) and overlay (18792).
  Loopback hosts must be listed explicitly; `<all_urls>` does not cover them.
