// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

// ── A.T.L.A.S Memory Studio (renderer) ─────────────
// Force-directed graph of the user's memory with right-side detail panel.
// Mounts on first navigation to the Memory tab; pauses the simulation when
// the tab is hidden. Fetches read-only data via window.atlas.studio.*.
//
// Theme: every visual value resolves through CSS custom properties on
// document.documentElement so the existing light/dark theme switch propagates
// without re-rendering. Color mapping is computed once per mount and again
// after any theme change.

(function () {
    if (typeof window === "undefined") return;
    if (window.MemoryStudio) return;

    const NODE_PALETTE_VARS = {
        you: "--accent-primary",
        memory: "--orb-cobalt",
        entity: "--orb-mint",
        trait: "--orb-amber",
        episode: "--orb-lavender",
        emotion: "--orb-peach",
        goal: "--text-muted",
        task_learning: "--text-muted",
        world_model: "--text-muted",
        self_state: "--text-muted",
    };

    const KIND_LABEL = {
        you: "You",
        memory: "Memory",
        entity: "Entity",
        trait: "Trait",
        episode: "Episode",
        emotion: "Emotion",
        goal: "Goal",
        task_learning: "Learning",
        world_model: "World",
        self_state: "Self-state",
    };

    const state = {
        mounted: false,
        graph: null,
        simulation: null,
        svg: null,
        gRoot: null,
        gEdges: null,
        gNodes: null,
        gLabels: null,
        gSynapse: null,
        zoom: null,
        tooltip: null,
        selectedId: null,
        filters: {
            kinds: new Set(["memory", "entity", "episode", "trait"]),
            advanced: false,
            similarity: true,
            query: "",
        },
        searchDebounceTimer: null,
        themeObserver: null,
        paletteCache: {},
        firingTimer: null,
    };

    function $(id) {
        return document.getElementById(id);
    }

    function _resolvePalette() {
        const styles = getComputedStyle(document.documentElement);
        const palette = {};
        for (const kind in NODE_PALETTE_VARS) {
            const v = styles.getPropertyValue(NODE_PALETTE_VARS[kind]).trim();
            palette[kind] = v || "#999";
        }
        // edge tints
        palette.edgeKg = styles.getPropertyValue("--accent-primary").trim() || "#e8533f";
        palette.edgeMention = styles.getPropertyValue("--text-muted").trim() || "#999";
        palette.edgeProv = styles.getPropertyValue("--orb-lavender").trim() || "#b58cff";
        palette.edgeSim = styles.getPropertyValue("--orb-cobalt").trim() || "#4d7bff";
        state.paletteCache = palette;
        return palette;
    }

    function _kindOf(nodeId) {
        const colon = nodeId.indexOf(":");
        if (colon < 0) return nodeId;
        return nodeId.slice(0, colon);
    }

    function _idTail(nodeId) {
        const colon = nodeId.indexOf(":");
        if (colon < 0) return nodeId;
        return nodeId.slice(colon + 1);
    }

    function _kindFromNamespace(prefix) {
        if (prefix === "you") return "you";
        if (prefix === "mem") return "memory";
        if (prefix === "cat") return "memory"; // category anchor — synthetic
        if (prefix === "ent") return "entity";
        if (prefix === "epi") return "episode";
        if (prefix === "trait") return "trait";
        if (prefix === "emo") return "emotion";
        if (prefix === "goal") return "goal";
        if (prefix === "world") return "world_model";
        if (prefix === "self") return "self_state";
        return "memory";
    }

    function _timeAgo(ts) {
        if (!ts) return "";
        const t = new Date(ts).getTime();
        if (!Number.isFinite(t)) return "";
        const s = Math.floor((Date.now() - t) / 1000);
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }

    function _escapeHtml(text) {
        if (text == null) return "";
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function _applyFilters(graph) {
        if (!graph) return graph;
        const allowedKinds = state.filters.kinds;
        const advanced = state.filters.advanced;
        const advancedKinds = new Set(["goal", "task_learning", "world_model", "self_state"]);

        const keepNode = (n) => {
            if (n.kind === "you") return true;
            if (advancedKinds.has(n.kind) && !advanced) return false;
            if (advancedKinds.has(n.kind)) return true;
            return allowedKinds.has(n.kind);
        };

        const visibleNodes = graph.nodes.filter(keepNode);
        const visibleIds = new Set(visibleNodes.map((n) => n.id));
        const visibleEdges = graph.edges.filter((e) => {
            const src = typeof e.source === "object" ? e.source.id : e.source;
            const tgt = typeof e.target === "object" ? e.target.id : e.target;
            if (!visibleIds.has(src) || !visibleIds.has(tgt)) return false;
            // The "Similarity edges" toggle controls the dense mesh layer.
            // Off = only structural KG/mention/provenance edges show, leaving
            // a clean star/cluster graph for users who find the mesh noisy.
            if (e.kind === "similarity" && !state.filters.similarity) return false;
            return true;
        });
        return { ...graph, nodes: visibleNodes, edges: visibleEdges };
    }

    async function _fetchGraph() {
        const res = state.filters.query
            ? await window.atlas.studio.search(state.filters.query, {
                  includeAdvanced: state.filters.advanced,
                  includeSimilarity: state.filters.similarity,
                  maxNodes: 400,
              })
            : await window.atlas.studio.graph({
                  centerOnUser: true,
                  hops: 1,
                  includeAdvanced: state.filters.advanced,
                  includeSimilarity: state.filters.similarity,
                  windowDays: 90,
                  maxNodes: 400,
              });
        if (!res?.success) {
            return null;
        }
        return res.graph;
    }

    function _ensureSvg(container) {
        if (state.svg) return state.svg;
        if (typeof window.d3 === "undefined") {
            container.innerHTML =
                '<div class="studio-empty">Graph library failed to load. Reinstall the desktop app to restore.</div>';
            return null;
        }
        const d3 = window.d3;
        const svg = d3.select(container).append("svg").attr("class", "studio-graph-svg");
        const gRoot = svg.append("g").attr("class", "studio-graph-root");
        const gEdges = gRoot.append("g").attr("class", "studio-graph-edges");
        const gSynapse = gRoot.append("g").attr("class", "studio-graph-synapse");
        const gNodes = gRoot.append("g").attr("class", "studio-graph-nodes");
        const gLabels = gRoot.append("g").attr("class", "studio-graph-labels");

        const zoom = d3
            .zoom()
            .scaleExtent([0.2, 3])
            .on("zoom", (event) => {
                gRoot.attr("transform", event.transform);
                // Hide labels when zoomed out — at small scales labels overlap
                // and the canvas should read as a network of pulses, not text.
                const k = event.transform.k;
                if (state.gLabels) {
                    state.gLabels.attr("opacity", k < 0.55 ? 0 : k < 0.85 ? (k - 0.55) / 0.3 : 1);
                }
            });
        svg.call(zoom);

        state.svg = svg;
        state.gRoot = gRoot;
        state.gEdges = gEdges;
        state.gSynapse = gSynapse;
        state.gNodes = gNodes;
        state.gLabels = gLabels;
        state.zoom = zoom;
        return svg;
    }

    function _renderGraph() {
        const container = $("studioGraph");
        if (!container) return;
        const svg = _ensureSvg(container);
        if (!svg) return;
        const palette = _resolvePalette();
        const d3 = window.d3;

        const filtered = _applyFilters(state.graph);
        const nodes = filtered.nodes.map((n) => ({ ...n }));
        const edges = filtered.edges.map((e) => ({ ...e }));
        const nodeById = new Map(nodes.map((n) => [n.id, n]));

        const rect = container.getBoundingClientRect();
        const width = Math.max(rect.width, 320);
        const height = Math.max(rect.height, 320);
        svg.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);

        const counter = $("studioNodeCount");
        if (counter) {
            const total = state.graph?.meta?.nodeCount ?? nodes.length;
            counter.textContent =
                state.graph?.meta?.truncated && !state.filters.query
                    ? `${nodes.length} of ${total}+`
                    : `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`;
        }

        // Stop existing simulation; clear stale firing dots if re-rendering.
        if (state.simulation) state.simulation.stop();
        if (state.gSynapse) state.gSynapse.selectAll("circle").remove();

        // Category anchors get a hub-like role: strong repulsion from each
        // other so the clusters spread, plus stronger pull from their
        // attached memories.
        const isAnchor = (n) => n.id && n.id.startsWith("cat:");

        const simulation = d3
            .forceSimulation(nodes)
            .force(
                "link",
                d3
                    .forceLink(edges)
                    .id((d) => d.id)
                    .distance((d) => {
                        const s = d.strength || 0.4;
                        const src = typeof d.source === "object" ? d.source : null;
                        const tgt = typeof d.target === "object" ? d.target : null;
                        // anchor → memory: keep memories close to their category center
                        if (src && tgt && (isAnchor(src) || isAnchor(tgt))) {
                            return 60 + (1 - s) * 60;
                        }
                        // you → anchor or you → leaf: push clusters far out
                        if (src && tgt && (src.id === "you" || tgt.id === "you")) {
                            return 380 + (1 - s) * 220;
                        }
                        return 140 + (1 - s) * 280;
                    })
                    .strength((d) => {
                        const s = d.strength || 0.4;
                        const src = typeof d.source === "object" ? d.source : null;
                        const tgt = typeof d.target === "object" ? d.target : null;
                        if (src && tgt && (isAnchor(src) || isAnchor(tgt))) {
                            return 0.9 * s; // pull cluster members in tightly
                        }
                        return 0.05 + 0.5 * s;
                    }),
            )
            .force(
                "charge",
                d3.forceManyBody()
                    .strength((d) => {
                        if (d.kind === "you") return -1100;
                        if (isAnchor(d)) return -1400;
                        if (d.kind === "trait") return -380;
                        return -260;
                    })
                    .distanceMin(20)
                    .distanceMax(900),
            )
            .force("center", d3.forceCenter(0, 0).strength(0.015))
            .force("collide", d3.forceCollide().radius((d) => Math.max(14, (d.size || 10) / 1.4 + 14)))
            .force("x", d3.forceX(0).strength(0.008))
            .force("y", d3.forceY(0).strength(0.008))
            .alphaDecay(0.03);

        // Don't pin "you" anymore — letting it drift means clusters can
        // distribute naturally across the canvas instead of all orbiting
        // a central gravity well.

        // Edges as quadratic Bezier paths — gentle perpendicular offset gives
        // the dendrite curve. The actual `d` attr is set in the tick handler.
        const edgeSel = state.gEdges
            .selectAll("path")
            .data(edges, (d) => `${d.source.id || d.source}->${d.target.id || d.target}::${d.kind}`)
            .join("path")
            .attr("class", (d) => `studio-graph-edge ${d.kind}`)
            .attr("fill", "none")
            .attr("stroke", (d) => {
                if (d.kind === "kg") return palette.edgeKg;
                if (d.kind === "mention") return palette.edgeMention;
                if (d.kind === "provenance") return palette.edgeProv;
                if (d.kind === "similarity") return palette.edgeSim;
                return palette.edgeMention;
            })
            .attr("stroke-width", (d) => {
                if (d.kind === "kg") return 1.4 + 0.8 * (d.strength || 0.5);
                if (d.kind === "mention") return 1.1;
                if (d.kind === "provenance") return 1;
                return 0.9; // similarity — was 0.6
            })
            .attr("stroke-opacity", (d) => {
                if (d.kind === "kg") return 0.55 + 0.35 * (d.strength || 0.5);
                if (d.kind === "mention") return 0.55;
                if (d.kind === "provenance") return 0.55;
                return 0.45; // similarity — was 0.25
            })
            .attr("stroke-linecap", "round");

        // Nodes — glow halo behind a core circle. The halo gets the pulse
        // animation when the node is "active" (recent activity).
        const nodeSel = state.gNodes
            .selectAll("g.studio-graph-node")
            .data(nodes, (d) => d.id)
            .join((enter) => {
                const g = enter.append("g").attr("class", "studio-graph-node");
                g.append("circle")
                    .attr("class", "studio-node-glow")
                    .attr("fill", "transparent")
                    .attr("stroke-width", 0);
                g.append("circle")
                    .attr("class", "studio-node-core")
                    .attr("stroke", "var(--glass-border-strong, rgba(255,255,255,0.85))")
                    .attr("stroke-width", 1.5);
                return g;
            })
            .attr("data-id", (d) => d.id)
            .classed("selected", (d) => d.id === state.selectedId)
            .classed("active", (d) => !!(d.meta && d.meta.active))
            .classed("pinned", (d) => !!d.pinned)
            .classed("anchor", (d) => !!(d.meta && d.meta.isCategoryAnchor))
            .classed("dim", (d) => d.kind !== "you" && (d.recency ?? 0) < 0.15 && !d.pinned && !(d.meta && d.meta.isCategoryAnchor));

        nodeSel
            .select("circle.studio-node-core")
            .attr("r", (d) => Math.max(5, (d.size || 10) / 1.4))
            .attr("fill", (d) => palette[d.kind] || palette.entity);

        nodeSel
            .select("circle.studio-node-glow")
            .attr("r", (d) => Math.max(5, (d.size || 10) / 1.4) + 6)
            .attr("fill", (d) => palette[d.kind] || palette.entity);

        nodeSel
            .on("click", (event, d) => {
                event.stopPropagation();
                _selectNode(d.id);
            })
            .on("mouseenter", (event, d) => _showTooltip(event, d))
            .on("mousemove", (event) => _moveTooltip(event))
            .on("mouseleave", () => _hideTooltip())
            .call(
                d3
                    .drag()
                    .on("start", (event, d) => {
                        if (!event.active) simulation.alphaTarget(0.3).restart();
                        d.fx = d.x;
                        d.fy = d.y;
                    })
                    .on("drag", (event, d) => {
                        d.fx = event.x;
                        d.fy = event.y;
                    })
                    .on("end", (event, d) => {
                        if (!event.active) simulation.alphaTarget(0);
                        if (d.kind !== "you") {
                            d.fx = null;
                            d.fy = null;
                        }
                    }),
            );

        // Labels — visible only on the items that genuinely shape the picture:
        // you, all entities, category anchors, and top-importance nodes. Any
        // labeled node that is also "active" or a category anchor gets the
        // `prominent` class so its label is fully opaque; everything else
        // sits at low opacity so the canvas reads as a graph, not a list.
        const isCategoryAnchor = (n) => n.id && n.id.startsWith("cat:");
        const labelEligible = (n) => {
            if (n.kind === "you") return true;
            if (n.kind === "entity") return true;
            if (isCategoryAnchor(n)) return true;
            if (n.meta && n.meta.active && (n.size || 0) >= 18) return true;
            return (n.importance || 0) >= 0.7 && (n.size || 0) >= 22;
        };
        const labelText = (d) => {
            const base = d.label || "";
            if (base.length <= 22) return base;
            return base.slice(0, 21) + "…";
        };
        const labelSel = state.gLabels
            .selectAll("text")
            .data(nodes.filter(labelEligible), (d) => d.id)
            .join("text")
            .attr("class", (d) => {
                const prominent =
                    d.kind === "you" ||
                    isCategoryAnchor(d) ||
                    (d.meta && d.meta.active);
                return `studio-graph-label${prominent ? " prominent" : ""}`;
            })
            .attr("text-anchor", "middle")
            .attr("dy", "0.35em")
            .attr("y", (d) => -(Math.max(5, (d.size || 10) / 1.4) + 10))
            .text(labelText);

        // Stable per-edge curvature so the bend doesn't jitter across ticks.
        // Sign + magnitude derived from a hash of the edge endpoints.
        const edgeCurve = (d) => {
            const key = `${d.source.id || d.source}::${d.target.id || d.target}`;
            let h = 0;
            for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
            const sign = (h & 1) ? 1 : -1;
            const mag = 0.18 + ((Math.abs(h) % 100) / 100) * 0.22; // 0.18..0.40
            return sign * mag;
        };

        const pathFor = (d) => {
            const sx = d.source.x ?? 0;
            const sy = d.source.y ?? 0;
            const tx = d.target.x ?? 0;
            const ty = d.target.y ?? 0;
            const dx = tx - sx;
            const dy = ty - sy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // Perpendicular offset for the control point — gives the dendrite curve.
            const k = edgeCurve(d);
            const cx = (sx + tx) / 2 - dy * k;
            const cy = (sy + ty) / 2 + dx * k;
            return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
        };
        edgeSel.each(function (d) { d._pathFor = pathFor; });

        simulation.on("tick", () => {
            edgeSel.attr("d", pathFor);
            nodeSel.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
            labelSel.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
        });

        // Stop after settling and auto-fit the viewport so the entire graph
        // fills the canvas instead of trailing off-screen with sprawling
        // anchor clusters.
        let fitted = false;
        simulation.on("tick.stop", () => {
            const a = simulation.alpha();
            if (!fitted && a < 0.08) {
                fitted = true;
                _fitToView(nodes);
            }
            if (a < 0.01) simulation.stop();
        });

        // Background click clears selection — but only when the click really
        // landed on the empty SVG, not when bubbling up from a node. Drag
        // behaviors sometimes interfere with stopPropagation, so we re-check
        // the actual event target instead of trusting bubbling alone.
        svg.on("click", (event) => {
            const t = event.target;
            if (t === svg.node() || (t && t.tagName === "svg")) {
                _selectNode(null);
            }
        });

        state.simulation = simulation;
    }

    function centerOnUserNode(nodes) {
        return nodes.some((n) => n.id === "you");
    }

    function _fitToView(nodes) {
        if (!state.svg || !state.zoom || !window.d3 || !nodes || !nodes.length) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of nodes) {
            if (typeof n.x !== "number" || typeof n.y !== "number") continue;
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        }
        if (!Number.isFinite(minX)) return;

        const container = $("studioGraph");
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const margin = 40;
        const w = Math.max(maxX - minX, 1);
        const h = Math.max(maxY - minY, 1);
        const sx = (rect.width - margin * 2) / w;
        const sy = (rect.height - margin * 2) / h;
        const k = Math.max(0.3, Math.min(2.0, Math.min(sx, sy)));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const transform = window.d3.zoomIdentity.translate(-cx * k, -cy * k).scale(k);
        state.svg.transition().duration(500).call(state.zoom.transform, transform);
    }

    function _highlightAdjacency(selectedId) {
        const palette = state.paletteCache;
        if (!state.gNodes) return;
        if (!selectedId) {
            state.gNodes.selectAll("g.studio-graph-node").classed("faded", false).classed("selected", false);
            state.gEdges.selectAll("path").classed("faded", false);
            state.gLabels.selectAll("text").classed("faded", false);
            return;
        }
        const adj = new Set([selectedId]);
        state.gEdges.selectAll("path").each((d) => {
            const src = d.source.id || d.source;
            const tgt = d.target.id || d.target;
            if (src === selectedId) adj.add(tgt);
            if (tgt === selectedId) adj.add(src);
        });
        state.gNodes
            .selectAll("g.studio-graph-node")
            .classed("faded", (d) => !adj.has(d.id))
            .classed("selected", (d) => d.id === selectedId);
        state.gEdges.selectAll("path").classed("faded", (d) => {
            const src = d.source.id || d.source;
            const tgt = d.target.id || d.target;
            return src !== selectedId && tgt !== selectedId;
        });
        state.gLabels.selectAll("text").classed("faded", (d) => !adj.has(d.id));
    }

    function _showTooltip(event, d) {
        if (!state.tooltip) return;
        const tip = state.tooltip;
        const kind = KIND_LABEL[d.kind] || d.kind;
        tip.innerHTML = `<strong>${_escapeHtml(d.label)}</strong><br><span style="opacity:0.7">${kind} · ${_timeAgo(d.createdAt)}</span>`;
        tip.style.display = "block";
        _moveTooltip(event);
    }
    function _moveTooltip(event) {
        if (!state.tooltip) return;
        const tip = state.tooltip;
        const wrap = $("studioGraph");
        const rect = wrap.getBoundingClientRect();
        let x = event.clientX - rect.left + 12;
        let y = event.clientY - rect.top + 12;
        if (x + 240 > rect.width) x = event.clientX - rect.left - 250;
        if (y + 80 > rect.height) y = event.clientY - rect.top - 80;
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
    }
    function _hideTooltip() {
        if (state.tooltip) state.tooltip.style.display = "none";
    }

    async function _selectNode(id) {
        state.selectedId = id;
        const detail = $("studioDetail");
        const body = document.querySelector(".studio-body");
        if (!id) {
            if (detail) detail.setAttribute("data-open", "false");
            if (body) body.setAttribute("data-detail-open", "false");
            _highlightAdjacency(null);
            setTimeout(() => _onResize(), 240);
            return;
        }
        _highlightAdjacency(id);

        const kindNs = _kindOf(id);
        const tail = _idTail(id);
        const kind = _kindFromNamespace(kindNs);

        const node = state.graph?.nodes.find((n) => n.id === id);
        if (!node) return;

        if (!detail) return;
        detail.setAttribute("data-open", "true");
        if (body) body.setAttribute("data-detail-open", "true");
        // Wait for the grid transition (220ms) before recomputing the SVG
        // viewport so the simulation reflows around the new canvas width.
        setTimeout(() => _onResize(), 240);

        let extra = null;
        if (kindNs === "you") {
            try {
                const res = await window.atlas.studio.you();
                if (res?.success) extra = res.you;
            } catch { /* non-fatal */ }
        } else if (kindNs === "cat" || kindNs === "world" || kindNs === "self") {
            // Synthetic / advanced-only kinds — render from in-memory node.
            extra = null;
        } else {
            try {
                const res = await window.atlas.studio.getNode(kind, isNumericNs(kindNs) ? Number(tail) : tail);
                if (res?.success) extra = res.node;
            } catch { /* non-fatal */ }
        }

        // Category anchors and advanced synthetic kinds don't have a DB row,
        // so we derive connections from the in-memory graph.
        const isLocal = kindNs === "cat" || kindNs === "world" || kindNs === "self";
        const connectionsP = isLocal
            ? Promise.resolve({ success: true, connections: _anchorMembers(id) })
            : window.atlas.studio
                  .connections(kind, isNumericNs(kindNs) ? Number(tail) : tail)
                  .catch(() => ({ success: false }));

        detail.innerHTML = _renderDetailHtml(node, extra);
        const conn = await connectionsP;
        if (conn?.success && Array.isArray(conn.connections)) {
            const connRow = detail.querySelector("[data-conn-row]");
            if (connRow) {
                connRow.innerHTML = _renderConnectionsHtml(conn.connections);
            }
        }
        const closeBtn = detail.querySelector(".studio-detail-close");
        if (closeBtn) closeBtn.addEventListener("click", () => _selectNode(null));

        _wireDetailActions(detail, node, extra);
    }

    function _wireDetailActions(detail, node, extra) {
        const actBtns = detail.querySelectorAll("[data-act]");
        actBtns.forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const act = btn.getAttribute("data-act");
                if (act === "edit") _openEditForm(detail, node, extra);
                else if (act === "pin") _toggleMemoryPin(node, extra);
                else if (act === "forget") _openForgetModal(node, "memory");
                else if (act === "delete") _quickDelete(node, "memory");
                else if (act === "forget-trait") _openForgetModal(node, "trait");
                else if (act === "forget-entity") _openForgetModal(node, "entity");
            });
        });
    }

    async function _toggleMemoryPin(node, extra) {
        const id = Number(_idTail(node.id));
        if (!Number.isFinite(id)) return;
        const next = !(extra && extra.pinned);
        try {
            const res = await window.atlas.studio.pinMemory(id, next);
            if (res?.success) {
                if (typeof window.showToast === "function") {
                    window.showToast(next ? "📌 Pinned" : "Unpinned");
                }
                await refresh();
                await _selectNode(node.id); // reopen with fresh state
            } else if (typeof window.showToast === "function") {
                window.showToast("Pin failed: " + (res?.error || "unknown"));
            }
        } catch (err) {
            if (typeof window.showToast === "function") window.showToast("Pin failed: " + err.message);
        }
    }

    function _openEditForm(detail, node, extra) {
        const form = detail.querySelector("[data-edit-form]");
        if (!form) return;
        const initialContent = (extra && extra.content) || node.fullText || "";
        const initialTags = (extra && extra.tags) || (node.tags || []).join(", ");
        const initialImportance = (extra && typeof extra.importance === "number")
            ? extra.importance
            : Math.round((node.importance || 0) * 10);
        form.style.display = "flex";
        form.innerHTML = `
            <textarea data-edit-content placeholder="Memory content">${_escapeHtml(initialContent)}</textarea>
            <input type="text" data-edit-tags placeholder="tag1, tag2" value="${_escapeHtml(initialTags)}" />
            <label class="studio-detail-label">Importance: <span data-edit-imp-val>${initialImportance}</span> / 10</label>
            <input type="range" min="1" max="10" step="1" value="${initialImportance}" class="studio-edit-importance" data-edit-importance />
            <div class="studio-edit-actions">
                <button class="btn btn-secondary btn-sm" data-edit-cancel>Cancel</button>
                <button class="btn btn-primary btn-sm" data-edit-save>Save</button>
            </div>
        `;
        const slider = form.querySelector("[data-edit-importance]");
        const impLabel = form.querySelector("[data-edit-imp-val]");
        if (slider && impLabel) {
            slider.addEventListener("input", () => { impLabel.textContent = slider.value; });
        }
        form.querySelector("[data-edit-cancel]").addEventListener("click", () => {
            form.style.display = "none";
            form.innerHTML = "";
        });
        form.querySelector("[data-edit-save]").addEventListener("click", async () => {
            const id = Number(_idTail(node.id));
            const content = form.querySelector("[data-edit-content]").value;
            const tags = form.querySelector("[data-edit-tags]").value;
            const importance = Number(slider.value);
            try {
                const res = await window.atlas.studio.updateMemory(id, { content, tags, importance });
                if (res?.success) {
                    if (typeof window.showToast === "function") window.showToast("✓ Memory updated");
                    await refresh();
                    await _selectNode(node.id);
                } else if (typeof window.showToast === "function") {
                    window.showToast("Update failed: " + (res?.error || "unknown"));
                }
            } catch (err) {
                if (typeof window.showToast === "function") window.showToast("Update failed: " + err.message);
            }
        });
    }

    const FORGET_REASONS = ["Wrong fact", "Private", "Outdated", "No longer relevant"];

    function _openForgetModal(node, kindNs) {
        // kindNs: "memory" | "trait" | "entity"
        const backdrop = document.createElement("div");
        backdrop.className = "studio-modal-backdrop";
        backdrop.innerHTML = `
            <div class="studio-modal" role="dialog">
                <div class="studio-modal-title">Forget this ${kindNs}?</div>
                <div class="studio-modal-body">
                    "${_escapeHtml((node.label || "").slice(0, 80))}"<br/>
                    ATLAS will remove it and log the reason so it doesn't get re-learned.
                </div>
                <div class="studio-modal-options" data-reason-options>
                    ${FORGET_REASONS.map((r, i) => `<button class="studio-modal-option${i === 0 ? " active" : ""}" data-reason="${_escapeHtml(r)}">${_escapeHtml(r)}</button>`).join("")}
                </div>
                <input type="text" placeholder="Or type your own reason…" data-reason-other />
                <div class="studio-modal-actions">
                    <button class="btn btn-secondary btn-sm" data-cancel>Cancel</button>
                    <button class="btn btn-primary btn-sm danger" data-confirm>Forget</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        let chosen = FORGET_REASONS[0];
        const optBtns = backdrop.querySelectorAll("[data-reason]");
        optBtns.forEach((b) => {
            b.addEventListener("click", () => {
                optBtns.forEach((x) => x.classList.remove("active"));
                b.classList.add("active");
                chosen = b.getAttribute("data-reason");
                const other = backdrop.querySelector("[data-reason-other]");
                if (other) other.value = "";
            });
        });
        const cleanup = () => backdrop.remove();
        backdrop.querySelector("[data-cancel]").addEventListener("click", cleanup);
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(); });
        backdrop.querySelector("[data-confirm]").addEventListener("click", async () => {
            const other = backdrop.querySelector("[data-reason-other]").value.trim();
            const reason = other || chosen;
            cleanup();
            await _executeForget(node, kindNs, reason);
        });
    }

    async function _quickDelete(node, kindNs) {
        if (!confirm(`Delete "${(node.label || "").slice(0, 60)}"? This can't be undone.`)) return;
        await _executeForget(node, kindNs, "deleted by user");
    }

    async function _executeForget(node, kindNs, reason) {
        const tail = _idTail(node.id);
        try {
            let res = null;
            if (kindNs === "memory") {
                res = await window.atlas.studio.forgetMemory(Number(tail), reason);
            } else if (kindNs === "trait") {
                res = await window.atlas.studio.forgetTrait(tail, reason);
            } else if (kindNs === "entity") {
                res = await window.atlas.studio.forgetEntity(Number(tail), reason, true);
            }
            if (res?.success) {
                if (typeof window.showToast === "function") window.showToast("🗑️ Forgotten");
                await _selectNode(null);
                await refresh();
            } else if (typeof window.showToast === "function") {
                window.showToast("Forget failed: " + (res?.error || "unknown"));
            }
        } catch (err) {
            if (typeof window.showToast === "function") window.showToast("Forget failed: " + err.message);
        }
    }

    function isNumericNs(ns) {
        return ns === "mem" || ns === "ent" || ns === "goal";
    }

    function _anchorMembers(anchorId) {
        if (!state.graph) return [];
        const members = [];
        for (const e of state.graph.edges) {
            const src = typeof e.source === "object" ? e.source.id : e.source;
            const tgt = typeof e.target === "object" ? e.target.id : e.target;
            if (src !== anchorId) continue;
            const memberNode = state.graph.nodes.find((n) => n.id === tgt);
            if (memberNode) {
                members.push({
                    kind: memberNode.kind,
                    id: tgt,
                    name: memberNode.label,
                    relation: "in cluster",
                    direction: "out",
                });
                if (members.length >= 12) break;
            }
        }
        return members;
    }

    function _renderDetailHtml(node, extra) {
        const kind = KIND_LABEL[node.kind] || node.kind;
        const ago = _timeAgo(node.createdAt);
        const tags = (node.tags || [])
            .map((t) => `<span class="studio-detail-tag">${_escapeHtml(t)}</span>`)
            .join(" ");
        const importancePct = Math.round((node.importance || 0) * 100);
        let body = node.fullText || node.label || "";
        if (extra && typeof extra === "object") {
            if (node.kind === "trait" && extra.value) body = extra.value;
            if (node.kind === "memory" && extra.content) body = extra.content;
            if (node.kind === "episode" && extra.description) body = extra.description;
            if (node.kind === "you") {
                const rel = extra.relationship;
                const traits = (extra.topTraits || [])
                    .map((t) => `${_escapeHtml(t.key.replace(/_/g, " "))} (${Math.round(t.confidence * 100)}%)`)
                    .join(" · ");
                body = [
                    extra.name ? `Name: ${_escapeHtml(extra.name)}` : "",
                    rel ? `Trust ${Math.round(rel.trustScore * 100)}% · Depth ${Math.round(rel.depthScore * 100)}% · Streak ${rel.engagementStreak}` : "",
                    traits ? `Top traits: ${traits}` : "",
                ]
                    .filter(Boolean)
                    .join("\n\n");
            }
        }

        const isMemory = node.kind === "memory" && node.id.startsWith("mem:");
        const isAnchor = node.id && node.id.startsWith("cat:");
        const isTrait = node.kind === "trait";
        const isEntity = node.kind === "entity";
        const pinned = !!(extra && extra.pinned);

        // Build action row based on what the kind actually supports.
        let actions = "";
        if (isMemory) {
            actions = `
                <button class="btn btn-primary btn-sm" data-act="edit">✏ Edit</button>
                <button class="btn btn-secondary btn-sm" data-act="pin">${pinned ? "★ Pinned" : "📌 Pin"}</button>
                <button class="btn btn-secondary btn-sm" data-act="forget">⊝ Forget</button>
                <button class="btn btn-secondary btn-sm danger" data-act="delete">🗑 Delete</button>
            `;
        } else if (isTrait) {
            actions = `
                <button class="btn btn-secondary btn-sm danger" data-act="forget-trait">⊝ Forget</button>
            `;
        } else if (isEntity) {
            actions = `
                <button class="btn btn-secondary btn-sm danger" data-act="forget-entity">⊝ Forget</button>
            `;
        } else if (isAnchor) {
            actions = `<span class="studio-empty" style="padding:4px 0">Click a member memory to edit it.</span>`;
        }

        return `
            <div class="studio-detail-meta">
                <span>${_escapeHtml(kind)}${pinned ? " · pinned" : ""}${ago ? " · " + _escapeHtml(ago) : ""}</span>
                <button class="studio-detail-close" title="Close">×</button>
            </div>
            <div class="studio-detail-title">${_escapeHtml(node.label || "Untitled")}</div>
            <div class="studio-detail-body" data-body>${_escapeHtml(body)}</div>
            ${tags ? `<div class="studio-detail-row"><span class="studio-detail-label">Tags</span><div data-tags>${tags}</div></div>` : ""}
            <div class="studio-detail-row">
                <span class="studio-detail-label">Importance</span>
                <span class="studio-detail-tag" data-importance>${importancePct}%</span>
            </div>
            <div>
                <div class="studio-detail-label">Connected to</div>
                <div class="studio-conn-row" data-conn-row><span class="studio-empty" style="padding:4px 0">Loading…</span></div>
            </div>
            <div class="studio-detail-actions">${actions}</div>
            <div class="studio-edit-form" data-edit-form style="display:none"></div>
        `;
    }

    function _renderConnectionsHtml(connections) {
        if (!connections.length) {
            return '<span class="studio-empty" style="padding:4px 0">No connections yet.</span>';
        }
        const palette = state.paletteCache;
        return connections
            .map((c) => {
                const dot = palette[c.kind] || palette.entity;
                const arrow = c.direction === "out" ? "→" : "←";
                return `<span class="studio-conn-chip" title="${_escapeHtml(c.relation || "")}"><span class="studio-conn-dot" style="background:${dot}"></span>${_escapeHtml(c.name || c.id)} <span style="opacity:0.6;margin-left:2px">${arrow}</span></span>`;
            })
            .join("");
    }

    function _renderLegend() {
        const legend = $("studioLegend");
        if (!legend) return;
        const palette = state.paletteCache;
        const visible = Array.from(state.filters.kinds);
        if (state.filters.advanced) visible.push("goal");
        const items = ["you", ...visible];
        const seen = new Set();
        const html = items
            .filter((k) => {
                if (seen.has(k)) return false;
                seen.add(k);
                return palette[k];
            })
            .map(
                (k) =>
                    `<span><span class="legend-dot" style="background:${palette[k]}"></span>${KIND_LABEL[k] || k}</span>`,
            )
            .join("");
        legend.innerHTML = html;
    }

    function _wireToolbar() {
        const search = $("studioSearch");
        if (search) {
            search.addEventListener("input", () => {
                clearTimeout(state.searchDebounceTimer);
                state.searchDebounceTimer = setTimeout(() => {
                    state.filters.query = search.value.trim();
                    refresh();
                }, 200);
            });
        }
        document.querySelectorAll(".studio-chip[data-filter]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const kind = btn.getAttribute("data-filter");
                if (state.filters.kinds.has(kind)) {
                    state.filters.kinds.delete(kind);
                    btn.classList.remove("active");
                } else {
                    state.filters.kinds.add(kind);
                    btn.classList.add("active");
                }
                _renderLegend();
                if (state.graph) _renderGraph();
            });
        });
        const deletedBtn = $("studioDeletedToggle");
        const deletedPane = $("studioDeletedPane");
        if (deletedBtn && deletedPane) {
            deletedBtn.addEventListener("click", async () => {
                const open = deletedPane.getAttribute("data-open") === "true";
                if (open) {
                    deletedPane.setAttribute("data-open", "false");
                    deletedBtn.textContent = "View deleted";
                    return;
                }
                deletedPane.setAttribute("data-open", "true");
                deletedBtn.textContent = "Hide deleted";
                deletedPane.innerHTML = '<span class="studio-empty">Loading…</span>';
                try {
                    const res = await window.atlas.studio.forgetLog(50);
                    if (!res?.success) {
                        deletedPane.innerHTML = `<span class="studio-empty">${_escapeHtml(res?.error || "Could not load deleted memory log.")}</span>`;
                        return;
                    }
                    const entries = res.entries || [];
                    if (!entries.length) {
                        deletedPane.innerHTML = '<span class="studio-empty">Nothing forgotten yet. Tombstones appear here when you delete or forget memories.</span>';
                        return;
                    }
                    deletedPane.innerHTML = entries.map((row) => `
                        <div class="studio-deleted-row">
                            <div class="studio-deleted-meta">${_escapeHtml(row.kind)} · ${_escapeHtml(_timeAgo(row.forgotten_at))} · ${_escapeHtml(row.reason || "—")}</div>
                            <div>${_escapeHtml((row.content_snapshot || "").slice(0, 160))}${(row.content_snapshot || "").length > 160 ? "…" : ""}</div>
                        </div>
                    `).join("");
                } catch (err) {
                    deletedPane.innerHTML = `<span class="studio-empty">Failed to load: ${_escapeHtml(err.message)}</span>`;
                }
            });
        }
        const advancedBtn = $("studioAdvancedToggle");
        if (advancedBtn) {
            advancedBtn.addEventListener("click", async () => {
                state.filters.advanced = !state.filters.advanced;
                advancedBtn.textContent = state.filters.advanced ? "Hide advanced" : "Show advanced";
                advancedBtn.classList.toggle("active", state.filters.advanced);
                await refresh();
                if (state.filters.advanced && typeof window.showToast === "function") {
                    const advanced = (state.graph?.nodes || []).filter((n) =>
                        n.kind === "goal" || n.kind === "task_learning" || n.kind === "world_model" || n.kind === "self_state",
                    );
                    if (advanced.length === 0) {
                        window.showToast("No advanced memory yet — goals/task-learnings/world-model nodes will appear when ATLAS records them.");
                    } else {
                        window.showToast(`+${advanced.length} advanced node${advanced.length === 1 ? "" : "s"} now visible`);
                    }
                }
            });
        }
        const simBox = $("studioSimilarity");
        if (simBox) {
            // Initial state derives from the DOM (default checked = on)
            state.filters.similarity = !!simBox.checked;
            simBox.addEventListener("change", () => {
                state.filters.similarity = simBox.checked;
                if (state.graph) _renderGraph();
            });
        }
        const recompute = $("studioRecomputeInsights");
        if (recompute) {
            recompute.addEventListener("click", async () => {
                recompute.disabled = true;
                const original = recompute.textContent;
                recompute.textContent = "Computing…";
                try {
                    const res = await window.atlas.studio.recomputeInsights();
                    if (res?.success) {
                        if (typeof window.showToast === "function") {
                            window.showToast(`✨ ${res.generated} insight${res.generated === 1 ? "" : "s"} refreshed`);
                        }
                        await _loadInsights();
                    } else if (typeof window.showToast === "function") {
                        window.showToast("Recompute failed: " + (res?.error || "unknown"));
                    }
                } catch (err) {
                    if (typeof window.showToast === "function") window.showToast("Recompute failed: " + err.message);
                } finally {
                    recompute.disabled = false;
                    recompute.textContent = original;
                }
            });
        }
        const zoomIn = document.querySelector('[data-zoom="in"]');
        const zoomOut = document.querySelector('[data-zoom="out"]');
        const zoomReset = document.querySelector('[data-zoom="reset"]');
        if (zoomIn) zoomIn.addEventListener("click", () => state.svg && state.zoom && state.svg.transition().duration(150).call(state.zoom.scaleBy, 1.3));
        if (zoomOut) zoomOut.addEventListener("click", () => state.svg && state.zoom && state.svg.transition().duration(150).call(state.zoom.scaleBy, 1 / 1.3));
        if (zoomReset)
            zoomReset.addEventListener("click", () => {
                if (state.svg && state.zoom && window.d3)
                    state.svg.transition().duration(220).call(state.zoom.transform, window.d3.zoomIdentity);
            });
    }

    function _ensureTooltip() {
        if (state.tooltip) return;
        const wrap = $("studioGraph");
        if (!wrap) return;
        const tip = document.createElement("div");
        tip.className = "studio-graph-tooltip";
        tip.style.display = "none";
        wrap.style.position = "relative";
        wrap.appendChild(tip);
        state.tooltip = tip;
    }

    function _watchTheme() {
        if (state.themeObserver) return;
        try {
            const observer = new MutationObserver(() => {
                _resolvePalette();
                _renderLegend();
                if (state.graph) _renderGraph();
            });
            observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
            state.themeObserver = observer;
        } catch { /* MutationObserver missing — skip */ }
    }

    async function refresh() {
        const graph = await _fetchGraph();
        if (!graph) {
            const container = $("studioGraph");
            if (container) {
                container.innerHTML =
                    '<div class="studio-empty">Memory database not ready yet. Start ATLAS at least once and try again.</div>';
            }
            return;
        }
        state.graph = graph;
        _renderGraph();
        _renderLegend();
        if (state.selectedId && !graph.nodes.find((n) => n.id === state.selectedId)) {
            await _selectNode(null);
        }
    }

    const MAX_CONCURRENT_FIRINGS = 8;
    let activeFirings = 0;

    function _fireSynapse() {
        if (!state.gEdges || !state.gSynapse || !state.graph || !window.d3) return;
        if (document.hidden) return;
        if (state.simulation && state.simulation.alpha() > 0.4) return;
        if (activeFirings >= MAX_CONCURRENT_FIRINGS) return;
        const edgePaths = state.gEdges.selectAll("path").nodes();
        if (!edgePaths.length) return;
        const candidate = edgePaths[Math.floor(Math.random() * edgePaths.length)];
        if (!candidate || typeof candidate.getTotalLength !== "function") return;
        const total = candidate.getTotalLength();
        if (!total || !Number.isFinite(total)) return;

        activeFirings += 1;

        // Brief edge brightness flash
        const sel = window.d3.select(candidate);
        sel.classed("firing", true);
        setTimeout(() => sel.classed("firing", false), 600 + Math.random() * 200);

        // Traveling synapse dot
        const dot = state.gSynapse
            .append("circle")
            .attr("class", "studio-synapse")
            .attr("r", 2.5 + Math.random() * 1.4)
            .attr("opacity", 0.95);
        const startPt = candidate.getPointAtLength(0);
        dot.attr("cx", startPt.x).attr("cy", startPt.y);

        const duration = 500 + Math.random() * 450;
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = t * t * (3 - 2 * t);
            const pt = candidate.getPointAtLength(eased * total);
            dot.attr("cx", pt.x).attr("cy", pt.y).attr("opacity", 0.95 * (1 - t * 0.4));
            if (t < 1) requestAnimationFrame(step);
            else {
                dot.remove();
                activeFirings = Math.max(0, activeFirings - 1);
            }
        };
        requestAnimationFrame(step);
    }

    function _startFiring() {
        if (state.firingTimer) return;
        // Tight cadence: every 180-360 ms try to spawn 1-2 new firings.
        // Combined with the 8-concurrent cap, the canvas hosts a constant
        // shimmer of ~4-6 traveling pulses across distributed regions.
        const tick = () => {
            const gap = 180 + Math.random() * 180;
            state.firingTimer = setTimeout(() => {
                const burst = 1 + (Math.random() < 0.45 ? 1 : 0);
                for (let i = 0; i < burst; i++) _fireSynapse();
                tick();
            }, gap);
        };
        tick();
    }

    function _stopFiring() {
        if (state.firingTimer) {
            clearTimeout(state.firingTimer);
            state.firingTimer = null;
        }
        activeFirings = 0;
    }

    function _isStudioActive() {
        const tab = document.getElementById("tab-memory");
        return !!(tab && tab.classList.contains("active"));
    }

    function _isInTextInput(target) {
        if (!target) return false;
        const tag = (target.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        if (target.isContentEditable) return true;
        return false;
    }

    async function _onKeydown(event) {
        if (!_isStudioActive()) return;
        // Modal open? defer to default behavior (esc closes modal natively below).
        const modalOpen = document.querySelector(".studio-modal-backdrop");

        // "/" — focus search (always, even with selection)
        if (event.key === "/" && !_isInTextInput(event.target) && !modalOpen) {
            const search = $("studioSearch");
            if (search) {
                event.preventDefault();
                search.focus();
                search.select();
            }
            return;
        }

        // Escape — clear selection / close detail / close modal
        if (event.key === "Escape") {
            if (modalOpen) {
                modalOpen.remove();
                return;
            }
            if (state.selectedId) {
                event.preventDefault();
                await _selectNode(null);
            }
            return;
        }

        // The remaining shortcuts only fire with a memory selected.
        if (_isInTextInput(event.target) || modalOpen) return;
        if (!state.selectedId || !state.selectedId.startsWith("mem:")) return;

        const node = state.graph?.nodes.find((n) => n.id === state.selectedId);
        if (!node) return;
        const detail = $("studioDetail");

        if (event.key === "e" || event.key === "E") {
            event.preventDefault();
            const editBtn = detail?.querySelector('[data-act="edit"]');
            if (editBtn) editBtn.click();
        } else if (event.key === "p" || event.key === "P") {
            event.preventDefault();
            const pinBtn = detail?.querySelector('[data-act="pin"]');
            if (pinBtn) pinBtn.click();
        } else if (event.key === "Delete" || event.key === "Backspace") {
            // Only Delete (not Backspace) on Mac to avoid stealing nav.
            if (event.key === "Backspace" && !event.metaKey) return;
            event.preventDefault();
            const forgetBtn = detail?.querySelector('[data-act="forget"]');
            if (forgetBtn) forgetBtn.click();
        }
    }

    function _onResize() {
        if (!state.mounted || !state.graph || !state.svg) return;
        const container = $("studioGraph");
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const width = Math.max(rect.width, 320);
        const height = Math.max(rect.height, 320);
        state.svg.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);
        if (state.simulation) state.simulation.alpha(0.3).restart();
    }

    async function mount() {
        if (state.mounted) {
            // Tab re-activation — resume simulation if it was paused.
            if (state.simulation) state.simulation.alpha(0.3).restart();
            _startFiring();
            await _loadInsights();
            return;
        }
        state.mounted = true;
        _resolvePalette();
        _ensureTooltip();
        _wireToolbar();
        _watchTheme();
        window.addEventListener("resize", _onResize);
        document.addEventListener("keydown", _onKeydown);
        await refresh();
        await _loadInsights();
        _startFiring();
    }

    async function _loadInsights() {
        const wrap = $("studioInsights");
        if (!wrap) return;
        try {
            const res = await window.atlas.studio.insights();
            if (!res?.success) {
                wrap.innerHTML = "";
                return;
            }
            _renderInsights(res.insights || []);
        } catch {
            /* non-fatal */
        }
    }

    const INSIGHT_LABEL = {
        mood: "📊 This week's mood",
        recurring_theme: "🌀 Recurring theme",
        avoidance: "🚧 Things you avoid",
        most_discussed: "⚡ Most-discussed",
    };

    function _renderInsights(cards) {
        const wrap = $("studioInsights");
        if (!wrap) return;
        if (!cards || cards.length === 0) {
            wrap.innerHTML = `
                <div class="surface-card studio-insight-card" style="grid-column: 1 / -1; text-align: center">
                    <div class="studio-insight-label">✨ No insights yet</div>
                    <div class="studio-insight-value" style="font-size:13px; font-weight:500">Click <strong>Recompute insights</strong> to generate the first set, or wait for ATLAS's next overnight dream replay.</div>
                </div>
            `;
            return;
        }
        wrap.innerHTML = cards
            .map((c) => {
                const label = INSIGHT_LABEL[c.kind] || c.kind;
                const ago = _timeAgo(c.computedAt);
                const clickable = Array.isArray(c.evidenceIds) && c.evidenceIds.length > 0;
                const evidenceAttr = clickable ? ` data-clickable="true" data-evidence='${_escapeHtml(JSON.stringify(c.evidenceIds))}'` : "";
                return `
                    <div class="surface-card studio-insight-card"${evidenceAttr}>
                        <div class="studio-insight-label">${_escapeHtml(label)}</div>
                        <div class="studio-insight-value">${_escapeHtml(c.title || "—")}</div>
                        <div class="studio-insight-detail">${_escapeHtml(c.body || "")}${ago ? ` · ${_escapeHtml(ago)}` : ""}</div>
                    </div>
                `;
            })
            .join("");
        wrap.querySelectorAll('.studio-insight-card[data-clickable="true"]').forEach((card) => {
            card.addEventListener("click", () => {
                try {
                    const evidence = JSON.parse(card.getAttribute("data-evidence") || "[]");
                    _focusOnEvidence(evidence);
                } catch { /* ignore */ }
            });
        });
    }

    function _focusOnEvidence(evidence) {
        if (!Array.isArray(evidence) || !evidence.length || !state.graph) return;
        const ids = new Set();
        for (const e of evidence) {
            const ns = e.kind === "memory" ? "mem" :
                       e.kind === "entity" ? "ent" :
                       e.kind === "episode" ? "epi" :
                       e.kind === "trait" ? "trait" :
                       e.kind === "emotion" ? "emo" : null;
            if (ns) ids.add(`${ns}:${e.id}`);
        }
        // Highlight matching nodes via "selected" + faded for the rest, like
        // adjacency highlighting but multi-target.
        if (!state.gNodes) return;
        state.gNodes.selectAll("g.studio-graph-node")
            .classed("faded", (d) => !ids.has(d.id))
            .classed("selected", (d) => ids.has(d.id));
        if (state.gEdges) state.gEdges.selectAll("path").classed("faded", true);
        if (state.gLabels) state.gLabels.selectAll("text").classed("faded", (d) => !ids.has(d.id));
        // Open the first hit
        const first = state.graph.nodes.find((n) => ids.has(n.id));
        if (first) _selectNode(first.id);
    }

    function pause() {
        if (state.simulation) state.simulation.stop();
        _stopFiring();
    }

    function destroy() {
        if (state.simulation) state.simulation.stop();
        if (state.themeObserver) state.themeObserver.disconnect();
        state.themeObserver = null;
        _stopFiring();
        window.removeEventListener("resize", _onResize);
        document.removeEventListener("keydown", _onKeydown);
        state.simulation = null;
        state.svg = null;
        state.gRoot = null;
        state.gEdges = null;
        state.gSynapse = null;
        state.gNodes = null;
        state.gLabels = null;
        state.zoom = null;
        state.tooltip = null;
        state.graph = null;
        state.mounted = false;
        const container = $("studioGraph");
        if (container) container.innerHTML = "";
    }

    window.MemoryStudio = { mount, refresh, pause, destroy };
})();
