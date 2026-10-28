// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A tiny shop for Site Skill tests: search → results → cart (captcha stub) →
// order → optional OTP → done, with a cookie modal on the home page.
// spa: results render in place from a fetch (600 ms, the URL never changes;
// the latest search wins) and the order is placed by fetch, its error shown in
// a role=alert. location: a typeahead delivery-location picker on the home page.
// track: the SPA checkout first sends a tracking POST (same-site /track or a
// third-party track.test/collect, both answered 400 {"error":"bad event"}) and
// the order orderDelayMs later. spinner: a search shows .spinner 50 ms in,
// until the results replace it. ticker: a countdown that changes every 200 ms,
// and a search also opens a long-poll the server never answers. renameSearch:
// a redesign renames the search button's id (#search → #go; its text stays).
import { createServer, type Server } from "node:http";

const ITEMS = [
    { id: "p1", name: "Paneer Tikka", price: 249 },
    { id: "p2", name: "Paneer Butter Masala", price: 299 },
    { id: "d1", name: "Dal Makhani", price: 199 },
];
const page = (body: string) => `<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`;

type ShopOpts = {
    otp?: boolean;
    bump?: number;
    renameIds?: boolean;
    renameSearch?: boolean;
    confirmPopup?: boolean;
    mobileDup?: boolean;
    note?: boolean;
    commitLabel?: string; // the checkout button's text (default "Place order")
    banner?: string; // text shown at the top of every page (as text, not markup)
    spa?: boolean;
    location?: boolean;
    soldOut?: string; // an item id shown as sold out, with no Add
    rejectOrders?: number; // the next n orders get 400 {ok:false} (nothing placed)
    track?: "same-site" | "third-party";
    orderDelayMs?: number;
    spinner?: boolean;
    ticker?: boolean;
};
const PLACES = ["Indiranagar, Bengaluru", "Indiranagar 2nd Stage, Bengaluru", "Koramangala, Bengaluru"];
// Home page: search (and the location picker) without a page load.
const SPA_HOME = `<script>
document.querySelector("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const seq = (window.seq = (window.seq || 0) + 1);
  if (window.spinner) setTimeout(() => { document.getElementById("out").innerHTML = '<p class="spinner">Loading…</p>'; }, 50);
  if (window.ticker) fetch("/api/poll");
  fetch("/api/results?q=" + encodeURIComponent(document.getElementById("q").value)).then((r) => r.text())
    .then((html) => { if (seq === window.seq) document.getElementById("out").innerHTML = html; });
});
</script>`;
const LOCATION = `<input id="loc" placeholder="Delivery location" autocomplete="off"><ul id="loc-list" role="listbox"></ul><p id="deliver-to"></p>
<script>
const places = ${JSON.stringify(PLACES)};
document.getElementById("loc").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  setTimeout(() => {
    document.getElementById("loc-list").innerHTML = places.filter((p) => q && p.toLowerCase().includes(q))
      .map((p) => "<li role=option>" + p + "</li>").join("");
  }, 200);
});
document.getElementById("loc-list").addEventListener("click", (e) => {
  if (e.target.getAttribute("role") !== "option") return;
  document.getElementById("deliver-to").textContent = "Delivering to " + e.target.textContent;
  document.getElementById("loc-list").innerHTML = "";
});
</script>`;
// Cart page: the order goes by fetch; a refusal shows in a fresh role=alert.
const SPA_CHECKOUT = `<div id="msg"></div><script>
document.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (window.track) {
    const to = window.track === "same-site" ? "/track" : "http://track.test:" + location.port + "/collect";
    fetch(to, { method: "POST", body: "checkout_click" }).catch(() => {});
    await new Promise((r) => setTimeout(r, window.orderDelayMs || 0));
  }
  fetch("/order", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: f.elements.namedItem("id").value, captcha: f.elements.namedItem("captcha").checked }) })
    .then((r) => r.json()).then((j) => {
      if (j.ok) location.href = j.next;
      else document.getElementById("msg").innerHTML = '<p role="alert">Order failed: ' + j.error + "</p>";
    });
});
</script>`;
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** Launch Chromium with this so shop.test resolves to the local test server. */
export const SHOP_RESOLVER_ARG = "--host-resolver-rules=MAP shop.test 127.0.0.1, MAP track.test 127.0.0.1";

