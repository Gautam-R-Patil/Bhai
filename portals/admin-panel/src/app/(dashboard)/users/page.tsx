"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { convexQuery, convexMutation } from "@/lib/convex";
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

  const loadUsers = async () => {
    setLoading(true);
    try {
      const [allUsers, userStats] = await Promise.all([
        convexQuery<Account[]>("accounts:listAll", {}),
        convexQuery<AccountStats>("accounts:getStats", {}),
      ]);
      setUsers(allUsers || []);
      setStats(userStats);
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
      await convexMutation("accounts:updateAccount", {
        id: user._id,
        status: newStatus,
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to update status:", err);
    }
  };

  const handleAddCredits = async () => {
    if (!selectedUser) return;
    try {
      await convexMutation("accounts:addCredits", {
        id: selectedUser._id,
        amount: creditsAmount,
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
      await convexMutation("accounts:updateAccount", {
        id: user._id,
        ai_credits: Math.max(0, user.ai_credits - parseInt(amount)),
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
      await convexMutation("accounts:updateAccount", {
        id: user._id,
        plan: newPlan,
      });
      loadUsers();
    } catch (err) {
      console.error("Failed to change plan:", err);
    }
  };

  const handleDeleteUser = async (user: Account) => {
    if (!confirm(`Are you sure you want to delete user ${user.email || user.phone}? This cannot be undone.`)) return;

    try {
      await convexMutation("accounts:deleteAccount", { id: user._id });
      loadUsers();
    } catch (err) {
      console.error("Failed to delete user:", err);
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
    </div>
  );
}
