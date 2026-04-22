// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

export const credentialSetup: ToolDefinition = {
	schema: {
		type: "function",
		function: {
			name: "credential_setup",
			description:
				"Set up API credentials for a social media platform. Call when a platform credential is missing. mode='autonomous' navigates the developer portal automatically; mode='guided' sends step-by-step instructions to the user's active channel.",
			parameters: {
				type: "object",
				properties: {
					platform: {
						type: "string",
						enum: ["instagram", "linkedin", "tiktok", "twitter", "apify", "apollo", "reddit"],
					},
					brand_id: { type: "string" },
					mode: {
						type: "string",
						enum: ["autonomous", "guided"],
					},
				},
				required: ["platform", "brand_id", "mode"],
			},
		},
	},
	async handler(_input) {
		return JSON.stringify({ status: "stub", message: "credential_setup not yet implemented — Plan 2" });
	},
};
