// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "clipboardy" {
    /** Read text from the system clipboard. */
    function read(): Promise<string>;
    /** Write text to the system clipboard. */
    function write(text: string): Promise<void>;
    /** Read text from the system clipboard synchronously. */
    function readSync(): string;
    /** Write text to the system clipboard synchronously. */
    function writeSync(text: string): void;
    export default { read, write, readSync, writeSync };
    export { read, write, readSync, writeSync };
}
