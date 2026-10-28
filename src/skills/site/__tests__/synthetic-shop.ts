// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A tiny shop for Site Skill tests: search → results → cart (captcha stub) →
// order → optional OTP → done, with a cookie modal on the home page.
import { createServer, type Server } from "node:http";

const ITEMS = [
    { id: "p1", name: "Paneer Tikka", price: 249 },
    { id: "p2", name: "Paneer Butter Masala", price: 299 },
    { id: "d1", name: "Dal Makhani", price: 199 },
];
const page = (body: string) => `<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`;

type ShopOpts = { otp?: boolean; bump?: number; renameIds?: boolean; confirmPopup?: boolean; mobileDup?: boolean; note?: boolean };
/** Launch Chromium with this so shop.test resolves to the local test server. */
export const SHOP_RESOLVER_ARG = "--host-resolver-rules=MAP shop.test 127.0.0.1";

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
            res.end(page(html));
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
            return send(`${modal}${mobile}<form action="/results"><input id="q" name="q"><button id="search">Search</button></form>`);
        }
        if (u.pathname === "/results") {
            const q = (u.searchParams.get("q") ?? "").toLowerCase();
            const hits = ITEMS.filter((i) => i.name.toLowerCase().includes(q));
            return send(`<ul>${hits.map((i) => `<li data-item>${i.name} — ₹${i.price} <a data-id="${i.id}" href="/cart?id=${i.id}">Add</a></li>`).join("")}</ul>`);
        }
        if (u.pathname === "/cart") {
            const item = ITEMS.find((i) => i.id === u.searchParams.get("id"));
            if (!item) return send("Not found", 404);
            const price = item.price + (opts.bump ?? 0); // a fee that appears late
            const btn = opts.renameIds ? "place-order-v2" : "checkout"; // a site redesign
            return send(`<p>${item.name} ₹${price}</p><form method="post" action="/order"><input type="hidden" name="id" value="${item.id}">${opts.note ? `<input id="note" name="note">` : ""}
              <label><input type="checkbox" id="captcha" name="captcha"> I'm not a robot</label><button id="${btn}"${opts.confirmPopup ? ` onclick="return confirm('Place order for ₹${price}?')"` : ""}>Place order</button></form>`);
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
