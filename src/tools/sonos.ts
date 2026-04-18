// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createSocket } from "dgram";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

interface SonosSpeaker {
    name: string;
    ip: string;
    model: string;
    room: string;
}

interface DiscoveryCache {
    speakers: SonosSpeaker[];
    timestamp: number;
}

// ── Constants ─────────────────────────────────

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SONOS_PORT = 1400;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SSDP_TIMEOUT_MS = 4000;

const SSDP_SEARCH = [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 3",
    "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
    "",
    "",
].join("\r\n");

const SERVICE_AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const SERVICE_RENDERING = "urn:schemas-upnp-org:service:RenderingControl:1";
const SERVICE_CONTENT_DIR = "urn:schemas-upnp-org:service:ContentDirectory:1";

const PATH_AV_TRANSPORT = "/MediaRenderer/AVTransport/Control";
const PATH_RENDERING = "/MediaRenderer/RenderingControl/Control";
const PATH_CONTENT_DIR = "/MediaServer/ContentDirectory/Control";

// ── Discovery Cache ───────────────────────────

let discoveryCache: DiscoveryCache | null = null;

// ── SOAP Helper ───────────────────────────────

function buildSoapEnvelope(
    service: string,
    action: string,
    args: Record<string, string | number> = {},
): string {
    const argXml = Object.entries(args)
        .map(([key, val]) => `<${key}>${escapeXml(String(val))}</${key}>`)
        .join("");

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
        ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
        "<s:Body>",
        `<u:${action} xmlns:u="${service}">`,
        argXml,
        `</u:${action}>`,
        "</s:Body>",
        "</s:Envelope>",
    ].join("");
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function soapAction(
    ip: string,
    path: string,
    service: string,
    action: string,
    args: Record<string, string | number> = {},
): Promise<string> {
    const body = buildSoapEnvelope(service, action, args);
    const url = `http://${ip}:${SONOS_PORT}${path}`;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": 'text/xml; charset="utf-8"',
            SOAPAction: `"${service}#${action}"`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
    });

    return res.text();
}

// ── XML Extraction Helper ─────────────────────

function extractTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = xml.match(regex);
    return match?.[1] ?? "";
}

function decodeXmlEntities(str: string): string {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

// ── SSDP Discovery ───────────────────────────

async function discoverSpeakers(): Promise<SonosSpeaker[]> {
    // Return cached results if still valid
    if (discoveryCache && Date.now() - discoveryCache.timestamp < CACHE_TTL_MS) {
        return discoveryCache.speakers;
    }

    const foundIps = new Set<string>();
    const speakers: SonosSpeaker[] = [];

    return new Promise((resolve) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        const searchBuf = Buffer.from(SSDP_SEARCH, "utf-8");

        const timeout = setTimeout(() => {
            socket.close();
            discoveryCache = { speakers, timestamp: Date.now() };
            resolve(speakers);
        }, SSDP_TIMEOUT_MS);

        socket.on("error", () => {
            clearTimeout(timeout);
            socket.close();
            discoveryCache = { speakers, timestamp: Date.now() };
            resolve(speakers);
        });

        socket.on("message", async (msg) => {
            const text = msg.toString();
            const locationMatch = text.match(/LOCATION:\s*(http:\/\/[\d.]+:\d+[^\s]*)/i);
            if (!locationMatch) return;

            const locationUrl = locationMatch[1];
            const ipMatch = locationUrl.match(/http:\/\/([\d.]+):/);
            if (!ipMatch) return;

            const ip = ipMatch[1];
            if (foundIps.has(ip)) return;
            foundIps.add(ip);

            try {
                const descRes = await fetch(locationUrl, {
                    signal: AbortSignal.timeout(3000),
                });
                const descXml = await descRes.text();

                const roomName =
                    extractTag(descXml, "roomName") ||
                    extractTag(descXml, "friendlyName") ||
                    "Unknown Room";
                const modelName = extractTag(descXml, "modelName") || "Sonos";
                const displayName = extractTag(descXml, "displayName") || roomName;

                speakers.push({
                    name: decodeXmlEntities(displayName),
                    ip,
                    model: decodeXmlEntities(modelName),
                    room: decodeXmlEntities(roomName),
                });
            } catch {
                // Could not fetch device description; add with minimal info
                speakers.push({ name: ip, ip, model: "Sonos", room: "Unknown" });
            }
        });

        socket.bind(() => {
            socket.addMembership(SSDP_ADDRESS);
            socket.send(searchBuf, 0, searchBuf.length, SSDP_PORT, SSDP_ADDRESS);
            // Send a second search after a short delay for reliability
            setTimeout(() => {
                try {
                    socket.send(searchBuf, 0, searchBuf.length, SSDP_PORT, SSDP_ADDRESS);
                } catch {
                    // socket may already be closed
                }
            }, 500);
        });
    });
}

