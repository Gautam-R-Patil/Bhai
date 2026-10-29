// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";

// Accept only "program" or "program.ext" style names. No separators, no shell
// metachars — the caller must hand the bare binary name; resolving the path
// is this function's job. First character is restricted to alphanumeric so
// a leading "-" can't turn into a flag like `where -R` if argv parsing ever
// changed (where.exe treats "-R dir" as recursive search).
const SAFE_BINARY = /^[a-zA-Z0-9_][a-zA-Z0-9_.\-+]*$/;

export function binaryExists(binary: string): Promise<boolean> {
    if (!binary || binary.startsWith("-") || !SAFE_BINARY.test(binary)) {
        return Promise.resolve(false);
    }
    const probe = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
        // execFile with array args bypasses the shell entirely — no chance
        // of interpretation even if the regex above ever regresses.
        execFile(probe, [binary], { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(false);
            resolve(stdout.trim().length > 0);
        });
    });
}
