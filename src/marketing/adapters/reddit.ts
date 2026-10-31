// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { resolveCredential } from "../brand-profile.js";

export interface RedditPostResult {
    postId: string;
    url: string;
}

export async function postReddit(
    brandId: string,
    subreddit: string,
    title: string,
    text?: string,
): Promise<RedditPostResult> {
    const clientId = resolveCredential(`REDDIT_CLIENT_ID_${brandId}`);
    const clientSecret = resolveCredential(`REDDIT_CLIENT_SECRET_${brandId}`);
    const refreshToken = resolveCredential(`REDDIT_REFRESH_TOKEN_${brandId}`);
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(`Reddit credentials not set for brand "${brandId}"`);
    }

    const userAgent = "BHAI-Marketing/1.0";
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": userAgent,
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const token = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenRes.ok || !token.access_token) {
        throw new Error(`Reddit token refresh failed: ${token.error ?? tokenRes.status}`);
    }

    const submitRes = await fetch("https://oauth.reddit.com/api/submit", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": userAgent,
        },
        body: new URLSearchParams({
            api_type: "json",
            kind: "self",
            sr: subreddit,
            title: title.slice(0, 300),
            text: text ?? "",
        }),
    });
    const submitted = (await submitRes.json()) as {
        json?: { errors?: unknown[][]; data?: { id?: string } };
    };
    const errors = submitted.json?.errors ?? [];
    if (!submitRes.ok || errors.length > 0 || !submitted.json?.data?.id) {
        throw new Error(`Reddit submit failed: ${errors.length ? JSON.stringify(errors) : submitRes.status}`);
    }

    const postId = submitted.json.data.id;
    return { postId, url: `https://reddit.com/r/${subreddit}/comments/${postId}` };
}
