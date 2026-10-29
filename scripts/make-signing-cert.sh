#!/bin/bash
# © 2024-2026 TRUSCOR Private Limited. All rights reserved.
#
# Creates a self-signed "Bhai Local Signing" code-signing identity in your login
# keychain, so local Bhai builds share one signature and macOS keeps their Screen
# Recording / Accessibility permissions across updates.
#   bash scripts/make-signing-cert.sh
#   BHAI_SIGN_IDENTITY="Bhai Local Signing" npm run build:mac   (in desktop/)
# macOS may ask for your login password to add it to the keychain.
set -euo pipefail
NAME="Bhai Local Signing"
if security find-identity -p codesigning | grep -q "$NAME"; then
    echo "\"$NAME\" already exists."; exit 0
fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null
PASS=$(openssl rand -hex 16)
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$TMP/id.p12" -passout "pass:$PASS" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$TMP/id.p12" -passout "pass:$PASS"
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign
security find-identity -p codesigning | grep "$NAME" && echo "Done: \"$NAME\" is ready."
