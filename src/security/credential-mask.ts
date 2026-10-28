// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Masks credentials by their structure — never by ordinary words — before text
// reaches the model, the logs or chat history (pii-vault.protect). A false
// positive costs more than a rare miss: "password: required", `token_type:
// bearer` or `const apiKey = getKey(config)` must come through unchanged, so
// every rule also checks that the value is shaped like a secret.
//
// What is masked (the value becomes [redacted]):
//   • Authorization / Proxy-Authorization values (Basic, Bearer, Digest response,
//     AWS SigV4 Signature, unschemed tokens), in headers, JSON or assignments;
//   • Cookie / Set-Cookie header values that hold name=value pairs;
//   • credential-named assignments (password, secret, api_key, token, …) whose
//     value is a secret-shaped literal;
//   • provider keys by prefix (sk-…, ghp_…, xoxb-…, AKIA…, AIza…, glpat-…, …),
//     JWTs and PEM private-key blocks.
// URLs are left as written: navigation needs them whole, and the secrets
// sanitizer handles credentials inside URLs.

const MASK = "[redacted]";

/** A value that looks like a secret: long enough, not a word, path, call or flag. */
export function secretShaped(v: string): boolean {
    const s = v.replace(/^["'`]|["'`]$/g, "");
    if (s.length < 6 || s === MASK) return false;
    if (/^(true|false|null|none|undefined|required|optional|missing|invalid|incorrect|expired|hidden|redacted|bearer|basic)$/i.test(s)) return false;
    if (/^[A-Za-z]+$/.test(s) && s.length < 20) return false; // a word
    if (/^[./~$]|^https?:/i.test(s)) return false; // a path, URL or $VAR
    if (/[()]/.test(s) || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(s)) return false; // a call or a.b.c reference
    if (/\s/.test(s) && !/^[A-Za-z0-9+/=._-]+$/.test(s)) return false; // prose
    if (/^\d{1,8}$/.test(s)) return false; // a small number (PIN/OTP handled by the PII vault)
    return /[0-9]/.test(s) || /[^A-Za-z]/.test(s) || s.length >= 20;
}

const AUTH_HEADER =
    /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(Basic|Bearer|Token|Negotiate|NTLM)\s+)?([A-Za-z0-9+/=._~-]{4,})/gi;
// "bearer <token>" / "basic <base64>" in free text, outside a header.
const FREE_SCHEME = /\b(bearer|basic)(\s+)([A-Za-z0-9+/=._~-]{4,})/gi;
const DIGEST_FIELD = /\b(response|nonce|cnonce)(\s*=\s*)("?)([A-Za-z0-9+/=]{12,})\3/gi;
const SIGV4_SIGNATURE = /\b(Signature=)([A-Za-z0-9]{8,})/g;
// Header form: the rest of the line, minus trailing prose after ", " that isn't another pair.
const COOKIE_HEADER = /\b(set-cookie|cookie)(\s*:\s*)([^\r\n]+)/gi;
// JSON / object / assignment form: "cookie":"a=b", cookie: 'sid=…', cookie=abc123.
const COOKIE_VALUE = /(["']?\bcookie["']?\s*[:=]\s*)(["'`])([^"'`\r\n]{1,1000})\2|(\bcookie=)([^\s"'`,;&]{6,})/gi;
// Names that only ever hold secrets. Loose words (token, secret, pass, pin)
// are left alone: "token=visible-9" is usually a label, not a credential.
const CREDENTIAL_KEY =
    "(?:[A-Za-z0-9_-]*?(?:pass(?:word|wd|phrase)|api[_-]?key|apikey|access[_-]?key|account[_-]?key|accountkey|storage[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|secret[_-]?key|client[_-]?secret|app[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|totp[_-]?(?:seed|secret)|otp[_-]?secret|credentials?)" +
    // id_token only on its own ("valid_token" is not "val" + "id_token").
    "|(?:[A-Za-z0-9]+[_-])*id[_-]?token)s?";
const ASSIGNMENT = new RegExp(
    `(["']?\\b${CREDENTIAL_KEY}\\b["']?)(\\s*(?::|=|=>)\\s*)("[^"\\r\\n]{0,500}"|'[^'\\r\\n]{0,500}'|\`[^\`\\r\\n]{0,500}\`|[^\\s,;}\\]"'\`]{1,500})`,
    "gi",
);
const PROVIDER_KEY =
    /\b(?:sk-(?:proj-|ant-(?:api\d{2}-)?|svcacct-|admin-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|shp(?:at|ss|ca)_[A-Za-z0-9]{16,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PEM = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g;
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** "sk-hynix-ddr5-kit-2026" is a product slug; a key has a long mixed run. */
const providerShaped = (k: string) => !/^sk-/.test(k) || /[A-Za-z0-9]{16,}/.test(k.replace(/^sk-(?:proj-|ant-(?:api\d{2}-)?|svcacct-|admin-)?/, "")) && /\d/.test(k);
/** Basic credentials are base64 of "user:pass" — even a short one ("dTpw"). */
const basicShaped = (v: string) => {
    try {
        if (!/^[A-Za-z0-9+/]+=*$/.test(v)) return false;
        const d = Buffer.from(v, "base64").toString("latin1");
        return /^[\x21-\x7e]+:[\x20-\x7e]*$/.test(d); // printable "user:pass" ("Open" decodes to junk)
    } catch {
        return false;
    }
};
/** A credential-named value worth masking (quoted values always, bare ones by shape). */
const assignedSecret = (sep: string, value: string) => {
    if (/^["'`]/.test(value)) {
        const inner = value.slice(1, -1);
        return inner.length > 0 && inner !== MASK && !/^\*+$/.test(inner) && !/[()]/.test(inner);
    }
    if (/^[./~$]|[()]|^(true|false|null|undefined|none)$/i.test(value)) return false; // path, call, $VAR, flag
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // a.b.c reference
    // "Password: Required." / "api_key: missing" are prose; "password=hunter" is an
    // assignment. After ": " a bare value must look like a real secret (not "ACME-123").
    if (/:\s/.test(sep)) return /^[A-Za-z]+\.?$/.test(value) ? false : value.length >= 10 && secretShaped(value);
    return true;
};

export function maskCredentials(text: string): string {
    if (!text || text.length < 6) return text;
    // Park URLs so no rule touches them, then put them back.
    const urls: string[] = [];
    let out = text.replace(URL_SPAN, (u) => `\u0000U${urls.push(u) - 1}\u0000`);

    out = out.replace(PEM, MASK);
    out = out.replace(DIGEST_FIELD, (_m, k, sep, q) => `${k}${sep}${q}${MASK}${q}`);
    out = out.replace(SIGV4_SIGNATURE, (_m, k) => `${k}${MASK}`);
    out = out.replace(AUTH_HEADER, (m, key, sep, scheme, value) => {
        if (value === MASK || /^Digest$/i.test(value) || /^AWS4-/i.test(value)) return m;
        const ok = scheme ? (/^basic$/i.test(scheme) ? basicShaped(value) || secretShaped(value) : secretShaped(value)) : secretShaped(value) || basicShaped(value);
        return ok ? `${key}${sep}${scheme ? `${scheme} ` : ""}${MASK}` : m;
    });
    out = out.replace(FREE_SCHEME, (m, scheme, sp, value) =>
        value !== MASK && (/^basic$/i.test(scheme) ? basicShaped(value) : secretShaped(value)) ? `${scheme}${sp}${MASK}` : m,
    );
    out = out.replace(COOKIE_HEADER, (m, key, sep, rest: string) => {
        if (rest.startsWith(MASK)) return m;
        // Keep trailing prose: ", then retry" (a comma not followed by another name=value).
        // (Not the comma in "Expires=Wed, 21 Oct …", which is followed by a digit.)
        const cut = /,\s+(?![\w.-]+\s*=)(?!\d)/.exec(rest);
        const value = cut ? rest.slice(0, cut.index) : rest;
        const tail = cut ? rest.slice(cut.index) : "";
        const pairs = /[\w.-]+\s*=\s*\S/.test(value);
        return pairs || secretShaped(value.trim()) ? `${key}${sep}${MASK}${tail}` : m;
    });
    out = out.replace(COOKIE_VALUE, (m, lead, q, inner, bareLead, bare) => {
        if (bareLead) return secretShaped(bare) ? `${bareLead}${MASK}` : m;
        return /=/.test(inner) || secretShaped(inner) ? `${lead}${q}${MASK}${q}` : m;
    });
    out = out.replace(ASSIGNMENT, (m, key, sep, value) => (assignedSecret(sep, value) ? `${key}${sep}${/^["'`]/.test(value) ? value[0] + MASK + value[0] : MASK}` : m));
    out = out.replace(PROVIDER_KEY, (k) => (providerShaped(k) ? MASK : k));
    out = out.replace(JWT, MASK);
    return out.replace(/\u0000U(\d+)\u0000/g, (_m, i) => urls[Number(i)]);
}
