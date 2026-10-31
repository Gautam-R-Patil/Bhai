// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Video Control Tool ─────────────────
// 3-tier fallback: JS Player API → keyboard shortcuts → hover+click UI
// Supports YouTube, Vimeo, and HTML5 <video> elements.

import { baseUrlHostMatches } from "../../utils/atomic-io.js";
import type { ToolDefinition } from "../get-current-time.js";
import { getActivePage } from "./core.js";
import { getVideoPlayerState, invalidateVideoState, setVideoPlayerState, signBrowserAction } from "./native-browser.js";

// ─── YouTube Player API JS ────────────────────────────────────────────────────

const YT_WAIT_READY = `
  const p = document.getElementById('movie_player');
  return !!(p && typeof p.getPlayerState === 'function' && p.getPlayerState() !== undefined);
`;

const YT_API = {
    play: `document.getElementById('movie_player')?.playVideo()`,
    pause: `document.getElementById('movie_player')?.pauseVideo()`,
    mute: `document.getElementById('movie_player')?.mute()`,
    unmute: `document.getElementById('movie_player')?.unMute()`,
    is_muted: `return document.getElementById('movie_player')?.isMuted()`,
    get_state: `return document.getElementById('movie_player')?.getPlayerState()`,
    get_time: `return document.getElementById('movie_player')?.getCurrentTime()`,
    get_duration: `return document.getElementById('movie_player')?.getDuration()`,
    get_volume: `return document.getElementById('movie_player')?.getVolume()`,
    get_info: `
      const p = document.getElementById('movie_player');
      return p ? {
        state: p.getPlayerState(),
        currentTime: p.getCurrentTime(),
        duration: p.getDuration(),
        isMuted: p.isMuted(),
        volume: p.getVolume(),
        videoData: p.getVideoData?.()
      } : null
    `,
};

// YT keyboard shortcuts — require player focus first
const YT_KEYS: Record<string, string> = {
    play: "k",
    pause: "k",
    mute: "m",
    unmute: "m",
    captions: "c",
    fullscreen: "f",
    seek_back_10: "j",
    seek_fwd_10: "l",
    seek_back_5: "ArrowLeft",
    seek_fwd_5: "ArrowRight",
    volume_up: "ArrowUp",
    volume_down: "ArrowDown",
};

// CSS selectors for hover-revealed YouTube controls
const YT_CSS: Record<string, string[]> = {
    play: [".ytp-play-button", 'button[aria-label*="Play"]', 'button[aria-label*="Pause"]'],
    mute: [".ytp-mute-button", 'button[aria-label*="Mute"]', 'button[aria-label*="Unmute"]'],
    captions: [".ytp-subtitles-button", 'button[aria-label*="Subtitles"]', 'button[aria-label*="captions"]'],
    fullscreen: [".ytp-fullscreen-button", 'button[aria-label*="Fullscreen"]'],
    settings: [".ytp-settings-button"],
};

// ─── HTML5 <video> element JS ─────────────────────────────────────────────────

const HTML5_API = {
    play: `document.querySelector('video')?.play()`,
    pause: `document.querySelector('video')?.pause()`,
    mute: `{ const v = document.querySelector('video'); if(v) v.muted = true; }`,
    unmute: `{ const v = document.querySelector('video'); if(v) v.muted = false; }`,
    is_muted: `return document.querySelector('video')?.muted`,
    get_time: `return document.querySelector('video')?.currentTime`,
    get_duration: `return document.querySelector('video')?.duration`,
    get_volume: `return document.querySelector('video')?.volume`,
    get_info: `
      const v = document.querySelector('video');
      return v ? {
        paused: v.paused, ended: v.ended, muted: v.muted,
        volume: v.volume, currentTime: v.currentTime, duration: v.duration,
        playbackRate: v.playbackRate, readyState: v.readyState,
        src: v.src?.substring(0, 80)
      } : null
    `,
};

// ═══════════════════════════════════════════════
// TOOL: Video Control
// ═══════════════════════════════════════════════

