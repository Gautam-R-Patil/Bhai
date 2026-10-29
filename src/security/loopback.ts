// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// DNS-rebinding guard for Bhai's local servers (overlay :18792, Chrome bridge
// :18800). Any website can point its own hostname at 127.0.0.1 and then reach
// these servers as same-origin — browsers send no Origin header on a
// same-origin GET — and read the tokens they hand out. Real clients always
// address the loopback host itself, so anything else is refused.
export function isLoopbackHost(host: string | undefined, port: number): boolean {
    const h = (host || "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** A browser page (http/https origin), as opposed to an extension or a local CLI. */
export function isWebOrigin(origin: string | undefined): boolean {
    return /^https?:\/\//i.test(origin || "");
}
