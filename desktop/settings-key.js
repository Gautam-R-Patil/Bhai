// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The master key that encrypts Bhai's settings (.env.enc) and account session.
// No Electron imports here: main.js passes safeStorage in (testable).

const crypto = require("crypto");
const fs = require("fs");

/**
 * The key stored at `keyPath`, made on first use. When the keychain won't hand it back
 * (access refused) this throws: the old fallback to another key read the settings as
 * empty, and the next save wrote over them, Telegram token and passwords included.
 */
function readMasterKey(keyPath, safeStorage) {
    if (fs.existsSync(keyPath)) {
        const stored = fs.readFileSync(keyPath);
        const plain = stored.toString("utf8");
        if (/^[0-9a-f]{64}$/.test(plain)) return plain; // saved without OS encryption (below)
        try {
            return safeStorage.decryptString(stored);
        } catch {
            throw new Error(
                "Bhai couldn't unlock its saved settings: the system keychain refused its key. Quit and reopen Bhai, then allow access (Always Allow).",
            );
        }
    }
    const key = crypto.randomBytes(32).toString("hex");
    // ponytail: no OS encryption (some Linux desktops) keeps the key in the clear, as before.
    fs.writeFileSync(keyPath, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : key, { mode: 0o600 });
    return key;
}

/**
 * Before a settings save: a file no key opens (its key file lost or replaced) read as
 * empty, so the save would drop every setting in it. Keep it aside instead.
 */
function setAsideIfUnreadable(file, read) {
    if (!fs.existsSync(file)) return;
    try {
        read(fs.readFileSync(file));
    } catch {
        fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
    }
}

module.exports = { readMasterKey, setAsideIfUnreadable };
