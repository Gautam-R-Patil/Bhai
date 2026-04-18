"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { convexQuery, convexMutation } from "@/lib/convex";
import type { Developer } from "@/lib/types";
import { Check, X, Ban, RotateCcw } from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  suspended: "bg-orange-100 text-orange-800",
  banned: "bg-gray-100 text-gray-800",
};

export default function DevelopersPage() {
  const searchParams = useSearchParams();
  const filterStatus = searchParams.get("status") || "all";

  const [developers, setDevelopers] = useState<Developer[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState(filterStatus);

  const loadDevelopers = async (status: string) => {
    setLoading(true);
    try {
      const devs = await convexQuery<Developer[]>(
        status === "all" ? "store/developers:list" : "store/developers:listByStatus",
        status === "all" ? { limit: 50 } : { status, limit: 50 }
      );
      setDevelopers(devs);
    } catch (err) {
      console.error("Failed to load developers:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDevelopers(activeFilter);
  }, [activeFilter]);

  const handleAction = async (devId: string, action: string, notes?: string) => {
    try {
      await convexMutation(`store/developers:${action}`, {
        developerId: devId,
        adminId: "admin", // TODO: get from session
        ...(notes ? { notes } : {}),
      });
      loadDevelopers(activeFilter);
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
    }
  };

  const filters = ["all", "pending", "approved", "rejected", "suspended", "banned"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Developers</h1>
          <p className="text-gray-600">Manage developer accounts and approvals</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex space-x-2">
        {filters.map((filter) => (
          <button
            key={filter}
            onClick={() => setActiveFilter(filter)}
            className={`px-4 py-2 text-sm font-medium rounded-lg capitalize transition-colors ${
              activeFilter === filter
                ? "bg-primary-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : developers.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No developers found</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Developer
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Apps
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Installs
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Joined
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {developers.map((dev) => (
                <tr key={dev._id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="font-medium text-gray-900">{dev.displayName}</div>
                      <div className="text-sm text-gray-500">{dev.email}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[dev.status]}`}>
                      {dev.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {dev.totalApps}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {dev.totalInstalls.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(dev.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    {dev.status === "pending" && (
                      <>
                        <button
                          onClick={() => handleAction(dev._id, "approve")}
                          className="text-green-600 hover:text-green-900"
                          title="Approve"
                        >
                          <Check className="h-5 w-5 inline" />
                        </button>
                        <button
                          onClick={() => {
                            const notes = prompt("Rejection reason:");
                            if (notes) handleAction(dev._id, "reject", notes);
                          }}
                          className="text-red-600 hover:text-red-900"
                          title="Reject"
                        >
                          <X className="h-5 w-5 inline" />
                        </button>
                      </>
                    )}
                    {dev.status === "approved" && (
                      <button
                        onClick={() => {
                          const notes = prompt("Suspension reason:");
                          if (notes) handleAction(dev._id, "suspend", notes);
                        }}
                        className="text-orange-600 hover:text-orange-900"
                        title="Suspend"
                      >
                        <Ban className="h-5 w-5 inline" />
                      </button>
                    )}
                    {(dev.status === "suspended" || dev.status === "rejected") && (
                      <button
                        onClick={() => handleAction(dev._id, "reinstate")}
                        className="text-green-600 hover:text-green-900"
                        title="Reinstate"
                      >
                        <RotateCcw className="h-5 w-5 inline" />
                      </button>
                    )}
                    <Link
                      href={`/developers/${dev._id}`}
                      className="text-primary-600 hover:text-primary-900"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
