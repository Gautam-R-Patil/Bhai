// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A.T.L.A.S Store — Main entry point

// Re-export types
export * from "./types.js";

// Re-export client functions
export {
  listItems,
  searchItems,
  getItemBySlug,
  getItemById,
  getFeaturedItems,
  getTrendingItems,
  getCategories,
  getUserInstalls,
  isItemInstalled,
  startInstall,
  confirmInstall,
  uninstall,
  checkUpdates,
  getUpdateDownload,
  updateVersion,
  setAutoUpdate,
  getItemReviews,
  getReviewSummary,
  getUserReview,
  submitReview,
  deleteReview,
  markReviewHelpful,
  getFileUrl,
  getItemContentUrl,
} from "./client.js";

// Re-export installer functions
export {
  installItem,
  uninstallItem,
  updateItem,
  getLocalInstalls,
  isInstalledLocally,
  getLocalInstallInfo,
  STORE_BASE_PATH,
  SKILLS_PATH,
  MCP_PATH,
  TOOLS_PATH,
  DYNAMIC_PATH,
  MCP_CONFIG_PATH,
} from "./installer.js";

// Re-export hot-reload functions
export {
  hotReloadItem,
  hotUnloadItem,
  registerSkillsReloader,
  registerMCPCallbacks,
  registerToolCallbacks,
  reloadAllStoreItems,
  isHotReloadAvailable,
} from "./hot-reload.js";
