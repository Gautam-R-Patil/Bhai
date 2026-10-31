// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edit as editTool } from "./edit.js";
import { hashContent, recordRead } from "./read-registry.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-edit-"));
beforeAll(() => {
    process.env.BHAI_NO_POST_EDIT_DIAGNOSTICS = "true";
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function edit(name: string, content: string, old_string: string, new_string: string) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    recordRead(file, hashContent(content));
    const res = JSON.parse(String(await editTool.handler({ file_path: file, old_string, new_string })));
    return { res, after: fs.readFileSync(file, "utf-8") };
}

describe("edit", () => {
    it("matches LF old_string in a CRLF file and keeps CRLF", async () => {
        const { res, after } = await edit("a.txt", "one\r\ntwo\r\nthree\r\n", "one\ntwo", "uno\ndos");
        expect(res.error).toBeUndefined();
        expect(after).toBe("uno\r\ndos\r\nthree\r\n");
    });

    it("writes $ patterns in new_string verbatim", async () => {
        const { after } = await edit("b.sh", "echo PID\n", "PID", "$$ $& $'");
        expect(after).toBe("echo $$ $& $'\n");
    });
});
