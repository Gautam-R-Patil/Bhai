#!/bin/bash
# Creates a styled macOS DMG with background image and drag-to-Applications layout
set -e

APP_NAME="A.T.L.A.S"
APP_PATH="dist/mac-arm64/${APP_NAME}.app"
# Derive the version from package.json so bumping the `version` field is
# the single place that moves. Fallback if jq-free / malformed.
APP_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
DMG_NAME="${APP_NAME}-${APP_VERSION}-arm64.dmg"
DMG_PATH="dist/${DMG_NAME}"
VOL_NAME="A.T.L.A.S Installer"
TEMP_DMG="dist/.temp-dmg.dmg"
BG_IMG="build/dmg-background@2x.png"

echo "📦 Creating DMG: ${DMG_NAME}"

[ ! -d "${APP_PATH}" ] && echo "❌ App not found: ${APP_PATH}" && exit 1

# Eject ALL existing atlas volumes
for vol in /Volumes/A.T.L.A.S*; do
    [ -d "$vol" ] && hdiutil detach "$vol" -force 2>/dev/null || true
done

rm -f "${DMG_PATH}" "${TEMP_DMG}"

APP_SIZE=$(du -sm "${APP_PATH}" | cut -f1)
# 20% padding for HFS+ overhead, minimum 300MB buffer
PADDING=$((APP_SIZE / 5))
[ "$PADDING" -lt 300 ] && PADDING=300
DMG_SIZE=$((APP_SIZE + PADDING))
echo "   App: ${APP_SIZE}MB, DMG: ${DMG_SIZE}MB"

hdiutil create -size "${DMG_SIZE}m" -fs HFS+ -volname "${VOL_NAME}" "${TEMP_DMG}" -ov -quiet

# Mount and get both device and volume path
MOUNT_OUTPUT=$(hdiutil attach "${TEMP_DMG}" -readwrite -noverify)
DEVICE=$(echo "$MOUNT_OUTPUT" | grep "Apple_HFS" | awk '{print $1}')
echo "   Mounted: /Volumes/${VOL_NAME} (${DEVICE})"

# Copy contents
echo "   Copying app..."
cp -R "${APP_PATH}" "/Volumes/${VOL_NAME}/"
ln -s /Applications "/Volumes/${VOL_NAME}/Applications"

# Background
mkdir "/Volumes/${VOL_NAME}/.background"
[ -f "${BG_IMG}" ] && cp "${BG_IMG}" "/Volumes/${VOL_NAME}/.background/bg.png"

# Style with Finder (20s timeout)
echo "   Styling window..."
(
osascript <<'EOF'
tell application "Finder"
    tell disk "A.T.L.A.S Installer"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {400, 200, 940, 580}
        set theViewOptions to the icon view options of container window
        set arrangement of theViewOptions to not arranged
        set icon size of theViewOptions to 80
        try
            set background picture of theViewOptions to file ".background:bg.png"
        end try
        set position of item "A.T.L.A.S.app" of container window to {130, 150}
        set position of item "Applications" of container window to {410, 150}
        close
        open
        update without registering applications
        delay 2
        close
    end tell
end tell
EOF
) &
PID=$!
for i in $(seq 1 20); do
    kill -0 $PID 2>/dev/null || break
    sleep 1
done
kill -0 $PID 2>/dev/null && { echo "   ⚠️  Finder timed out"; kill $PID 2>/dev/null; wait $PID 2>/dev/null || true; } || echo "   ✅ Window styled"

# CRITICAL: Tell Finder to eject, then force detach
echo "   Ejecting..."
osascript -e 'tell application "Finder" to eject disk "A.T.L.A.S Installer"' 2>/dev/null || true
sleep 2

# Force detach by volume path AND device path (belt + suspenders)
hdiutil detach "/Volumes/${VOL_NAME}" -force 2>/dev/null || true
hdiutil detach "${DEVICE}" -force 2>/dev/null || true

# Verify it's actually unmounted
if [ -d "/Volumes/${VOL_NAME}" ]; then
    echo "   ⚠️  Volume still mounted, waiting 5s..."
    sleep 5
    hdiutil detach "/Volumes/${VOL_NAME}" -force 2>/dev/null || true
    hdiutil detach "${DEVICE}" -force 2>/dev/null || true
fi

# Compress
echo "   Compressing..."
hdiutil convert "${TEMP_DMG}" -format UDZO -imagekey zlib-level=9 -o "${DMG_PATH}" -quiet

rm -f "${TEMP_DMG}"
SIZE=$(du -h "${DMG_PATH}" | cut -f1)
echo "✅ DMG created: ${DMG_PATH} (${SIZE})"
