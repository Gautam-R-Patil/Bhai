# Releasing the Bhai Desktop App

The desktop installer is **not** hosted on GitHub Releases any more.
GitHub's per-file upload ceiling (and the round-trip cost of re-uploading
the whole ASAR blob on every release) makes it a poor fit for a 400 MB+
installer. Binaries live in **Cloudflare R2** instead; the Convex HTTP
endpoint at `/api/updates` serves only the YAML metadata and points
`electron-updater` at the R2 URL.

## Architecture

```
 ┌────────────┐   checks every 4h   ┌────────────────────────────┐
 │ Desktop app│ ───────────────────▶│ Convex /api/updates/*.yml  │
 │ (electron- │                     │   reads UPDATE_* env vars  │
 │  updater)  │◀── latest*.yml ─────│   returns metadata only    │
 └─────┬──────┘                     └────────────────────────────┘
       │ downloads the mac ZIP / EXE + blockmap directly from R2
       ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Cloudflare R2 bucket (e.g. atlas-releases)                     │
 │   stable/0.2.1/Bhai-0.2.1-arm64.dmg      (download only)  │
 │   stable/0.2.1/Bhai-0.2.1-arm64-mac.zip  (mac update)     │
 │   stable/0.2.1/Bhai-0.2.1-arm64-mac.zip.blockmap          │
 │   stable/0.2.1/Bhai-0.2.1-mac.zip        (Intel mac update)│
 │   stable/0.2.1/Bhai Setup 0.2.1.exe                       │
 │   stable/0.2.1/Bhai Setup 0.2.1.exe.blockmap              │
 │   beta/…                                                       │
 └────────────────────────────────────────────────────────────────┘
```

The Convex YAML surface supports:

- **Channels** — `stable`, `alpha`, `beta`, `canary`. Clients append
  `?channel=alpha` to the feed URL; each channel reads suffixed env
  vars (e.g. `UPDATE_URL_MAC_ALPHA`). If a channel-specific var is
  unset, the handler falls back to the unsuffixed `stable` var.
- **Intel Macs** — `UPDATE_URL_MAC` is the Apple Silicon zip. The Intel
  zip (`Bhai-<v>-mac.zip`, built with `--x64`) goes in
  `UPDATE_URL_MAC_X64` / `UPDATE_SHA512_MAC_X64` / `UPDATE_SIZE_MAC_X64`
  and is listed as a second `files:` entry; electron-updater picks the
  one for its arch. `scripts/release.mjs` sets them when that zip is in
  `desktop/dist`, and removes `UPDATE_URL_MAC_X64` when it is not. Intel
  Macs ask with `?arch=x64` and get 404 (nothing to install) until an
  Intel zip is listed, so they never see an update they can't install.
- **Nothing published** — a feed with no `UPDATE_VERSION` / `UPDATE_URL_*`
  answers 404, which the app treats as "no release yet".
- **Failover URLs** — set `UPDATE_URL_MAC_MIRROR` to add a second
  `files:` entry; electron-updater tries them in order.
- **Delta updates** — uploading the `.blockmap` alongside the binary
  lets electron-updater diff the old install and download only the
  changed chunks. A 400 MB full update typically becomes 50–100 MB.
- **User-facing channel toggle** — Settings → Advanced has an update
  channel dropdown (`prefUpdateChannel` in `desktop/panel.html`) that calls
  `update:setChannel`. Testers pick "Alpha (early access)" to opt in.

## One-time setup

### 1. Create the R2 bucket

```
Cloudflare Dashboard → R2 → Create bucket → "atlas-releases"
```

Then either:

- Attach a custom domain (recommended). Bucket → Settings → Custom
  Domains → add `dl.bhai.<your-domain>`. DNS propagates in minutes.
- Or enable the `r2.dev` subdomain for testing (lower throughput; public
  URL looks like `https://pub-<hash>.r2.dev`).

### 2. Add CORS / public access rules

R2 objects are private by default. The cleanest path is:

