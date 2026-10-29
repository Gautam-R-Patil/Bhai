// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

/**
 * What a non-owner gets when the channel passed no allowlist: a contact on
 * Telegram/Discord/Slack/Matrix, an email sender, a web-widget visitor.
 * Never shell, files, OS control, browser or messaging as the owner.
 */
export const NON_OWNER_TOOLS = ["get_current_time", "weather", "web_search", "ask_owner"];

/** undefined = unrestricted (owner); a list, even an empty one, = only those tools. */
export function isToolAllowed(allowlist: string[] | undefined, name: string): boolean {
    return allowlist === undefined || name === "get_current_time" || allowlist.includes(name);
}
