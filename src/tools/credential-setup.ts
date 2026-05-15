// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getMissingCredentials, validateCredential } from "../marketing/credential-manager.js";
import { getApifyGuidedInstructions, setupApifyAutonomous } from "../marketing/credential-setup/apify.js";
import { getApolloGuidedInstructions, setupApolloAutonomous } from "../marketing/credential-setup/apollo.js";
import { getInstagramGuidedInstructions, setupInstagramAutonomous } from "../marketing/credential-setup/instagram.js";
import { getLinkedInGuidedInstructions, setupLinkedInAutonomous } from "../marketing/credential-setup/linkedin.js";
import { getRedditGuidedInstructions, setupRedditAutonomous } from "../marketing/credential-setup/reddit.js";
import { getTikTokGuidedInstructions, setupTikTokAutonomous } from "../marketing/credential-setup/tiktok.js";
import { getTwitterGuidedInstructions, setupTwitterGuided } from "../marketing/credential-setup/twitter.js";
import { deliverToActiveChannel } from "./channel-send.js";
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
    async handler(input) {
        const platform = input.platform as string;
        const brandId = input.brand_id as string;
        const mode = input.mode as "autonomous" | "guided";

        try {
            if (mode === "guided") {
                const instructions = getGuidedInstructions(platform, brandId);
                await deliverToActiveChannel(instructions, "");
                return JSON.stringify({
                    success: true,
                    mode: "guided",
                    message: "Instructions sent to your active channel",
                });
            }

            // Autonomous mode
            let result: { success: boolean; error?: string };
            switch (platform) {
                case "apify":
                    result = await setupApifyAutonomous();
                    break;
                case "apollo":
                    result = await setupApolloAutonomous();
                    break;
                case "instagram":
                    result = await setupInstagramAutonomous(brandId);
                    break;
                case "linkedin":
                    result = await setupLinkedInAutonomous(brandId);
                    break;
                case "tiktok":
                    result = await setupTikTokAutonomous(brandId);
                    break;
                case "twitter":
                    // Twitter is guided-only due to CAPTCHA
                    result = await setupTwitterGuided(brandId);
                    break;
                case "reddit":
                    result = await setupRedditAutonomous(brandId);
                    break;
                default:
                    return JSON.stringify({ success: false, error: `Unknown platform: ${platform}` });
            }

            if (!result.success) {
                // Fall back to guided instructions on autonomous failure
                const instructions = getGuidedInstructions(platform, brandId);
                await deliverToActiveChannel(
                    `Autonomous setup failed: ${result.error}\n\nHere are manual instructions instead:\n\n${instructions}`,
                    "",
                );
                return JSON.stringify({
                    success: false,
                    error: result.error,
                    nextStep: "Guided instructions sent to your active channel",
                });
            }

            // Check if credential is now valid
            const valid = await validateCredential(platform, brandId);
            return JSON.stringify({
                success: result.success,
                platform,
                validated: valid,
                message: valid
                    ? `${platform} credentials set up and validated successfully`
                    : `${platform} credentials saved but could not be validated — they may still work`,
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

function getGuidedInstructions(platform: string, brandId: string): string {
    switch (platform) {
        case "apify":
            return getApifyGuidedInstructions();
        case "apollo":
            return getApolloGuidedInstructions();
        case "instagram":
            return getInstagramGuidedInstructions(brandId);
        case "linkedin":
            return getLinkedInGuidedInstructions(brandId);
        case "tiktok":
            return getTikTokGuidedInstructions(brandId);
        case "twitter":
            return getTwitterGuidedInstructions(brandId);
        case "reddit":
            return getRedditGuidedInstructions(brandId);
        default:
            return `No setup instructions available for platform: ${platform}`;
    }
}

// Re-export getMissingCredentials for convenience — callers that import this tool
// file can also surface missing-credential info without a separate import.
export { getMissingCredentials };
