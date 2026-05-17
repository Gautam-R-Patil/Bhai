"use client";

// TODO(F16): see dashboard/page.tsx. store/submissions:* are internalQuery
// in Convex; this client-side direct call will fail in prod until a
// dev-portal server proxy is added.
import { useEffect, useState } from "react";
import Link from "next/link";
import { convexQuery } from "@/lib/convex";
import type { Submission } from "@/lib/types";
import { Clock, CheckCircle, XCircle, AlertCircle, FileUp } from "lucide-react";

const statusConfig: Record<string, { icon: React.ElementType; color: string; bgColor: string }> = {
  pending: { icon: Clock, color: "text-yellow-600", bgColor: "bg-yellow-100" },
  in_review: { icon: Clock, color: "text-blue-600", bgColor: "bg-blue-100" },
  approved: { icon: CheckCircle, color: "text-green-600", bgColor: "bg-green-100" },
  rejected: { icon: XCircle, color: "text-red-600", bgColor: "bg-red-100" },
  revision_requested: { icon: AlertCircle, color: "text-orange-600", bgColor: "bg-orange-100" },
};

const typeIcons: Record<string, string> = {
  skill: "📚",
  mcp: "🔌",
  tool: "🔧",
};

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSubmissions = async () => {
      try {
        const meRes = await fetch("/api/developer/me");
        if (!meRes.ok) throw new Error("Not authenticated");
        const { developerId } = (await meRes.json()) as { developerId: string };

        const subs = await convexQuery<Submission[]>("store/submissions:listByDeveloper", {
          developerId,
          limit: 50,
        });
        setSubmissions(subs);
      } catch (err) {
        console.error("Failed to load submissions:", err);
      } finally {
        setLoading(false);
      }
    };

    loadSubmissions();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Submissions</h1>
        <p className="text-gray-600">Track the status of your app submissions</p>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-8">Loading...</div>
      ) : submissions.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm p-12 text-center">
          <FileUp className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No submissions yet</h3>
          <p className="text-gray-500 mb-6">
            Submit your first app to get started
          </p>
          <Link
            href="/apps/new"
            className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            New Submission
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-200">
            {submissions.map((sub) => {
              const statusInfo = statusConfig[sub.status] || statusConfig.pending;
              const StatusIcon = statusInfo.icon;

              return (
                <div key={sub._id} className="p-6 hover:bg-gray-50">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-4">
                      <span className="text-3xl">{typeIcons[sub.type]}</span>
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="font-medium text-gray-900">{sub.name}</h3>
                          {sub.isUpdate && (
                            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
                              Update
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500">
                          v{sub.version} &bull; {sub.category}
                        </p>
                        <p className="text-sm text-gray-600 mt-1 line-clamp-1">
                          {sub.description}
                        </p>

                        {sub.reviewNotes && (
                          <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                            <p className="text-sm font-medium text-gray-700">Review Notes:</p>
                            <p className="text-sm text-gray-600">{sub.reviewNotes}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end space-y-2">
                      <div className={`flex items-center space-x-1 px-2 py-1 rounded-full ${statusInfo.bgColor}`}>
                        <StatusIcon className={`h-4 w-4 ${statusInfo.color}`} />
                        <span className={`text-xs font-medium ${statusInfo.color}`}>
                          {sub.status.replace("_", " ")}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400">
                        {new Date(sub.submittedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
