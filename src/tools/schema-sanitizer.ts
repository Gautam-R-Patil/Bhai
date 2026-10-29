// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SchemaObject = { [key: string]: JsonValue };

const PRIMITIVE_TYPE_NAMES = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);

function deepCopy<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        return value.map((v) => deepCopy(v)) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = deepCopy(v);
    }
    return out as T;
}

export interface StripNullableUnionsOptions {
    keepNullableHint?: boolean;
}

/**
 * Collapse `anyOf`/`oneOf` nullable unions to the non-null branch. Pydantic
 * optional fields commonly arrive as
 * `{anyOf: [{type: "string"}, {type: "null"}], default: null}`. Anthropic
 * rejects the null branch at the top of `input_schema`; collapse to the
 * non-null variant and (by default) keep `nullable: true` as a hint.
 *
 * Safe on non-dict/non-array inputs (returned unchanged). Does NOT deep-copy
 * the input — callers that need a fresh tree should wrap with `deepCopy`.
 */
export function stripNullableUnions(schema: unknown, options: StripNullableUnionsOptions = {}): unknown {
    const keepHint = options.keepNullableHint ?? true;
    if (Array.isArray(schema)) {
        return schema.map((item) => stripNullableUnions(item, { keepNullableHint: keepHint }));
    }
    if (schema === null || typeof schema !== "object") return schema;

    const input = schema as SchemaObject;
    const stripped: SchemaObject = {};
    for (const [k, v] of Object.entries(input)) {
        stripped[k] = stripNullableUnions(v, {
            keepNullableHint: keepHint,
        }) as JsonValue;
    }
    for (const unionKey of ["anyOf", "oneOf"] as const) {
        const variants = stripped[unionKey];
        if (!Array.isArray(variants)) continue;
        const nonNull = variants.filter(
            (item) =>
                !(
                    item !== null &&
                    typeof item === "object" &&
                    !Array.isArray(item) &&
                    (item as SchemaObject).type === "null"
                ),
        );
        if (nonNull.length === 1 && nonNull.length !== variants.length) {
            const sole = nonNull[0];
            const replacement: SchemaObject =
                sole !== null && typeof sole === "object" && !Array.isArray(sole) ? { ...(sole as SchemaObject) } : {};
            if (keepHint && replacement.nullable === undefined) {
                replacement.nullable = true;
            }
            for (const metaKey of ["title", "description", "default", "examples"] as const) {
                if (metaKey in stripped && !(metaKey in replacement)) {
                    replacement[metaKey] = stripped[metaKey];
                }
            }
            return stripNullableUnions(replacement, {
                keepNullableHint: keepHint,
            });
        }
    }
    return stripped;
}

function sanitizeNode(node: unknown, path: string): JsonValue {
    // Bare-string schema value → wrap as { type: X } (or empty object for "object")
    if (typeof node === "string") {
        if (PRIMITIVE_TYPE_NAMES.has(node)) {
            return node === "object" ? { type: "object", properties: {} } : { type: node };
        }
        // Stray non-type string at a schema position → permissive empty object
        return { type: "object", properties: {} };
    }

    if (Array.isArray(node)) {
        return node.map((item, i) => sanitizeNode(item, `${path}[${i}]`)) as JsonValue[];
    }

    if (node === null || typeof node !== "object") {
        return node as JsonValue;
    }

    const input = node as SchemaObject;
    const out: SchemaObject = {};

    for (const [key, value] of Object.entries(input)) {
        // type: [X, "null"] → type: X + nullable: true
        if (key === "type" && Array.isArray(value)) {
            const nonNull = value.filter((t) => t !== "null");
            if (nonNull.length === 1 && typeof nonNull[0] === "string") {
                out.type = nonNull[0];
                if (value.includes("null") && out.nullable === undefined) {
                    out.nullable = true;
                }
                continue;
            }
            const firstStr = value.find((t): t is string => typeof t === "string" && t !== "null");
            if (firstStr !== undefined) {
                out.type = firstStr;
                continue;
            }
            out.type = "object";
            continue;
        }

        // Recurse into object-of-schemas shapes
        if (
            (key === "properties" || key === "$defs" || key === "definitions") &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            const inner: SchemaObject = {};
            for (const [subK, subV] of Object.entries(value as SchemaObject)) {
                inner[subK] = sanitizeNode(subV, `${path}.${key}.${subK}`);
            }
            out[key] = inner;
            continue;
        }

        if (key === "items" || key === "additionalProperties") {
            if (typeof value === "boolean") {
                out[key] = value;
            } else {
                out[key] = sanitizeNode(value, `${path}.${key}`);
            }
            continue;
        }

        if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
            out[key] = value.map((item, i) => sanitizeNode(item, `${path}.${key}[${i}]`));
            continue;
        }

        // Sibling keywords whose values are NOT schemas — pass through
        // unchanged so literal strings like "path" aren't rewritten.
        if (key === "required" || key === "enum" || key === "examples") {
            out[key] = deepCopy(value) as JsonValue;
            continue;
        }

        // Generic recursion for anything else only when dict/array
        if (
            value !== null &&
            typeof value === "object" &&
            (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
        ) {
            out[key] = sanitizeNode(value, `${path}.${key}`);
        } else {
            out[key] = value as JsonValue;
        }
    }

    // Object nodes without properties: inject empty properties dict.
    if (
        out.type === "object" &&
        !(out.properties !== null && typeof out.properties === "object" && !Array.isArray(out.properties))
    ) {
        out.properties = {};
    }

    // Prune required entries that don't exist in properties
    if (out.type === "object" && Array.isArray(out.required)) {
        const propsObj = (out.properties as Record<string, unknown> | undefined) ?? {};
        const valid = (out.required as unknown[]).filter((r) => typeof r === "string" && r in propsObj) as string[];
        if (valid.length === 0) {
            delete out.required;
        } else if (valid.length !== (out.required as unknown[]).length) {
            out.required = valid;
        }
    }

    return out;
}

export interface ToolSchemaShape {
    type?: string;
    function?: {
        name?: string;
        description?: string;
        parameters?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/**
 * Sanitize the parameter schemas on a list of OpenAI-format tools. Returns a
 * deep-copied list so callers can mutate freely.
 */
export function sanitizeToolSchemas<T extends ToolSchemaShape>(tools: T[] | undefined): T[] | undefined {
    if (!tools) return tools;
    if (!Array.isArray(tools) || tools.length === 0) return tools;
    return tools.map((t) => sanitizeSingleTool(t));
}

function sanitizeSingleTool<T extends ToolSchemaShape>(tool: T): T {
    const out = deepCopy(tool);
    const fn = out?.function;
    if (!fn || typeof fn !== "object") return out;

    const params = fn.parameters;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        fn.parameters = { type: "object", properties: {} };
        return out;
    }

    const name = typeof fn.name === "string" ? fn.name : "<tool>";
    let sanitized = sanitizeNode(params, name);
    // Guarantee top-level is an object with properties
    if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
        sanitized = { type: "object", properties: {} };
    } else {
        const s = sanitized as SchemaObject;
        if (s.type !== "object") s.type = "object";
        if (s.properties === null || typeof s.properties !== "object" || Array.isArray(s.properties)) {
            s.properties = {};
        }
    }
    // Final nullable-union collapse
    fn.parameters = stripNullableUnions(sanitized, { keepNullableHint: true });
    return out;
}
