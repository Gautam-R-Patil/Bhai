// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The static gate a minted Site Skill passes before it is replayed, reviewed or
// shown to the owner. Deterministic, no model, no browser:
//
//   1 manifest   the minter's skill.json fields (zod), host fields filled in
//   2 compile    acorn; ≤24 KB; the required shape (exports.step, a phases
//                object with search, select and after_confirm)
//   3 SAST       forge's regex critic plus AST bans for minted code: require,
//                process, globalThis, Function, eval, timers, network, dynamic
//                import, .constructor / __proto__ and the other ways to reach
//                another object's prototype or a caller (getPrototypeOf, with,
//                this, arguments, stack-trace hooks), a computed key that is
//                not a literal (except the required phases[...] dispatch),
//                async code, loops with no exit test
//   4 literals   no value from the session (the search text, the chosen item,
//                what else was typed, the order id, the amount) and no PII
//   5 selectors  no generated/hashed class, no data-atlas-id; :nth-child warns
//   6 questions  every needsUser.question is a string literal skill.json declares
//   7 commits    listed when the session committed; their selectors appear only
//                inside a confirm.submit object; neither is a pick
//   8 domains    host-computed; a minter value that differs is reported, and
//                paymentDomains only from a fixed allowlist
//
// Findings name a value by its placeholder ({{input.query}}), never the value.

import * as acorn from "acorn";
import { z } from "zod";
import { runSastCritic } from "../../../forge/critics.js";
import { findPii } from "../../../security/pii-redactor.js";
import { ActionSchema } from "../host.js";
import { commitEvent, type LoadedTrace } from "./recorder.js";
import { lib } from "./replay.js";

export interface Finding {
    id: string;
    severity: "error" | "warning";
    detail: string;
}
/** A value the session used, and the placeholder the minter knows it by. */
export interface RecordedValue {
    value: string;
    label: string;
}

export const MAX_SKILL_BYTES = 24_000;
export const PAYMENT_DOMAINS = ["razorpay.com", "payu.in", "juspay.in", "cashfree.com", "paytm.com"];

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "snake_case, ≤40 chars");
const compiles = (p: string) => {
    try {
        new RegExp(p);
        return true;
    } catch {
        return false;
    }
};

/** The fields the minter writes; the host adds name, version, domains, effect, status and minted. */
export const MintedManifestSchema = z.object({
    input: z
        .record(
            Id,
            z
                .object({
                    type: z.enum(["string", "number", "boolean"]),
                    required: z.boolean().optional(),
                    description: z.string().max(200).optional(),
                })
                .strict(),
        )
        .refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 10, "1 to 10 input fields"),
    commits: z.array(ActionSchema).max(5),
    questions: z
        .array(
            z
                .object({
                    id: Id,
                    kind: z.enum(["otp", "choice", "text", "confirm"]),
                    prompt: z.string().min(3).max(200),
                })
                .strict(),
        )
        .max(10),
    confirmPattern: z.string().min(3).max(200).refine(compiles, "confirmPattern must compile"),
    paymentDomains: z.array(z.string().max(100)).max(5).optional(),
    domains: z.array(z.string()).optional(), // the host's own value replaces it
    assumptions: z.array(z.string().max(300)).max(20).optional(),
    untested: z.array(z.string().max(300)).max(20).optional(),
});
export type MintedManifest = z.infer<typeof MintedManifestSchema>;

// ── AST helpers ───────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes
type N = any;
/** Every node with its parent and the key it sits under. */
function walk(node: N, visit: (n: N, parent: N | null, key: string) => void, parent: N | null = null, key = ""): void {
    if (!node || typeof node.type !== "string") return;
    visit(node, parent, key);
    for (const [k, v] of Object.entries(node)) {
        if (k === "type" || k === "start" || k === "end") continue;
        if (Array.isArray(v)) for (const c of v) walk(c, visit, node, k);
        else if (v && typeof v === "object") walk(v, visit, node, k);
    }
}
const keyName = (p: N): string | undefined =>
    p?.type === "Property" && !p.computed ? (p.key.name ?? p.key.value) : undefined;
/** A string literal or template's text (each ${…} as "${}"), else undefined. */
const stringOf = (n: N): string | undefined =>
    n?.type === "Literal" && typeof n.value === "string"
        ? n.value
        : n?.type === "TemplateLiteral"
          ? n.quasis.map((q: N) => q.value.cooked ?? q.value.raw).join("${}")
          : undefined;
