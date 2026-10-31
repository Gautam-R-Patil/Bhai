// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Deep Research v2 — Re-export from modular research/ directory
// All implementation is in src/research/*.ts

export {
    cancelDeepResearch,
    checkDeepResearch,
    clearDeepResearchProgress,
    clearOverlayResearchProgress,
    deepResearch,
    getResearchStatusSnippet,
    initDeepResearch,
    multiEngineSearch,
    registerResearchStatusCard,
    researchStatusLine,
    resumeInterruptedResearch,
    type SearchResult,
    setDeepResearchLLM,
    setDeepResearchNotifier,
    setDeepResearchProgress,
    setOverlayResearchProgress,
    setOverlayResearchResult,
} from "../research/index.js";
