"use client";

import { useEffect, useState } from "react";
import { convexQuery } from "@/lib/convex";
import type { ActivityLog } from "@/lib/types";
import {
  Download,
  Upload,
  Star,
  Check,
  User,
  Package,
  Trash2,
} from "lucide-react";

const activityIcons: Record<string, React.ElementType> = {
  install: Download,
  uninstall: Trash2,
  update: Upload,
  review: Star,
  submission: Package,
  approval: Check,
  registration: User,
};

const activityColors: Record<string, string> = {
  install: "bg-green-100 text-green-600",
  uninstall: "bg-red-100 text-red-600",
  update: "bg-blue-100 text-blue-600",
  review: "bg-yellow-100 text-yellow-600",
  submission: "bg-purple-100 text-purple-600",
  approval: "bg-emerald-100 text-emerald-600",
  registration: "bg-gray-100 text-gray-600",
};

export default function ActivityPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");

  const loadLogs = async () => {
    setLoading(true);
    try {
      const result = await convexQuery<ActivityLog[]>("store/admins:getActivityLogs", {
        type: typeFilter === "all" ? undefined : typeFilter,
        limit: 100,
      });
      setLogs(result);
    } catch (err) {
      console.error("Failed to load logs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, [typeFilter]);

  const filters = ["all", "install", "uninstall", "review", "submission", "approval"];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Activity Logs</h1>
        <p className="text-gray-600">Monitor all store activity</p>
      </div>

      {/* Filters */}
      <div className="flex space-x-2 flex-wrap gap-2">
        {filters.map((filter) => (
          <button
            key={filter}
            onClick={() => setTypeFilter(filter)}
            className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
              typeFilter === filter
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* Logs */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No activity found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {logs.map((log) => {
              const Icon = activityIcons[log.type] || Package;
              const colorClass = activityColors[log.type] || "bg-gray-100 text-gray-600";
              const metadata = log.metadata ? JSON.parse(log.metadata) : {};

              return (
                <div key={log._id} className="p-4 hover:bg-gray-50">
                  <div className="flex items-start space-x-4">
                    <div className={`p-2 rounded-lg ${colorClass}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {formatActivityMessage(log.type, metadata)}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        {new Date(log.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatActivityMessage(type: string, metadata: Record<string, unknown>): string {
  switch (type) {
    case "install":
      return `User installed "${metadata.itemName || "an app"}"`;
    case "uninstall":
      return `User uninstalled "${metadata.itemName || "an app"}"`;
    case "update":
      return `"${metadata.itemName || "App"}" updated to v${metadata.version || "?"}`;
    case "review":
      return `New review on "${metadata.itemName || "an app"}" (${metadata.rating || "?"}★)`;
    case "submission":
      return `New submission: "${metadata.name || "Unknown"}"`;
    case "approval":
      return `"${metadata.name || "Item"}" was ${metadata.action || "approved"}`;
    case "registration":
      return `New developer registered: ${metadata.email || "Unknown"}`;
    default:
      return `Activity: ${type}`;
  }
}
