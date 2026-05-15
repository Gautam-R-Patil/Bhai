"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Code2,
  FileCheck,
  Package,
  Activity,
  Settings,
  Shield,
  LogOut,
  BarChart3,
  UserPlus,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Observability", href: "/dashboard/observability", icon: BarChart3 },
  { name: "Users", href: "/users", icon: Users },
  { name: "Waitlist", href: "/waitlist", icon: UserPlus },
  { name: "Developers", href: "/developers", icon: Code2 },
  { name: "Submissions", href: "/submissions", icon: FileCheck },
  { name: "Published Apps", href: "/apps", icon: Package },
  { name: "Activity Logs", href: "/activity", icon: Activity },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Admins", href: "/admins", icon: Shield },
];

interface SidebarProps {
  adminName: string;
  adminRole: string;
}

export default function Sidebar({ adminName, adminRole }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex flex-col w-64 min-h-screen sidebar-glass">
      {/* Logo Header */}
      <div className="flex items-center justify-center h-16 border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="A.T.L.A.S" className="w-8 h-8 rounded-lg" />
          <span className="text-white font-semibold text-lg tracking-tight">A.T.L.A.S Admin</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto">
        <div className="space-y-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`nav-item-glass ${isActive ? "active" : ""}`}
              >
                <item.icon className="h-[18px] w-[18px]" />
                {item.name}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* User Profile Footer */}
      <div className="p-4 border-t border-white/[0.08]">
        <div className="flex items-center mb-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-sm">
            {adminName.charAt(0).toUpperCase()}
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-white">{adminName}</p>
            <p className="text-xs text-white/50 capitalize">{adminRole.replace("_", " ")}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center w-full px-3 py-2 text-sm font-medium text-white/60 rounded-lg hover:bg-white/[0.08] hover:text-white transition-all"
        >
          <LogOut className="mr-3 h-[18px] w-[18px]" />
          Sign out
        </button>
      </div>
    </div>
  );
}
