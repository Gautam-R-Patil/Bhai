"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// Same-origin proxies — accounts:listAll / getStats / updateAccount /
// addCredits / deleteAccount are internalQuery/internalMutation in
// convex/accounts.ts (NOT reachable via /api/query). The /api/users/*
// Next.js routes (server-side) hold BHAI_ADMIN_KEY and forward to the
// admin-key-gated Convex routes.
async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}
import {
  Users,
  Search,
  CreditCard,
  Ban,
  CheckCircle,
  XCircle,
  Plus,
  Minus,
  Trash2,
  RefreshCw,
  Pencil,
} from "lucide-react";

interface Account {
  _id: string;
  otplessUserId: string;
  email?: string;
  phone?: string;
  name?: string;
  status: string;
  plan: string;
  ai_credits: number;
  activations: number;
  max_activations: number;
}

interface AccountStats {
  total: number;
  active: number;
  suspended: number;
  blocked: number;
  totalCredits: number;
  planCounts: Record<string, number>;
}

export default function UsersPage() {
  const searchParams = useSearchParams();
  const filterStatus = searchParams.get("status") || "all";

  const [users, setUsers] = useState<Account[]>([]);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState(filterStatus);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<Account | null>(null);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [creditsAmount, setCreditsAmount] = useState(100);
  const [editingUser, setEditingUser] = useState<Account | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    email: string;
    phone: string;
    plan: string;
    status: string;
    ai_credits: number;
    max_activations: number;
  } | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Render whichever half succeeds — if /stats is slow/down, the table
      // still loads. Promise.all would have refused to resolve until both
      // finished, leaving a blank table on a single failure.
      const [usersR, statsR] = await Promise.allSettled([
        fetchJson<Account[]>("/api/users"),
        fetchJson<AccountStats>("/api/users/stats"),
      ]);
      setUsers(usersR.status === "fulfilled" ? usersR.value || [] : []);
      setStats(statsR.status === "fulfilled" ? statsR.value : null);
      if (usersR.status === "rejected") console.error("[users] list failed:", usersR.reason);
      if (statsR.status === "rejected") console.error("[users] stats failed:", statsR.reason);
    } catch (err) {
      console.error("Failed to load users:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const filteredUsers = users.filter((user) => {
    const matchesStatus = activeFilter === "all" || user.status === activeFilter;
    const matchesSearch =
      !searchQuery ||
      user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.phone?.includes(searchQuery) ||
      user.name?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const handleStatusChange = async (user: Account, newStatus: string) => {
    try {
      await fetchJson("/api/users/update", {
        method: "POST",
        body: JSON.stringify({ id: user._id, status: newStatus }),
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to update status:", err);
    }
  };

  const handleAddCredits = async () => {
    if (!selectedUser) return;
    try {
      await fetchJson("/api/users/credits", {
        method: "POST",
        body: JSON.stringify({ id: selectedUser._id, amount: creditsAmount }),
      });
      setShowCreditsModal(false);
      setSelectedUser(null);
      loadUsers();
    } catch (err) {
      console.error("Failed to add credits:", err);
    }
  };

  const handleDeductCredits = async (user: Account) => {
    const amount = prompt("Enter amount to deduct:", "10");
    if (!amount) return;
    try {
      await fetchJson("/api/users/update", {
        method: "POST",
        body: JSON.stringify({
          id: user._id,
          ai_credits: Math.max(0, user.ai_credits - parseInt(amount)),
        }),
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to deduct credits:", err);
    }
  };

  const handleChangePlan = async (user: Account) => {
    const plans = ["free", "pro", "enterprise"];
    const currentIndex = plans.indexOf(user.plan);
    const newPlan = plans[(currentIndex + 1) % plans.length];

    if (!confirm(`Change plan from ${user.plan} to ${newPlan}?`)) return;

    try {
      await fetchJson("/api/users/update", {
        method: "POST",
        body: JSON.stringify({ id: user._id, plan: newPlan }),
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to change plan:", err);
    }
  };

  const handleDeleteUser = async (user: Account) => {
    if (!confirm(`Are you sure you want to delete user ${user.email || user.phone}? This cannot be undone.`)) return;

    try {
      await fetchJson("/api/users/delete", {
        method: "POST",
        body: JSON.stringify({ id: user._id }),
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to delete user:", err);
    }
  };

  const openEditModal = (user: Account) => {
    setEditingUser(user);
    setEditForm({
      name: user.name ?? "",
      email: user.email ?? "",
      phone: user.phone ?? "",
      plan: user.plan,
      status: user.status,
      ai_credits: user.ai_credits,
      max_activations: user.max_activations,
    });
  };

  const closeEditModal = () => {
    setEditingUser(null);
    setEditForm(null);
  };

  const saveEditedUser = async () => {
    if (!editingUser || !editForm) return;
    // Only send changed fields. Empty strings on optional fields are sent as
    // empty string so the server can decide to clear them — but we filter
    // them out to avoid overwriting with "" by accident.
    const payload: Record<string, unknown> = { id: editingUser._id };
    if (editForm.name.trim() && editForm.name.trim() !== editingUser.name) payload.name = editForm.name.trim();
    if (editForm.email.trim() && editForm.email.trim() !== editingUser.email) payload.email = editForm.email.trim();
    if (editForm.phone.trim() && editForm.phone.trim() !== editingUser.phone) payload.phone = editForm.phone.trim();
    if (editForm.plan !== editingUser.plan) payload.plan = editForm.plan;
    if (editForm.status !== editingUser.status) payload.status = editForm.status;
    if (editForm.ai_credits !== editingUser.ai_credits) payload.ai_credits = editForm.ai_credits;
    if (editForm.max_activations !== editingUser.max_activations) payload.max_activations = editForm.max_activations;

    if (Object.keys(payload).length === 1) {
      closeEditModal();
      return;
    }

    try {
      await fetchJson("/api/users/update", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeEditModal();
      loadUsers();
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const filters = ["all", "active", "suspended", "blocked"];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="page-header">
          <h1 className="page-title">Users</h1>
          <p className="page-subtitle">Manage user accounts and credits</p>
        </div>
        <button
          onClick={loadUsers}
          className="btn-glass btn-glass-secondary flex items-center gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="stat-card-glass">
            <div className="stat-icon stat-icon-blue">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="stat-label">Total Users</p>
              <p className="stat-value text-xl">{stats.total}</p>
            </div>
          </div>
          <div className="stat-card-glass">
            <div className="stat-icon stat-icon-green">
              <CheckCircle className="h-5 w-5" />
            </div>
            <div>
              <p className="stat-label">Active</p>
              <p className="stat-value text-xl">{stats.active}</p>
            </div>
          </div>
          <div className="stat-card-glass">
            <div className="stat-icon stat-icon-orange">
              <Ban className="h-5 w-5" />
            </div>
            <div>
              <p className="stat-label">Suspended</p>
              <p className="stat-value text-xl">{stats.suspended}</p>
            </div>
          </div>
          <div className="stat-card-glass">
            <div className="stat-icon stat-icon-red">
              <XCircle className="h-5 w-5" />
            </div>
            <div>
              <p className="stat-label">Blocked</p>
              <p className="stat-value text-xl">{stats.blocked}</p>
            </div>
          </div>
          <div className="stat-card-glass">
            <div className="stat-icon stat-icon-purple">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <p className="stat-label">Total Credits</p>
              <p className="stat-value text-xl">{stats.totalCredits.toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex gap-2">
          {filters.map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`filter-btn capitalize ${activeFilter === filter ? "active" : ""}`}
            >
              {filter}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[--text-muted]" />
          <input
            type="text"
            placeholder="Search by email, phone, or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-glass pl-11"
          />
        </div>
      </div>

      {/* Users Table */}
      <div className="glass-card-static overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-[--text-muted]">Loading users...</div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-[--text-muted]">No users found</div>
        ) : (
          <table className="table-glass">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Plan</th>
                <th>Credits</th>
                <th>Activations</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user._id}>
                  <td>
                    <div>
                      <div className="font-medium text-[--text-primary]">
                        {user.name || "Unnamed User"}
                      </div>
                      <div className="text-sm text-[--text-muted]">
                        {user.email || user.phone || user.otplessUserId.slice(0, 12) + "..."}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge-glass ${
                      user.status === "active" ? "badge-success" :
                      user.status === "suspended" ? "badge-warning" : "badge-danger"
                    }`}>
                      {user.status}
                    </span>
                  </td>
                  <td>
                    <button
                      onClick={() => handleChangePlan(user)}
                      className={`badge-glass cursor-pointer hover:opacity-80 ${
                        user.plan === "pro" ? "badge-info" :
                        user.plan === "enterprise" ? "bg-purple-100 text-purple-700" : "badge-neutral"
                      }`}
                      title="Click to change plan"
                    >
                      {user.plan}
                    </button>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[--text-primary]">
                        {user.ai_credits.toLocaleString()}
                      </span>
                      <button
                        onClick={() => {
                          setSelectedUser(user);
                          setShowCreditsModal(true);
                        }}
                        className="action-icon action-icon-success"
                        title="Add credits"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeductCredits(user)}
                        className="action-icon action-icon-danger"
                        title="Deduct credits"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                  <td className="text-[--text-muted]">
                    {user.activations} / {user.max_activations}
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      {user.status === "active" && (
                        <button
                          onClick={() => handleStatusChange(user, "suspended")}
                          className="action-icon action-icon-warning"
                          title="Suspend"
                        >
                          <Ban className="h-5 w-5" />
                        </button>
                      )}
                      {user.status === "suspended" && (
                        <>
                          <button
                            onClick={() => handleStatusChange(user, "active")}
                            className="action-icon action-icon-success"
                            title="Reactivate"
                          >
                            <CheckCircle className="h-5 w-5" />
                          </button>
                          <button
                            onClick={() => handleStatusChange(user, "blocked")}
                            className="action-icon action-icon-danger"
                            title="Block"
                          >
                            <XCircle className="h-5 w-5" />
                          </button>
                        </>
                      )}
                      {user.status === "blocked" && (
                        <button
                          onClick={() => handleStatusChange(user, "active")}
                          className="action-icon action-icon-success"
                          title="Unblock"
                        >
                          <CheckCircle className="h-5 w-5" />
                        </button>
                      )}
                      <button
                        onClick={() => openEditModal(user)}
                        className="action-icon"
                        title="Edit user"
                      >
                        <Pencil className="h-5 w-5" />
                      </button>
                      <button
                        onClick={() => handleDeleteUser(user)}
                        className="action-icon action-icon-danger"
                        title="Delete user"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Credits Modal */}
      {showCreditsModal && selectedUser && (
        <div className="modal-overlay">
          <div className="modal-glass p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-[--text-primary] mb-4">Add Credits</h3>
            <p className="text-sm text-[--text-muted] mb-4">
              Adding credits to {selectedUser.email || selectedUser.phone || "user"}
            </p>
            <div className="mb-5">
              <label className="block text-sm font-medium text-[--text-secondary] mb-2">
                Amount
              </label>
              <input
                type="number"
                value={creditsAmount}
                onChange={(e) => setCreditsAmount(parseInt(e.target.value) || 0)}
                className="input-glass"
                min="1"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowCreditsModal(false);
                  setSelectedUser(null);
                }}
                className="btn-glass btn-glass-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCredits}
                className="btn-glass btn-glass-primary"
              >
                Add Credits
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && editForm && (
        <div className="modal-overlay">
          <div className="modal-glass p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-[--text-primary] mb-1">Edit user</h3>
            <p className="text-sm text-[--text-muted] mb-4">
              {editingUser.otplessUserId.slice(0, 18)}…
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[--text-secondary] mb-1">Name</label>
                <input
                  type="text"
                  className="input-glass"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  placeholder="Display name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[--text-secondary] mb-1">Email</label>
                <input
                  type="email"
                  className="input-glass"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  placeholder="user@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[--text-secondary] mb-1">Phone</label>
                <input
                  type="tel"
                  className="input-glass"
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  placeholder="+91…"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[--text-secondary] mb-1">Plan</label>
                  <select
                    className="input-glass"
                    value={editForm.plan}
                    onChange={(e) => setEditForm({ ...editForm, plan: e.target.value })}
                  >
                    <option value="free">Free</option>
                    <option value="pro">Pro</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[--text-secondary] mb-1">Status</label>
                  <select
                    className="input-glass"
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[--text-secondary] mb-1">AI Credits</label>
                  <input
                    type="number"
                    min={0}
                    className="input-glass"
                    value={editForm.ai_credits}
                    onChange={(e) =>
                      setEditForm({ ...editForm, ai_credits: Math.max(0, parseInt(e.target.value) || 0) })
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[--text-secondary] mb-1">Max Activations</label>
                  <input
                    type="number"
                    min={1}
                    className="input-glass"
                    value={editForm.max_activations}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        max_activations: Math.max(1, parseInt(e.target.value) || 1),
                      })
                    }
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={closeEditModal} className="btn-glass btn-glass-secondary">
                Cancel
              </button>
              <button onClick={saveEditedUser} className="btn-glass btn-glass-primary">
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