1. Bucket → Settings → Public access → enable on your custom domain.
2. Bucket → Settings → CORS → add a rule allowing `GET` from
   `https://bhai.xagilabs.com` (or `*` if you don't mind).

Blockmap requests do `Range` reads, so make sure your CORS response
includes `Access-Control-Expose-Headers: Content-Range, Content-Length`.

### 3. Create R2 S3-compatible credentials

The Bhai installer is larger than wrangler's 300 MiB per-file upload
limit, so `scripts/release.mjs` uses the S3-compatible API with proper
multipart upload instead. You need R2-scoped S3 keys, NOT a regular
Cloudflare API token:

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens** → Create API
   token.
2. Permission: **Object Read & Write** on the bucket(s) you use.
3. Copy the **Access Key ID** and **Secret Access Key** — Cloudflare
   shows the secret once and only once.

### 4. Populate `.env`

```
R2_BUCKET=atlas-releases
R2_PUBLIC_BASE=https://pub-<hash>.r2.dev       # or custom domain
CLOUDFLARE_ACCOUNT_ID=<32-hex-chars>           # dashboard home, right sidebar
R2_ACCESS_KEY_ID=<from step 3>
R2_SECRET_ACCESS_KEY=<from step 3>
```

## Signing and notarization (read before shipping)

What the config actually does today (`desktop/package.json` → `build.mac`):

- `identity: "-"` (ad-hoc), `hardenedRuntime: true`, `notarize: false`. The
  release DMG is therefore **not Developer-ID signed or notarized**; Gatekeeper
  needs right-click → Open on first launch.
- `build:mac` (local dev DMG) additionally runs `build/resign-local.sh`, which
  re-signs with a stable self-made "Bhai Local Signing" identity if present
  (`scripts/make-signing-cert.sh`) so macOS keeps Screen Recording /
  Accessibility grants across updates. Every mac build now runs it from the
  `afterSign` hook (`build/after-sign.js`), but only while `mac.identity` is
  `"-"`: a Developer ID build keeps its signature and notarization.
- `desktop/build/check-signing.js` documents the env vars for real signing
  (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`; `SKIP_SIGNING_CHECK=true` to skip). Windows uses
  `signtoolOptions` (sha256) and needs `CSC_LINK`/`CSC_KEY_PASSWORD` to be signed.
- Build hooks: `afterPack` runs `build/protect-source.js`; `build:*:protected`
  variants run `npm run prebuild` first.

## Cutting a release

CI (`.github/workflows/`: `ci.yml`, `codeql.yml`, `dependency-review.yml`,
`workflow-lint.yml`) only lints/tests/builds native; it does **not** build or
publish installers. Releases are cut by hand from a Mac (and a Windows host).
Before releasing, run `npm run lint && npm run typecheck && npm run test:hermetic`,
and `npx convex deploy` if `convex/` changed (the update feed is served by
`convex/http.ts` at `/api/updates`, and the app's `publish.url` points at the
Convex site `https://avid-finch-726.convex.site/api/updates`).

```
# Stable release
npm run release -- --version 0.2.1 --apply-convex

# Beta channel
npm run release -- --version 0.3.0-beta.1 --channel beta --apply-convex
```

The script (uses the AWS S3 SDK multipart upload, not wrangler):

1. Bumps `desktop/package.json` version (the root `package.json` version,
   currently 0.2.1, is not touched).
2. Builds the installer via `npm run build:mac:release` (which first runs
   `npm run build:helpers` — the Swift OCR/location/AX helpers must exist —
   then `npm run build`, then `electron-builder --mac dmg zip`), then converts
   the DMG to ULMO (LZMA, ~26% smaller; electron-builder only offers UDZO/ULFO)
   and re-signs it as it was. electron-updater's MacUpdater installs only from
   the ZIP (`ERR_UPDATER_ZIP_FILE_NOT_FOUND` otherwise), so the ZIP and its
   blockmap are the Mac update and `UPDATE_*_MAC` describe the ZIP; the DMG is
   the first-install download. `build:mac`'s custom `create-dmg.sh` makes no
   ZIP and must not be used for releases. On a Windows host it runs
   `npm run build:win` (NSIS, x64).
3. Locates the DMG / ZIP / EXE / blockmaps / `latest*.yml` in `desktop/dist/`.
4. Uploads each file to `r2://<bucket>/<channel>/<version>/<filename>`.
5. Computes SHA-512 (base64) and byte size for each binary.
6. Either prints or runs the `npx convex env set UPDATE_…` commands.

### Common flags

| Flag | Purpose |
|------|---------|
| `--version X.Y.Z` | **Required.** Version to publish. |
| `--channel beta\|canary\|stable` | Target channel (default `stable`). |
| `--skip-build` | Reuse artifacts already in `desktop/dist/`. |
| `--skip-mac` / `--skip-win` | Skip one platform. |
| `--apply-convex` | Run the `convex env set` commands automatically. Omit to print them. |

### Windows artifacts

Windows builds must run on a Windows host (or a Windows VM). Typical
flow: build the mac DMG locally, then RDP/SSH into a Windows machine
and run `npm run release -- --version <v> --skip-mac --apply-convex`
with `R2_PUBLIC_BASE` pointing at the same bucket. Both runs update
the same Convex env vars — they don't conflict because the mac run
only writes `UPDATE_*_MAC` and the win run only writes `UPDATE_*_WIN`.

### Rolling back

Convex env vars are the only source of truth for "which version is
live." To roll back, re-run the commands for the previous version's
artifacts (they're still in R2 unless you deleted them).

### Moving a release between channels

If you published to the wrong channel (e.g. pushed an unstable build
to `stable`), use the migrate helper. It S3-copies the objects under
the new channel prefix and deletes the old copies — no re-upload of
the 400 MB binary.

```
node scripts/migrate-channel.mjs --from stable --to alpha --version 0.2.1
```

Then unset the stable Convex vars and set the alpha ones:

```
npx convex env remove UPDATE_VERSION
npx convex env remove UPDATE_URL_MAC
npx convex env remove UPDATE_SHA512_MAC
npx convex env remove UPDATE_SIZE_MAC
npx convex env remove UPDATE_RELEASE_DATE
npx convex env set UPDATE_VERSION_ALPHA    0.2.1
npx convex env set UPDATE_URL_MAC_ALPHA    https://.../alpha/0.2.1/<file>-mac.zip
npx convex env set UPDATE_SHA512_MAC_ALPHA <base64-sha512>
npx convex env set UPDATE_SIZE_MAC_ALPHA   <bytes>
npx convex env set UPDATE_RELEASE_DATE_ALPHA <iso-date>
```

## Client behavior

`desktop/main.js::checkForUpdates` is called:

- 5 seconds after launch.
- Every 4 hours thereafter.
- On demand via the `update:check` IPC (tray menu and Settings).

On failure it retries with exponential backoff (30 s → 2 min → 10 min)
before falling back to the next 4 h tick. 404 responses are treated as
"no release yet" rather than a retryable error.

Users can opt in to a non-stable channel (`beta`, `alpha`, `canary`) from
Settings → Advanced, which calls `update:setChannel` (`bhai.setUpdateChannel` in the
renderer), saves the choice to `electron-store`, and re-checks the feed immediately.

## Why not…

- **…GitHub Releases?** 2 GB per-file hard limit, frequent timeouts on
  web UI uploads, and you're still paying for egress on every
  download. Fine for text releases, wrong shape for multi-hundred-MB
  installers.
- **…Hostinger Object Storage?** Works, but paid egress. R2 is free
  egress which matters once you have a user base.
- **…S3 direct?** R2 with a custom domain fronted by Cloudflare's
  CDN ends up equivalent in practice, and Cloudflare's free tier
  covers a lot more traffic than S3 Transfer Acceleration's free tier.
