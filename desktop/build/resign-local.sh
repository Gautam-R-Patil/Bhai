#!/bin/bash
# © 2024-2026 XAGI Labs Private Limited. All rights reserved.
#
# Re-signs the built app with a stable local identity ("Bhai Local Signing",
# made by scripts/make-signing-cert.sh) when it exists. Ad-hoc signatures change
# with every build, so macOS treated each update as a new app and asked for
# Screen Recording / Accessibility again; a stable certificate keeps them.
# No identity → leaves the ad-hoc signature as it is.
set -euo pipefail
IDENTITY="${BHAI_SIGN_IDENTITY:-Bhai Local Signing}"
APP="${1:-dist/mac-arm64/Bhai.app}"
if ! security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "resign-local: no \"$IDENTITY\" identity — keeping the ad-hoc signature"; exit 0
fi
codesign --force --deep --options runtime --entitlements build/entitlements.mac.plist -s "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"
echo "resign-local: signed with \"$IDENTITY\""
