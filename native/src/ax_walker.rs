// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// AX-tree walker + flattener + label search.
//
// Why Rust here:
//   * AX dumps can have 100-2000 nodes (Safari open with many tabs ~1500, VS Code ~600).
//   * The walk + role-filter + label-similarity scan is O(N) JS today; ~50-200 μs.
//   * Net per-call: 80-300 μs in TS vs ~5-20 μs in Rust + FFI tax. Worth it for AX-heavy workloads.
//
// Schema mirrors src/screen/ax-dump.ts (AxNode / AxDump / AxFlatElement).
// All operations accept JSON strings to keep the napi boundary cheap (vs structured arg marshaling).

use std::collections::HashSet;

use napi_derive::napi;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AxNode {
    role: Option<String>,
    #[serde(default)]
    subrole: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    value: Option<String>,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    focusable: bool,
    enabled: bool,
    #[serde(default)]
    children: Vec<AxNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AxDump {
    app: String,
    pid: i64,
    root: AxNode,
    trusted: bool,
    depth: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Bbox {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Center {
    x: i64,
    y: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AxFlatElement {
    id: u64,
    role: String,
    label: String,
    value: String,
    bbox: Bbox,
    center: Center,
    focusable: bool,
    enabled: bool,
    path: Vec<u32>,
    depth: u32,
}

static INTERACTIVE_ROLES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // macOS AX
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXSlider", "AXIncrementor",
        "AXComboBox", "AXTabGroup", "AXTab", "AXRow", "AXCell", "AXImage", "AXStaticText",
        // Windows UIA
        "Button", "Hyperlink", "Edit", "Document", "CheckBox", "RadioButton",
        "ComboBox", "MenuItem", "Slider", "Tab", "TabItem", "DataItem", "ListItem", "TreeItem",
        "Image", "Text",
        // Linux AT-SPI
        "push button", "link", "text", "entry", "check box", "radio button",
        "combo box", "menu item", "slider", "tab", "page tab", "table cell", "table row",
        "image", "label",
    ]
    .into_iter()
    .collect()
});

fn is_interactive(role: &Option<String>) -> bool {
    match role {
        Some(r) => INTERACTIVE_ROLES.contains(r.as_str()),
        None => false,
    }
}

// Hard cap to prevent stack overflow on adversarial inputs. The OS helpers cap
// dump depth at 30, but a malicious caller could hand-craft a deeper JSON tree.
const MAX_WALK_DEPTH: u32 = 64;

fn flatten_recursive(
    node: &AxNode,
    out: &mut Vec<AxFlatElement>,
    next_id: &mut u64,
    path: &mut Vec<u32>,
    depth: u32,
) {
    if depth > MAX_WALK_DEPTH { return; }
    if is_interactive(&node.role) && node.w > 0 && node.h > 0 {
        let label = node.label.as_deref().unwrap_or("").trim().to_string();
        let value = node.value.as_deref().unwrap_or("").trim().to_string();
        if !label.is_empty() || !value.is_empty() {
            *next_id += 1;
            out.push(AxFlatElement {
                id: *next_id,
                role: node.role.clone().unwrap_or_default(),
                label,
                value,
                bbox: Bbox { x: node.x, y: node.y, w: node.w, h: node.h },
                center: Center { x: node.x + node.w / 2, y: node.y + node.h / 2 },
                focusable: node.focusable,
                enabled: node.enabled,
                path: path.clone(),
                depth,
            });
        }
    }
    for (i, child) in node.children.iter().enumerate() {
        path.push(i as u32);
        flatten_recursive(child, out, next_id, path, depth + 1);
        path.pop();
    }
}

/// Flatten an AX dump's interactive elements. Input/output are JSON-encoded strings.
///
/// Designed so the napi boundary only crosses one string per call rather than marshaling
/// a deeply-nested object graph (serde_json deserialize is 5-10× faster than per-property
/// napi marshaling for tree-shaped data).
#[napi]
pub fn ax_flatten_interactive(dump_json: String) -> napi::Result<String> {
    let dump: AxDump = serde_json::from_str(&dump_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid AxDump JSON: {e}")))?;
    let mut out: Vec<AxFlatElement> = Vec::new();
    let mut next_id: u64 = 0;
    let mut path: Vec<u32> = Vec::new();
    flatten_recursive(&dump.root, &mut out, &mut next_id, &mut path, 0);
    serde_json::to_string(&out)
        .map_err(|e| napi::Error::from_reason(format!("encode failed: {e}")))
}

fn score_text(q: &str, hay: &str) -> f64 {
    if hay.is_empty() { return 0.0; }
    if hay == q { return 1.0; }
    if hay.contains(q) || q.contains(hay) { return 0.85; }
    // Char-overlap similarity.
    let hay_set: HashSet<char> = hay.chars().collect();
    let q_chars: HashSet<char> = q.chars().collect();
    let intersect = q_chars.intersection(&hay_set).count() as f64;
    let q_len = q.chars().count().max(1) as f64;
    (intersect / q_len) * 0.5
}

/// Find the best label/value match in a previously-flattened element list.
/// Returns the matching element JSON, or "" if nothing meets min_score.
#[napi]
pub fn ax_find_by_label(elements_json: String, query: String, min_score: f64) -> napi::Result<String> {
    if query.is_empty() {
        return Ok(String::new());
    }
    let elements: Vec<AxFlatElement> = serde_json::from_str(&elements_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid elements JSON: {e}")))?;
    let q = query.to_lowercase();
    let q = q.trim();
    let mut best: Option<(AxFlatElement, f64)> = None;
    for el in elements {
        let label_lower = el.label.to_lowercase();
        let value_lower = el.value.to_lowercase();
        if label_lower.is_empty() && value_lower.is_empty() {
            continue;
        }
        let score = score_text(q, &label_lower).max(score_text(q, &value_lower));
        match &best {
            None => best = Some((el, score)),
            Some((_, prev)) if score > *prev => best = Some((el, score)),
            _ => {}
        }
    }
    match best {
        Some((el, score)) if score >= min_score => serde_json::to_string(&el)
            .map_err(|e| napi::Error::from_reason(format!("encode failed: {e}"))),
        _ => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dump(json: &str) -> String {
        json.to_string()
    }

    #[test]
    fn flatten_collects_macos_roles() {
        let dump = make_dump(
            r#"{"app":"t","pid":1,"trusted":true,"depth":12,"root":{
                "role":"AXWindow","label":"main","value":null,"x":0,"y":0,"w":800,"h":600,"focusable":false,"enabled":true,
                "children":[
                    {"role":"AXButton","label":"Save","value":null,"x":50,"y":100,"w":80,"h":30,"focusable":true,"enabled":true,"children":[]},
                    {"role":"AXTextField","label":"search","value":"hello","x":50,"y":200,"w":200,"h":30,"focusable":true,"enabled":true,"children":[]}
                ]
            }}"#,
        );
        let result = ax_flatten_interactive(dump).unwrap();
        let els: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(els.len(), 2);
        assert_eq!(els[0]["label"], "Save");
        assert_eq!(els[1]["label"], "search");
        assert_eq!(els[1]["value"], "hello");
    }

    #[test]
    fn flatten_drops_zero_bbox() {
        let dump = make_dump(
            r#"{"app":"t","pid":1,"trusted":true,"depth":12,"root":{
                "role":"AXWindow","label":"main","value":null,"x":0,"y":0,"w":800,"h":600,"focusable":false,"enabled":true,
                "children":[
                    {"role":"AXButton","label":"Hidden","value":null,"x":0,"y":0,"w":0,"h":0,"focusable":true,"enabled":true,"children":[]},
                    {"role":"AXButton","label":"Visible","value":null,"x":50,"y":100,"w":80,"h":30,"focusable":true,"enabled":true,"children":[]}
                ]
            }}"#,
        );
        let result = ax_flatten_interactive(dump).unwrap();
        let els: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(els.len(), 1);
        assert_eq!(els[0]["label"], "Visible");
    }

    #[test]
    fn find_by_label_exact_match() {
        let elements = r#"[{"id":1,"role":"AXButton","label":"Save","value":"","bbox":{"x":0,"y":0,"w":100,"h":30},"center":{"x":50,"y":15},"focusable":true,"enabled":true,"path":[],"depth":1}]"#;
        let result = ax_find_by_label(elements.to_string(), "Save".to_string(), 0.5).unwrap();
        assert!(!result.is_empty());
    }

    #[test]
    fn find_by_label_returns_empty_on_no_match() {
        let elements = r#"[{"id":1,"role":"AXButton","label":"Save","value":"","bbox":{"x":0,"y":0,"w":100,"h":30},"center":{"x":50,"y":15},"focusable":true,"enabled":true,"path":[],"depth":1}]"#;
        let result = ax_find_by_label(elements.to_string(), "xyz".to_string(), 0.9).unwrap();
        assert!(result.is_empty());
    }
}
