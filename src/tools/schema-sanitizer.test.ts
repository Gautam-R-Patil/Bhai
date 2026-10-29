// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { sanitizeToolSchemas, stripNullableUnions } from "./schema-sanitizer.js";

describe("stripNullableUnions", () => {
    it("collapses anyOf nullable union to the non-null branch", () => {
        const input = {
            type: "object",
            properties: {
                name: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                    default: null,
                    description: "user name",
                },
            },
        };
        const out = stripNullableUnions(input) as Record<string, unknown>;
        const name = (out.properties as Record<string, Record<string, unknown>>).name;
        expect(name.type).toBe("string");
        expect(name.nullable).toBe(true);
        expect(name.description).toBe("user name");
        expect(name).not.toHaveProperty("anyOf");
    });

    it("collapses oneOf nullable union to the non-null branch", () => {
        const input = {
            oneOf: [{ type: "integer" }, { type: "null" }],
            title: "limit",
        };
        const out = stripNullableUnions(input) as Record<string, unknown>;
        expect(out.type).toBe("integer");
        expect(out.nullable).toBe(true);
        expect(out.title).toBe("limit");
        expect(out).not.toHaveProperty("oneOf");
    });

    it("leaves non-nullable unions alone (two meaningful branches)", () => {
        const input = {
            anyOf: [{ type: "string" }, { type: "integer" }],
        };
        const out = stripNullableUnions(input) as Record<string, unknown>;
        expect(out).toEqual(input);
    });

    it("leaves unions without a null branch untouched", () => {
        const input = { anyOf: [{ type: "string" }] };
        const out = stripNullableUnions(input) as Record<string, unknown>;
        expect(out).toEqual(input);
    });

    it("can be configured to drop the nullable hint", () => {
        const input = {
            anyOf: [{ type: "string" }, { type: "null" }],
        };
        const out = stripNullableUnions(input, {
            keepNullableHint: false,
        }) as Record<string, unknown>;
        expect(out.type).toBe("string");
        expect(out).not.toHaveProperty("nullable");
    });

    it("recurses into nested properties", () => {
        const input = {
            type: "object",
            properties: {
                outer: {
                    type: "object",
                    properties: {
                        inner: {
                            anyOf: [{ type: "string" }, { type: "null" }],
                        },
                    },
                },
            },
        };
        const out = stripNullableUnions(input) as Record<string, unknown>;
        const outer = (out.properties as Record<string, Record<string, unknown>>).outer;
        const inner = (outer.properties as Record<string, Record<string, unknown>>).inner;
        expect(inner.type).toBe("string");
        expect(inner.nullable).toBe(true);
    });
});

describe("sanitizeToolSchemas", () => {
    it("passes an already-clean schema through unchanged (deep-copied)", () => {
        const tools = [
            {
                type: "function",
                function: {
                    name: "get_time",
                    description: "Get current time",
                    parameters: {
                        type: "object",
                        properties: {
                            timezone: { type: "string" },
                        },
                        required: ["timezone"],
                    },
                },
            },
        ];
        const out = sanitizeToolSchemas(tools);
        expect(out).toEqual(tools);
        // Deep copy — mutating output should not affect input
        (out![0].function as { parameters: { properties: Record<string, unknown> } }).parameters.properties.tampered =
            true;
        expect(
            (tools[0].function as { parameters: { properties: Record<string, unknown> } }).parameters.properties,
        ).not.toHaveProperty("tampered");
    });

    it("adds empty `properties` when an object schema is missing it", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "noop",
                    parameters: { type: "object" },
                },
            },
        ]);
        const params = (out![0].function as { parameters: Record<string, unknown> }).parameters;
        expect(params.type).toBe("object");
        expect(params.properties).toEqual({});
    });

    it("replaces bare-string schema values with a proper dict", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "bad_mcp",
                    parameters: {
                        type: "object",
                        properties: {
                            // Malformed: value is a string, not a schema
                            raw: "string" as unknown as Record<string, unknown>,
                        },
                    },
                },
            },
        ]);
        const raw = (
            out![0].function as {
                parameters: { properties: Record<string, Record<string, unknown>> };
            }
        ).parameters.properties.raw;
        expect(raw).toEqual({ type: "string" });
    });

    it("collapses `type: [X, 'null']` to `type: X` with `nullable: true`", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: {
                            x: { type: ["string", "null"] as unknown as string },
                        },
                    },
                },
            },
        ]);
        const x = (
            out![0].function as {
                parameters: { properties: Record<string, Record<string, unknown>> };
            }
        ).parameters.properties.x;
        expect(x.type).toBe("string");
        expect(x.nullable).toBe(true);
    });

    it("prunes `required` entries pointing at undefined properties", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: { a: { type: "string" } },
                        required: ["a", "ghost"],
                    },
                },
            },
        ]);
        const params = (out![0].function as { parameters: Record<string, unknown> }).parameters;
        expect(params.required).toEqual(["a"]);
    });

    it("drops `required` entirely when all entries point at ghosts", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: { a: { type: "string" } },
                        required: ["ghost1", "ghost2"],
                    },
                },
            },
        ]);
        const params = (out![0].function as { parameters: Record<string, unknown> }).parameters;
        expect(params).not.toHaveProperty("required");
    });

    it("does NOT rewrite `required: ['path']` into a schema (sibling-keyword isolation)", () => {
        // The bug being prevented: recursion treats the string "path" as a
        // bare-string schema and replaces it with {type: "object"}.
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: { path: { type: "string" } },
                        required: ["path"],
                    },
                },
            },
        ]);
        const params = (out![0].function as { parameters: Record<string, unknown> }).parameters;
        expect(params.required).toEqual(["path"]);
    });

    it("preserves enum values verbatim", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: {
                            kind: {
                                type: "string",
                                enum: ["object", "string", "array"],
                            },
                        },
                    },
                },
            },
        ]);
        const kind = (
            out![0].function as {
                parameters: { properties: Record<string, Record<string, unknown>> };
            }
        ).parameters.properties.kind;
        expect(kind.enum).toEqual(["object", "string", "array"]);
    });

    it("replaces a non-object parameters field with a valid empty object schema", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: null as unknown as Record<string, unknown>,
                },
            },
        ]);
        const params = (out![0].function as { parameters: Record<string, unknown> }).parameters;
        expect(params).toEqual({ type: "object", properties: {} });
    });

    it("returns the input list unchanged when empty or undefined", () => {
        expect(sanitizeToolSchemas([])).toEqual([]);
        expect(sanitizeToolSchemas(undefined as unknown as Array<Record<string, unknown>>)).toBeUndefined();
    });

    it("collapses nullable union at the top-level parameters field", () => {
        const out = sanitizeToolSchemas([
            {
                type: "function",
                function: {
                    name: "fn",
                    parameters: {
                        type: "object",
                        properties: {
                            maybe: {
                                anyOf: [{ type: "integer" }, { type: "null" }],
                            },
                        },
                    },
                },
            },
        ]);
        const maybe = (
            out![0].function as {
                parameters: { properties: Record<string, Record<string, unknown>> };
            }
        ).parameters.properties.maybe;
        expect(maybe.type).toBe("integer");
        expect(maybe.nullable).toBe(true);
    });
});
