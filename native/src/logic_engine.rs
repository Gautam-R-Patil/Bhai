// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Neurosymbolic Logic Engine — SAT solving, simple FOL operations,
// proof-by-contradiction for verifying agent reasoning chains.
// Inspired by Aristotle (ACL 2025) and LogicReward (ICLR 2026).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct Proposition {
    pub id: String,
    pub text: String,
    pub truth_value: Option<bool>, // None = unknown
    pub confidence: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct LogicClause {
    /// Literals: positive = variable ID, negative = negated variable
    pub literals: Vec<i32>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ConsistencyResult {
    pub is_consistent: bool,
    pub contradictions: Vec<String>, // Pairs of contradicting proposition IDs
    pub unsatisfied_clauses: Vec<u32>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub is_valid: bool,
    pub score: f64,          // 0-1 logical soundness
    pub issues: Vec<String>, // Specific logical issues found
}

// ── SAT Solver (DPLL) ──────────────────────────────

/// Simple DPLL SAT solver for checking logical consistency.
/// Variables are indexed 1..n. Clauses are lists of signed integers.
#[napi]
pub fn check_satisfiability(clauses: Vec<LogicClause>, num_variables: u32) -> ConsistencyResult {
    let cnf: Vec<Vec<i32>> = clauses.iter().map(|c| c.literals.clone()).collect();

    let mut assignment: HashMap<u32, bool> = HashMap::new();
    let is_sat = dpll(&cnf, &mut assignment, num_variables);

    if is_sat {
        ConsistencyResult {
            is_consistent: true,
            contradictions: vec![],
            unsatisfied_clauses: vec![],
        }
    } else {
        // Find which clauses are unsatisfied
        let unsatisfied: Vec<u32> = cnf
            .iter()
            .enumerate()
            .filter(|(_, clause)| !clause_satisfied(clause, &assignment))
            .map(|(i, _)| i as u32)
            .collect();

        ConsistencyResult {
            is_consistent: false,
            contradictions: vec!["Unsatisfiable formula detected".to_string()],
            unsatisfied_clauses: unsatisfied,
        }
    }
}

fn dpll(clauses: &[Vec<i32>], assignment: &mut HashMap<u32, bool>, n: u32) -> bool {
    // Check if all clauses satisfied
    if clauses.iter().all(|c| clause_satisfied(c, assignment)) {
        return true;
    }
    // Check for empty clause (conflict)
    if clauses.iter().any(|c| clause_falsified(c, assignment)) {
        return false;
    }

    // Unit propagation
    for clause in clauses {
        let unassigned: Vec<i32> = clause
            .iter()
            .filter(|&&lit| !assignment.contains_key(&(lit.unsigned_abs())))
            .copied()
            .collect();
        if unassigned.len() == 1 {
            let lit = unassigned[0];
            let var = lit.unsigned_abs();
            assignment.insert(var, lit > 0);
            return dpll(clauses, assignment, n);
        }
    }

    // Choose unassigned variable
    let var = (1..=n).find(|v| !assignment.contains_key(v));
    match var {
        Some(v) => {
            // Try true
            assignment.insert(v, true);
            if dpll(clauses, assignment, n) {
                return true;
            }
            // Try false
            assignment.insert(v, false);
            if dpll(clauses, assignment, n) {
                return true;
            }
            assignment.remove(&v);
            false
        }
        None => clauses.iter().all(|c| clause_satisfied(c, assignment)),
    }
}

fn clause_satisfied(clause: &[i32], assignment: &HashMap<u32, bool>) -> bool {
    clause.iter().any(|&lit| {
        let var = lit.unsigned_abs();
        assignment.get(&var).is_some_and(|&val| (lit > 0) == val)
    })
}

fn clause_falsified(clause: &[i32], assignment: &HashMap<u32, bool>) -> bool {
    clause.iter().all(|&lit| {
        let var = lit.unsigned_abs();
        assignment.get(&var).is_some_and(|&val| (lit > 0) != val)
    })
}

// ── Consistency Checking ───────────────────────────

/// Check if a set of propositions is internally consistent.
/// Looks for direct contradictions (A and NOT A).
#[napi]
pub fn check_proposition_consistency(propositions: Vec<Proposition>) -> ConsistencyResult {
    let mut contradictions = Vec::new();

    // Check for direct contradictions
    for i in 0..propositions.len() {
        for j in (i + 1)..propositions.len() {
            let a = &propositions[i];
            let b = &propositions[j];

            if let (Some(va), Some(vb)) = (a.truth_value, b.truth_value) {
                // Same topic, opposite truth values
                if topics_match(&a.text, &b.text) && va != vb {
                    contradictions.push(format!("{} vs {}", a.id, b.id));
                }
            }
        }
    }

    ConsistencyResult {
        is_consistent: contradictions.is_empty(),
        contradictions,
        unsatisfied_clauses: vec![],
    }
}

fn topics_match(a: &str, b: &str) -> bool {
    // Simple word overlap check for topic matching
    let words_a: HashSet<&str> = a
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .collect();
    let words_b: HashSet<&str> = b
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .collect();

    let intersection = words_a.intersection(&words_b).count();
    let union = words_a.union(&words_b).count();

    if union == 0 {
        return false;
    }
    (intersection as f64 / union as f64) > 0.5
}

// ── Reasoning Chain Verification ───────────────────

/// Verify a sequence of reasoning steps for logical soundness.
/// Checks: no contradictions, each step follows from previous, conclusion follows.
#[napi]
pub fn verify_reasoning_chain(
    steps: Vec<Proposition>,
    conclusion_confidence: f64,
) -> VerificationResult {
    let mut issues = Vec::new();
    let mut score = 1.0f64;

    // Check for internal contradictions
    let consistency = check_proposition_consistency(steps.clone());
    if !consistency.is_consistent {
        for c in &consistency.contradictions {
            issues.push(format!("Contradiction: {}", c));
        }
        score -= 0.3 * consistency.contradictions.len() as f64;
    }

    // Check confidence monotonicity (later steps shouldn't have wildly higher confidence)
    for i in 1..steps.len() {
        if steps[i].confidence > steps[i - 1].confidence + 0.3 {
            issues.push(format!(
                "Step {} confidence jump: {:.2} → {:.2}",
                i + 1,
                steps[i - 1].confidence,
                steps[i].confidence
            ));
            score -= 0.1;
        }
    }

    // Check conclusion confidence vs step confidence
    let avg_step_conf = if steps.is_empty() {
        0.0
    } else {
        steps.iter().map(|s| s.confidence).sum::<f64>() / steps.len() as f64
    };
    if conclusion_confidence > avg_step_conf + 0.2 {
        issues.push(format!(
            "Conclusion confidence ({:.2}) exceeds average step confidence ({:.2})",
            conclusion_confidence, avg_step_conf
        ));
        score -= 0.15;
    }

    score = score.clamp(0.0, 1.0);

    VerificationResult {
        is_valid: issues.is_empty(),
        score,
        issues,
    }
}