// ── Speaker Resolution ────────────────────────

async function resolveSpeaker(
    speakerIdent?: string,
): Promise<SonosSpeaker> {
    const speakers = await discoverSpeakers();

    if (speakers.length === 0) {
        throw new Error(
            "No Sonos speakers found on the network. Make sure speakers are powered on and connected to the same network.",
        );
    }

    if (!speakerIdent) {
        return speakers[0];
    }

    // Check if it looks like an IP address
    if (/^\d+\.\d+\.\d+\.\d+$/.test(speakerIdent)) {
        const byIp = speakers.find((s) => s.ip === speakerIdent);
        if (byIp) return byIp;
        // Use the IP directly even if not in cache
        return { name: speakerIdent, ip: speakerIdent, model: "Sonos", room: "Unknown" };
    }

    // Match by name or room (case-insensitive)
    const lower = speakerIdent.toLowerCase();
    const match = speakers.find(
        (s) =>
            s.name.toLowerCase() === lower ||
            s.room.toLowerCase() === lower ||
            s.name.toLowerCase().includes(lower) ||
            s.room.toLowerCase().includes(lower),
    );

    if (!match) {
        const available = speakers.map((s) => `${s.name} (${s.room})`).join(", ");
        throw new Error(
            `Speaker "${speakerIdent}" not found. Available speakers: ${available}`,
        );
    }

    return match;
}

// ── Action Handlers ───────────────────────────

async function handleDiscover(): Promise<object> {
    // Force fresh discovery
    discoveryCache = null;
    const speakers = await discoverSpeakers();

    if (speakers.length === 0) {
        return {
            success: false,
            error: "No Sonos speakers found. Ensure they are powered on and on the same Wi-Fi network. SSDP multicast must not be blocked by your router.",
        };
    }

    return { success: true, speakers };
}

async function handleStatus(speaker: SonosSpeaker): Promise<object> {
    // Get transport state
    const transportXml = await soapAction(
        speaker.ip,
        PATH_AV_TRANSPORT,
        SERVICE_AV_TRANSPORT,
        "GetTransportInfo",
        { InstanceID: 0 },
    );

    const rawState = extractTag(transportXml, "CurrentTransportState");
    const stateMap: Record<string, string> = {
        PLAYING: "playing",
        PAUSED_PLAYBACK: "paused",
        STOPPED: "stopped",
        TRANSITIONING: "transitioning",
    };
    const state = stateMap[rawState] ?? rawState.toLowerCase();

    // Get current track metadata
    const positionXml = await soapAction(
        speaker.ip,
        PATH_AV_TRANSPORT,
        SERVICE_AV_TRANSPORT,
        "GetPositionInfo",
        { InstanceID: 0 },
    );

    const metaRaw = extractTag(positionXml, "TrackMetaData");
    const meta = decodeXmlEntities(metaRaw);
    const track = decodeXmlEntities(extractTag(meta, "dc:title")) || "Unknown";
    const artist = decodeXmlEntities(extractTag(meta, "dc:creator")) || "Unknown";
    const album = decodeXmlEntities(extractTag(meta, "upnp:album")) || "Unknown";

    // Get volume
    const volXml = await soapAction(
        speaker.ip,
        PATH_RENDERING,
        SERVICE_RENDERING,
        "GetVolume",
        { InstanceID: 0, Channel: "Master" },
    );
    const volume = parseInt(extractTag(volXml, "CurrentVolume"), 10) || 0;

    // Get mute state
    const muteXml = await soapAction(
        speaker.ip,
        PATH_RENDERING,
        SERVICE_RENDERING,
        "GetMute",
        { InstanceID: 0, Channel: "Master" },
    );
    const muted = extractTag(muteXml, "CurrentMute") === "1";

    return {
        success: true,
        speaker: speaker.name,
        room: speaker.room,
        state,
        track,
        artist,
        album,
        volume,
        muted,
    };
}

async function handleTransportAction(
    speaker: SonosSpeaker,
    action: "Play" | "Pause" | "Stop" | "Next" | "Previous",
): Promise<object> {
    await soapAction(
        speaker.ip,
        PATH_AV_TRANSPORT,
        SERVICE_AV_TRANSPORT,
        action,
        { InstanceID: 0, ...(action === "Play" ? { Speed: 1 } : {}) },
    );

    return { success: true, speaker: speaker.name, action: action.toLowerCase() };
}

