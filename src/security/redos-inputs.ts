// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Adversarial inputs for the protect() pipeline: each one made a credential,
// PII or secrets pattern rescan to the end of the text from every offset
// (quadratic) before the fixes in credential-mask.ts / secrets-sanitizer.ts.
// Shared by the ReDoS test, the native parity test and scripts/bench-native.ts.

const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

/** Deterministic "a1b2c3d4-e5f6…" hash chain. */
function kebab(n: number): string {
    let x = 0x9e3779b9;
    let s = "";
    while (s.length < n) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        s += `${x.toString(16).padStart(8, "0")}-`;
    }
    return s.slice(0, n);
}

/** The adversarial set: every input that made a pattern rescan to the end from each offset. */
export function adversarial(n: number): Record<string, string> {
    return {
        "a-": rep("a-", n),
        "pass-": rep("pass-", n),
        "x.": rep("x.", n),
        a_: rep("a_", n),
        "id-": rep("id-", n),
        "1-": rep("1-", n),
        kebab: kebab(Math.round(n * 1.15)), // the 46KB hash chain at n = 40KB
        "http+a.": `http${rep("a.", n)}`,
        "a.@ybl": `${rep("a.", n)}@ybl`,
        "a-b_": rep("a-b_", n),
        "eyJa.": rep("eyJa.", n),
        "sk-": rep("sk-", n),
        "PEM BEGIN×": rep("-----BEGIN PRIVATE KEY-----\n", n),
        "Cookie: a…": `Cookie: ${rep("a", n)}`,
        "Cookie: a.…": `Cookie: ${rep("a.", n)}`,
        'cookie: "a…': `cookie: "${rep("a", n)}`,
    };
}
