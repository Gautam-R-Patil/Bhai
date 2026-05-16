// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox handler shim. Runs inside the OS-sandboxed Node child.
//
// Contract:
//   - Reads JSON-line requests from stdin: {"id": "<uuid>", "input": <any>, "deadline_ms": <int>}
//   - Writes JSON-line responses to stdout: {"id": "<uuid>", "ok": true, "result": <any>}
//                                       or  {"id": "<uuid>", "ok": false, "error": {"kind", "message", "stack?"}}
//   - Boot message emitted ONCE at startup: {"id": "__boot__", "ok": true}
//   - Handler lives at $ATLAS_FORGE_HANDLER_PATH and exports a single async fn.
//
// NO monkey-patching — the OS sandbox is the fence. If the handler tries
// fs.readFile("/etc/passwd"), it gets EACCES and throws; we catch + report
// as `handler_error` (the supervisor will classify it as a cap_denied strike
// based on the error.code field).

"use strict";

const readline = require("node:readline");

const handlerPath = process.env.ATLAS_FORGE_HANDLER_PATH;
if (!handlerPath) {
    process.stderr.write("forge-shim: ATLAS_FORGE_HANDLER_PATH not set\n");
    process.exit(2);
}

let handler;
try {
    handler = require(handlerPath);
    if (typeof handler !== "function") {
        if (handler && typeof handler.default === "function") {
            handler = handler.default;
        } else if (handler && typeof handler.handler === "function") {
            handler = handler.handler;
        } else {
            throw new Error("handler module did not export a function");
        }
    }
} catch (err) {
    process.stdout.write(JSON.stringify({
        id: "__boot__",
        ok: false,
        error: { kind: "boot_failed", message: String(err && err.message || err), stack: err && err.stack },
    }) + "\n");
    process.exit(3);
}

process.stdout.write(JSON.stringify({ id: "__boot__", ok: true }) + "\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
    let req;
    try { req = JSON.parse(line); }
    catch (err) {
        process.stdout.write(JSON.stringify({
            id: "unknown",
            ok: false,
            error: { kind: "ipc_corruption", message: "malformed request JSON" },
        }) + "\n");
        return;
    }

    const id = req && req.id;
    try {
        const result = await handler(req.input);
        process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
    } catch (err) {
        const e = (err && typeof err === "object") ? err : { message: String(err) };
        process.stdout.write(JSON.stringify({
            id,
            ok: false,
            error: {
                kind: "handler_error",
                message: String(e.message || e),
                stack: e.stack || undefined,
                code: e.code || undefined,
            },
        }) + "\n");
    }
});

rl.on("close", () => process.exit(0));

process.on("uncaughtException", (err) => {
    process.stderr.write("forge-shim uncaughtException: " + (err && err.stack || err) + "\n");
    process.exit(4);
});

process.on("unhandledRejection", (err) => {
    process.stderr.write("forge-shim unhandledRejection: " + (err && err.stack || err) + "\n");
    process.exit(5);
});

process.on("message", () => {});
