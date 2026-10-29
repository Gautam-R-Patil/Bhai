// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Server-side E2E encryption using Web Crypto API.
// ECDH P-256 key exchange + AES-256-GCM payload encryption.

// ── Types ─────────────────────────────────────

export interface EncryptedEnvelope {
  iv: string;    // base64
  ct: string;    // base64
  tag: string;   // base64
  ts: number;    // timestamp
  rid: string;   // request ID
}

// ── Key Exchange ──────────────────────────────

/**
 * Generate server ECDH P-256 key pair.
 * Returns { publicKey (base64), privateKey (base64) }
 */
export async function generateServerKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, // extractable
    ["deriveBits"]
  );

  const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  return {
    publicKey: bufToBase64(pubRaw),
    privateKey: JSON.stringify(privJwk),
  };
}

/**
 * Supported KDF versions (mirror of src/crypto-kdf.ts — keep in sync).
 *   v1: SHA256(shared ‖ salt ‖ info)       — legacy, kept for existing sessions
 *   v2: HKDF-SHA256(shared, salt, info, 32) — new sessions, RFC 5869
 */
export const KDF_VERSION_LEGACY = 1;
export const KDF_VERSION_HKDF = 2;
export const KDF_VERSION_LATEST = KDF_VERSION_HKDF;
export const SUPPORTED_KDF_VERSIONS = [KDF_VERSION_LEGACY, KDF_VERSION_HKDF] as const;

/**
 * Derive AES-256 shared key from server private key + client public key.
 *
 * `version` selects the KDF. The caller (the /api/auth/session HTTP
 * action) reads the client's requested kdfVersion from the request
 * body, validates it, and echoes it back in the session response so
 * the client knows which KDF the stored shared key was made with.
 */
export async function deriveSharedKey(
  serverPrivateKeyJwk: string,
  clientPublicKeyBase64: string,
  version: number = KDF_VERSION_LATEST,
  serverPublicKeyBase64?: string,
): Promise<string> {
  // Import server private key
  const privKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(serverPrivateKeyJwk),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  // Import client public key from raw base64
  const clientPubRaw = base64ToBuf(clientPublicKeyBase64);
  // Length + format check: uncompressed P-256 point is 65 bytes, first byte 0x04.
  if (clientPubRaw.byteLength !== 65 || new Uint8Array(clientPubRaw)[0] !== 0x04) {
    throw new Error("Invalid client public key");
  }
  const clientPubKey = await crypto.subtle.importKey(
    "raw",
    clientPubRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // ECDH: derive shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPubKey },
    privKey,
    256
  );

  const salt = new TextEncoder().encode("atlas-e2e-salt");
  // Bind both pubkeys into info so any key-substitution under TLS MITM breaks
  // decryption on both ends. Server pubkey is optional for backward compat
  // with callers that haven't been updated yet; when present, both ends MUST
  // include identical pubkey strings.
  const infoBase = serverPublicKeyBase64
    ? `atlas-e2e-aes256-key|${clientPublicKeyBase64}|${serverPublicKeyBase64}`
    : "atlas-e2e-aes256-key";
  const info = new TextEncoder().encode(infoBase);

  if (version === KDF_VERSION_LEGACY) {
    // Legacy: SHA-256(shared_secret + salt + info) — the original
    // kept for sessions created before the HKDF rollout.
    const combined = new Uint8Array(
      sharedBits.byteLength + salt.byteLength + info.byteLength
    );
    combined.set(new Uint8Array(sharedBits), 0);
    combined.set(salt, sharedBits.byteLength);
    combined.set(info, sharedBits.byteLength + salt.byteLength);
    const hashBuf = await crypto.subtle.digest("SHA-256", combined);
    return bufToBase64(hashBuf);
  }

  if (version === KDF_VERSION_HKDF) {
    // HKDF-SHA256 (RFC 5869) via HMAC primitives — the V8-isolate runtime
    // that httpActions/mutations/queries run in does not implement
    // crypto.subtle.importKey({name:"HKDF"}), but it DOES implement
    // importKey+sign for {name:"HMAC"}, which is all HKDF needs.
    //
    // Must byte-match Node's hkdfSync("sha256", ikm, salt, info, 32) on the
    // client side (see src/crypto-kdf.ts v2 path).
    const okm = await hkdfSha256(new Uint8Array(sharedBits), salt, info);
    return bufToBase64(okm.buffer.slice(okm.byteOffset, okm.byteOffset + okm.byteLength) as ArrayBuffer);
  }

  throw new Error(`Unsupported KDF version: ${version}`);
}

