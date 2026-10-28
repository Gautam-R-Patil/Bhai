// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Imported first by src/index.ts: every console line the bot prints (which the
// desktop app also writes to its log files) goes through the API-key sanitizer
// and the PII vault, so cards, OTPs, UPI IDs, Aadhaar numbers and cookies show
// up as handles like [OTP_1], never as values.

import { formatWithOptions } from "node:util";
import { protect } from "./pii-vault.js";
import { sanitizeSecrets } from "./secrets-sanitizer.js";

// customInspect off: a logged value may come from a vm sandbox (an unhandled
// rejection reason), and util.inspect hands a custom-inspect hook host objects.
const NO_HOOKS = { customInspect: false } as const;

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) =>
        original(protect(sanitizeSecrets(formatWithOptions(NO_HOOKS, ...args)).sanitized));
}
