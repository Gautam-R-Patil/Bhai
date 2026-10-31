// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { afterEach, describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import {
  AUTH_LOGIN_HTML,
  OTPLESS_APP_ID,
  claimHandoff,
  completeHandoff,
  isHandoffNonce,
  isHandoffToken,
  parseOtplessIdentity,
  startHandoff,
} from "./otpless.js";

describe("parseOtplessIdentity", () => {
  it("extracts userId + phone from MOBILE identity", () => {
    const raw = {
      userId: "u_123",
      identities: [
        { identityType: "MOBILE", identityValue: "919899038845", verified: true, name: "Satyam" },
      ],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_123",
      phone: "+919899038845",
      name: "Satyam",
    });
  });

  it("extracts userId + email from EMAIL identity", () => {
    const raw = {
      userId: "u_456",
      identities: [{ identityType: "EMAIL", identityValue: "a@b.com" }],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_456",
      email: "a@b.com",
    });
  });

  it("preserves leading + on phone numbers", () => {
    const raw = { userId: "u", identities: [{ identityType: "MOBILE", identityValue: "+911234567890" }] };
    expect(parseOtplessIdentity(raw).phone).toBe("+911234567890");
  });

  it("unwraps identities nested under response (validate-token shape)", () => {
    const raw = {
      response: {
        userId: "u_789",
        identities: [{ identityType: "EMAIL", identityValue: "c@d.com" }],
      },
    };
    expect(parseOtplessIdentity(raw)).toEqual({ userId: "u_789", email: "c@d.com" });
  });

  it("throws when userId is missing", () => {
    expect(() => parseOtplessIdentity({ identities: [] })).toThrow(/missing userId/);
  });

  it("extracts both email and phone when EMAIL and MOBILE coexist", () => {
    const raw = {
      userId: "u_multi",
      identities: [
        { identityType: "EMAIL", identityValue: "multi@x.com", name: "First" },
        { identityType: "MOBILE", identityValue: "919999999999", name: "Second" },
      ],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_multi",
      email: "multi@x.com",
      phone: "+919999999999",
      name: "First",
    });
  });
});

describe("handoff validators", () => {
  it("accepts only 64-hex nonces and token-shaped strings", () => {
    expect(isHandoffNonce("a".repeat(64))).toBe(true);
    expect(isHandoffNonce("A".repeat(64))).toBe(false);
    expect(isHandoffNonce("a".repeat(63))).toBe(false);
    expect(isHandoffNonce(undefined)).toBe(false);
    expect(isHandoffToken("695b21614ca6410e803a4256966fffe1")).toBe(true);
    expect(isHandoffToken("short")).toBe(false);
    expect(isHandoffToken("<script>alert(1)</script>")).toBe(false);
  });
});


// Minimal in-memory stand-in for ctx.db: enough for the handoff mutations.
function fakeDb() {
  const rows: any[] = [];
  let nextId = 0;
  const db = {
    rows,
    query: () => ({
      withIndex: (_name: string, f: (q: any) => any) => {
        const preds: ((r: any) => boolean)[] = [];
        const q = {
          eq: (k: string, val: unknown) => { preds.push((r) => r[k] === val); return q; },
          lt: (k: string, val: number) => { preds.push((r) => r[k] < val); return q; },
        };
        f(q);
        const hits = () => rows.filter((r) => preds.every((p) => p(r)));
        return { unique: async () => hits()[0] ?? null, take: async (n: number) => hits().slice(0, n) };
      },
    }),
    insert: async (_t: string, doc: any) => { rows.push({ _id: String(nextId++), ...doc }); },
    patch: async (id: string, fields: any) => { Object.assign(rows.find((r) => r._id === id), fields); },
    delete: async (id: string) => { rows.splice(rows.findIndex((r) => r._id === id), 1); },
  };
  return { db };
}
const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

