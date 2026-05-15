// Admin Panel Types

export interface Account {
  _id: string;
  otplessUserId: string;
  email?: string;
  phone?: string;
  name?: string;
  status: "active" | "suspended" | "blocked";
  plan: "free" | "pro" | "enterprise";
  ai_credits: number;
  activations: number;
  max_activations: number;
}

export interface AccountStats {
  total: number;
  active: number;
  suspended: number;
  blocked: number;
  totalCredits: number;
  planCounts: Record<string, number>;
}

export interface Admin {
  _id: string;
  email: string;
  name: string;
  role: "super_admin" | "moderator" | "reviewer";
  permissions: string[];
  lastLoginAt?: number;
  createdAt: number;
}

export interface Developer {
  _id: string;
  email: string;
  displayName: string;
  companyName?: string;
  website?: string;
  bio?: string;
  status: "pending" | "approved" | "rejected" | "suspended" | "banned";
  verificationNotes?: string;
  approvedBy?: string;
  approvedAt?: number;
  totalApps: number;
  totalInstalls: number;
  createdAt: number;
  lastLoginAt?: number;
}

export interface StoreItem {
  _id: string;
  slug: string;
  type: "skill" | "mcp" | "tool";
  name: string;
  description: string;
  longDescription?: string;
  developerId: string;
  developerName?: string;
  version: string;
  changelog?: string;
  contentFileId: string;
  iconFileId?: string;
  category: string;
  tags: string[];
  permissions: string[];
  pricing: string;
  installCount: number;
  rating: number;
  ratingCount: number;
  weeklyInstalls: number;
  status: "active" | "deprecated" | "removed";
  featuredRank?: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number;
}

export interface Submission {
  _id: string;
  developerId: string;
  developerName?: string;
  existingItemId?: string;
  isUpdate: boolean;
  type: "skill" | "mcp" | "tool";
  name: string;
  slug: string;
  description: string;
  longDescription?: string;
  version: string;
  changelog?: string;
  contentFileId: string;
  iconFileId?: string;
  category: string;
  tags: string[];
  permissions: string[];
  pricing: string;
  status: "pending" | "in_review" | "approved" | "rejected" | "revision_requested";
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  submittedAt: number;
}

export interface DashboardStats {
  totalUsers: number;
  totalDevelopers: number;
  pendingDevelopers: number;
  totalItems: number;
  activeItems: number;
  pendingSubmissions: number;
  totalInstalls: number;
  recentActivity?: ActivityLog[];
}

export interface ActivityLog {
  _id: string;
  type: string;
  userId?: string;
  developerId?: string;
  itemId?: string;
  adminId?: string;
  metadata?: string;
  timestamp: number;
}

// ── Observability Types ──────────────────────────

export interface ObservabilityData {
  totalAccounts: number;
  activeAccounts: number;
  totalCreditsRemaining: number;
  creditsByPlan: Record<string, { count: number; totalCredits: number }>;
  activeSessions: number;
  sessionsToday: number;
  sessionsThisWeek: number;
  sessionsThisMonth: number;
  requestsOverTime: Array<{ date: string; requests: number }>;
  activityByType: Record<string, number>;
  modelUsage: Array<{
    model: string;
    fullModel: string;
    tier: string;
    creditsPerCall: number;
    costPer1kInput: number;
    costPer1kOutput: number;
  }>;
  tierBreakdown: Record<string, { label: string; credits: number; color: string }>;
  recentErrors: Array<{
    id: string;
    type: string;
    timestamp: number;
    metadata: string | null;
  }>;
  errorCount: number;
}

export interface CreditUsageUser {
  userId: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  creditsRemaining: number;
  activations: number;
}

// ── Waitlist Types ───────────────────────────────

export type WaitlistStatus = "new" | "contacted" | "accepted" | "rejected";

export interface WaitlistEntry {
  _id: string;
  _creationTime: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  company?: string;
  useCase: string;
  status: WaitlistStatus;
  adminNotes?: string;
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
  submittedAt: number;
}

export interface WaitlistStats {
  total: number;
  new: number;
  contacted: number;
  accepted: number;
  rejected: number;
  last24h: number;
  last7d: number;
  scanCapped?: boolean;
}

export interface WaitlistListResponse {
  entries: WaitlistEntry[];
  isDone: boolean;
  continueCursor: string | null;
}