export const browserVideoControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_video_control",
            description:
                "Control video playback on YouTube, Vimeo, or HTML5 video pages. Automatically tries the most reliable method first: (1) JavaScript player API — no hover needed, instant and accurate, (2) keyboard shortcuts — works even if UI is hidden, (3) hover-to-reveal then click UI controls. Handles seek (to a specific time in seconds), mute/unmute, captions toggle, play/pause, volume, fullscreen, and state inspection.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description:
                            "Action to perform: 'play', 'pause', 'toggle_play', 'seek', 'mute', 'unmute', 'toggle_mute', 'captions', 'fullscreen', 'volume', 'set_speed', 'get_state', 'get_info'",
                    },
                    seek_to_seconds: {
                        type: "number",
                        description: "Target time in seconds for 'seek' action. E.g. 300 = 5 minutes.",
                    },
                    volume_level: {
                        type: "number",
                        description: "Volume 0–100 for 'volume' action.",
                    },
                    speed: {
                        type: "number",
                        description:
                            "Playback speed multiplier for 'set_speed': 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0",
                    },
                    site: {
                        type: "string",
                        description:
                            "Hint for which player to target: 'youtube' (default auto-detected), 'html5', 'vimeo'. Auto-detected from URL if omitted.",
                    },
                    method: {
                        type: "string",
                        description:
                            "Force a specific execution method: 'js_api' (default), 'keyboard', 'ui_click'. Only set this if you know the previous method failed.",
                    },
                },
                required: ["action"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const action = input.action as string;
            const seekTo = input.seek_to_seconds as number | undefined;
            const volumeLevel = input.volume_level as number | undefined;
            const speed = input.speed as number | undefined;
            const forcedMethod = input.method as string | undefined;

            // Auto-detect site from URL
            const url = page.url();
            const isYouTube = baseUrlHostMatches(url, "youtube.com") || baseUrlHostMatches(url, "youtu.be");
            const isVimeo = baseUrlHostMatches(url, "vimeo.com");
            const siteHint = (input.site as string) || (isYouTube ? "youtube" : isVimeo ? "vimeo" : "html5");

            // Sign this action for tamper-evident audit trail (IP protection)
            signBrowserAction("browser_video_control", JSON.stringify({ action, seekTo, volumeLevel }));

            // For get_info/get_state: check native cache first to avoid redundant evaluate()
            if ((action === "get_info" || action === "get_state") && !forcedMethod) {
                const cached = getVideoPlayerState(url);
                if (cached) {
                    return JSON.stringify({
                        success: true,
                        method: "native_cache",
                        site: siteHint,
                        action,
                        info: JSON.parse(cached),
                    });
                }
            }
            // Invalidate state cache for mutating actions (they change player state)
            if (
                [
                    "seek",
                    "mute",
                    "unmute",
                    "toggle_mute",
                    "play",
                    "pause",
                    "toggle_play",
                    "volume",
                    "set_speed",
                ].includes(action)
            ) {
                invalidateVideoState(url);
            }

            // ── TIER 1: JavaScript Player API ─────────────────────────────────
            if (!forcedMethod || forcedMethod === "js_api") {
                try {
                    if (siteHint === "youtube") {
                        // Wait for YouTube player to be ready (up to 8s)
                        const isReady = await page
                            .waitForFunction(YT_WAIT_READY, undefined, { timeout: 8000, polling: 300 })
                            .then(() => true)
                            .catch(() => false);

                        if (isReady) {
                            let result: unknown;

                            switch (action) {
                                case "play":
                                    await page.evaluate(YT_API.play);
                                    break;
                                case "pause":
                                    await page.evaluate(YT_API.pause);
                                    break;
                                case "toggle_play": {
                                    const state = await page.evaluate(`(async()=>{ ${YT_API.get_state} })()`);
                                    if (state === 1) await page.evaluate(YT_API.pause);
                                    else await page.evaluate(YT_API.play);
                                    break;
                                }
                                case "mute":
                                    await page.evaluate(YT_API.mute);
                                    break;
                                case "unmute":
                                    await page.evaluate(YT_API.unmute);
                                    break;
                                case "toggle_mute": {
                                    const muted = await page.evaluate(`(async()=>{ ${YT_API.is_muted} })()`);
                                    await page.evaluate(muted ? YT_API.unmute : YT_API.mute);
                                    break;
                                }
                                case "seek":
                                    if (seekTo === undefined)
                                        return JSON.stringify({ error: "seek requires seek_to_seconds" });
                                    await page.evaluate(
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        /* javascript-obfuscator:disable */ (secs: number) => {
                                            const p = document.getElementById("movie_player") as any;
                                            p?.seekTo?.(secs, true);
                                        },
                                        /* javascript-obfuscator:enable */ seekTo,
                                    );
                                    break;
                                case "volume":
                                    if (volumeLevel === undefined)
                                        return JSON.stringify({ error: "volume requires volume_level (0-100)" });
                                    await page.evaluate(
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        /* javascript-obfuscator:disable */ (vol: number) => {
                                            const p = document.getElementById("movie_player") as any;
                                            p?.setVolume?.(vol);
                                        },
                                        /* javascript-obfuscator:enable */ volumeLevel,
                                    );
                                    break;
                                case "set_speed":
                                    if (speed === undefined)
                                        return JSON.stringify({ error: "set_speed requires speed" });
                                    await page.evaluate(
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        /* javascript-obfuscator:disable */ (r: number) => {
                                            const p = document.getElementById("movie_player") as any;
                                            p?.setPlaybackRate?.(r);
                                        },
                                        /* javascript-obfuscator:enable */ speed,
                                    );
                                    break;
                                case "captions":
                                    // YouTube setOption captions is limited — fall through to keyboard
                                    throw new Error("captions: prefer keyboard shortcut");
                                case "get_state":
                                    result = await page.evaluate(`(async()=>{ ${YT_API.get_state} })()`);
                                    return JSON.stringify({
                                        success: true,
                                        method: "js_api",
                                        site: "youtube",
                                        player_state: result,
                                        state_meaning: {
                                            "-1": "unstarted",
                                            "0": "ended",
                                            "1": "playing",
                                            "2": "paused",
                                            "3": "buffering",
                                            "5": "cued",
                                        }[String(result)],
                                    });
                                case "get_info":
                                    result = await page.evaluate(`(async()=>{ ${YT_API.get_info} })()`);
                                    // Cache in native for future get_info calls (avoids page.evaluate round-trip)
                                    setVideoPlayerState(url, JSON.stringify(result));
                                    return JSON.stringify({
                                        success: true,
                                        method: "js_api",
                                        site: "youtube",
                                        info: result,
                                    });
                                default:
                                    throw new Error(`Unknown action: ${action}`);
                            }

                            // Verify key actions
                            let verification: Record<string, unknown> = {};
                            if (["mute", "unmute", "toggle_mute"].includes(action)) {
                                const nowMuted = await page
                                    .evaluate(`(async()=>{ ${YT_API.is_muted} })()`)
                                    .catch(() => null);
                                verification = { verified_muted: nowMuted };
                            }
                            if (action === "seek") {
                                await page
                                    .waitForFunction(
                                        /* javascript-obfuscator:disable */ () =>
                                            !document.querySelector("video")?.seeking,
                                        /* javascript-obfuscator:enable */ undefined,
                                        { timeout: 2000, polling: 100 },
                                    )
                                    .catch(() => {});
                                const nowTime = await page
                                    .evaluate(`(async()=>{ ${YT_API.get_time} })()`)
                                    .catch(() => null);
                                verification = { verified_current_time: nowTime };
                            }
                            if (action === "volume") {
                                const nowVol = await page
                                    .evaluate(`(async()=>{ ${YT_API.get_volume} })()`)
                                    .catch(() => null);
                                verification = { verified_volume: nowVol };
                            }

                            return JSON.stringify({
                                success: true,
                                method: "js_api",
                                site: "youtube",
                                action,
                                ...verification,
                            });
                        }
                    }

                    // HTML5 <video> fallback
                    if (siteHint === "html5" || !isYouTube) {
                        const videoExists = await page
                            .evaluate(
                                /* javascript-obfuscator:disable */ () => !!document.querySelector("video"),
                                /* javascript-obfuscator:enable */ undefined,
                            )
                            .catch(() => false);
                        if (videoExists) {
                            switch (action) {
                                case "play":
                                    await page.evaluate(HTML5_API.play);
                                    break;
                                case "pause":
                                    await page.evaluate(HTML5_API.pause);
                                    break;
                                case "toggle_play": {
                                    const paused = await page.evaluate(
                                        'return document.querySelector("video")?.paused',
                                    );
                                    await page.evaluate(paused ? HTML5_API.play : HTML5_API.pause);
                                    break;
                                }
                                case "mute":
                                    await page.evaluate(HTML5_API.mute);
                                    break;
                                case "unmute":
                                    await page.evaluate(HTML5_API.unmute);
                                    break;
                                case "toggle_mute": {
                                    const muted = await page.evaluate(`(async()=>{ ${HTML5_API.is_muted} })()`);
                                    await page.evaluate(muted ? HTML5_API.unmute : HTML5_API.mute);
                                    break;
                                }
                                case "seek":
                                    if (seekTo === undefined)
                                        return JSON.stringify({ error: "seek requires seek_to_seconds" });
                                    await page.evaluate(
                                        /* javascript-obfuscator:disable */ (t: number) => {
                                            const v = document.querySelector("video");
                                            if (v) v.currentTime = t;
                                        },
                                        /* javascript-obfuscator:enable */ seekTo,
                                    );
                                    break;
                                case "volume":
                                    if (volumeLevel === undefined)
                                        return JSON.stringify({ error: "volume requires volume_level (0-100)" });
                                    await page.evaluate(
                                        /* javascript-obfuscator:disable */ (vol: number) => {
                                            const v = document.querySelector("video");
                                            if (v) v.volume = vol / 100;
                                        },
                                        /* javascript-obfuscator:enable */ volumeLevel,
                                    );
                                    break;
                                case "set_speed":
                                    if (speed === undefined)
                                        return JSON.stringify({ error: "set_speed requires speed" });
                                    await page.evaluate(
                                        /* javascript-obfuscator:disable */ (r: number) => {
                                            const v = document.querySelector("video");
                                            if (v) v.playbackRate = r;
                                        },
                                        /* javascript-obfuscator:enable */ speed,
                                    );
                                    break;
                                case "get_info": {
                                    const info = await page.evaluate(`(async()=>{ ${HTML5_API.get_info} })()`);
                                    return JSON.stringify({ success: true, method: "js_api", site: "html5", info });
                                }
                                default:
                                    throw new Error(`Unknown html5 action: ${action}`);
                            }
                            return JSON.stringify({ success: true, method: "js_api", site: "html5", action });
                        }
                    }
                } catch (jsErr) {
                    const msg = (jsErr as Error).message;
                    // Only fall through if it's a genuine failure, not a programmer error
                    if (msg.includes("Unknown action") || msg.includes("requires ")) {
                        return JSON.stringify({ error: msg });
                    }
                    // Fall through to keyboard tier
                    console.log(`[video_control] JS API failed (${msg}), trying keyboard shortcuts`);
                }
            }

            // ── TIER 2: Keyboard Shortcuts ──────────────────────────────────────
            if (!forcedMethod || forcedMethod === "keyboard") {
                try {
                    // Focus the video player to receive keyboard events
                    if (isYouTube) {
                        await page
                            .locator("#movie_player")
                            .click({ timeout: 3000 })
                            .catch(
                                () => page.mouse.click(640, 400), // fallback: click center of viewport
                            );
                        await page
                            .waitForFunction(
                                /* javascript-obfuscator:disable */ () =>
                                    !!document.activeElement?.closest("#movie_player"),
                                /* javascript-obfuscator:enable */ undefined,
                                { timeout: 1000, polling: 50 },
                            )
                            .catch(() => {});
                    }

                    let keyUsed = "";
                    switch (action) {
                        case "play":
                        case "pause":
                        case "toggle_play":
                            await page.keyboard.press("k");
                            keyUsed = "k (play/pause toggle)";
                            break;
                        case "mute":
                        case "unmute":
                        case "toggle_mute":
                            await page.keyboard.press("m");
                            keyUsed = "m (mute toggle)";
                            break;
                        case "captions":
                            await page.keyboard.press("c");
                            keyUsed = "c (captions toggle)";
                            break;
                        case "fullscreen":
                            await page.keyboard.press("f");
                            keyUsed = "f (fullscreen)";
                            break;
                        case "seek":
                            if (seekTo === undefined) return JSON.stringify({ error: "seek requires seek_to_seconds" });
                            // Use number key for percentage jump if duration unknown, else calculate
                            {
                                const pct = await page
                                    .evaluate(`
                                  (async() => {
                                    const p = document.getElementById('movie_player');
                                    const dur = p?.getDuration?.();
                                    if (dur && dur > 0) return Math.round(${seekTo} / dur * 100);
                                    return null;
                                  })()
                                `)
                                    .catch(() => null);
                                if (pct !== null && typeof pct === "number" && pct >= 0 && pct <= 100) {
                                    const digit = String(Math.round(pct / 10));
                                    await page.keyboard.press(digit);
                                    keyUsed = `${digit} (jump to ~${pct}%)`;
                                } else {
                                    // Seek by repeated arrow keys as last resort
                                    const steps = Math.round(seekTo / 10);
                                    for (let i = 0; i < Math.min(steps, 30); i++) await page.keyboard.press("l");
                                    keyUsed = `l x${Math.min(steps, 30)} (forward 10s each)`;
                                }
                            }
                            break;
                        default:
                            throw new Error(`No keyboard shortcut for action: ${action}`);
                    }

                    return JSON.stringify({
                        success: true,
                        method: "keyboard",
                        site: isYouTube ? "youtube" : "html5",
                        action,
                        key_used: keyUsed,
                    });
                } catch (kbErr) {
                    console.log(`[video_control] Keyboard failed (${(kbErr as Error).message}), trying UI hover+click`);
                }
            }

            // ── TIER 3: Hover + Click UI Controls ──────────────────────────────
            if (!forcedMethod || forcedMethod === "ui_click") {
                try {
                    // Hover over the player center to reveal controls (interpolated steps)
                    const playerSel = isYouTube ? "#movie_player" : "video";
                    const bbox = await page
                        .locator(playerSel)
                        .first()
                        .boundingBox()
                        .catch(() => null);
                    const cx = bbox ? bbox.x + bbox.width / 2 : 640;
                    const cy = bbox ? bbox.y + bbox.height / 2 : 400;

                    await page.mouse.move(cx, cy, { steps: 8 });

                    // Wait for control bar to appear
                    const controlSel = isYouTube ? ".ytp-chrome-bottom" : '[class*="control"]';
                    await page
                        .waitForFunction(
                            /* javascript-obfuscator:disable */ (sel: string) => {
                                const el = document.querySelector(sel);
                                return el && parseFloat(window.getComputedStyle(el).opacity) > 0.9; // faded in
                            },
                            /* javascript-obfuscator:enable */ controlSel,
                            { timeout: 3000, polling: 100 },
                        )
                        .catch(() => {}); // non-fatal — try click anyway

                    // Determine which button to click
                    const selectors: string[] = [];
                    if (["mute", "unmute", "toggle_mute"].includes(action)) selectors.push(...(YT_CSS.mute || []));
                    else if (["play", "pause", "toggle_play"].includes(action)) selectors.push(...(YT_CSS.play || []));
                    else if (action === "captions") selectors.push(...(YT_CSS.captions || []));
                    else if (action === "fullscreen") selectors.push(...(YT_CSS.fullscreen || []));
                    else if (action === "seek" && seekTo !== undefined) {
                        // Click on progress bar at the percentage position
                        const progressSel = ".ytp-progress-bar";
                        const pBox = await page
                            .locator(progressSel)
                            .first()
                            .boundingBox()
                            .catch(() => null);
                        if (pBox) {
                            const duration = await page
                                .evaluate(`(async()=>{ ${YT_API.get_duration} })()`)
                                .catch(() => null);
                            if (typeof duration === "number" && duration > 0) {
                                const pct = seekTo / duration;
                                await page.mouse.click(
                                    pBox.x + pBox.width * Math.min(pct, 1),
                                    pBox.y + pBox.height / 2,
                                );
                                return JSON.stringify({
                                    success: true,
                                    method: "ui_click",
                                    site: isYouTube ? "youtube" : "html5",
                                    action,
                                    clicked_progress_bar: true,
                                });
                            }
                        }
                        return JSON.stringify({
                            error: "seek via UI failed: could not determine duration or find progress bar",
                        });
                    }

                    // Try each selector in order
                    for (const sel of selectors) {
                        const el = page.locator(sel).first();
                        const visible = await el.isVisible().catch(() => false);
                        if (visible) {
                            await el.click();
                            return JSON.stringify({
                                success: true,
                                method: "ui_click",
                                site: isYouTube ? "youtube" : "html5",
                                action,
                                selector_used: sel,
                            });
                        }
                    }

                    return JSON.stringify({
                        error: `ui_click: could not find visible button for action "${action}". Controls may still be hidden — try hovering longer.`,
                    });
                } catch (uiErr) {
                    return JSON.stringify({
                        error: `All methods failed. Last error: ${(uiErr as Error).message}. Try: (1) ensure a video is loaded and playing, (2) use method:"keyboard" with the player focused, (3) check if the site uses an embedded iframe (use browser_run_js to call video controls inside the frame).`,
                    });
                }
            }

            return JSON.stringify({ error: `No method succeeded for action "${action}" on ${url}` });
        } catch (err) {
            return JSON.stringify({ error: `video_control failed: ${(err as Error).message}` });
        }
    },
};
