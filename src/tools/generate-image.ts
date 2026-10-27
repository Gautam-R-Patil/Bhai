// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import { getConvexSiteUrl } from "../config/keys.js";
import { getImagesDir } from "../config/paths.js";
import { encryptedFetch } from "../crypto-transport.js";
import { getSessionToken } from "../session.js";
import type { ToolDefinition } from "./get-current-time.js";
import { getTelegramContext } from "./send-file.js";

// ── Image Generation Model ───────────────────
const IMAGE_MODEL = "openai/gpt-5-image";

// ── Tool: Generate Image ─────────────────────

export const generateImage: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "generate_image",
            description:
                "Generate an image from a text prompt using AI (GPT-5 Image). Use this when the user asks you to CREATE, GENERATE, MAKE, DRAW, or DESIGN an image. Do NOT use web_search to find images — use this tool instead. The generated image is saved locally and auto-sent to the user.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "Detailed description of the image to generate. Be specific about style, colors, composition, mood, etc.",
                    },
                    filename: {
                        type: "string",
                        description:
                            "Optional filename for the generated image (without extension). Defaults to 'generated_image'.",
                    },
                },
                required: ["prompt"],
            },
        },
    },

    async handler(input) {
        try {
            const prompt = input.prompt as string;
            const filename = (input.filename as string) || "generated_image";

            if (!prompt || prompt.trim().length === 0) {
                return JSON.stringify({ error: "Prompt is required for image generation." });
            }

            console.log(`  🎨 Generating image: "${prompt.substring(0, 80)}..."`);

            const sessionToken = await getSessionToken();
            if (!sessionToken) {
                return JSON.stringify({ error: "Not authenticated — cannot generate images." });
            }

            const proxyUrl = `${getConvexSiteUrl()}/api/llm/chat`;

            // Route through server-side proxy (no API key on client)
            const response = await encryptedFetch(proxyUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${sessionToken}`,
                },
                body: JSON.stringify({
                    model: IMAGE_MODEL,
                    modalities: ["text", "image"],
                    messages: [
                        {
                            role: "user",
                            content: `Generate an image: ${prompt}`,
                        },
                    ],
                }),
            });

            if (!response.ok) {
                const errBody = await response.text();
                console.error(`  ❌ OpenRouter returned ${response.status}: ${errBody.substring(0, 500)}`);
                return JSON.stringify({
                    error: `Image generation API error: ${response.status} — ${errBody.substring(0, 200)}`,
                });
            }

            // Get raw response text first for full debugging
            const rawText = await response.text();
            console.log(`  📦 Raw response (first 500 chars): ${rawText.substring(0, 500)}`);

            let data: Record<string, unknown>;
            try {
                data = JSON.parse(rawText);
            } catch {
                return JSON.stringify({
                    error: "Failed to parse API response as JSON.",
                    raw: rawText.substring(0, 300),
                });
            }

            // Log full structure
            console.log(`  📦 Top-level keys: ${JSON.stringify(Object.keys(data))}`);

            const choices = data.choices as Array<Record<string, unknown>> | undefined;
            if (!choices || choices.length === 0) {
                return JSON.stringify({ error: "No choices in response.", raw: rawText.substring(0, 500) });
            }

            const choice = choices[0];
            const msg = choice.message as Record<string, unknown> | undefined;
            if (!msg) {
                console.log(`  📦 Choice keys: ${JSON.stringify(Object.keys(choice))}`);
                return JSON.stringify({
                    error: "No message in choice.",
                    raw: JSON.stringify(choice).substring(0, 500),
                });
            }

            console.log(`  📦 Message keys: ${JSON.stringify(Object.keys(msg))}`);
            const content = msg.content;
            console.log(
                `  📦 Content type: ${typeof content}, isArray: ${Array.isArray(content)}, isNull: ${content === null}`,
            );

            if (content !== null && content !== undefined) {
                console.log(`  📦 Content preview: ${JSON.stringify(content).substring(0, 300)}`);
            }

            // Try multiple extraction paths for the image data
            let imageBase64: string | null = null;
            let mimeType = "image/png";

            // Path 0: GPT-5 Image format — images in separate 'images' field
            if (!imageBase64 && msg.images) {
                const images = msg.images as Array<Record<string, unknown>>;
                if (Array.isArray(images) && images.length > 0) {
                    const img = images[0];
                    console.log(`  📦 images[0] keys: ${JSON.stringify(Object.keys(img))}`);

                    // Format: { b64_json: "...", revised_prompt: "..." }
                    if (img.b64_json) {
                        imageBase64 = img.b64_json as string;
                        mimeType = "image/png";
                        console.log(`  ✅ Extracted via msg.images[0].b64_json (${imageBase64.length} chars)`);
                    }
                    // Format: { url: "data:image/png;base64,..." }
                    else if (img.url) {
                        const url = img.url as string;
                        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                        if (match) {
                            mimeType = match[1];
                            imageBase64 = match[2];
                            console.log(`  ✅ Extracted via msg.images[0].url data URI (${mimeType})`);
                        } else {
                            // It's a regular URL — download it
                            console.log(`  📥 Downloading from images[0].url: ${url.substring(0, 80)}...`);
                            try {
                                const imgResp = await fetch(url);
                                if (imgResp.ok) {
                                    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
                                    imageBase64 = imgBuf.toString("base64");
                                    const ct = imgResp.headers.get("content-type");
                                    if (ct) mimeType = ct;
                                    console.log(`  ✅ Downloaded image (${Math.round(imgBuf.length / 1024)}KB)`);
                                }
                            } catch (dlErr) {
                                console.warn(`  ⚠️ Download failed: ${(dlErr as Error).message}`);
                            }
                        }
                    }
                    // Format: { data: "base64...", mime_type: "image/png" }
                    else if (img.data) {
                        imageBase64 = img.data as string;
                        mimeType = (img.mime_type as string) || "image/png";
                        console.log(`  ✅ Extracted via msg.images[0].data (${mimeType})`);
                    }
                }
            }

            // Path 1: Content is an array of parts
            if (Array.isArray(content)) {
                for (let i = 0; i < content.length; i++) {
                    const part = content[i] as Record<string, unknown>;
                    console.log(`  📦 Part[${i}] type: ${part.type}, keys: ${JSON.stringify(Object.keys(part))}`);

                    // OpenRouter format: { type: "image_url", image_url: { url: "data:..." } }
                    if (part.type === "image_url") {
                        const imgUrl = part.image_url as Record<string, unknown>;
                        const url = imgUrl?.url as string;
                        if (url) {
                            const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                            if (match) {
                                mimeType = match[1];
                                imageBase64 = match[2];
                                console.log(`  ✅ Extracted via image_url (${mimeType}, ${imageBase64.length} chars)`);
                                break;
                            }
                        }
                    }

                    // Gemini format: { inline_data: { mime_type, data } }
                    if (part.inline_data) {
                        const inlineData = part.inline_data as Record<string, unknown>;
                        mimeType = (inlineData.mime_type as string) || "image/png";
                        imageBase64 = inlineData.data as string;
                        console.log(`  ✅ Extracted via inline_data (${mimeType})`);
                        break;
                    }
                }
            }

            // Path 2: Content is a string containing a data URL
            if (!imageBase64 && typeof content === "string" && content.includes("data:image")) {
                const dataUrlMatch = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\n\r]+/);
                if (dataUrlMatch) {
                    const match = dataUrlMatch[0].match(/^data:([^;]+);base64,(.+)$/s);
                    if (match) {
                        mimeType = match[1];
                        imageBase64 = match[2].replace(/[\n\r\s]/g, "");
                        console.log(`  ✅ Extracted from string content (${mimeType})`);
                    }
                }
            }

            // Path 3: Look for image data anywhere in the raw response
            if (!imageBase64) {
                const b64Match = rawText.match(/data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]{100,})/);
                if (b64Match) {
                    mimeType = `image/${b64Match[1]}`;
                    imageBase64 = b64Match[2];
                    console.log(`  ✅ Extracted from raw response text (${mimeType})`);
                }
            }

            // Path 4: Check if response has a 'data' field (OpenAI Images API format)
            if (!imageBase64 && data.data) {
                const dataArr = data.data as Array<Record<string, unknown>>;
                if (Array.isArray(dataArr) && dataArr.length > 0) {
                    const first = dataArr[0];
                    if (first.b64_json) {
                        imageBase64 = first.b64_json as string;
                        console.log(`  ✅ Extracted from data[0].b64_json`);
                    } else if (first.url) {
                        // Download image from URL
                        console.log(`  📥 Downloading image from URL: ${(first.url as string).substring(0, 80)}...`);
                        try {
                            const imgResp = await fetch(first.url as string);
                            if (imgResp.ok) {
                                const imgBuf = Buffer.from(await imgResp.arrayBuffer());
                                imageBase64 = imgBuf.toString("base64");
                                const contentType = imgResp.headers.get("content-type");
                                if (contentType) mimeType = contentType;
                                console.log(`  ✅ Downloaded image (${Math.round(imgBuf.length / 1024)}KB)`);
                            }
                        } catch (dlErr) {
                            console.warn(`  ⚠️ Failed to download image: ${(dlErr as Error).message}`);
                        }
                    }
                }
            }

            if (!imageBase64) {
                const textContent = typeof content === "string" ? content : JSON.stringify(content);
                return JSON.stringify({
                    error: "Image generation did not return image data.",
                    model_response: textContent ? textContent.substring(0, 500) : "null",
                    raw_keys: Object.keys(data),
                    message_keys: Object.keys(msg),
                    tip: "Check console logs for full response structure.",
                });
            }

            // Save the image to Bhai workspace Images folder
            const ext =
                mimeType.includes("jpeg") || mimeType.includes("jpg")
                    ? "jpg"
                    : mimeType.includes("webp")
                      ? "webp"
                      : "png";
            const imageDir = getImagesDir();

            const sanitizedName = filename.replace(/[^a-zA-Z0-9_-]/g, "_");
            const filePath = path.join(imageDir, `${sanitizedName}_${Date.now()}.${ext}`);
            const imageBuffer = Buffer.from(imageBase64, "base64");
            fs.writeFileSync(filePath, imageBuffer);

            console.log(`  ✅ Image generated: ${filePath} (${Math.round(imageBuffer.length / 1024)}KB)`);

            // Auto-send via Telegram if context is available
            const { bot, chatId } = getTelegramContext();
            if (bot && chatId) {
                try {
                    const { InputFile } = await import("grammy");
                    const inputFile = new InputFile(imageBuffer, `${sanitizedName}.${ext}`);
                    await bot.api.sendPhoto(chatId, inputFile, {
                        caption: prompt.length > 200 ? prompt.substring(0, 197) + "..." : prompt,
                    });
                    console.log(`  📤 Image sent to Telegram`);
                    return JSON.stringify({
                        success: true,
                        file_path: filePath,
                        size_kb: Math.round(imageBuffer.length / 1024),
                        sent_to_telegram: true,
                    });
                } catch (sendErr) {
                    console.warn(`  ⚠️ Failed to auto-send image: ${(sendErr as Error).message}`);
                }
            }

            return JSON.stringify({
                success: true,
                file_path: filePath,
                size_kb: Math.round(imageBuffer.length / 1024),
                sent_to_telegram: false,
                tip: "Use send_file to send this image to the user.",
            });
        } catch (err) {
            console.error(`  ❌ Image generation failed:`, err);
            return JSON.stringify({ error: `Image generation failed: ${(err as Error).message}` });
        }
    },
};
