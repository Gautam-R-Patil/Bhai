// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { extractJSON } from "../utils/json-extract.js";

export type ExpectedKind =
    | "returns_contains"
    | "returns_equals"
    | "returns_matches_regex"
    | "throws"
    | "throws_contains"
    | "returns_no_error"
    | "side_effect_file_exists"
    | "side_effect_url_called";

export interface SynthesisTest {
    input: Record<string, unknown>;
    expected_kind: ExpectedKind;
    expected_value: string | number | boolean | null | Record<string, unknown> | unknown[];
    description: string;
}

export interface SynthesisEnvelope {
    handler_code: string;
    tests: SynthesisTest[];
    capabilities_declared: string[];
    side_effects: "none" | "fs.write" | "net.outbound" | "system.modify";
    synthesis_notes: string;
}

const VALID_KINDS = new Set<ExpectedKind>([
    "returns_contains",
    "returns_equals",
    "returns_matches_regex",
    "throws",
    "throws_contains",
    "returns_no_error",
    "side_effect_file_exists",
    "side_effect_url_called",
]);

const VALID_SIDE_EFFECTS = new Set(["none", "fs.write", "net.outbound", "system.modify"]);
const MAX_HANDLER_BYTES = 50_000;
const MIN_TESTS = 3;
const MAX_TESTS = 7;

export type ParseResult = { ok: true; envelope: SynthesisEnvelope } | { ok: false; errors: string[] };

export function parseEnvelope(raw: string): ParseResult {
    const errors: string[] = [];

    let json: unknown;
    const extracted = extractJSON(raw);
    if (!extracted) {
        return { ok: false, errors: ["malformed JSON / no extractable JSON object"] };
    }
    try {
        json = JSON.parse(extracted);
    } catch (err) {
        return { ok: false, errors: [`JSON.parse failed: ${(err as Error).message}`] };
    }

    if (!json || typeof json !== "object") {
        return { ok: false, errors: ["envelope must be an object"] };
    }
    const o = json as Record<string, unknown>;

    if (typeof o.handler_code !== "string") errors.push("handler_code missing or not a string");
    else if (Buffer.byteLength(o.handler_code, "utf8") > MAX_HANDLER_BYTES)
        errors.push(`handler_code too large (>${MAX_HANDLER_BYTES} bytes)`);

    if (!Array.isArray(o.tests)) errors.push("tests missing or not an array");
    else {
        if (o.tests.length < MIN_TESTS) errors.push(`expected at least 3 tests, got ${o.tests.length}`);
        if (o.tests.length > MAX_TESTS) errors.push(`expected at most 7 tests, got ${o.tests.length}`);
        for (let i = 0; i < o.tests.length; i++) {
            const t = o.tests[i] as Record<string, unknown>;
            if (!t || typeof t !== "object") {
                errors.push(`test[${i}] not an object`);
                continue;
            }
            if (typeof t.expected_kind !== "string" || !VALID_KINDS.has(t.expected_kind as ExpectedKind)) {
                errors.push(`test[${i}].expected_kind invalid`);
            }
            if (typeof t.description !== "string") errors.push(`test[${i}].description missing`);
        }
    }

    if (typeof o.side_effects !== "string" || !VALID_SIDE_EFFECTS.has(o.side_effects as string)) {
        errors.push(`side_effects must be one of: ${Array.from(VALID_SIDE_EFFECTS).join(", ")}`);
    }

    if (!Array.isArray(o.capabilities_declared)) errors.push("capabilities_declared missing or not an array");

    const synthesisNotes = typeof o.synthesis_notes === "string" ? o.synthesis_notes : "";

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        envelope: {
            handler_code: o.handler_code as string,
            tests: o.tests as SynthesisTest[],
            capabilities_declared: o.capabilities_declared as string[],
            side_effects: o.side_effects as SynthesisEnvelope["side_effects"],
            synthesis_notes: synthesisNotes,
        },
    };
}
