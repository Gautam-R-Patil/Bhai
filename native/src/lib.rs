// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Native SIMD-accelerated operations for A.T.L.A.S

#![deny(clippy::all)]
#![allow(dead_code, unused_variables, unused_imports, unused_mut)]

mod vector;
mod batch;
mod model_router;
mod tool_analytics;
mod tool_router;
mod security;
mod research_engine;
mod hnsw;
mod spreading;
mod consolidation;
mod temporal_cache;
mod memory_tiers;
mod query_classifier;
mod memory_state;
mod context_pruning;
mod knowledge_graph;
mod task_learnings;
mod traits_engine;
mod session_memory;
mod reflection_core;
mod agent_core;
mod swarm;
mod mesh;
mod sub_agent;
mod long_task;
mod inner_thoughts;
mod metacognition;
mod goal_engine;
mod notification_tracker;
mod surprise_gate;
mod user_model;
mod world_model;
mod mcts_engine;
mod process_reward;
mod working_memory;
mod pattern_speculator;
mod prompt_evaluator;
mod sleep_gate;
mod logic_engine;
mod hopfield;
mod active_inference;
mod credibility_model;
mod habit_detector;
mod skill_scorer;
mod info_gain;
mod citation_graph;
mod chrome_bridge;
mod proactive_intent;
mod proactive_scheduler;
mod proactive_monitor;
mod browser_agent;
mod ip_guard;
mod browser_guard;

use napi_derive::napi;

// Re-export all public functions
pub use vector::*;
pub use batch::*;
pub use model_router::*;
pub use tool_analytics::*;
pub use tool_router::*;
pub use security::*;
pub use research_engine::*;
pub use hnsw::*;
pub use spreading::*;
pub use consolidation::*;
pub use temporal_cache::*;
pub use memory_tiers::*;
pub use query_classifier::*;
pub use memory_state::*;
pub use context_pruning::*;
pub use knowledge_graph::*;
pub use task_learnings::*;
pub use traits_engine::*;
pub use session_memory::*;
pub use reflection_core::*;
pub use agent_core::*;
pub use swarm::*;
pub use mesh::*;
pub use sub_agent::*;
pub use long_task::*;
pub use inner_thoughts::*;
pub use metacognition::*;
pub use goal_engine::*;
pub use notification_tracker::*;
pub use surprise_gate::*;
pub use user_model::*;
pub use world_model::*;
pub use mcts_engine::*;
pub use process_reward::*;
pub use working_memory::*;
pub use pattern_speculator::*;
pub use prompt_evaluator::*;
pub use sleep_gate::*;
pub use logic_engine::*;
pub use hopfield::*;
pub use active_inference::*;
pub use credibility_model::*;
pub use habit_detector::*;
pub use skill_scorer::*;
pub use info_gain::*;
pub use citation_graph::*;
pub use chrome_bridge::*;
pub use proactive_intent::*;
pub use proactive_scheduler::*;
pub use proactive_monitor::*;
pub use browser_agent::*;
pub use ip_guard::*;
pub use browser_guard::*;

/// Get the native module version
#[napi]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Check if SIMD is available on this platform
#[napi]
pub fn has_simd_support() -> bool {
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        true
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        false
    }
}