describe("handoff state machine", () => {
  afterEach(() => vi.useRealTimers());
  const h = "d".repeat(64);

  it("parks once, needs the code, and hands the token over exactly once", async () => {
    const ctx = fakeDb();
    await run(startHandoff, ctx, { nonce: h });
    expect(await run(claimHandoff, ctx, { nonce: h })).toEqual({ status: "pending" });
    const parked = await run(completeHandoff, ctx, { nonce: h, token: "tok_12345678" });
    expect(parked.code).toMatch(/^\d{6}$/);
    expect(await run(completeHandoff, ctx, { nonce: h, token: "tok_other_999" })).toBeNull(); // first token wins
    expect(await run(claimHandoff, ctx, { nonce: h })).toEqual({ status: "needs_code" });
    expect(await run(claimHandoff, ctx, { nonce: h, code: parked.code })).toEqual({ status: "ready", token: "tok_12345678" });
    expect(await run(claimHandoff, ctx, { nonce: h, code: parked.code })).toEqual({ status: "gone" });
  });

  it("burns the row after 5 wrong codes", async () => {
    const ctx = fakeDb();
    await run(startHandoff, ctx, { nonce: h });
    const { code } = await run(completeHandoff, ctx, { nonce: h, token: "tok_12345678" });
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await run(claimHandoff, ctx, { nonce: h, code: wrong })).status).toBe("wrong_code");
    expect(await run(claimHandoff, ctx, { nonce: h, code: wrong })).toEqual({ status: "gone" });
    expect(await run(claimHandoff, ctx, { nonce: h, code })).toEqual({ status: "gone" });
  });

  it("stays alive while the window polls and refuses parking once it stops", async () => {
    vi.useFakeTimers();
    const ctx = fakeDb();
    await run(startHandoff, ctx, { nonce: h });
    for (let i = 0; i < 40; i++) { // 100s of polling every 2.5s
      vi.advanceTimersByTime(2500);
      expect((await run(claimHandoff, ctx, { nonce: h })).status).toBe("pending");
    }
    vi.advanceTimersByTime(31_000); // window closed
    expect(await run(completeHandoff, ctx, { nonce: h, token: "tok_12345678" })).toBeNull();
  });
});

// Runs the /auth-login inline script against a stub DOM with manual timers:
// enough to check the order that matters (nonce in the URL before the SDK
// loads) and the window/browser halves of the email-link flow.
function runAuthPage(opts: { search: string; inApp: boolean; replies?: Record<string, any[]>; bridgeName?: "bhaiAuth" | "atlasAuth" }) {
  const el = () => {
    const classes = new Set<string>(["hidden"]);
    const listeners: Record<string, (e: any) => unknown> = {};
    return {
      textContent: "",
      value: "",
      onclick: null as null | (() => unknown),
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      addEventListener: (t: string, f: (e: any) => unknown) => { listeners[t] = f; },
      focus: () => {},
      fire: (t: string) => listeners[t]({ preventDefault: () => {} }),
      get visible() { return !classes.has("hidden"); },
    };
  };
  const els: Record<string, ReturnType<typeof el>> = {};
  for (const id of ["otpless-login-page", "title", "sub", "status", "code", "code-form", "code-input", "retry", "error"]) els[id] = el();
  els["otpless-login-page"].classList.remove("hidden");
  const log: string[] = [];
  const scripts: any[] = [];
  const fetches: any[] = [];
  const timers: (() => void)[] = [];
  const submitted: string[] = [];
  let otplessCallback: any = null;
  const replies = opts.replies || {};
  const location = { search: opts.search, pathname: "/auth-login" };
  const window: any = opts.inApp ? { [opts.bridgeName ?? "bhaiAuth"]: { submitToken: async (t: string) => { submitted.push(t); return { success: true }; } } } : {};
  const document: any = {
    title: "Bhai — Sign In",
    getElementById: (id: string) => els[id],
    createElement: () => { const s: any = { attrs: {}, setAttribute: (k: string, v: string) => { s.attrs[k] = v; } }; return s; },
    body: { classList: el().classList, appendChild: (s: any) => { log.push("sdk " + s.src); scripts.push(s); } },
  };
  const ctx = vm.createContext({
    window,
    document,
    location,
    URLSearchParams,
    crypto: webcrypto,
    setTimeout: (f: () => void) => { timers.push(f); return timers.length; },
    clearTimeout: () => {},
    history: { replaceState: (_s: unknown, _t: string, url: string) => { log.push("replaceState " + url); location.search = url.slice(url.indexOf("?")); } },
    fetch: async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetches.push(body);
      const reply = (replies[body.op] || []).shift() || { ok: true };
      return { ok: reply.httpOk !== false, json: async () => reply };
    },
    OTPless: function (cb: any) { otplessCallback = cb; },
  });
  vm.runInContext(AUTH_LOGIN_HTML.match(/<script>([\s\S]*?)<\/script>/)![1], ctx);
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = async () => { await flush(); const due = timers.splice(0); for (const f of due) f(); await flush(); await flush(); };
  return { els, log, scripts, fetches, submitted, document, location, tick, fireSdk: (e: unknown) => otplessCallback(e) };
}