export async function startShop(
    opts: ShopOpts = {},
): Promise<{
    url: string;
    orders: () => number;
    set: (o: ShopOpts) => void;
    // biome-ignore lint/suspicious/noExplicitAny: Playwright BrowserContext
    route: (context: any) => Promise<any>;
    close: () => Promise<void>;
}> {
    let orders = 0;
    const pending = new Map<string, string>(); // order ticket → item id
    const server: Server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        const send = (html: string, status = 200) => {
            res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
            res.end(page(`${opts.banner ? `<p class="banner">${escHtml(opts.banner)}</p>` : ""}${html}`));
        };
        const redirect = (to: string) => {
            res.writeHead(303, { location: to });
            res.end();
        };
        const form = () =>
            new Promise<URLSearchParams>((resolve) => {
                let b = "";
                req.on("data", (c) => (b += c));
                req.on("end", () => resolve(new URLSearchParams(b)));
            });

        if (u.pathname === "/") {
            const modal = /ok=1/.test(req.headers.cookie ?? "")
                ? ""
                : `<div id="cookie-modal" style="position:fixed;inset:0;background:#0008"><p>We use cookies</p>
                   <button id="accept" onclick="document.cookie='ok=1';document.getElementById('cookie-modal').remove()">Accept</button></div>`;
            // A responsive site's hidden mobile copy of the search button (same id).
            const mobile = opts.mobileDup ? `<nav style="display:none"><button id="search">Search</button></nav>` : "";
            const loc = opts.location ? LOCATION : "";
            const flags = `<script>window.spinner = ${!!opts.spinner}; window.ticker = ${!!opts.ticker};</script>`;
            const spa = opts.spa ? `<div id="out"></div>${flags}${SPA_HOME}` : "";
            const ticker = opts.ticker
                ? `<p>Order in <span id="tick">12:00</span></p><script>let t = 720; setInterval(() => { document.getElementById("tick").textContent = Math.floor(--t / 60) + ":" + String(t % 60).padStart(2, "0"); }, 200);</script>`
                : "";
            return send(`${modal}${mobile}${loc}${ticker}<form action="/results"><input id="q" name="q"><button id="${opts.renameSearch ? "go" : "search"}">Search</button></form>${spa}`);
        }
        const results = (q: string) => {
            const hits = ITEMS.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
            if (!hits.length) return "<p>No results</p>";
            const add = (i: (typeof ITEMS)[number]) =>
                i.id === opts.soldOut ? `<button data-id="${i.id}" disabled>Sold out</button>` : `<a data-id="${i.id}" href="/cart?id=${i.id}">Add</a>`;
            return `<ul>${hits.map((i) => `<li data-item>${i.name} — ₹${i.price} ${add(i)}</li>`).join("")}</ul>`;
        };
        if (u.pathname === "/results") return send(results(u.searchParams.get("q") ?? ""));
        if (u.pathname === "/api/results") {
            return void setTimeout(() => {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(results(u.searchParams.get("q") ?? ""));
            }, 600);
        }
        if (u.pathname === "/api/poll") return void setTimeout(() => res.end(), 20_000).unref(); // a long-poll that never answers in time
        if ((u.pathname === "/track" || u.pathname === "/collect") && req.method === "POST") {
            res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" });
            return void res.end(JSON.stringify({ error: "bad event" }));
        }
        if (u.pathname === "/cart") {
            const item = ITEMS.find((i) => i.id === u.searchParams.get("id"));
            if (!item) return send("Not found", 404);
            const price = item.price + (opts.bump ?? 0); // a fee that appears late
            const btn = opts.renameIds ? "place-order-v2" : "checkout"; // a site redesign
            return send(`<p>${item.name} ₹${price}</p><form method="post" action="/order"><input type="hidden" name="id" value="${item.id}">${opts.note ? `<input id="note" name="note">` : ""}
              <label><input type="checkbox" id="captcha" name="captcha"> I'm not a robot</label><button id="${btn}"${opts.confirmPopup ? ` onclick="return confirm('Place order for ₹${price}?')"` : ""}>${opts.commitLabel ?? "Place order"}</button></form>${opts.spa ? `<script>window.track = ${JSON.stringify(opts.track ?? "")}; window.orderDelayMs = ${opts.orderDelayMs ?? 0};</script>${SPA_CHECKOUT}` : ""}`);
        }
        if (u.pathname === "/order" && req.method === "POST" && /json/.test(req.headers["content-type"] ?? "")) {
            let b = "";
            req.on("data", (c) => (b += c));
            return void req.on("end", () => {
                const f = JSON.parse(b || "{}") as { id?: string; captcha?: boolean };
                const json = (status: number, body: unknown) => {
                    res.writeHead(status, { "content-type": "application/json" });
                    res.end(JSON.stringify(body));
                };
                if (opts.rejectOrders) {
                    opts.rejectOrders--;
                    return json(400, { ok: false, error: "Payment declined" });
                }
                if (!f.captcha) return json(400, { ok: false, error: "Please tick the box" });
                if (!opts.otp) return json(200, { ok: true, next: `/done?n=${++orders}` });
                const ticket = Math.random().toString(36).slice(2);
                pending.set(ticket, f.id ?? "");
                json(200, { ok: true, next: `/otp?t=${ticket}` });
            });
        }
        if (u.pathname === "/order" && req.method === "POST") {
            return void form().then((f) => {
                if (!f.get("captcha")) return send("Please tick the box", 400);
                if (!opts.otp) return redirect(`/done?n=${++orders}`);
                const ticket = Math.random().toString(36).slice(2);
                pending.set(ticket, f.get("id") ?? "");
                redirect(`/otp?t=${ticket}`);
            });
        }
        if (u.pathname === "/otp") {
            const wrong = u.searchParams.get("wrong") ? "<p>Wrong code, try again</p>" : "";
            return send(`${wrong}<form method="post" action="/verify"><input type="hidden" name="t" value="${u.searchParams.get("t")}">
              <input id="otp" name="otp"><button id="verify">Verify</button></form>`);
        }
        if (u.pathname === "/verify" && req.method === "POST") {
            return void form().then((f) => {
                const t = f.get("t") ?? "";
                if (!pending.has(t)) return send("Expired", 400);
                if (f.get("otp") !== "123456") return redirect(`/otp?t=${t}&wrong=1`);
                pending.delete(t);
                redirect(`/done?n=${++orders}`);
            });
        }
        if (u.pathname === "/done") return send(`<h1>Order placed #${u.searchParams.get("n")}</h1>`);
        send("Not found", 404);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return {
        // A real-looking origin (cookies, redirects and same-site rules behave as on
        // a live site, and no manifest needs "localhost"): Chromium resolves
        // shop.test to 127.0.0.1 via SHOP_RESOLVER_ARG at launch.
        url: `http://shop.test:${port}/`,
        orders: () => orders,
        set: (o) => Object.assign(opts, o),
        route: async (context) => context,
        close: () => new Promise((r) => server.close(() => r())) };
}