// ── Encrypt / Decrypt ─────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM using the shared key.
 *
 * `additionalData` (optional) — callback that, given the chosen ts/rid,
 * returns an AAD string to bind into the GCM tag. The client must
 * compute the same AAD on receive or decryption fails. Used to bind the
 * envelope to its request route so a captured envelope cannot be
 * replayed against a different endpoint.
 */
export async function encryptResponse(
  plaintext: string,
  sharedKeyBase64: string,
  additionalData?: (ts: number, rid: string) => string,
): Promise<EncryptedEnvelope> {
  const keyBuf = base64ToBuf(sharedKeyBase64);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit
  const ts = Date.now();
  const rid = randomHex(16);
  const encoded = new TextEncoder().encode(plaintext);
  const aad = additionalData
    ? new TextEncoder().encode(additionalData(ts, rid))
    : undefined;

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128, ...(aad ? { additionalData: aad } : {}) },
    aesKey,
    encoded
  );

  // Web Crypto appends the tag to the ciphertext
  const ctWithTag = new Uint8Array(ciphertext);
  const ct = ctWithTag.slice(0, ctWithTag.length - 16);
  const tag = ctWithTag.slice(ctWithTag.length - 16);

  return {
    iv: bufToBase64(iv),
    ct: bufToBase64(ct),
    tag: bufToBase64(tag),
    ts,
    rid,
  };
}

/**
 * Decrypt an encrypted envelope with AES-256-GCM.
 *
 * `aad` (optional) — must match the AAD bound during encryption.
 */
export async function decryptRequest(
  envelope: EncryptedEnvelope,
  sharedKeyBase64: string,
  aad?: Uint8Array,
): Promise<string> {
  const keyBuf = base64ToBuf(sharedKeyBase64);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const iv = base64ToBuf(envelope.iv);
  const ct = base64ToBuf(envelope.ct);
  const tag = base64ToBuf(envelope.tag);

  // Web Crypto expects tag appended to ciphertext
  const ctWithTag = new Uint8Array(ct.byteLength + tag.byteLength);
  ctWithTag.set(new Uint8Array(ct), 0);
  ctWithTag.set(new Uint8Array(tag), ct.byteLength);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128, ...(aad ? { additionalData: aad } : {}) },
    aesKey,
    ctWithTag
  );

  return new TextDecoder().decode(decrypted);
}

// ── Replay Protection ─────────────────────────

const MAX_REQUEST_AGE_MS = 90_000; // 90 seconds (increased from 30s to accommodate model fallback chains)

/**
 * Validate timestamp to prevent replay attacks.
 */
export function validateTimestamp(ts: number): boolean {
  const age = Date.now() - ts;
  return age >= 0 && age <= MAX_REQUEST_AGE_MS;
}

// ── HMAC-based HKDF (works inside Convex's V8-isolate runtime) ─

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(sig);
}

// HKDF-SHA256 (RFC 5869). Only one Expand iteration because we need just
// 32 bytes out — that's one T(1) block. Matches Node's hkdfSync.
async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  // Empty salt → zero-filled salt of HashLen per RFC 5869 §2.2.
  const extractSalt = salt.byteLength > 0 ? salt : new Uint8Array(32);
  const prk = await hmacSha256(extractSalt, ikm);
  const expandInput = new Uint8Array(info.byteLength + 1);
  expandInput.set(info, 0);
  expandInput[info.byteLength] = 0x01;
  return await hmacSha256(prk, expandInput);
}

// ── Helpers ───────────────────────────────────

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length / 2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
