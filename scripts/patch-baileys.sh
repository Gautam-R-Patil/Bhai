#!/bin/bash
# Patches Baileys 7.0.0-rc.9 to fix 405 connection failure
# See: https://github.com/WhiskeySockets/Baileys/issues/2376
# Bugs fixed: outdated version, passive:true, lidDbMigrated:false, noise await race

BAILEYS="node_modules/@whiskeysockets/baileys/lib"

if [ ! -d "$BAILEYS" ]; then
    echo "[patch-baileys] Baileys not installed, skipping"
    exit 0
fi

echo "[patch-baileys] Patching Baileys v7.0.0-rc.9..."

# Patch 1: Fix hardcoded WhatsApp protocol version
if grep -q '1027934701' "$BAILEYS/Defaults/index.js" 2>/dev/null; then
    sed -i.bak 's/1027934701/1034074495/g' "$BAILEYS/Defaults/index.js"
    sed -i.bak 's/1027934701/1034074495/g' "$BAILEYS/Utils/generics.js"
    echo "  [1/4] Version patched: 1027934701 -> 1034074495"
else
    echo "  [1/4] Version already patched"
fi

# Patch 2: Fix passive:true -> passive:false in login payload
if grep -q 'passive: true,' "$BAILEYS/Utils/validate-connection.js" 2>/dev/null; then
    sed -i.bak 's/passive: true,/passive: false,/g' "$BAILEYS/Utils/validate-connection.js"
    echo "  [2/4] Passive flag patched: true -> false"
else
    echo "  [2/4] Passive flag already patched"
fi

# Patch 3: Remove lidDbMigrated:false from login payload
if grep -q 'lidDbMigrated: false' "$BAILEYS/Utils/validate-connection.js" 2>/dev/null; then
    sed -i.bak '/lidDbMigrated: false/d' "$BAILEYS/Utils/validate-connection.js"
    # Clean up trailing comma if needed
    sed -i.bak 's/device: device,$/device: device/g' "$BAILEYS/Utils/validate-connection.js"
    echo "  [3/4] lidDbMigrated removed"
else
    echo "  [3/4] lidDbMigrated already removed"
fi

# Patch 4: Remove await from noise.finishInit() race condition
if grep -q 'await noise.finishInit()' "$BAILEYS/Socket/socket.js" 2>/dev/null; then
    sed -i.bak 's/await noise\.finishInit()/noise.finishInit()/g' "$BAILEYS/Socket/socket.js"
    echo "  [4/4] Noise race condition patched"
else
    echo "  [4/4] Noise already patched"
fi

# Clean up .bak files
find "$BAILEYS" -name "*.bak" -delete 2>/dev/null

echo "[patch-baileys] Done!"
