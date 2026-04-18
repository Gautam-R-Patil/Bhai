"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { convexQuery, convexMutation } from "@/lib/convex";
import type { Submission } from "@/lib/types";
import { Check, X, MessageSquare, Eye } from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  in_review: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  revision_requested: "bg-orange-100 text-orange-800",
};

const typeIcons: Record<string, string> = {
  skill: "📚",
  mcp: "🔌",
  tool: "🔧",
};

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState("pending");

  const loadSubmissions = async (status: string) => {
    setLoading(true);
    try {
      const subs = await convexQuery<Submission[]>(
        status === "all" ? "store/submissions:list" : "store/submissions:listByStatus",
        status === "all" ? { limit: 50 } : { status, limit: 50 }
      );
      setSubmissions(subs);
    } catch (err) {
      console.error("Failed to load submissions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSubmissions(activeFilter);
  }, [activeFilter]);

  const handleAction = async (subId: string, action: string, notes?: string) => {
    try {
      await convexMutation(`store/submissions:${action}`, {
        submissionId: subId,
        adminId: "admin", // TODO: get from session
        ...(notes ? { notes } : {}),
      });
      loadSubmissions(activeFilter);
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
      alert(`Failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const filters = ["pending", "in_review", "approved", "rejected", "revision_requested", "all"];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">App Submissions</h1>
        <p className="text-gray-600">Review and approve app submissions</p>
      </div>

      {/* Filters */}
      <div className="flex space-x-2 flex-wrap gap-2">
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
            {filter.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Submissions List */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : submissions.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No submissions found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {submissions.map((sub) => (
              <div key={sub._id} className="p-6 hover:bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-4">
                    <div className="text-3xl">{typeIcons[sub.type]}</div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <h3 className="font-medium text-gray-900">{sub.name}</h3>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[sub.status]}`}>
                          {sub.status.replace("_", " ")}
                        </span>
                        {sub.isUpdate && (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
                            Update
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        {sub.type} &bull; v{sub.version} &bull; {sub.category}
                      </p>
                      <p className="text-sm text-gray-600 mt-2 line-clamp-2">
                        {sub.description}
                      </p>
                      <p className="text-xs text-gray-400 mt-2">
                        Submitted {new Date(sub.submittedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Link
                      href={`/submissions/${sub._id}`}
                      className="p-2 text-gray-400 hover:text-primary-600 rounded-lg hover:bg-gray-100"
                      title="View Details"
                    >
                      <Eye className="h-5 w-5" />
                    </Link>

                    {sub.status === "pending" && (
                      <>
                        <button
                          onClick={() => handleAction(sub._id, "approve")}
                          className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                          title="Approve"
                        >
                          <Check className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => {
                            const notes = prompt("Rejection reason:");
                            if (notes) handleAction(sub._id, "reject", notes);
                          }}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                          title="Reject"
                        >
                          <X className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => {
                            const notes = prompt("What changes are needed?");
                            if (notes) handleAction(sub._id, "requestRevision", notes);
                          }}
                          className="p-2 text-orange-600 hover:bg-orange-50 rounded-lg"
                          title="Request Revision"
                        >
                          <MessageSquare className="h-5 w-5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
