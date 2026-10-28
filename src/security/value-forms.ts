// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The ways a known sensitive value (a card number, an OTP) can reappear in text
// Bhai reads back: as typed, trimmed or whitespace-collapsed, and encoded the way
// pages, URLs, form bodies, JSON and base64 write it. pii-vault masks every one,
// so `?card=4111%201111…` or a base64 blob can't carry the value past it.
//
// Each form is returned with `short`: under SHORT_FORM characters a form is only
// masked as a whole token, since a six-digit code also turns up inside order
// numbers and timestamps by chance.

export const SHORT_FORM = 8;

/** Lone surrogates can't be percent-encoded (encodeURIComponent throws). */
const encodable = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** Percent-encoding with lowercase hex, as some servers and clients write it. */
const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase());

/** Every distinct form of `value`, longest first, each with whether it is short. */
export function knownForms(value: string): Array<[form: string, short: boolean]> {
    if (!value) return [];
    const variants = new Set([value, value.trim(), value.replace(/[​­]/g, "").trim().replace(/\s+/g, " ")]);
    const forms = new Set<string>();
    for (const v of variants) {
        if (!v) continue;
        forms.add(v);
        forms.add(JSON.stringify(v).slice(1, -1)); // inside a JSON string
        forms.add(v.replace(/'/g, "''")); // inside a single-quoted SQL/YAML string
        if (encodable(v)) {
            const uri = encodeURIComponent(v); // %20 for a space
            const form = new URLSearchParams({ v }).toString().slice(2); // + for a space
            for (const e of [uri, form, encodeURI(v)]) {
                forms.add(e);
                forms.add(lowerHex(e));
            }
        }
    }
    forms.add(Buffer.from(value).toString("base64"));
    forms.add(Buffer.from(value).toString("base64url"));
    return [...forms]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map((f) => [f, f.length < SHORT_FORM]);
}
