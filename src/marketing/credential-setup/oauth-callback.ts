// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createServer } from "node:http";
import { oauthStateMatches } from "../../security/oauth-state.js";

export type OAuthCallbackResult = { code: string } | { error: string };

const successHTML = `
<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center">
  <h1 style="font-size:3em;margin-bottom:0.2em">✅</h1>
  <h2>Connected!</h2>
  <p style="opacity:0.5;margin-top:2em">You can close this tab now.</p>
  <script>setTimeout(()=>window.close(),3000)</script>
</div></body></html>`;

const errorHTML = (msg: string) => `
<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center">
  <h1 style="font-size:3em;margin-bottom:0.2em">❌</h1>
  <h2>Connection Failed</h2>
  <p style="opacity:0.8">${msg.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>
  <p style="opacity:0.5;margin-top:2em">You can close this tab.</p>
</div></body></html>`;

/**
 * Start a temporary HTTP server on 127.0.0.1:port.
 * Waits for GET /?code=xxx or /?error=xxx carrying this flow's `state` (newOAuthState());
 * requests without it are ignored, so a stray page can't abort or hijack the sign-in.
 * Resolves with {code} on success or {error} on failure/timeout.
 * Auto-closes after receiving the first result.
 */
export function startOAuthCallback(
  port: number,
  expectedState: string,
  timeoutMs = 300_000
): Promise<OAuthCallbackResult> {
  return new Promise((resolve) => {
    let server: ReturnType<typeof createServer> | null = null;

    const cleanup = () => {
      if (server) {
        try { server.close(); } catch { /* ignore */ }
        server = null;
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ error: `OAuth timed out after ${timeoutMs / 1000}s — no callback received` });
    }, timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if ((code || error) && !oauthStateMatches(url.searchParams.get("state"), expectedState)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("This sign-in link doesn't match the one Bhai started.");
        return;
      }

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHTML(error));
        clearTimeout(timeout);
        cleanup();
        resolve({ error: `OAuth denied: ${error}` });
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(successHTML);
        clearTimeout(timeout);
        cleanup();
        resolve({ code });
        return;
      }

      // Waiting page for any other requests
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h2>⏳ Waiting for authorization…</h2></div></body></html>`);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      cleanup();
      resolve({ error: `Callback server error on port ${port}: ${err.message}` });
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`🔐 OAuth callback server listening on port ${port}`);
    });
  });
}