async function handlePlay(
    speaker: SonosSpeaker,
    uri?: string,
): Promise<object> {
    if (uri) {
        // Set the transport URI first, then play
        const metadata = "";
        await soapAction(
            speaker.ip,
            PATH_AV_TRANSPORT,
            SERVICE_AV_TRANSPORT,
            "SetAVTransportURI",
            { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: metadata },
        );
    }

    await soapAction(
        speaker.ip,
        PATH_AV_TRANSPORT,
        SERVICE_AV_TRANSPORT,
        "Play",
        { InstanceID: 0, Speed: 1 },
    );

    return {
        success: true,
        speaker: speaker.name,
        action: "play",
        ...(uri ? { uri } : {}),
    };
}

async function handleVolume(
    speaker: SonosSpeaker,
    volume: number,
): Promise<object> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));

    await soapAction(
        speaker.ip,
        PATH_RENDERING,
        SERVICE_RENDERING,
        "SetVolume",
        { InstanceID: 0, Channel: "Master", DesiredVolume: clamped },
    );

    return { success: true, speaker: speaker.name, volume: clamped };
}

async function handleGroup(
    speaker: SonosSpeaker,
    groupAction: string,
    targetSpeaker?: string,
): Promise<object> {
    switch (groupAction) {
        case "party": {
            // Group all speakers with this one as coordinator
            const speakers = await discoverSpeakers();
            const coordinatorUuid = await getUuid(speaker.ip);
            for (const s of speakers) {
                if (s.ip !== speaker.ip) {
                    await soapAction(
                        s.ip,
                        PATH_AV_TRANSPORT,
                        SERVICE_AV_TRANSPORT,
                        "SetAVTransportURI",
                        {
                            InstanceID: 0,
                            CurrentURI: `x-rincon:${coordinatorUuid}`,
                            CurrentURIMetaData: "",
                        },
                    );
                }
            }
            return {
                success: true,
                speaker: speaker.name,
                action: "party",
                grouped: speakers.map((s) => s.name),
            };
        }

        case "solo": {
            await soapAction(
                speaker.ip,
                PATH_AV_TRANSPORT,
                SERVICE_AV_TRANSPORT,
                "BecomeCoordinatorOfStandaloneGroup",
                { InstanceID: 0 },
            );
            return { success: true, speaker: speaker.name, action: "solo" };
        }

        case "join": {
            if (!targetSpeaker) {
                return { error: "target_speaker is required for join action" };
            }
            const target = await resolveSpeaker(targetSpeaker);
            const targetUuid = await getUuid(target.ip);
            await soapAction(
                speaker.ip,
                PATH_AV_TRANSPORT,
                SERVICE_AV_TRANSPORT,
                "SetAVTransportURI",
                {
                    InstanceID: 0,
                    CurrentURI: `x-rincon:${targetUuid}`,
                    CurrentURIMetaData: "",
                },
            );
            return {
                success: true,
                speaker: speaker.name,
                action: "join",
                target: target.name,
            };
        }

        case "leave": {
            await soapAction(
                speaker.ip,
                PATH_AV_TRANSPORT,
                SERVICE_AV_TRANSPORT,
                "BecomeCoordinatorOfStandaloneGroup",
                { InstanceID: 0 },
            );
            return { success: true, speaker: speaker.name, action: "leave" };
        }

        default:
            return { error: `Unknown group action: ${groupAction}` };
    }
}

async function getUuid(ip: string): Promise<string> {
    const res = await fetch(`http://${ip}:${SONOS_PORT}/status/zp`, {
        signal: AbortSignal.timeout(5000),
    });
    const xml = await res.text();
    const uuid = extractTag(xml, "LocalUID") || extractTag(xml, "SerialNumber");
    if (!uuid) {
        throw new Error(`Could not determine UUID for speaker at ${ip}`);
    }
    return uuid;
}

async function handleFavorites(speaker: SonosSpeaker): Promise<object> {
    const xml = await soapAction(
        speaker.ip,
        PATH_CONTENT_DIR,
        SERVICE_CONTENT_DIR,
        "Browse",
        {
            ObjectID: "FV:2",
            BrowseFlag: "BrowseDirectChildren",
            Filter: "*",
            StartingIndex: 0,
            RequestedCount: 100,
            SortCriteria: "",
        },
    );

    const resultRaw = extractTag(xml, "Result");
    const result = decodeXmlEntities(resultRaw);

    const favorites: Array<{ title: string; uri: string }> = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(result)) !== null) {
        const itemXml = match[1];
        const title = decodeXmlEntities(extractTag(itemXml, "dc:title"));
        const uri =
            decodeXmlEntities(extractTag(itemXml, "res")) ||
            decodeXmlEntities(extractTag(itemXml, "orderedItem"));

        if (title) {
            favorites.push({ title, uri });
        }
    }

    return { success: true, speaker: speaker.name, favorites };
}

