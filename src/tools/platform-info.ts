// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { formatCapabilitiesForContext, getPlatformCapabilities } from "../utils/platform-capabilities.js";
import type { ToolDefinition } from "./get-current-time.js";

export const platformInfoTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "platform_info",
            description:
                "Get information about the current platform's capabilities: which shell is available, screenshot engine, clipboard engine, OCR availability, app automation tools, and whether native modules are loaded. Use this before attempting platform-specific operations to avoid tool failures.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler(_input) {
        const caps = await getPlatformCapabilities();
        return JSON.stringify({
            ...caps,
            summary: formatCapabilitiesForContext(caps),
        });
    },
};
