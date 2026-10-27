"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  FileUp,
  BarChart3,
  Settings,
  LogOut,
  Clock,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "My Apps", href: "/apps", icon: Package },
  { name: "Submissions", href: "/submissions", icon: FileUp },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Settings", href: "/settings", icon: Settings },
];

const statusConfig: Record<string, { icon: React.ElementType; color: string; bgColor: string; label: string }> = {
  pending: { icon: Clock, color: "text-yellow-400", bgColor: "bg-yellow-500/20", label: "Pending Approval" },
  approved: { icon: CheckCircle, color: "text-green-400", bgColor: "bg-green-500/20", label: "Approved" },
  rejected: { icon: AlertCircle, color: "text-red-400", bgColor: "bg-red-500/20", label: "Rejected" },
  suspended: { icon: AlertCircle, color: "text-orange-400", bgColor: "bg-orange-500/20", label: "Suspended" },
};

interface DeveloperSidebarProps {
  displayName: string;
  status: string;
}

export default function DeveloperSidebar({ displayName, status }: DeveloperSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const statusInfo = statusConfig[status] || statusConfig.pending;
  const StatusIcon = statusInfo.icon;

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex flex-col w-64 min-h-screen sidebar-glass">
      {/* Logo Header */}
      <div className="flex items-center justify-center h-16 border-b border-white/[0.08]">
        <Link href="/" className="flex items-center gap-3">
          <img src="/logo.png" alt="Bhai" className="w-8 h-8 rounded-lg" />
          <span className="text-white font-semibold text-lg tracking-tight">Bhai Dev</span>
        </Link>
      </div>

      {/* Account Status */}
      <div className="px-4 py-3 border-b border-white/[0.08]">
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${statusInfo.bgColor}`}>
          <StatusIcon className={`h-4 w-4 ${statusInfo.color}`} />
          <span className={`text-sm font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto">
        <div className="space-y-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const isDisabled = status !== "approved" && item.href !== "/dashboard" && item.href !== "/settings";

            return (
              <Link
                key={item.name}
                href={isDisabled ? "#" : item.href}
                className={`nav-item-glass ${isActive ? "active" : ""} ${
                  isDisabled ? "opacity-40 cursor-not-allowed" : ""
                }`}
                onClick={(e) => {
                  if (isDisabled) e.preventDefault();
                }}
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
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-green-500 to-teal-600 flex items-center justify-center text-white font-semibold text-sm">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-white">{displayName}</p>
            <p className="text-xs text-white/50">Developer</p>
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
