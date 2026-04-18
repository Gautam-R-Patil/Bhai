// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Zod-Based Tool Input Validation ─────────────
// Registry of Zod schemas for tool inputs. Validates LLM-generated
// tool call arguments before execution, returning errors that the
// LLM can use to self-correct.

import { z } from "zod";

// ── Schema Registry ─────────────────────────────

const toolSchemas = new Map<string, z.ZodType>();

/**
 * Register a Zod schema for a given tool name.
 * If a schema already exists for the tool, it is replaced.
 */
export function registerToolSchema(toolName: string, schema: z.ZodType): void {
    toolSchemas.set(toolName, schema);
}

/**
 * Validate tool input against its registered Zod schema.
 * Returns { valid: true } if no schema is registered (fail-open).
 */
export function validateToolInput(
    toolName: string,
    input: unknown,
): { valid: boolean; errors?: string[] } {
    const schema = toolSchemas.get(toolName);
    if (!schema) {
        // No schema registered -- fail-open, allow execution
        return { valid: true };
    }

    const result = schema.safeParse(input);
    if (result.success) {
        return { valid: true };
    }

    // Extract human-readable error messages from Zod
    const errors = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
    });

    return { valid: false, errors };
}

/**
 * Convert a tool's Zod schema to JSON Schema for LLM consumption.
 * Returns null if no schema is registered.
 */
export function getToolJsonSchema(toolName: string): object | null {
    const schema = toolSchemas.get(toolName);
    if (!schema) return null;

    // Use Zod's built-in JSON Schema conversion if available,
    // otherwise do a basic manual conversion for common types
    try {
        // zod-to-json-schema is not a dependency, so we do a lightweight conversion
        return zodToJsonSchema(schema);
    } catch {
        return null;
    }
}

/**
 * Check if a tool has a registered schema.
 */
export function hasToolSchema(toolName: string): boolean {
    return toolSchemas.has(toolName);
}

/**
 * Get all registered tool schema names (for debugging).
 */
export function getRegisteredSchemaNames(): string[] {
    return Array.from(toolSchemas.keys());
}

// ── Lightweight Zod-to-JSON-Schema Conversion ───
// Handles the common Zod types used in tool schemas without
// requiring the full zod-to-json-schema package.

function zodToJsonSchema(schema: z.ZodType): object {
    return convertZodType(schema);
}

function convertZodType(schema: z.ZodType): object {
    const def = (schema as z.ZodType & { _def: Record<string, unknown> })._def;

    if (!def) return { type: "object" };

    const typeName = def.typeName as string;

    switch (typeName) {
        case "ZodObject": {
            const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
            const properties: Record<string, object> = {};
            const required: string[] = [];

            for (const [key, value] of Object.entries(shape)) {
                const fieldSchema = value as z.ZodType;
                const fieldDef = (fieldSchema as z.ZodType & { _def: Record<string, unknown> })._def;
                const isOptional = (fieldDef?.typeName as string) === "ZodOptional";

                if (isOptional) {
                    const innerType = (fieldDef as Record<string, z.ZodType>).innerType;
                    properties[key] = convertZodType(innerType);
                } else {
                    properties[key] = convertZodType(fieldSchema);
                    required.push(key);
                }
            }

            const result: Record<string, unknown> = {
                type: "object",
                properties,
            };
            if (required.length > 0) result.required = required;
            return result;
        }

        case "ZodString":
            return { type: "string" };

        case "ZodNumber": {
            const checks = ((def as any).checks as Array<{ kind: string; value?: number }>) || [];
            const result: Record<string, unknown> = { type: "number" };
            for (const check of checks) {
                if (check.kind === "int") result.type = "integer";
                if (check.kind === "min") result.minimum = check.value;
                if (check.kind === "max") result.maximum = check.value;
            }
            return result;
        }

        case "ZodBoolean":
            return { type: "boolean" };

        case "ZodArray": {
            const itemType = (def as Record<string, z.ZodType>).type;
            return {
                type: "array",
                items: itemType ? convertZodType(itemType) : {},
            };
        }

        case "ZodOptional": {
            const innerType = (def as Record<string, z.ZodType>).innerType;
            return convertZodType(innerType);
        }

        case "ZodEnum": {
            const values = (def as Record<string, string[]>).values;
            return { type: "string", enum: values };
        }

        default:
            return {};
    }
}

// ── Built-in Tool Schemas ───────────────────────
// Pre-register schemas for the most critical tools.

const shellExecSchema = z.object({
    command: z.string().describe("Shell command to execute"),
    args: z.array(z.string()).optional().describe("Command arguments"),
    cwd: z.string().optional().describe("Working directory for command execution"),
});
registerToolSchema("shell_exec", shellExecSchema);

const readSchema = z.object({
    file_path: z.string().describe("Absolute or relative file path to read"),
    offset: z.number().optional().describe("1-based line to start reading from"),
    limit: z.number().optional().describe("Max lines to read (default 2000)"),
    pages: z.string().optional().describe("Page range for PDFs, e.g. '1-5'"),
});
registerToolSchema("read", readSchema);

const writeSchema = z.object({
    file_path: z.string().describe("Absolute or relative file path to write"),
    content: z.string().describe("Full content to write"),
});
registerToolSchema("write", writeSchema);

const editSchema = z.object({
    file_path: z.string().describe("Absolute or relative file path to edit"),
    old_string: z.string().describe("Exact text to find and replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence"),
});
registerToolSchema("edit", editSchema);

const appendFileSchema = z.object({
    file_path: z.string().describe("Absolute or relative file path"),
    content: z.string().describe("Content to append"),
});
registerToolSchema("append_file", appendFileSchema);

const grepSchema = z.object({
    pattern: z.string().describe("Regex pattern (ripgrep syntax)"),
    path: z.string().optional().describe("Directory or file to search in"),
    glob: z.string().optional().describe("Glob filter like '*.ts'"),
    type: z.string().optional().describe("Language shortcut like 'ts'"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    "-i": z.boolean().optional(),
    "-n": z.boolean().optional(),
    "-A": z.number().optional(),
    "-B": z.number().optional(),
    "-C": z.number().optional(),
    multiline: z.boolean().optional(),
    head_limit: z.number().optional(),
    offset: z.number().optional(),
});
registerToolSchema("grep", grepSchema);

const globSchema = z.object({
    pattern: z.string().describe("Glob pattern like 'src/**/*.ts'"),
    path: z.string().optional().describe("Base directory"),
    include_ignored: z.boolean().optional(),
});
registerToolSchema("glob", globSchema);

const webSearchSchema = z.object({
    query: z.string().describe("Search query"),
    num_results: z.number().int().min(1).max(15).optional().describe("Number of results to return (1-15)"),
});
registerToolSchema("web_search", webSearchSchema);

const memoryStoreSchema = z.object({
    content: z.string().min(1).describe("Content to store in memory"),
    category: z.string().optional().describe("Memory category (e.g., 'fact', 'preference', 'task')"),
    importance: z.number().min(1).max(10).optional().describe("Importance score (1-10)"),
});
registerToolSchema("memory_store", memoryStoreSchema);
