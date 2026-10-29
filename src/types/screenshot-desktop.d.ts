// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "screenshot-desktop" {
    interface ScreenshotOptions {
        screen?: number | string;
        filename?: string;
        format?: "png" | "jpg";
    }
    function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
    export default screenshot;
}
