// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "qrcode-terminal" {
    interface QRCodeOptions {
        small?: boolean;
    }

    export function generate(text: string, options?: QRCodeOptions, callback?: (qrcode: string) => void): void;
    export function setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
}
