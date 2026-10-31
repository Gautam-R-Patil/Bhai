// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Never import from a client bundle — `clientSecret` must stay server-side.

import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const OTPLESS_USER_AUTH_BASE = "https://user-auth.otpless.app";

function authHeaders() {
  const clientId = process.env.OTPLESS_CLIENT_ID;
  const clientSecret = process.env.OTPLESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("OTPLESS_CLIENT_ID / OTPLESS_CLIENT_SECRET not configured");
  }
  return {
    "Content-Type": "application/json",
    clientId,
    clientSecret,
  };
}

export function parseOtplessIdentity(raw: any): {
  userId: string;
  email?: string;
  phone?: string;
  name?: string;
} {
  const userId = raw?.userId || raw?.response?.userId;
  if (!userId || typeof userId !== "string") {
    throw new Error("OTPless response missing userId");
  }
  const identities: any[] = raw?.identities || raw?.response?.identities || [];
  let email: string | undefined;
  let phone: string | undefined;
  let name: string | undefined;
  for (const id of identities) {
    if (id?.identityType === "EMAIL" && typeof id.identityValue === "string") {
      email = id.identityValue;
    }
    if (id?.identityType === "MOBILE" && typeof id.identityValue === "string") {
      phone = id.identityValue.startsWith("+") ? id.identityValue : `+${id.identityValue}`;
    }
    if (!name && typeof id?.name === "string") name = id.name;
  }
  return { userId, email, phone, name };
}

export const validateTokenInternal = internalAction({
  args: { token: v.string() },
  handler: async (_ctx, { token }) => {
    const res = await fetch(`${OTPLESS_USER_AUTH_BASE}/auth/v1/validate/token`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ token }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(raw?.description || raw?.message || `OTPless validate-token failed (${res.status})`);
    }
    if (raw?.status !== "SUCCESS") {
      throw new Error(raw?.description || "Token validation did not succeed");
    }
    return parseOtplessIdentity(raw);
  },
});

// ── Email-link handoff ───────────────────────────────────────────────────
// OTPless email sign-in is a link, and it opens in the user's default
// browser, not in Bhai's sign-in window. The window tags its page URL with a
// random nonce (OTPless keeps it in the link's return URL) and polls; the
// browser tab parks the token under that nonce and shows a one-time code,
// which the user types into the window to claim it. The code is what stops
// a stranger's window (one that asked OTPless to email *you* a link) from
// receiving your sign-in when you click that link.

const WINDOW_GONE_MS = 30_000;       // a pending row lives while the window polls (every 2.5s)
const CODE_TTL_MS = 10 * 60 * 1000;  // time to type the code once the token is parked
const MAX_CODE_ATTEMPTS = 5;

export function isHandoffNonce(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

export function isHandoffToken(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9._-]{8,512}$/.test(s);
}

async function getHandoff(ctx: MutationCtx, nonce: string) {
  return await ctx.db
    .query("auth_handoffs")
    .withIndex("by_nonce", (q) => q.eq("nonce", nonce))
    .unique();
}

export const startHandoff = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, { nonce }) => {
    const now = Date.now();
    // Opportunistic sweep: claimed rows are deleted, so only abandoned ones age out here.
    const stale = await ctx.db
      .query("auth_handoffs")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of stale) await ctx.db.delete(row._id);

    if (!(await getHandoff(ctx, nonce))) {
      await ctx.db.insert("auth_handoffs", { nonce, expiresAt: now + WINDOW_GONE_MS, attempts: 0 });
    }
    return null;
  },
});

// Uniform 000000-999999: draws at or above 4_294_000_000 (the largest multiple
// of 1e6 below 2^32) are redrawn, so the modulo carries no bias.
function sixDigitCode(): string {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n >= 4_294_000_000) continue;
    return String(n % 1_000_000).padStart(6, "0");
  }
}

// Browser tab parks the token. Refused when the window stopped polling (row
// expired) or a token is already parked. Returns the code to show.
export const completeHandoff = internalMutation({
  args: { nonce: v.string(), token: v.string() },
  handler: async (ctx, { nonce, token }): Promise<{ code: string } | null> => {
    const row = await getHandoff(ctx, nonce);
    if (!row || row.expiresAt < Date.now() || row.token) return null;
    const code = sixDigitCode();
    await ctx.db.patch(row._id, { token, code, expiresAt: Date.now() + CODE_TTL_MS });
    return { code };
  },
});

export type HandoffClaim =
  | { status: "pending" | "needs_code" | "wrong_code" | "gone" }
  | { status: "ready"; token: string };