const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length;

// Names minted code may not touch: they reach outside step()'s arguments.
const BANNED_NAMES = new Set([
    "require",
    "process",
    "globalThis",
    "global",
    "Function",
    "eval",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "Buffer",
    "Reflect",
    "Proxy",
    "WebAssembly",
    "SharedArrayBuffer",
    "Atomics",
    "arguments",
]);
// Keys that lead from an object to its prototype, its constructor (another
// realm's Function), its caller, or the frames on the stack.
const BANNED_PROPS = new Set([
    "constructor",
    "__proto__",
    "prototype",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "getPrototypeOf",
    "setPrototypeOf",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "caller",
    "callee",
    "prepareStackTrace",
    "captureStackTrace",
    "getFunction",
    "getThis",
]);
const literalKey = (n: N) => n?.type === "Literal" && (typeof n.value === "string" || typeof n.value === "number");

// A class token that mixes letters and digits in its last segment (.css-1x2y3z,
// .sc-abc123, Foo__bar_3kXq, .a1b2c3): generated per build, gone next deploy.
const GENERATED_CLASS = /(?:^|[_-])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,}$/;
const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/;

const words = (t: string) => ` ${lib.fold(t)} `;

/**
 * Runs checks 1–8 on what the minter wrote. `trace` gives the commit and the
 * order ids; `values` the session's own values; `domains` the host's domains.
 */
