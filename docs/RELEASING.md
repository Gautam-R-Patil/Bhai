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
       │ downloads DMG/EXE + blockmap directly from R2
       ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Cloudflare R2 bucket (e.g. atlas-releases)                     │
 │   stable/0.2.1/Bhai-0.2.1-arm64.dmg                       │
 │   stable/0.2.1/Bhai-0.2.1-arm64.dmg.blockmap              │
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
- **Failover URLs** — set `UPDATE_URL_MAC_MIRROR` to add a second
  `files:` entry; electron-updater tries them in order.
- **Delta updates** — uploading the `.blockmap` alongside the binary
  lets electron-updater diff the old install and download only the
  changed chunks. A 400 MB full update typically becomes 50–100 MB.
- **User-facing channel toggle** — the panel → Preferences → Updates
  section has a dropdown that calls `update:setChannel`. Testers
  pick "Alpha (early access)" to opt in.

## One-time setup

### 1. Create the R2 bucket

```
Cloudflare Dashboard → R2 → Create bucket → "atlas-releases"
```

Then either:

- Attach a custom domain (recommended). Bucket → Settings → Custom
  Domains → add `dl.atlas.<your-domain>`. DNS propagates in minutes.
- Or enable the `r2.dev` subdomain for testing (lower throughput; public
  URL looks like `https://pub-<hash>.r2.dev`).

### 2. Add CORS / public access rules

R2 objects are private by default. The cleanest path is:

1. Bucket → Settings → Public access → enable on your custom domain.
2. Bucket → Settings → CORS → add a rule allowing `GET` from
   `https://atlas.xagilabs.com` (or `*` if you don't mind).

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

## Cutting a release

```
# Stable release
npm run release -- --version 0.2.1 --apply-convex

# Beta channel
npm run release -- --version 0.3.0-beta.1 --channel beta --apply-convex
```

The script:

1. Bumps `desktop/package.json` version.
2. Builds the installer via `npm run build:mac:release` (which uses
   `electron-builder --mac dmg` so a blockmap is emitted — the custom
   `create-dmg.sh` does NOT produce blockmaps and must not be used for
   releases).
3. Locates the DMG / EXE / blockmap / `latest*.yml` in `desktop/dist/`.
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
npx convex env set UPDATE_URL_MAC_ALPHA    https://.../alpha/0.2.1/<file>.dmg
npx convex env set UPDATE_SHA512_MAC_ALPHA <base64-sha512>
npx convex env set UPDATE_SIZE_MAC_ALPHA   <bytes>
npx convex env set UPDATE_RELEASE_DATE_ALPHA <iso-date>
```

## Client behavior

`desktop/main.js::checkForUpdates` is called:

- 5 seconds after launch.
- Every 4 hours thereafter.
- On demand via the `update:check` IPC (wired into the tray menu and
  panel UI).

On failure it retries with exponential backoff (30 s → 2 min → 10 min)
before falling back to the next 4 h tick. 404 responses are treated as
"no release yet" rather than a retryable error.

Users can opt in to the `beta` channel via:

```
window.api.invoke("update:setChannel", "beta")
```

which writes to `electron-store` and re-checks the feed immediately.

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
