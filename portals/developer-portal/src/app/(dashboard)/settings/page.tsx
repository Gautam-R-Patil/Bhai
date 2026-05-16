"use client";

// TODO(F16): see dashboard/page.tsx. store/developers:* are internalQuery /
// internalMutation in Convex; direct calls fail in prod until a dev-portal
// server proxy is added.
import { useState, useEffect } from "react";
import { convexQuery, convexMutation } from "@/lib/convex";
import type { Developer } from "@/lib/types";

export default function SettingsPage() {
  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const [formData, setFormData] = useState({
    displayName: "",
    companyName: "",
    website: "",
    bio: "",
  });

  useEffect(() => {
    const loadDeveloper = async () => {
      try {
        const dev = await convexQuery<Developer>("store/developers:getCurrent", {});
        setDeveloper(dev);
        setFormData({
          displayName: dev.displayName || "",
          companyName: dev.companyName || "",
          website: dev.website || "",
          bio: dev.bio || "",
        });
      } catch (err) {
        console.error("Failed to load developer:", err);
      } finally {
        setLoading(false);
      }
    };

    loadDeveloper();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      await convexMutation("store/developers:updateProfile", {
        developerId: developer?._id,
        ...formData,
      });
      setMessage("Profile updated successfully!");
    } catch (err) {
      setMessage("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-center text-gray-500 py-8">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600">Manage your developer profile</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {message && (
            <div
              className={`p-3 rounded-lg ${
                message.includes("success")
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {message}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              value={developer?.email || ""}
              disabled
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500"
            />
            <p className="mt-1 text-xs text-gray-500">Email cannot be changed</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Display Name</label>
            <input
              type="text"
              required
              value={formData.displayName}
              onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Company Name</label>
            <input
              type="text"
              value={formData.companyName}
              onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Website</label>
            <input
              type="url"
              value={formData.website}
              onChange={(e) => setFormData({ ...formData, website: e.target.value })}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              placeholder="https://example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Bio</label>
            <textarea
              value={formData.bio}
              onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
              rows={4}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              placeholder="Tell users about yourself or your company..."
            />
          </div>

          <div className="pt-4 border-t border-gray-200">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>

      {/* Account Status */}
      <div className="bg-white rounded-xl shadow-sm p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Account Status</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Status</span>
            <span
              className={`px-2 py-1 text-xs font-medium rounded-full capitalize ${
                developer?.status === "approved"
                  ? "bg-green-100 text-green-800"
                  : developer?.status === "pending"
                  ? "bg-yellow-100 text-yellow-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {developer?.status}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Member Since</span>
            <span className="text-sm text-gray-900">
              {developer?.createdAt
                ? new Date(developer.createdAt).toLocaleDateString()
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Published Apps</span>
            <span className="text-sm text-gray-900">{developer?.totalApps || 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Total Installs</span>
            <span className="text-sm text-gray-900">
              {(developer?.totalInstalls || 0).toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
