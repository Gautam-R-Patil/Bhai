// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A keychain that refuses the settings key is an error, never a different key
// (which read the settings as empty and let the next save write over them).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMasterKey, setAsideIfUnreadable } from "../settings-key.js";

const keychain = (refuse = false) => ({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`v10${s}`),
    decryptString: (b) => {
        if (refuse) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
        return b.toString().slice(3);
    },
});
const keyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bhai-key-")), ".keystore");

describe("settings key", () => {
    it("is made once and read back the same", () => {
        const f = keyFile();
        const key = readMasterKey(f, keychain());
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(readMasterKey(f, keychain())).toBe(key);
    });

    it("a refused keychain throws instead of handing out another key", () => {
        const f = keyFile();
        readMasterKey(f, keychain());
        expect(() => readMasterKey(f, keychain(true))).toThrow(/keychain refused/);
    });

    it("a key saved without OS encryption still reads back", () => {
        const f = keyFile();
        const noOs = { ...keychain(), isEncryptionAvailable: () => false };
        const key = readMasterKey(f, noOs);
        expect(readMasterKey(f, noOs)).toBe(key); // used to come back as a machine-derived key
    });

    it("a settings file no key opens is kept aside, a readable one stays", () => {
        const f = keyFile();
        fs.writeFileSync(f, "ok");
        setAsideIfUnreadable(f, () => "settings");
        expect(fs.readFileSync(f, "utf8")).toBe("ok");
        setAsideIfUnreadable(f, () => { throw new Error("bad key"); });
        expect(fs.existsSync(f)).toBe(false);
        const kept = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(".keystore.unreadable-"));
        expect(kept).toHaveLength(1);
    });
});
