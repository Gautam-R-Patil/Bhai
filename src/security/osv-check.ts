// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export interface OsvMalwareResult {
    blocked: boolean;
    advisoryIds: string[];
    pkg?: { name: string; ecosystem: "npm" | "PyPI" };
    reason?: string;
}

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

type Ecosystem = "npm" | "PyPI";

function basename(command: string): string {
    const parts = command.split(/[\\/]/);
    return parts[parts.length - 1] || command;
}

function inferEcosystem(command: string): Ecosystem | null {
    const base = basename(command);
    if (base === "npx") return "npm";
    if (base === "uvx" || base === "pipx") return "PyPI";
    return null;
}

function extractRawSpec(ecosystem: Ecosystem, args: string[]): string | null {
    const flagWithValue =
        ecosystem === "npm" ? new Set(["-p", "--package"]) : new Set(["--from", "-w", "--with", "--python"]);
    const preferredFlag = ecosystem === "npm" ? new Set(["-p", "--package"]) : new Set(["--from"]);

    let firstNonFlag: string | null = null;
    for (let i = 0; i < args.length; i++) {
        const tok = args[i];
        if (tok === "--") continue;
        if (preferredFlag.has(tok) && i + 1 < args.length) {
            return args[i + 1];
        }
        if (flagWithValue.has(tok)) {
            i++;
            continue;
        }
        if (tok.startsWith("-")) continue;
        if (firstNonFlag === null) firstNonFlag = tok;
    }
    return firstNonFlag;
}

function isTagVersion(version: string): boolean {
    return /^(latest|next|beta|alpha|canary|rc)$/i.test(version);
}

function parseNpmSpec(raw: string): { name: string; version?: string } {
    if (raw.startsWith("@")) {
        const at = raw.lastIndexOf("@");
        if (at > 0) {
            const name = raw.slice(0, at);
            const version = raw.slice(at + 1);
            return { name, version: version || undefined };
        }
        return { name: raw };
    }
    const at = raw.indexOf("@");
    if (at > 0) {
        return { name: raw.slice(0, at), version: raw.slice(at + 1) || undefined };
    }
    return { name: raw };
}

function normalizePyPiName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function parsePyPiSpec(raw: string): { name: string; version?: string } {
    let spec = raw.replace(/\[[^\]]*\]/, "");
    const eq = spec.indexOf("==");
    if (eq >= 0) {
        const name = normalizePyPiName(spec.slice(0, eq));
        const version = spec.slice(eq + 2);
        return { name, version: version || undefined };
    }
    const specifier = spec.search(/[<>~!=]/);
    if (specifier >= 0) {
        spec = spec.slice(0, specifier);
    }
    return { name: normalizePyPiName(spec) };
}

function parsePackageSpec(ecosystem: Ecosystem, args: string[]): { name: string; version?: string } | null {
    const raw = extractRawSpec(ecosystem, args);
    if (!raw) return null;
    const parsed = ecosystem === "npm" ? parseNpmSpec(raw) : parsePyPiSpec(raw);
    if (!parsed.name) return null;
    if (ecosystem === "npm" && parsed.version && isTagVersion(parsed.version)) {
        return { name: parsed.name };
    }
    return parsed;
}

export async function checkPackageForMalware(command: string, args: string[]): Promise<OsvMalwareResult> {
    if (process.env.BHAI_NO_OSV_CHECK === "true") return { blocked: false, advisoryIds: [] };

    const ecosystem = inferEcosystem(command);
    if (!ecosystem) return { blocked: false, advisoryIds: [] };

    const parsed = parsePackageSpec(ecosystem, args);
    if (!parsed) return { blocked: false, advisoryIds: [] };

    const body = parsed.version
        ? { package: { name: parsed.name, ecosystem }, version: parsed.version }
        : { package: { name: parsed.name, ecosystem } };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let data: { vulns?: Array<{ id?: unknown }> };
    try {
        const res = await fetch(OSV_QUERY_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) return { blocked: false, advisoryIds: [], reason: "osv-unreachable" };
        data = (await res.json()) as { vulns?: Array<{ id?: unknown }> };
    } catch {
        // Fail-open: a slow/down/unparseable OSV must never block a connect.
        return { blocked: false, advisoryIds: [], reason: "osv-unreachable" };
    } finally {
        clearTimeout(timeout);
    }

    // MAL- = OSV malicious-package class; near-zero FP, unlike CVE/GHSA noise.
    const seen = new Set<string>();
    const matches: string[] = [];
    for (const v of data?.vulns || []) {
        if (typeof v.id === "string" && v.id.toUpperCase().startsWith("MAL-") && !seen.has(v.id)) {
            seen.add(v.id);
            matches.push(v.id);
        }
    }
    const capped = matches.slice(0, 3);

    if (capped.length > 0) {
        return {
            blocked: true,
            advisoryIds: capped,
            pkg: { name: parsed.name, ecosystem },
            reason: `OSV malware advisory: ${capped.join(", ")}`,
        };
    }
    return { blocked: false, advisoryIds: [], pkg: { name: parsed.name, ecosystem } };
}
