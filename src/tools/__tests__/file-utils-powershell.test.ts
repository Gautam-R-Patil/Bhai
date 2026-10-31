// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Windows: paths went into double-quoted PowerShell, which runs a $(…) in a file name.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const ps = vi.hoisted(() => vi.fn(async (_cmd: string) => ""));
vi.mock("../platform.js", async (orig) => ({
    ...(await orig<typeof import("../platform.js")>()),
    IS_WIN: true,
    IS_MAC: false,
    runPowerShell: ps,
    runPowerShellInline: ps,
}));

const { compressFiles, trashManager } = await import("../file-utils.js");

describe("file-utils on Windows", () => {
    const dir = mkdtempSync(join(homedir(), ".bhai-ps-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("passes file names as single-quoted literals", async () => {
        const name = join(dir, "invoice$(iwr x|iex)'s");
        const lit = (p: string) => `'${p.replace(/'/g, "''")}'`;
        writeFileSync(`${name}.txt`, "a");
        writeFileSync(`${name}.zip`, "zip");
        await compressFiles.handler({ action: "zip", paths: [`${name}.txt`], archive_path: join(dir, "o.zip") });
        await compressFiles.handler({ action: "unzip", archive_path: `${name}.zip`, output_dir: join(dir, "out") });
        await trashManager.handler({ action: "trash", path: `${name}.zip` });
        const [zip, unzip, trash] = ps.mock.calls.map((c) => c[0]);
        expect(zip).toContain(`Compress-Archive -LiteralPath ${lit(`${name}.txt`)}`);
        expect(unzip).toContain(`Expand-Archive -LiteralPath ${lit(`${name}.zip`)}`);
        expect(trash).toContain(`ParseName(${lit(`${name}.zip`)})`);
    });
});
