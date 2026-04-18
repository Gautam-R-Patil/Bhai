// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "ffprobe-static" {
    const ffprobe: { path: string; version?: string; url?: string };
    export default ffprobe;
    export const path: string;
}
