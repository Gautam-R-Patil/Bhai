import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import DeveloperSidebar from "@/components/DeveloperSidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect("/login");
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
