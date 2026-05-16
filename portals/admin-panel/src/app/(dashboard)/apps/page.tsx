"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { storeProxy } from "@/lib/convex";
import type { StoreItem } from "@/lib/types";
import { Star, Download, Trash2, Award } from "lucide-react";

const typeIcons: Record<string, string> = {
  skill: "📚",
  mcp: "🔌",
  tool: "🔧",
};

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  deprecated: "bg-yellow-100 text-yellow-800",
  removed: "bg-red-100 text-red-800",
};

export default function AppsPage() {
  const [apps, setApps] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");

  const loadApps = async () => {
    setLoading(true);
    try {
      const items = await storeProxy<StoreItem[]>("query", "store/items:list", {
        type: typeFilter === "all" ? undefined : typeFilter,
        limit: 50,
      });
      setApps(items);
    } catch (err) {
      console.error("Failed to load apps:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApps();
  }, [typeFilter]);

  const handleFeature = async (itemId: string, rank: number | null) => {
    try {
      await storeProxy("mutation", "store/items:setFeatured", {
        itemId,
        featuredRank: rank,
      });
      loadApps();
    } catch (err) {
      console.error("Failed to feature:", err);
    }
  };

  const handleRemove = async (itemId: string) => {
    if (!confirm("Are you sure you want to remove this app?")) return;
    try {
      await storeProxy("mutation", "store/items:updateStatus", {
        itemId,
        status: "removed",
      });
      loadApps();
    } catch (err) {
      console.error("Failed to remove:", err);
    }
  };

  const filteredApps = search
    ? apps.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.description.toLowerCase().includes(search.toLowerCase())
      )
    : apps;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Published Apps</h1>
        <p className="text-gray-600">Manage published store items</p>
      </div>

      {/* Filters */}
      <div className="flex items-center space-x-4">
        <div className="flex space-x-2">
          {["all", "skill", "mcp", "tool"].map((type) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
                typeFilter === type
                  ? "bg-primary-600 text-white"
                  : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {type === "all" ? "All" : type}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search apps..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {/* Apps Grid */}
      {loading ? (
        <div className="text-center text-gray-500 py-8">Loading...</div>
      ) : filteredApps.length === 0 ? (
        <div className="text-center text-gray-500 py-8">No apps found</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredApps.map((app) => (
            <div
              key={app._id}
              className="bg-white rounded-xl shadow-sm p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-3">
                  <span className="text-3xl">{typeIcons[app.type]}</span>
                  <div>
                    <h3 className="font-medium text-gray-900">{app.name}</h3>
                    <p className="text-sm text-gray-500">{app.type} &bull; v{app.version}</p>
                  </div>
                </div>
                {app.featuredRank && (
                  <span className="bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded-full flex items-center">
                    <Award className="h-3 w-3 mr-1" /> Featured
                  </span>
                )}
              </div>

              <p className="text-sm text-gray-600 mt-3 line-clamp-2">
                {app.description}
              </p>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
                <div className="flex items-center space-x-4 text-sm text-gray-500">
                  <span className="flex items-center">
                    <Star className="h-4 w-4 text-yellow-400 mr-1" />
                    {app.rating.toFixed(1)}
                  </span>
                  <span className="flex items-center">
                    <Download className="h-4 w-4 mr-1" />
                    {app.installCount.toLocaleString()}
                  </span>
                </div>
                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[app.status]}`}>
                  {app.status}
                </span>
              </div>

              <div className="flex items-center justify-between mt-4">
                <Link
                  href={`/apps/${app._id}`}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  View Details
                </Link>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleFeature(app._id, app.featuredRank ? null : 1)}
                    className={`p-1.5 rounded-lg ${
                      app.featuredRank
                        ? "text-yellow-600 bg-yellow-50"
                        : "text-gray-400 hover:bg-gray-100"
                    }`}
                    title={app.featuredRank ? "Unfeature" : "Feature"}
                  >
                    <Award className="h-4 w-4" />
                  </button>
                  {app.status !== "removed" && (
                    <button
                      onClick={() => handleRemove(app._id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
