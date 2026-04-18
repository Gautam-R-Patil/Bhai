// Developer Portal Types

export interface Developer {
  _id: string;
  email: string;
  displayName: string;
  companyName?: string;
  website?: string;
  bio?: string;
  status: "pending" | "approved" | "rejected" | "suspended" | "banned";
  verificationNotes?: string;
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
  version: string;
  changelog?: string;
  category: string;
  tags: string[];
  permissions: string[];
  pricing: string;
  installCount: number;
  rating: number;
  ratingCount: number;
  status: "active" | "deprecated" | "removed";
  createdAt: number;
  updatedAt: number;
  publishedAt: number;
}

export interface Submission {
  _id: string;
  developerId: string;
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
  submittedAt: number;
}

export interface DeveloperStats {
  totalApps: number;
  totalInstalls: number;
  totalReviews: number;
  averageRating: number;
  activeItems: number;
  pendingSubmissions: number;
}

export const CATEGORIES = [
  { value: "automation", label: "Automation" },
  { value: "research", label: "Research" },
  { value: "coding", label: "Coding" },
  { value: "productivity", label: "Productivity" },
  { value: "media", label: "Media" },
  { value: "communication", label: "Communication" },
  { value: "utilities", label: "Utilities" },
];

export const PERMISSIONS = [
  { value: "file_system", label: "File System Access", description: "Read/write files on disk" },
  { value: "network", label: "Network Access", description: "Make HTTP requests" },
  { value: "shell", label: "Shell Execution", description: "Run shell commands" },
  { value: "browser", label: "Browser Control", description: "Control web browser" },
  { value: "system", label: "System Control", description: "Modify system settings" },
];
