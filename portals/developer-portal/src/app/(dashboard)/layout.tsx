import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { convexQuery } from "@/lib/convex";
import DeveloperSidebar from "@/components/DeveloperSidebar";
import type { Developer } from "@/lib/types";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  // F14d: re-fetch the developer's current status from Convex on every
  // dashboard page load. The JWT session carries the status from
  // login-time — if an admin bans the developer mid-session, the JWT is
  // still valid until expiry. Without this check, banned/suspended
  // developers stay in-portal until their cookie expires.
  //
  // TODO(F16): the convex/store/developers:* functions are exported as
  // internalQuery/internalMutation, so direct convexQuery() calls will
  // fail in production until the developer-portal is wired through a
  // server proxy (analogous to admin-panel's /api/store). Until then,
  // the catch below treats fetch failure as "trust the session" — same
  // posture as before this change.
  try {
    const developer = await convexQuery<Developer | null>(
      "store/developers:getById",
      { developerId: session.developerId },
    );
    if (developer && (developer.status === "banned" || developer.status === "suspended")) {
      redirect("/banned");
    }
  } catch (err) {
    // F14d: see TODO above. Don't fail-closed in case Convex is briefly
    // unreachable — but the banned page exists and will catch them on
    // their next nav.
    console.warn("[dashboard layout] developer status re-fetch failed:", err);
  }

  return (
    <div className="flex min-h-screen relative">
      {/* Animated Background Orbs */}
      <div className="bg-orbs">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
        <div className="orb orb-4"></div>
      </div>

      <DeveloperSidebar displayName={session.displayName} status={session.status} />
      <main className="flex-1 p-8 relative z-10">{children}</main>
    </div>
  );
}