// Window polls with no code until a token is parked, then sends the code the
// user typed. A ready token is returned once and the row is deleted.
export const claimHandoff = internalMutation({
  args: { nonce: v.string(), code: v.optional(v.string()) },
  handler: async (ctx, { nonce, code }): Promise<HandoffClaim> => {
    const now = Date.now();
    const row = await getHandoff(ctx, nonce);
    if (!row || row.expiresAt < now) {
      if (row) await ctx.db.delete(row._id);
      return { status: "gone" };
    }
    if (!row.token || !row.code) {
      // Keep the row alive while the window polls; refresh at most every ~10s.
      if (row.expiresAt - now < WINDOW_GONE_MS - 10_000) await ctx.db.patch(row._id, { expiresAt: now + WINDOW_GONE_MS });
      return { status: "pending" };
    }
    if (code === undefined) return { status: "needs_code" };
    if (code !== row.code) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await ctx.db.delete(row._id);
        return { status: "gone" };
      }
      await ctx.db.patch(row._id, { attempts });
      return { status: "wrong_code" };
    }
    await ctx.db.delete(row._id);
    return { status: "ready", token: row.token };
  },
});

// ── Sign-in page (GET /auth-login) ──────────────────────────────────────
// Loaded by the desktop sign-in window. The OTPless SDK rejects file://
// origins, so the page is served over HTTPS from this deployment and the
// token goes back to the app via window.bhaiAuth (window.atlasAuth in
// installs from before the rename). Opened in a plain browser
// from the email link, it hands the token to that window instead (above).

export const OTPLESS_APP_ID = "F1WCDC7B2QKKDI2UTGVD";

