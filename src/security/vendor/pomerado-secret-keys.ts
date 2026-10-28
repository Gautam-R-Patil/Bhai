// Vendored from Pomerado (https://github.com/Pomerado/pomerado), typescript/src/privacy/secret-keys.ts.
// MIT License, Copyright (c) 2026 Pomerado AI, Inc. — full text in third-party/pomerado/LICENSE.
// biome-ignore-all lint: kept as upstream wrote it

const normalizedSecretKeys = new Set([
  "accesstoken",
  "apikey",
  "authenticitytoken",
  "authorization",
  "clientsecret",
  "cookie",
  "csrf",
  "csrfmiddlewaretoken",
  "csrftoken",
  "idtoken",
  "otp",
  "passwd",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "requestverificationtoken",
  "sessionid",
  "sessiontoken",
  "setcookie",
  "totp",
  "totpseed",
  "xapikey",
  "xauthtoken",
  "xcsrftoken",
  "xsrf",
  "xsrftoken",
  "xxsrftoken",
  "xaccesstoken",
  "xamzsecuritytoken",
  "privatetoken",
  "jwt",
  "authtoken",
  "oauthtoken",
  "otpcode",
  "xvercelprotectionbypass",
]);

const normalizeSecretKey = (name: string): string => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Exact match after removing conventional key-name separators. No substring matching. */
export const isSecretKey = (name: string): boolean =>
  normalizedSecretKeys.has(normalizeSecretKey(name));
