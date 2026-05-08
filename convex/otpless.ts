// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Never import from a client bundle — `clientSecret` must stay server-side.

import { internalAction } from "./_generated/server";
import { v } from "convex/values";

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

export const initiateOtpInternal = internalAction({
  args: {
    channel: v.union(v.literal("PHONE"), v.literal("EMAIL")),
    phone: v.optional(v.string()),
    countryCode: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (_ctx, { channel, phone, countryCode, email }) => {
    const body: Record<string, unknown> = {
      channels: channel === "PHONE" ? ["SMS", "WHATSAPP"] : ["EMAIL"],
      expiry: 300,
      otpLength: 6,
    };
    if (channel === "PHONE") {
      if (!phone || !countryCode) throw new Error("phone+countryCode required for PHONE channel");
      body.phoneNumber = `${countryCode.replace(/^\+/, "")}${phone.replace(/\D/g, "")}`;
    } else {
      if (!email) throw new Error("email required for EMAIL channel");
      body.email = email;
    }

    const res = await fetch(`${OTPLESS_BASE}/auth/v1/initiate/otp`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(raw?.description || raw?.message || `OTPless initiate failed (${res.status})`);
    }
    const requestId: string | undefined = raw?.requestId || raw?.response?.requestId;
    if (!requestId) throw new Error("OTPless initiate returned no requestId");
    const deliveryChannel: string = raw?.response?.deliveryChannel || (channel === "PHONE" ? "SMS" : "EMAIL");
    return { requestId, deliveryChannel };
  },
});
