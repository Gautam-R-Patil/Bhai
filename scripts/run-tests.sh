#!/usr/bin/env bash
# Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
#
# Hermetic test runner — closes the dev-machine vs CI drift surface.
#
# Five drift sources this closes:
#   1. Credentials: any *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD in the
#      developer's shell would authenticate to real services and bypass
#      unit-level mocks. Unset them all before vitest starts.
#   2. Bhai runtime env vars: anything starting with BHAI_* (or the old
#      ATLAS_* spelling, which the bot still honours) could change
#      behavior in ways CI never sees. Unset too.
#   3. Timezone: pin TZ=UTC so date-formatting tests match CI.
#   4. Locale: pin LANG=C.UTF-8 + LC_ALL=C.UTF-8 so sort order / number
#      formatting / unicode handling match CI.
#   5. Worker count: CI runs 2-core GitHub Actions runners; a dev's 10-core
#      M-series machine exposes test-ordering flakes that CI never catches.
#      Pin maxThreads=4 (overridable via BHAI_TEST_WORKERS, or the old
#      ATLAS_TEST_WORKERS).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Read before Step 2 unsets it.
WORKERS="${BHAI_TEST_WORKERS:-${ATLAS_TEST_WORKERS:-4}}"

# ── Step 1: unset credentials ─────────────────
# Iterate `env` output, unset anything whose name matches the patterns.
while IFS='=' read -r name _value; do
    case "$name" in
        *_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_CREDENTIALS|*_ACCESS_KEY|AWS_ACCESS_KEY_ID|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN|DISCORD_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|HF_TOKEN|CONVEX_DEPLOY_KEY|ELEVENLABS_API_KEY|FIRECRAWL_API_KEY|TAVILY_API_KEY)
            unset "$name" 2>/dev/null || true
            ;;
    esac
done < <(env)

# ── Step 2: unset BHAI_* / ATLAS_* behavioral flags ────
while IFS='=' read -r name _value; do
    case "$name" in
        BHAI_*|ATLAS_*)
            unset "$name" 2>/dev/null || true
            ;;
    esac
done < <(env)

# ── Step 3: pin deterministic runtime ─────────
export TZ=UTC
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
# Vitest respects NODE_ENV=test; make sure it's set.
export NODE_ENV=test

# ── Step 5: run vitest ────────────────────────
# Forward any extra args ("npm run test:hermetic -- src/utils/" etc.).
# Use `forks` pool (vitest's default) — `threads` rejects process.chdir()
# which some Bhai tests use for cwd-relative path resolution.
exec npx vitest run \
    --pool=forks \
    --maxWorkers="$WORKERS" \
    "$@"
