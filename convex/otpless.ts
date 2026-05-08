// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Never import from a client bundle — `clientSecret` must stay server-side.

const OTPLESS_BASE = "https://auth.otpless.app";
const OTPLESS_USER_AUTH_BASE = "https://user-auth.otpless.app";

function authHeaders() {
  const clientId = process.env.OTPLESS_CLIENT_ID;
  const clientSecret = process.env.OTPLESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("OTPLESS_CLIENT_ID / OTPLESS_CLIENT_SECRET not configured");
  }
  return {
    "Content-Type": "application/json",
    clientId,
    clientSecret,
  };
}

export function parseOtplessIdentity(raw: any): {
  userId: string;
  email?: string;
  phone?: string;
  name?: string;
} {
  const userId = raw?.userId || raw?.response?.userId;
  if (!userId || typeof userId !== "string") {
    throw new Error("OTPless response missing userId");
  }
  const identities: any[] = raw?.identities || raw?.response?.identities || [];
  let email: string | undefined;
  let phone: string | undefined;
  let name: string | undefined;
  for (const id of identities) {
    if (id?.identityType === "EMAIL" && typeof id.identityValue === "string") {
      email = id.identityValue;
    }
    if (id?.identityType === "MOBILE" && typeof id.identityValue === "string") {
      phone = id.identityValue.startsWith("+") ? id.identityValue : `+${id.identityValue}`;
    }
    if (!name && typeof id?.name === "string") name = id.name;
  }
  return { userId, email, phone, name };
}
