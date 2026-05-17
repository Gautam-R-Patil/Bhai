"use client";

// TODO(F16): see dashboard/page.tsx. store/items:* are internalQuery in
// Convex; direct calls fail in prod until a dev-portal server proxy is added.
import { useEffect, useState } from "react";
import Link from "next/link";
import { convexQuery } from "@/lib/convex";
import type { StoreItem } from "@/lib/types";
import { Plus, Star, Download, Package } from "lucide-react";

const typeIcons: Record<string, string> = {
  skill: "📚",
  mcp: "🔌",
  tool: "🔧",
};

export default function MyAppsPage() {
  const [apps, setApps] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadApps = async () => {
      try {
        // Note: In real implementation, get developerId from session
        const items = await convexQuery<StoreItem[]>("store/items:listByDeveloper", {
          developerId: "current", // Backend should get from session
          limit: 50,
        });
        setApps(items);
      } catch (err) {
        console.error("Failed to load apps:", err);
      } finally {
        setLoading(false);
      }
    };

    loadApps();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Apps</h1>
          <p className="text-gray-600">Manage your published Skills, MCP Servers, and Tools</p>
        </div>
        <Link
          href="/apps/new"
          className="flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          <Plus className="h-5 w-5 mr-2" />
          New Submission
        </Link>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-8">Loading...</div>
      ) : apps.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm p-12 text-center">
          <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No apps published yet</h3>
          <p className="text-gray-500 mb-6">
            Start by creating your first Skill, MCP Server, or Tool
          </p>
          <Link
            href="/apps/new"
            className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create New
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {apps.map((app) => (
            <div
              key={app._id}
              className="bg-white rounded-xl shadow-sm p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <span className="text-3xl">{typeIcons[app.type]}</span>
                  <div>
                    <h3 className="font-medium text-gray-900">{app.name}</h3>
                    <p className="text-sm text-gray-500">v{app.version}</p>
                  </div>
                </div>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded-full ${
                    app.status === "active"
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {app.status}
                </span>
              </div>

              <p className="text-sm text-gray-600 line-clamp-2 mb-4">
                {app.description}
              </p>

              <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
                <span className="flex items-center">
                  <Download className="h-4 w-4 mr-1" />
                  {app.installCount.toLocaleString()}
                </span>
                <span className="flex items-center">
                  <Star className="h-4 w-4 text-yellow-400 mr-1" />
                  {app.rating.toFixed(1)} ({app.ratingCount})
                </span>
              </div>

              <div className="flex space-x-2">
                <Link
                  href={`/apps/${app._id}`}
                  className="flex-1 text-center px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
                >
                  View Details
                </Link>
                <Link
                  href={`/apps/${app._id}/update`}
                  className="flex-1 text-center px-3 py-2 bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100 text-sm font-medium"
                >
                  Update
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
