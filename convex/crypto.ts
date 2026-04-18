// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
 * Derive AES-256 shared key from server private key + client public key.
 * Uses ECDH + HKDF (same params as client side).
 */
export async function deriveSharedKey(
  serverPrivateKeyJwk: string,
  clientPublicKeyBase64: string
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

  // Use SHA-256 hash of (shared_secret + salt + info) as the AES key
  // This is a simpler alternative to HKDF that Convex runtime supports
  const salt = new TextEncoder().encode("atlas-e2e-salt");
  const info = new TextEncoder().encode("atlas-e2e-aes256-key");
  const combined = new Uint8Array(sharedBits.byteLength + salt.byteLength + info.byteLength);
  combined.set(new Uint8Array(sharedBits), 0);
  combined.set(salt, sharedBits.byteLength);
  combined.set(info, sharedBits.byteLength + salt.byteLength);

  const hashBuf = await crypto.subtle.digest("SHA-256", combined);
  return bufToBase64(hashBuf);
}

// ── Encrypt / Decrypt ─────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM using the shared key.
 */
export async function encryptResponse(
  plaintext: string,
  sharedKeyBase64: string
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
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
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
    ts: Date.now(),
    rid: randomHex(16),
  };
}

/**
 * Decrypt an encrypted envelope with AES-256-GCM.
 */
export async function decryptRequest(
  envelope: EncryptedEnvelope,
  sharedKeyBase64: string
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
    { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128 },
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