async function handleQueue(speaker: SonosSpeaker): Promise<object> {
    const xml = await soapAction(
        speaker.ip,
        PATH_CONTENT_DIR,
        SERVICE_CONTENT_DIR,
        "Browse",
        {
            ObjectID: "Q:0",
            BrowseFlag: "BrowseDirectChildren",
            Filter: "*",
            StartingIndex: 0,
            RequestedCount: 50,
            SortCriteria: "",
        },
    );

    const resultRaw = extractTag(xml, "Result");
    const result = decodeXmlEntities(resultRaw);

    const queue: Array<{ title: string; artist: string; album: string }> = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(result)) !== null) {
        const itemXml = match[1];
        queue.push({
            title: decodeXmlEntities(extractTag(itemXml, "dc:title")) || "Unknown",
            artist: decodeXmlEntities(extractTag(itemXml, "dc:creator")) || "Unknown",
            album: decodeXmlEntities(extractTag(itemXml, "upnp:album")) || "Unknown",
        });
    }

    const totalStr = extractTag(xml, "TotalMatches");
    const total = parseInt(totalStr, 10) || queue.length;

    return { success: true, speaker: speaker.name, total, queue };
}

// ── Tool Definition ───────────────────────────

export const sonosControl: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "sonos_control",
            description:
                "Control Sonos speakers on the local network. Discover speakers, play/pause/stop music, adjust volume, manage groups, browse favorites, and view the queue.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: [
                            "discover",
                            "status",
                            "play",
                            "pause",
                            "stop",
                            "next",
                            "previous",
                            "volume",
                            "group",
                            "favorites",
                            "queue",
                        ],
                        description: "The action to perform on the Sonos system.",
                    },
                    speaker: {
                        type: "string",
                        description:
                            "Speaker name or IP address. If omitted, uses the first discovered speaker.",
                    },
                    volume: {
                        type: "number",
                        description: "Volume level 0-100. Required for the volume action.",
                        minimum: 0,
                        maximum: 100,
                    },
                    group_action: {
                        type: "string",
                        enum: ["join", "leave", "party", "solo"],
                        description:
                            'Group operation type. "party" groups all speakers together, "solo" removes a speaker from its group, "join"/"leave" require target_speaker.',
                    },
                    target_speaker: {
                        type: "string",
                        description:
                            "Target speaker name or IP for group join/leave operations.",
                    },
                    uri: {
                        type: "string",
                        description:
                            "Media URI to play (Spotify URI, radio URL, etc.). Used with the play action.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        try {
            const action = input.action as string;
            const speakerIdent = input.speaker as string | undefined;
            const volumeLevel = input.volume as number | undefined;
            const groupAction = input.group_action as string | undefined;
            const targetSpeaker = input.target_speaker as string | undefined;
            const uri = input.uri as string | undefined;

            switch (action) {
                case "discover":
                    return JSON.stringify(await handleDiscover());

                case "status": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(await handleStatus(speaker));
                }

                case "play": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(await handlePlay(speaker, uri));
                }

                case "pause": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleTransportAction(speaker, "Pause"),
                    );
                }

                case "stop": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleTransportAction(speaker, "Stop"),
                    );
                }

                case "next": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleTransportAction(speaker, "Next"),
                    );
                }

                case "previous": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleTransportAction(speaker, "Previous"),
                    );
                }

                case "volume": {
                    if (volumeLevel === undefined || volumeLevel === null) {
                        return JSON.stringify({
                            error: "volume parameter is required for the volume action.",
                        });
                    }
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleVolume(speaker, volumeLevel),
                    );
                }

                case "group": {
                    if (!groupAction) {
                        return JSON.stringify({
                            error: 'group_action parameter is required. Use "join", "leave", "party", or "solo".',
                        });
                    }
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(
                        await handleGroup(speaker, groupAction, targetSpeaker),
                    );
                }

                case "favorites": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(await handleFavorites(speaker));
                }

                case "queue": {
                    const speaker = await resolveSpeaker(speakerIdent);
                    return JSON.stringify(await handleQueue(speaker));
                }

                default:
                    return JSON.stringify({
                        error: `Unknown action: ${action}. Valid actions: discover, status, play, pause, stop, next, previous, volume, group, favorites, queue.`,
                    });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return JSON.stringify({ error: message });
        }
    },
};
