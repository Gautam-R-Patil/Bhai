# Spotify Latency Fix — Design

## Context

A simple "play closer" request currently takes ~40s end-to-end through the agent. The delay has two distinct causes:

1. **Spotify side (~20s).** spogo's `search track` hits Spotify's internal web-player endpoints which take ~15s per call, then spogo's `play` waits for a device, then Spotify desktop cold-starts if needed.
2. **Agent side (~18s).** Before the tool fires: Haiku classifier (~3s) + full memory retrieval with 10-source aggregation + a secondary Haiku call for memory briefing (~5s) + Sonnet orchestrator plan (~2s) + first Haiku tool-call turn (~3s). After the tool: another Haiku turn for the final reply (~3s).

Users ask "play X" hundreds of times a session. Current latency is unshippable. This spec replaces the slow spogo search path with Spotify's public search API via the Client Credentials flow, and adds a narrow music fast-path that skips the orchestrator and heavy memory briefing for high-confidence simple-intent commands while preserving memory-aware lookups (e.g. "play my favorite song").

## Goals

- **Latency target:** <15s cold, <8s warm, for simple "play X" requests on a running Spotify app.
- **Correctness:** Fast-path must fire only when the classifier is 100% confident the intent is music playback. Any ambiguity → full current path.
- **Memory-aware:** Possessive references like "my favorite song" still resolve correctly, via a cheap targeted memory peek (not the full 10-source briefing).
- **Zero user setup:** No new OAuth consent, no new per-user credentials. Still works for unlimited public users (Client Credentials has no 5-user Dev Mode cap, unlike user-OAuth).
- **Fail-open:** Every new path has a fallback to the current behavior. If the Client Credentials token endpoint is down, searches fall through to spogo. If the fast-path gate fails, the full orchestrator path runs.

## Non-goals

- Replacing spogo for playback. Playback needs user scope (Premium account state, device list, cookies), which Client Credentials can't provide. spogo stays.
- Changing the tool's public action surface or schema.
- Speeding up non-music intents. The fast-path is gated narrowly; everything else runs the existing path.
- Shipping a music-specific persistence layer. The memory peek reuses the existing `memory_search`; it doesn't introduce new stores.

## Architecture

### Unit 1: `src/tools/spotify-search.ts` — fast search via Client Credentials

One module, one public function, one internal token cache.

```
fastSearchTrack(query: string, limit?: number) → Promise<{uri, name, artists} | null>
```

- **Behavior:**
  - Fetch (or reuse cached) app-only access token via `getAppToken()` below.
  - Call `GET https://api.spotify.com/v1/search?q=<query>&type=track&limit=10` with `Authorization: Bearer <token>`.
  - Return `items[0]` normalized as `{uri, name, artists}` or `null` on no match.
  - Returns `null` (not throws) on any error — caller falls back to spogo.

- **Token manager (`getAppToken()`):**
  - In-memory cache of `{access_token, expires_at}`. TTL = token's expiry minus 60s safety margin.
  - Cache miss → call Convex endpoint `POST /api/spotify/app-token` over the existing `encryptedFetch` (session-authenticated, E2E-encrypted).
  - Convex endpoint receives no body; server mints a Client Credentials token using env `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`; returns `{access_token, expires_in}`.
  - Secret never reaches the client.

- **Shape of data returned from Spotify:** standard Spotify Web API search response. We only read `tracks.items[0].{uri, name, artists[].name}`.

- **Failure handling:**
  - Convex endpoint 5xx / timeout → `getAppToken` returns `null` → `fastSearchTrack` returns `null`.
  - Spotify `/v1/search` 401 (token expired) → evict cache, retry once, then `null` on repeat failure.
  - Spotify `/v1/search` 429 → respect `Retry-After` header, return `null` for this call (caller falls back to spogo). We don't block the user waiting for rate-limit recovery.
  - Network error → `null`.

### Unit 2: `src/tools/spotify.ts` — wire the fast path into `searchTop`

```
searchTop(type, query):
  1. Check in-memory URI cache (already exists). Hit → return.
  2. If type === "track": try fastSearchTrack(query). Hit → cache + return.
  3. Fall through to current spogo search path. Cache + return.
```

- For non-track types (album, artist, playlist) we keep spogo since Spotify Web API would need more complex shaping. YAGNI.
- The 15-min URI cache we already shipped keeps working — fast-path populates the same cache.

### Unit 3: `convex/http.ts` — Convex endpoint `POST /api/spotify/app-token`

- Auth: existing session token (Bearer) validated by `validateRequest`.
- Body: none required. Optionally `{}`.
- Response: `{access_token: string, expires_in: number}`.
- Implementation: server `fetch('https://accounts.spotify.com/api/token', ...)` with `grant_type=client_credentials` and Basic auth using env vars. Uses existing `buildResponse` + encryption path.
- Returns 500 clearly if env vars missing, so client sees a clean error and falls back to spogo.

### Unit 4: `src/agent.ts` — music fast-path

Two new helpers, one early-return branch in `runAgent`.

