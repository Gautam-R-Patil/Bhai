// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { parseOtplessIdentity } from "./otpless.js";

describe("parseOtplessIdentity", () => {
  it("extracts userId + phone from MOBILE identity", () => {
    const raw = {
      userId: "u_123",
      identities: [
        { identityType: "MOBILE", identityValue: "919899038845", verified: true, name: "Satyam" },
      ],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_123",
      phone: "+919899038845",
      name: "Satyam",
    });
  });

  it("extracts userId + email from EMAIL identity", () => {
    const raw = {
      userId: "u_456",
      identities: [{ identityType: "EMAIL", identityValue: "a@b.com" }],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_456",
      email: "a@b.com",
    });
  });

  it("preserves leading + on phone numbers", () => {
    const raw = { userId: "u", identities: [{ identityType: "MOBILE", identityValue: "+911234567890" }] };
    expect(parseOtplessIdentity(raw).phone).toBe("+911234567890");
  });

  it("unwraps identities nested under response (validate-token shape)", () => {
    const raw = {
      response: {
        userId: "u_789",
        identities: [{ identityType: "EMAIL", identityValue: "c@d.com" }],
      },
    };
    expect(parseOtplessIdentity(raw)).toEqual({ userId: "u_789", email: "c@d.com" });
  });

  it("throws when userId is missing", () => {
    expect(() => parseOtplessIdentity({ identities: [] })).toThrow(/missing userId/);
  });

  it("extracts both email and phone when EMAIL and MOBILE coexist", () => {
    const raw = {
      userId: "u_multi",
      identities: [
        { identityType: "EMAIL", identityValue: "multi@x.com", name: "First" },
        { identityType: "MOBILE", identityValue: "919999999999", name: "Second" },
      ],
    };
    expect(parseOtplessIdentity(raw)).toEqual({
      userId: "u_multi",
      email: "multi@x.com",
      phone: "+919999999999",
      name: "First",
    });
  });
});
