import { type NextRequest, NextResponse } from "next/server";
import { guard } from "@/lib/route-guards";
import {
  listEnterpriseLicenses,
  issueEnterpriseLicense,
} from "@/lib/mcp-admin";

export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: "manage_enterprise", allowAnyBodySize: true });
  if (!g.ok) return g.response;

  try {
    const licenses = await listEnterpriseLicenses();
    return NextResponse.json({ licenses });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list licenses";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const g = await guard(request, { permission: "manage_enterprise" });
  if (!g.ok) return g.response;

  let body: {
    client_name?: string;
    contact_email?: string;
    plan?: "pilot" | "standard" | "enterprise";
    seat_limit?: number;
    lifetime_days?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    typeof body.client_name !== "string" ||
    body.client_name.length < 1 ||
    body.client_name.length > 200 ||
    typeof body.contact_email !== "string" ||
    !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(body.contact_email)
  ) {
    return NextResponse.json({ error: "invalid_client_fields" }, { status: 400 });
  }
  const plan = body.plan ?? "pilot";
  if (!["pilot", "standard", "enterprise"].includes(plan)) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  const seatLimit = body.seat_limit ?? (plan === "pilot" ? 5 : plan === "standard" ? 50 : 500);
  if (!Number.isInteger(seatLimit) || seatLimit <= 0 || seatLimit > 10000) {
    return NextResponse.json({ error: "invalid_seat_limit" }, { status: 400 });
  }
  const lifetimeDays = body.lifetime_days ?? 365;
  if (!Number.isInteger(lifetimeDays) || lifetimeDays <= 0 || lifetimeDays > 3650) {
    return NextResponse.json({ error: "invalid_lifetime_days" }, { status: 400 });
  }

  try {
    const result = await issueEnterpriseLicense({
      client_name: body.client_name,
      contact_email: body.contact_email,
      plan,
      seat_limit: seatLimit,
      lifetime_days: lifetimeDays,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to issue license";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
