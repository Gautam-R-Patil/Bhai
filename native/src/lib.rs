// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Native SIMD-accelerated operations for Bhai

#![deny(clippy::all)]
#![allow(dead_code, unused_variables, unused_imports, unused_mut)]

mod active_inference;
mod ax_walker;
mod batch;
mod browser_agent;
mod browser_guard;
mod chrome_bridge;
mod citation_graph;
mod consolidation;
mod context_pruning;
mod credibility_model;
mod forge_sandbox;
mod glass_effect;
mod goal_engine;
mod habit_detector;
mod harness_optimizer;
mod hnsw;
mod hopfield;
mod info_gain;
mod inner_thoughts;
mod ip_guard;
mod knowledge_graph;
mod logic_engine;
mod long_task;
mod mcts_engine;
mod memory_tiers;
mod mesh;
mod metacognition;
mod model_router;
mod notification_tracker;
mod pii_protect;
mod proactive_calendar;
mod proactive_intent;
mod proactive_monitor;
mod proactive_news;
mod proactive_scheduler;
mod proactive_source_gate;
mod proactive_stale_email;
mod proactive_tasks;
mod proactive_weather;
mod process_reward;
mod prompt_evaluator;
mod query_classifier;
mod reflection_core;
mod research_engine;
mod secrets_sanitizer;
mod security;
mod session_memory;
mod skill_scorer;
mod sleep_gate;
mod spreading;
mod sub_agent;
mod surprise_gate;
mod swarm;
mod task_learnings;
mod temporal_cache;
mod tool_analytics;
mod tool_router;
mod traits_engine;
mod user_model;
mod vector;
mod working_memory;
mod world_model;

#[cfg(feature = "vad")]
mod pcm_vad;

use napi_derive::napi;

// Re-export all public functions
pub use active_inference::*;
pub use ax_walker::*;
pub use batch::*;
pub use browser_agent::*;
pub use browser_guard::*;
pub use chrome_bridge::*;
pub use citation_graph::*;
pub use consolidation::*;
pub use context_pruning::*;
pub use credibility_model::*;
pub use forge_sandbox::api::*;
pub use glass_effect::*;
pub use goal_engine::*;
pub use habit_detector::*;
pub use harness_optimizer::*;
pub use hnsw::*;
pub use hopfield::*;
pub use info_gain::*;
pub use inner_thoughts::*;
pub use ip_guard::*;
pub use knowledge_graph::*;
pub use logic_engine::*;
pub use long_task::*;
pub use mcts_engine::*;
pub use memory_tiers::*;
pub use mesh::*;
pub use metacognition::*;
pub use model_router::*;
pub use notification_tracker::*;
pub use proactive_calendar::*;
pub use proactive_intent::*;
pub use proactive_monitor::*;
pub use proactive_news::*;
pub use proactive_scheduler::*;
pub use proactive_source_gate::*;
pub use proactive_stale_email::*;
pub use proactive_tasks::*;
pub use proactive_weather::*;
pub use process_reward::*;
pub use prompt_evaluator::*;
pub use query_classifier::*;
pub use reflection_core::*;
pub use research_engine::*;
pub use secrets_sanitizer::*;
pub use security::*;
pub use session_memory::*;
pub use skill_scorer::*;
pub use sleep_gate::*;
pub use spreading::*;
pub use sub_agent::*;
pub use surprise_gate::*;
pub use swarm::*;
pub use task_learnings::*;
pub use temporal_cache::*;
pub use tool_analytics::*;
pub use tool_router::*;
pub use traits_engine::*;
pub use user_model::*;
pub use vector::*;
pub use working_memory::*;
pub use world_model::*;

#[cfg(feature = "vad")]
pub use pcm_vad::*;

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