describe("/auth-login page", () => {
  it("interpolates the app id and leaves no template leftovers", () => {
    expect(AUTH_LOGIN_HTML).toContain(OTPLESS_APP_ID);
    expect(AUTH_LOGIN_HTML).not.toContain("${");
  });

  it("in the Bhai window: puts a nonce in the URL before loading the SDK, then registers it", () => {
    const page = runAuthPage({ search: "", inApp: true });
    expect(page.log[0]).toMatch(/^replaceState \/auth-login\?h=[0-9a-f]{64}$/);
    expect(page.log[1]).toBe("sdk https://otpless.com/v4/auth.js");
    expect(page.scripts[0].attrs["data-appid"]).toBe(OTPLESS_APP_ID);
    expect(page.fetches[0]).toEqual({ op: "start", h: page.location.search.slice(3) });
  });

  it("in the Bhai window: asks for the code once a token is parked, retries a wrong one, then signs in", async () => {
    const page = runAuthPage({
      search: "",
      inApp: true,
      replies: {
        claim: [{ status: "pending" }, { status: "needs_code" }, { status: "wrong_code" }, { status: "ready", token: "tok_12345678" }],
      },
    });
    await page.tick(); // poll: pending
    await page.tick(); // poll: needs_code
    expect(page.els["code-form"].visible).toBe(true);
    page.els["code-input"].value = "111111";
    await page.els["code-form"].fire("submit");
    expect(page.els.error.textContent).toMatch(/didn't match/);
    page.els["code-input"].value = "482913";
    await page.els["code-form"].fire("submit");
    const h = page.location.search.slice(3);
    expect(page.fetches.filter((f) => f.code)).toEqual([{ op: "claim", h, code: "111111" }, { op: "claim", h, code: "482913" }]);
    expect(page.submitted).toEqual(["tok_12345678"]);
  });

  it("in an install from before the rename: finds window.atlasAuth and signs in through it", async () => {
    const page = runAuthPage({
      search: "",
      inApp: true,
      bridgeName: "atlasAuth",
      replies: { claim: [{ status: "needs_code" }, { status: "ready", token: "tok_old_install" }] },
    });
    expect(page.fetches[0].op).toBe("start"); // inApp: the bridge was found
    await page.tick(); // poll: needs_code
    page.els["code-input"].value = "482913";
    await page.els["code-form"].fire("submit");
    expect(page.submitted).toEqual(["tok_old_install"]);
  });

  it("in the Bhai window: re-registers after the row goes away instead of giving up", async () => {
    const page = runAuthPage({ search: "", inApp: true, replies: { claim: [{ status: "gone" }] } });
    await page.tick(); // claim -> gone
    await page.tick(); // start again, then keep polling
    expect(page.fetches.map((f) => f.op).slice(0, 4)).toEqual(["start", "claim", "start", "claim"]);
  });

  it("in a browser from the email link: parks the token and shows the code", async () => {
    const h = "b".repeat(64);
    const page = runAuthPage({ search: "?h=" + h + "&code=abc", inApp: false, replies: { complete: [{ code: "482913" }] } });
    expect(page.log).toEqual(["sdk https://otpless.com/v4/headless.js"]);
    page.scripts[0].onload();
    page.fireSdk({ responseType: "ONETAP", success: true, response: { token: "tok_12345678", identities: [{ identityValue: "a@b.com" }] } });
    await page.tick();
    expect(page.fetches).toEqual([{ op: "complete", h, token: "tok_12345678" }]);
    expect(page.els.code.textContent).toBe("482913");
    expect(page.document.title).toContain("482913");
    expect(page.els.status.textContent).toContain("a@b.com");
  });

  it("in a browser without a link code: loads nothing", () => {
    const page = runAuthPage({ search: "?h=" + "c".repeat(64), inApp: false });
    expect(page.scripts).toEqual([]);
    expect(page.els.status.textContent).toBe("Open the Bhai app to sign in.");
  });
});
