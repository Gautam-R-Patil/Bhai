#!/bin/bash
# Build A.T.L.A.S Native Overlay
# Output: .build/release/ATLASOverlay

set -euo pipefail
cd "$(dirname "$0")"

echo "⚡ Building A.T.L.A.S native overlay…"
swift build -c release 2>&1

BINARY=".build/release/ATLASOverlay"
if [ -f "$BINARY" ]; then
    echo "✓ Built: $BINARY"
    echo "  Size: $(du -h "$BINARY" | cut -f1)"
else
    echo "✗ Build failed — binary not found"
    exit 1
fi
