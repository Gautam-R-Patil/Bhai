// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A value derived from a file, recomputed only when the file's size or mtime
// (or the caller's `extra` key, e.g. today's date) changes. The panel polls
// these every few seconds; the files (chat history, audit log) only grow.
const fs = require("node:fs");

function fileMemo(file, compute) {
    let key = null;
    let value;
    return (extra = "") => {
        let st = null;
        try {
            st = fs.statSync(file);
        } catch {
            /* missing: computed like any other state */
        }
        const k = st ? `${st.mtimeMs}:${st.size}:${extra}` : `-:${extra}`;
        if (k !== key) {
            value = compute();
            key = k;
        }
        return value;
    };
}

module.exports = { fileMemo };