export const AUTH_LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bhai — Sign In</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f4f1; --card: #fff; --text: #1d1b19; --muted: #6b6560; --err: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141312; --card: #1f1d1b; --text: #f2efeb; --muted: #a29b94; --err: #f2b8b5; } }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
         background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { box-sizing: border-box; width: 100%; max-width: 400px; background: var(--card); border-radius: 16px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
  h1 { font-size: 22px; margin: 0; text-align: center; }
  p { color: var(--muted); text-align: center; margin: 6px 0 20px; }
  .hidden { display: none; }
  #error { color: var(--err); text-align: center; margin-top: 12px; }
  button { box-sizing: border-box; width: 100%; margin-top: 8px; padding: 12px; border: 0; border-radius: 10px; background: #E87B2D; color: #1E1A15; font: inherit; font-weight: 600; line-height: 1.2; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  input { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid var(--muted); border-radius: 10px; background: transparent; color: var(--text); font: 600 22px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 6px; text-align: center; }
  .code { font: 700 34px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 8px; text-align: center; color: var(--text); margin: 4px 0 14px; }
  body.top { align-items: flex-start; }
  .logo { display: flex; justify-content: center; margin-bottom: 14px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo"><svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" aria-hidden="true" viewBox="0 0 472 472">
  <rect width="472" height="472" rx="108" fill="#E87B2D"/>
  <g fill="#1E1A15">
    <rect x="74" y="147" width="324" height="16" rx="5"/>
    <path d="M74 157H222C222 212 194 246 155 246H141C102 246 74 212 74 157Z"/>
    <path d="M250 157H398C398 212 370 246 331 246H317C278 246 250 212 250 157Z"/>
  </g>
  <g fill="none" stroke-linecap="round">
    <path d="M110 186L148 172M288 186L326 172" stroke="#9E9E9E" stroke-width="12"/>
    <path d="M199 326C240 336 295 332 324 288" stroke="#1E1A15" stroke-width="20"/>
  </g>
</svg></div>
  <h1 id="title">Sign in to Bhai</h1>
  <p id="sub">Enter your email and we'll send you a sign-in link</p>
  <div id="otpless-login-page"></div>
  <p id="status" class="hidden"></p>
  <div id="code" class="code hidden"></div>
  <form id="code-form" class="hidden">
    <input id="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="6-digit code">
    <button type="submit">Continue</button>
  </form>
  <button id="retry" type="button" class="hidden">Try again</button>
  <div id="error" role="alert"></div>
</div>

<script>
  const widget = document.getElementById("otpless-login-page");
  const title = document.getElementById("title");
  const sub = document.getElementById("sub");
  const status = document.getElementById("status");
  const codeBox = document.getElementById("code");
  const codeForm = document.getElementById("code-form");
  const codeInput = document.getElementById("code-input");
  const retryBtn = document.getElementById("retry");
  const error = document.getElementById("error");
  // atlasAuth: the preload name in installs from before the rename. Keep it.
  const bridge = window.bhaiAuth || window.atlasAuth;
  const inApp = !!(bridge && bridge.submitToken);
  const params = new URLSearchParams(location.search);
  const NONCE = /^[0-9a-f]{64}$/;
  const EXPIRED = "This sign-in link has expired or was already used. Go back to Bhai and request a new one.";
  let h = params.get("h");
  let busy = false;      // a token is being verified
  let askingCode = false; // the window is showing the code form
  let expiry = null;

  function show(msg) { widget.classList.add("hidden"); status.textContent = msg; status.classList.remove("hidden"); error.textContent = ""; }
  function fail(msg) {
    if (inApp && !askingCode) widget.classList.remove("hidden");
    status.classList.add("hidden");
    error.textContent = msg;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function loadSdk(file, onload) {
    const s = document.createElement("script");
    s.id = "otpless-sdk";
    s.src = "https://otpless.com/v4/" + file;
    s.setAttribute("data-appid", "${OTPLESS_APP_ID}");
    if (onload) s.onload = onload;
    s.onerror = function () { clearTimeout(expiry); fail("Couldn't load the sign-in service. Check your internet connection, then try again."); };
    document.body.appendChild(s);
  }
  async function handoff(op, extra) {
    const r = await fetch("/api/otpless/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ op: op, h: h }, extra)),
    });
    const j = await r.json().catch(function () { return {}; });
    j.httpOk = r.ok;
    return j;
  }

  async function submit(token) {
    if (busy) return;
    busy = true;
    show("Verifying…");
    try {
      const res = await bridge.submitToken(token);
      if (res && res.success) return show("Signed in. Returning to Bhai…");
      fail((res && res.error) || "Sign-in failed. Please try again.");
    } catch (err) {
      fail((err && err.message) || "Sign-in failed.");
    }
    busy = false;
  }

  // Called by the OTPless SDK on successful sign-in in the Bhai window.
  function otpless(user) {
    if (!inApp) return;
    const token = user && user.token;
    if (!token) return fail("Sign-in returned no token.");
    submit(token);
  }

  // Bhai window: keep the nonce registered and wait for the browser tab
  // opened from the email link. Runs for as long as the window is open.
  async function pollHandoff() {
    let registered = false;
    for (;;) {
      if (!registered) {
        try { registered = (await handoff("start")).httpOk; } catch (_) { /* retry below */ }
      }
      await sleep(registered ? 2500 : 10000);
      if (!registered || busy || askingCode) continue;
      let res;
      try { res = await handoff("claim"); } catch (_) { continue; }
      if (res.status === "gone") registered = false;
      else if (res.status === "needs_code") askForCode();
    }
  }

  function askForCode() {
    askingCode = true;
    widget.classList.add("hidden");
    show("Enter the 6-digit code shown in your browser.");
    codeForm.classList.remove("hidden");
    codeInput.focus();
  }

  codeForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    const code = codeInput.value.replace(/[^0-9]/g, "");
    if (code.length !== 6) return fail("Enter all 6 digits.");
    let res = {};
    try { res = await handoff("claim", { code: code }); } catch (_) { return fail("Couldn't reach Bhai's server. Check your connection and try again."); }
    if (res.status === "ready") {
      codeForm.classList.add("hidden");
      askingCode = false;
      return submit(res.token);
    }
    if (res.status === "wrong_code") { codeInput.value = ""; codeInput.focus(); return fail("That code didn't match. Check your browser and try again."); }
    if (res.status === "pending" || res.status === "needs_code") return fail("Enter the code from your browser.");
    // gone: too many tries or expired. Start over.
    codeForm.classList.add("hidden");
    codeInput.value = "";
    askingCode = false;
    fail(res.error || "Too many tries, or the code expired. Request a new link.");
  });

  // Browser tab: park the token and show the code to type into Bhai.
  function onBrowserSignIn(event) {
    if (!event) return;
    if (event.success === false) { clearTimeout(expiry); return fail(EXPIRED); }
    const resp = event.response;
    if (event.responseType !== "ONETAP" || !resp || !resp.token) return;
    clearTimeout(expiry);
    const id = (resp.identities || []).find(function (i) { return i && i.identityValue; });
    async function park() {
      retryBtn.classList.add("hidden");
      show("Finishing sign-in…");
      let r;
      try { r = await handoff("complete", { token: resp.token }); } catch (_) {
        fail("Couldn't reach Bhai's server. Check your connection, then try again.");
        retryBtn.classList.remove("hidden");
        return;
      }
      if (!r.httpOk || !r.code) return fail(r.error || EXPIRED);
      document.title = "Code " + r.code + " · Bhai";
      codeBox.textContent = r.code;
      codeBox.classList.remove("hidden");
      show("Type this code into the Bhai sign-in window" + (id ? " to sign in as " + id.identityValue : "") + ". Didn't ask to sign in? Close this tab; nothing happens without the code.");
    }
    retryBtn.onclick = park;
    park();
  }

  if (inApp) {
    if (!NONCE.test(h || "")) {
      h = Array.from(crypto.getRandomValues(new Uint8Array(32)), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      // Before the SDK loads: OTPless builds the email link's return URL from this URL.
      history.replaceState(null, "", location.pathname + "?h=" + h);
    }
    pollHandoff();
    loadSdk("auth.js");
  } else if (NONCE.test(h || "") && params.get("code")) {
    document.body.classList.add("top"); // out from under the floating Bhai window
    title.textContent = "Finish signing in";
    sub.classList.add("hidden");
    show("Finishing sign-in…");
    expiry = setTimeout(function () { fail(EXPIRED); }, 20000);
    loadSdk("headless.js", function () { new OTPless(onBrowserSignIn); });
  } else {
    sub.classList.add("hidden");
    show("Open the Bhai app to sign in.");
  }
</script>
</body>
</html>`;
