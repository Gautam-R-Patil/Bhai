// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { executeTool } from "../../tools/index.js";

/**
 * Navigate to a URL using the Chrome extension first (user is already logged in),
 * falling back to headless Playwright if the extension is not connected.
 */
export async function navigateToUrl(url: string): Promise<void> {
  try {
    await executeTool("browser_navigate", { url, mode: "chrome" });
  } catch {
    await executeTool("browser_navigate", { url, mode: "fast" });
  }
}

/**
 * Extract text/data from the current page using natural-language instructions.
 * Returns the raw string result from the browser.
 */
export async function extractFromPage(instructions: string): Promise<string> {
  const result = await executeTool("browser_extract", {
    type: "text",
    instructions,
  });
  // executeTool returns a JSON string — try to unwrap text content
  try {
    const parsed = JSON.parse(result) as { text?: string; content?: string };
    return parsed.text ?? parsed.content ?? result;
  } catch {
    return result;
  }
}