**Gate (`isMusicFastPathEligible`):** returns true iff ALL of:
- Classifier returned with `confidence >= 0.9`.
- Classifier `intent` matches `/^(play_music|play_song|pause|resume|next|previous|skip|volume|shuffle|repeat|now_playing)/`.
- Classifier `specific_tools` is exactly `["spotify"]` or exactly `["music_control"]`.
- The raw user message (trimmed) is ≤ 80 chars.
- This is the first iteration of `runAgent` for the current user turn (so we can't already be mid-tool-loop).
- Not in plan mode.

**Memory peek (`musicMemoryPeek`):** runs only when the gate passes AND the user message contains `/\b(my|our|the one|that|favorite|fav|usual|go-to|mine)\b/i`.
- Runs a single `memory_search` with the user message + "music" tag. Limit 3.
- If hits contain a Spotify URI string (`/spotify:(track|album|playlist|artist):[A-Za-z0-9]+/`), include a `[Music Memory Hint] URI: <uri>` note in a system message the LLM sees. If multiple hits, include all.
- If no URI but memory has relevant text, include short text snippet (≤200 chars).
- Total time budget: 500ms. If it exceeds, skip the peek, let the agent call memory_search itself if needed.

**Fast-path branch:**
```
if (gate passes) {
  optional await musicMemoryPeek() → inject tiny hint (≤300 chars)
  skip orchestrator planning entirely
  skip the USE_MEMORY_BRIEFING block
  proceed with normal tool-call LLM turn (Haiku already has `spotify` in its tool list)
  after first tool returns success: skip the orchestrator's auto-verification loop and go straight to final reply
}
```

**After-tool optimization:** when fast-path is active AND tool result has `{success: true, mode: "spogo" | "os_launch_uri"}`, inject a system message: `[FAST_PATH_DONE] Reply to the user briefly confirming the song is playing. Do not call now_playing unless the tool reported failure.` This lets the LLM produce a one-shot final reply without the verification iteration.

## Data flow — "play closer"

```
User message → Haiku classifier (intent="play_music", conf=0.95, tools=[spotify])
           → isMusicFastPathEligible? YES
           → no possessive → skip musicMemoryPeek
           → Haiku tool-call turn (spotify action=play query="closer")
             └─ searchTop("track","closer")
                  1. cache miss
                  2. fastSearchTrack("closer") → Spotify Web API → "Closer" (200ms)
                  3. cached + returned
             └─ spogo play spotify:track:<id> → success
           → FAST_PATH_DONE system msg
           → Haiku final reply ("Playing Closer by The Chainsmokers 🎶")
```

## Data flow — "play my favorite song"

```
User message → Haiku classifier (intent="play_music", conf=0.95, tools=[spotify])
           → isMusicFastPathEligible? YES
           → possessive detected → musicMemoryPeek
             └─ memory_search("my favorite song music") → hit: "User's fav song is spotify:track:ABC123"
             → inject [Music Memory Hint] URI: spotify:track:ABC123
           → Haiku tool-call turn (spotify action=play uri=spotify:track:ABC123)
             └─ searchTop not called (uri provided directly)
             └─ spogo play → success
           → FAST_PATH_DONE → final reply
```

## Error handling

| Failure | Behavior |
|---|---|
| Convex app-token endpoint 5xx | `getAppToken` returns null → `fastSearchTrack` returns null → spogo search runs |
| SPOTIFY_CLIENT_ID missing on server | Endpoint returns 500 with clear message → client logs once, falls back to spogo |
| Spotify `/v1/search` 429 | Single call returns null, spogo fallback. No retry storm. |
| Spotify `/v1/search` 401 | Evict cached token, one retry. Still fails → null, spogo fallback. |
| Fast-path gate misfires (intent mis-classified) | Falls to full orchestrator path unchanged. |
| Memory peek times out (>500ms) | Skip the hint, proceed with normal tool call. LLM can still call `memory_search` itself if needed. |
| Fast-path tool call fails | Clear FAST_PATH_DONE hint; let agent enter normal retry/verification flow on next iteration. |

## Testing plan

1. **Unit-ish checks on `spotify-search.ts`:** call `fastSearchTrack` with the five queries that previously misranked under spogo — "Closer", "Bohemian Rhapsody", "Stairway to Heaven", "Hotel California", "Shape of You" — and assert `items[0].name` equals the expected title (no "Girls Like You" for "Closer", etc.).
2. **Latency measurement (tool-handler only, not full agent loop):** time `spotifyTool.handler({action:"play", query:"closer"})` for cold, warm (cached URI), and memory-peek cases. Expected tool-handler times: <1s cached, <5s fresh. Full-agent-loop goal remains <15s cold, <8s warm (includes classifier + final-reply LLM turns).
3. **Fast-path gate:** craft 10 test classifier outputs (half music, half not; varying confidence; varying specific_tools) and assert `isMusicFastPathEligible` returns correctly.
4. **End-to-end:** run the live agent against "play closer", "pause", "play my favorite song" (after priming a fav in memory), "play something relaxing and then remind me to drink water" (should NOT fast-path). Assert correct behavior + timing.
5. **Fallback:** with `SPOTIFY_CLIENT_ID` temporarily unset on Convex, "play closer" should still work (slower, via spogo).
6. **Regression:** non-music queries ("what's the weather", "search my github") take the full path, unchanged.

## Critical files

- New: `src/tools/spotify-search.ts`
- Modify: `src/tools/spotify.ts` (only `searchTop` implementation)
- Modify: `convex/http.ts` (add one route near the existing secrets/admin routes)
- Modify: `src/agent.ts` (add `isMusicFastPathEligible`, `musicMemoryPeek`, early-return branch in `runAgent`)
- Reuse: `src/crypto-transport.ts` `encryptedFetch`, `src/session.ts` `getSessionToken`, `src/config/keys.ts` `getConvexSiteUrl`
- Convex env: re-add `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`

## Verification

- `npm run typecheck` + `npm run build` clean.
- Live: cold "play closer" ≤ 15s, warm ≤ 8s, "play my favorite song" picks the remembered URI.
- Classifier gate: manually log `fast_path=true/false` for 20 diverse queries; ensure 0 false-positives (non-music queries entering fast-path).
- Fallback: kill the Convex app-token endpoint; "play closer" still succeeds via spogo (just slower).
