# Refactor Plan — Replace `googleapis` with per-service `@googleapis/*`

Companion to `desktop/BUNDLE_SIZE.md`. This doc captures the
concrete work required to realize the ~190 MB bundle-size
reduction that was deferred during the audit session.

## Why

`googleapis` (v171.4.0) ships TypeScript types and client code for
**every** Google API (Drive, Sheets, Docs, Forms, Analytics, Admin,
Books, dozens more). Unpacked size: **194 MB**. Bhai only uses 4
of them.

## What we actually use — measured

Two files import from `googleapis`:

| File | Imports | Factories used | Methods called |
|---|---|---|---|
| `src/tools/google-api.ts` | `google, type calendar_v3` | `google.gmail({v1})`, `google.calendar({v3})`, `google.oauth2({v2})` | `gmail.users.messages.list / .get / .send`, `calendar.events.list / .insert`, `oauth2.userinfo.get` |
| `src/marketing/adapters/youtube.ts` | `google` | `google.youtube({v3})` | `youtube.videos.insert` |

Plus 1 type import: `type calendar_v3` (for `Schema$Event` etc.).

## Per-service package sizes (from `npm view`)

| Package | Version | Unpacked |
|---|---|---|
| `@googleapis/gmail` | 16.1.1 | 1.15 MB |
| `@googleapis/calendar` | 14.2.0 | 0.81 MB |
| `@googleapis/youtube` | 31.0.0 | 1.76 MB |
| `@googleapis/oauth2` | 5.0.1 | 0.11 MB |
| **Total** | — | **≈ 3.83 MB** |

Vs. the monolithic `googleapis` at **194 MB**.

**Expected savings: ~190 MB per Electron bundle.** This exceeds
the combined −250 MB savings already shipped in b4 (platform
binary filter) and 9567c86 (dev-dep filter) combined.

## Step-by-step migration

### 1. Install the four per-service packages

```sh
npm install @googleapis/gmail @googleapis/calendar @googleapis/oauth2 @googleapis/youtube
npm uninstall googleapis
```

### 2. Refactor `src/tools/google-api.ts`

The `@googleapis/<service>` packages each export a default factory
named after the service, plus the same type namespaces. So:

```ts
// BEFORE
import { google, type calendar_v3 } from "googleapis";

const gmail = google.gmail({ version: "v1", auth: client });
const calendar = google.calendar({ version: "v3", auth: client });
const oauth2 = google.oauth2({ version: "v2", auth: client });
```

becomes:

```ts
// AFTER
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { oauth2 } from "@googleapis/oauth2";

const gmailClient = gmail({ version: "v1", auth: client });
const calendarClient = calendar({ version: "v3", auth: client });
const oauth2Client = oauth2({ version: "v2", auth: client });
```

Method call sites (`gmail.users.messages.list(...)` etc.) are
identical — the service client object has the same shape.

### 3. Refactor `src/marketing/adapters/youtube.ts`

```ts
// BEFORE
import { google } from "googleapis";
const youtube = google.youtube({ version: "v3", auth: oauth2 });

// AFTER
import { youtube } from "@googleapis/youtube";
const yt = youtube({ version: "v3", auth: oauth2 });
```

### 4. Check for transitive assumptions

`googleapis` re-exported `OAuth2Client` and some auth types. If
either file currently uses `google.auth.*` helpers, they need to
move to `import { OAuth2Client } from "google-auth-library"`
(already in node_modules as a peer dep of `@googleapis/*`).

### 5. Verification

1. `npm run typecheck` — must pass
2. Smoke-test each Google integration against a real dev account:
   - Gmail: send a test email, list unread, fetch one message
   - Calendar: list events, create an event, delete it
   - YouTube: upload a small test video to an unlisted dev channel
   - OAuth: run the signin flow and confirm `userinfo.get` works
3. Measure dist size:
   - `rm -rf dist && npm run build`
   - `du -sh node_modules/@googleapis/ node_modules/googleapis 2>/dev/null`
   - Confirm `googleapis` is absent and the 4 per-service
     packages total ~4 MB
4. Run the full suite: `npm test` + `cargo test`

### 6. Clean up

`src/config/keys.ts` and any `.env.example` references to
`googleapis` should be inspected for stale documentation. The
`GOOGLE_APPLICATION_CREDENTIALS` env-var path is still valid
because the auth library is unchanged.

## Risk assessment

**Low.** The per-service packages are maintained by the same
Google Node.js team as `googleapis` — they're literally a re-
packaged subset of the monolith. API shapes are documented as
identical.

**Caveat:** This refactor was NOT executed in the audit session
because:
1. No ability to test against a real Google account from the
   sandbox.
2. The 190 MB savings only materialize on a fresh Electron build,
   which requires electron-builder signing certs for a realistic
   end-to-end test.

Both are prerequisites the user needs to supply, not blockers for
the code change itself. A senior engineer with API access can
complete the migration and verification in ~30 min.

## Open question

After the swap, consider adding a lint rule (custom Biome or
ESLint plugin) that forbids `import { * } from "googleapis"`
going forward so the monolith doesn't creep back in via a future
copy-paste.