export async function checkSkill(opts: {
    skillJson: unknown;
    skillCjs: string;
    trace: LoadedTrace;
    values: RecordedValue[];
    domains: string[];
}): Promise<{ manifest: MintedManifest | null; findings: Finding[] }> {
    const findings: Finding[] = [];
    const err = (id: string, detail: string) => findings.push({ id, severity: "error", detail });
    const warn = (id: string, detail: string) => findings.push({ id, severity: "warning", detail });
    const src = typeof opts.skillCjs === "string" ? opts.skillCjs : "";

    // 1 manifest
    const parsed = MintedManifestSchema.safeParse(opts.skillJson);
    const manifest = parsed.success ? parsed.data : null;
    if (!parsed.success) {
        for (const i of parsed.error.issues.slice(0, 8))
            err("manifest", `skill_json.${i.path.join(".") || "(root)"}: ${i.message}`);
    }

    // 8 domains
    if (manifest?.domains && JSON.stringify([...manifest.domains].sort()) !== JSON.stringify([...opts.domains].sort()))
        warn("domains_overridden", `domains are set by the host from the session: ${JSON.stringify(opts.domains)}`);
    for (const d of manifest?.paymentDomains ?? [])
        if (!PAYMENT_DOMAINS.includes(d)) err("payment_domain", `${d} is not an allowed payment domain`);

    // 2 compile
    if (Buffer.byteLength(src) > MAX_SKILL_BYTES) err("too_large", `skill_cjs is over ${MAX_SKILL_BYTES} bytes`);
    let ast: N;
    try {
        ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: false });
    } catch (e) {
        err("compile", (e as Error).message);
        return { manifest, findings };
    }

    // The top-level `const phases = {…}` (the one binding of phases allowed).
    const phasesDecl = ast.body
        .filter((s: N) => s.type === "VariableDeclaration")
        .flatMap((s: N) => s.declarations)
        .find((d: N) => d.id.type === "Identifier" && d.id.name === "phases");
    let hasStep = false;
    const phaseKeys = new Set<string>();
    const needsUser: N[] = [];
    const submits: Array<[number, number]> = [];
    const strings: Array<{ text: string; start: number; node: N; parent: N; key: string }> = [];
    const numbers: Array<{ value: number; start: number }> = [];
    walk(ast, (n, parent, key) => {
        // exports.step = … / module.exports.step = …
        if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
            const l = n.left;
            const obj = l.object.type === "Identifier" ? l.object.name : l.object.property?.name;
            if (obj === "exports" && (l.property.name ?? l.property.value) === "step") hasStep = true;
        }
        if (n === phasesDecl && n.init?.type === "ObjectExpression")
            for (const p of n.init.properties) if (keyName(p)) phaseKeys.add(keyName(p) as string);

        // 3 bans
        const at = `(line ${lineOf(src, n.start)})`;
        if (n.type === "Identifier") {
            const asKey =
                (parent?.type === "MemberExpression" && key === "property" && !parent.computed) ||
                (parent?.type === "Property" && key === "key" && !parent.computed && !parent.shorthand);
            if (!asKey && (BANNED_NAMES.has(n.name) || BANNED_PROPS.has(n.name)))
                err("banned", `${n.name} is not allowed ${at}`);
            // phases is the top-level phases object, used only as phases.x or phases[...].
            const phasesUse =
                asKey ||
                (parent?.type === "MemberExpression" && key === "object") ||
                (parent?.type === "VariableDeclarator" && key === "id" && parent === phasesDecl);
            if (n.name === "phases" && !phasesUse)
                err("banned", `phases may only be the top-level phases object, read as phases.x or phases[...] ${at}`);
        }
        if (n.type === "MemberExpression") {
            const p = n.computed ? (literalKey(n.property) ? n.property.value : undefined) : n.property.name;
            if (BANNED_PROPS.has(p)) err("banned", `.${p} is not allowed ${at}`);
            const dispatch = n.object.type === "Identifier" && n.object.name === "phases";
            if (n.computed && !literalKey(n.property) && !dispatch)
                err("banned", `a computed key must be a string or number literal (x["a"], x[0]) ${at}`);
        }
        if (n.type === "Property") {
            if (BANNED_PROPS.has(keyName(n) as string)) err("banned", `${keyName(n)} is not allowed ${at}`);
            if (n.computed && !literalKey(n.key) && parent?.type === "ObjectPattern")
                err("banned", `a computed key must be a string or number literal ${at}`);
        }
        if (n.type === "ThisExpression") err("banned", `this is not allowed ${at}`);
        if (n.type === "WithStatement") err("banned", `with is not allowed ${at}`);
        if (n.async || n.type === "AwaitExpression")
            err("banned", `async code is not allowed: step() returns its result ${at}`);
        if (n.type === "ImportExpression" || n.type === "MetaProperty")
            err("banned", `dynamic import is not allowed ${at}`);
        if (
            (n.type === "WhileStatement" || n.type === "DoWhileStatement" || n.type === "ForStatement") &&
            (!n.test || (n.test.type === "Literal" && n.test.value))
        )
            err("banned", `a loop with no exit test is not allowed ${at}`);

        if (keyName(n) === "needsUser") needsUser.push(n.value);
        if (keyName(n) === "submit") {
            submits.push([n.value.start, n.value.end]);
            const op = n.value.type === "ObjectExpression" ? n.value.properties.find((p: N) => keyName(p) === "op") : undefined;
            if (op?.value?.type === "Literal" && op.value.value === "pick")
                err("commits", `confirm.submit must click the commit, not pick one (line ${lineOf(src, n.start)})`);
        }
        const text = stringOf(n);
        if (text !== undefined) strings.push({ text, start: n.start, node: n, parent, key });
        if (n.type === "Literal" && n.regex)
            strings.push({ text: n.regex.pattern, start: n.start, node: n, parent, key });
        if (n.type === "Literal" && typeof n.value === "number") numbers.push({ value: n.value, start: n.start });
    });
    if (!hasStep) err("shape", "skill_cjs must set exports.step");
    for (const p of ["search", "select", "after_confirm"])
        if (!phaseKeys.has(p)) err("shape", `const phases = {…} must have ${p}`);

    const sast = await runSastCritic(src, { rulesPath: null });
    for (const f of sast.findings) if (f.severity === "ERROR") err("sast", `${f.message} (line ${f.line})`);

    // 4 literals: the session's values, the order id and the amount
    const values = opts.values.filter((v) => lib.fold(v.value).length >= 3);
    const commit = commitEvent(opts.trace);
    let pattern: RegExp | null = null;
    try {
        pattern = manifest ? new RegExp(manifest.confirmPattern, "g") : null;
    } catch {}
    const after = opts.trace.pages.filter((p) => !p.offsite && (!commit || p.k > commit.k));
    if (commit && pattern) {
        for (const p of after)
            for (const m of p.snapshot.text.matchAll(pattern)) {
                if (/\d/.test(m[0])) values.push({ value: m[0], label: "the order confirmation" });
                const id = /[A-Z0-9][A-Z0-9-]{3,}$/i.exec(m[0].replace(/[^A-Z0-9-]+$/i, ""));
                if (id && /\d/.test(id[0])) values.push({ value: id[0], label: "the order id" });
            }
    }
    const amounts = new Set<number>();
    const reviewPage = commit ? opts.trace.pages.find((p) => p.k === commit.k) : undefined;
    for (const m of (reviewPage?.snapshot.text ?? "").matchAll(/(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)/gi)) {
        const v = Number(m[1].replace(/,/g, ""));
        if (v >= 10) amounts.add(v);
    }
    const reported = new Set<string>();
    for (const s of strings) {
        const w = words(s.text);
        for (const v of values) {
            if (reported.has(v.label)) continue;
            if (w.includes(words(v.value)) || s.text.includes(v.value)) {
                reported.add(v.label);
                err(
                    "example_literal",
                    `${v.label} from the session is hard-coded at line ${lineOf(src, s.start)}; read it from input, answer or the page`,
                );
            }
        }
        for (const a of amounts) {
            if (!reported.has(`₹${a}`) && w.includes(` ${a} `)) {
                reported.add(`₹${a}`);
                err(
                    "example_literal",
                    `the session's amount is hard-coded at line ${lineOf(src, s.start)}; read it from the page`,
                );
            }
        }
        const pii = findPii(s.text)[0];
        if (pii) err("pii_literal", `a ${pii.kind} value is in the code at line ${lineOf(src, s.start)}`);
        else if (PHONE.test(s.text))
            err("pii_literal", `a phone number is in the code at line ${lineOf(src, s.start)}`);
    }
    for (const n of numbers) {
        if (amounts.has(n.value) && !reported.has(`₹${n.value}`)) {
            reported.add(`₹${n.value}`);
            err(
                "example_literal",
                `the session's amount is hard-coded at line ${lineOf(src, n.start)}; read it from the page`,
            );
        }
    }

    // 5 selectors
    for (const s of strings) {
        if (s.text.includes("data-atlas-id"))
            err("selector", `data-atlas-id changes on every scan (line ${lineOf(src, s.start)})`);
        if (keyName(s.parent) !== "sel" || s.key !== "value") continue;
        const bare = s.text.replace(/"[^"]*"|'[^']*'|\$\{\}/g, "");
        for (const m of bare.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
            if (GENERATED_CLASS.test(m[1]))
                err(
                    "selector",
                    `.${m[1]} looks generated by a build; use an id, data-* attribute, name, role or text (line ${lineOf(src, s.start)})`,
                );
        }
        if (/:nth-(?:child|of-type)/.test(bare))
            warn("selector", `:nth-child breaks when the page reorders (line ${lineOf(src, s.start)})`);
    }

    // 6 questions
    const declared = new Set((manifest?.questions ?? []).map((q) => q.id));
    for (const v of needsUser) {
        const q = v?.type === "ObjectExpression" ? v.properties.find((p: N) => keyName(p) === "question") : undefined;
        const id = q?.value?.type === "Literal" ? q.value.value : undefined;
        if (typeof id !== "string")
            err("question", `needsUser.question must be a string literal (line ${lineOf(src, v.start)})`);
        else if (!declared.has(id)) err("question", `question "${id}" is not declared in skill_json.questions`);
    }

    // 7 commits
    if (manifest) {
        if (commit && !manifest.commits.length)
            err("commits", "the session placed an order: skill_json.commits must list the confirm.submit action");
        else if (submits.length && !manifest.commits.length)
            err("commits", "skill_cjs has a confirm.submit: skill_json.commits must list that action");
        for (const c of manifest.commits) {
            if (c.op === "pick") err("commits", "a commit must be a click or a press, not a pick");
            const key = c.target?.sel ?? c.target?.text;
            if (!key) continue;
            const uses = strings.filter((s) => s.text === key);
            const inSubmit = (s: { start: number }) => submits.some(([a, b]) => s.start >= a && s.start < b);
            if (!uses.some(inSubmit)) err("commits", `commit ${JSON.stringify(key)} must be the confirm.submit target`);
            if (uses.some((s) => !inSubmit(s)))
                err(
                    "commit_outside_confirm",
                    `commit ${JSON.stringify(key)} is used outside confirm.submit (line ${lineOf(src, uses.find((s) => !inSubmit(s))?.start ?? 0)})`,
                );
        }
    }
    return { manifest, findings };
}
